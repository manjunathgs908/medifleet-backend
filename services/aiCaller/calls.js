'use strict';
/**
 * services/aiCaller/calls.js
 * ============================================================
 * AI TELECALLER — PILOT. The call's life outside the conversation:
 * start (every guard in config.checkCanCall, then Plivo dials), hand off
 * to on-duty people (live transfer to a <Dial>), fail safe, queue a human
 * follow-up, and finish the record from Plivo's hangup report.
 *
 * Fail-safe rule: anything that goes wrong in the AI part hands the caller
 * to a person; if that cannot happen, the call is ended politely and a
 * callback is queued — never a caller left talking to a broken bot.
 * ============================================================
 */
const AiCall = require('../../models/AiCall');
const CallbackTask = require('../../models/CallbackTask');
const plivo = require('../plivoService');
const config = require('./config');
const { loadOnDuty, fallbackPhones } = require('../../controllers/callController');

const HUMAN_PART_SECONDS = 1800; // Plivo's cap leaves room for the person's part of the call

// ── Start ────────────────────────────────────────────────────
async function startCall({ phone, user }) {
  const gate = await config.checkCanCall(phone);
  if (!gate.ok) return gate;

  const call = await AiCall.create({ phone: gate.phone, startedBy: user?._id, status: 'dialing', dialedAt: new Date() });
  try {
    const { requestId } = await plivo.callAiLeg({
      phone    : gate.phone,
      callId   : String(call._id),
      timeLimit: config.maxCallSeconds() + HUMAN_PART_SECONDS,
    });
    await AiCall.updateOne({ _id: call._id }, { $set: { plivoRequestUuid: requestId } });
    return { ok: true, callId: String(call._id) };
  } catch (err) {
    const message = plivo.friendlyError?.(err) || err.message;
    await AiCall.updateOne({ _id: call._id }, { $set: { status: 'failed', outcome: 'failed', error: String(message).slice(0, 500), endedAt: new Date() } });
    return { ok: false, code: 'dial_failed', message: `Plivo could not place the call: ${message}` };
  }
}

// ── Follow-up for a person (the existing callback queue) ────
// One open task per number (CallbackTask's unique index): join it if one
// is open, else open one with source 'ai_call'.
async function queueFollowUp(callId, summary) {
  const call = await AiCall.findById(callId).select('+phone callbackTask');
  if (!call || call.callbackTask) return call?.callbackTask || null;
  const now = new Date();
  const event = { type: 'ai_call', at: now, detail: { aiCall: call._id, summary: summary || undefined } };
  let task = null;
  for (let attempt = 0; attempt < 3 && !task; attempt += 1) {
    task = await CallbackTask.findOneAndUpdate(
      { customerPhone: call.phone, state: 'open' },
      { $push: { events: event }, $set: { lastQueuedAt: now }, $inc: { rev: 1 } },
      { new: true },
    );
    if (task) break;
    try {
      task = await CallbackTask.create({
        customerPhone: call.phone, source: 'ai_call', state: 'open',
        firstMissedAt: now, lastMissedAt: now, lastQueuedAt: now, events: [event],
      });
    } catch (err) {
      if (err?.code !== 11000) throw err; // someone opened it at the same moment: join theirs
    }
  }
  if (task) await AiCall.updateOne({ _id: call._id }, { $set: { callbackTask: task._id } });
  return task?._id || null;
}

// ── Fail safe: end politely, queue a callback ───────────────
async function failSafe(callId, error) {
  const call = await AiCall.findOneAndUpdate(
    { _id: callId, status: { $in: config.ACTIVE_STATES } },
    { $set: { status: 'failed', outcome: 'follow_up', error: String(error).slice(0, 500) } },
    { new: true },
  );
  if (!call) return;
  console.error(`[aiCaller] fail-safe on ${callId}:`, error);
  if (call.plivoCallUuid) {
    await plivo.transferCall(call.plivoCallUuid, plivo.apiUrl(`/api/ai-caller/plivo/goodbye?call=${callId}`))
      .catch(() => plivo.hangupCall(call.plivoCallUuid).catch(() => {}));
  }
  await queueFollowUp(callId, `AI call failed: ${error}`).catch((err) => console.error('[aiCaller] follow-up queue failed:', err.message));
}

// ── Hand off to people ──────────────────────────────────────
// Moves the live call onto handoff XML (which rings the on-duty phones).
// Only from in_progress, once. A transfer Plivo refuses -> fail safe.
async function handOff(callId, reason) {
  const call = await AiCall.findOneAndUpdate(
    { _id: callId, status: 'in_progress' },
    { $set: { status: 'handing_off', handoff: true, handoffReason: String(reason || 'handoff').slice(0, 300), handoffAt: new Date() } },
    { new: true },
  );
  if (!call) return false;
  try {
    await plivo.transferCall(call.plivoCallUuid, plivo.apiUrl(`/api/ai-caller/plivo/handoff?call=${callId}`));
    return true;
  } catch (err) {
    await AiCall.updateOne({ _id: callId }, { $set: { status: 'in_progress' } }); // let failSafe claim it
    await failSafe(callId, `handoff transfer failed: ${err.message}`);
    return false;
  }
}

const HANDOFF_SAY = 'Connecting you to a SaveLife team member. Please stay on the line.';
const NOBODY_SAY = 'Sorry, nobody from our team is free right now. A SaveLife team member will call you back shortly. Thank you.';
const GOODBYE_SAY = 'Sorry, we could not continue this call. A SaveLife team member will call you back shortly. Thank you.';

// XML for the handoff URL: ring the on-duty phones, or apologise and queue.
async function handoffXml(callId) {
  const call = await AiCall.findById(callId).select('+phone');
  if (!call) return plivo.hangupXml();
  const numbers = fallbackPhones(await loadOnDuty(), call.phone);
  if (!numbers.length) {
    await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'follow_up' } });
    await queueFollowUp(callId, `Handoff (${call.handoffReason}): nobody on duty`);
    return plivo.speakXml(NOBODY_SAY);
  }
  return plivo.aiHandoffXml({ numbers, actionUrl: plivo.apiUrl(`/api/ai-caller/plivo/handoff-done?call=${callId}`), say: HANDOFF_SAY });
}

// The handoff Dial ended: answered -> handed_off; not -> apologise + queue.
async function handoffDone(callId, dialStatus) {
  if (dialStatus === 'completed') {
    await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'handed_off' } });
    return plivo.hangupXml();
  }
  await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'follow_up' } });
  await queueFollowUp(callId, `Handoff not answered (${dialStatus || 'unknown'})`);
  return plivo.speakXml(NOBODY_SAY);
}

// ── Hang up (end_call, the time limit) ──────────────────────
async function hangUp(callId) {
  const call = await AiCall.findById(callId).select('plivoCallUuid');
  if (call?.plivoCallUuid) await plivo.hangupCall(call.plivoCallUuid).catch((err) => console.error('[aiCaller] hangup failed:', err.message));
}

// ── Plivo's hangup report: final status, duration, cost ─────
async function finish(callId, { duration, cause, answered }) {
  const call = await AiCall.findById(callId);
  if (!call) return;
  const durationSec = Number(duration) || 0;
  const $set = {
    endedAt    : call.endedAt || new Date(),
    durationSec,
    hangupCause: cause || undefined,
    estCostPaise: config.estimateCostPaise(call.usage?.toObject?.() || call.usage, durationSec),
  };
  if (!call.answeredAt && !answered) {
    Object.assign($set, { status: 'no_answer', outcome: 'no_answer' });
  } else if (call.status !== 'failed') {
    $set.status = 'completed';
    if (!call.outcome) $set.outcome = call.handoff ? 'handed_off' : 'ended';
  }
  await AiCall.updateOne({ _id: callId }, { $set });
}

module.exports = {
  startCall, queueFollowUp, failSafe, handOff, handoffXml, handoffDone, hangUp, finish,
  HANDOFF_SAY, NOBODY_SAY, GOODBYE_SAY,
};
