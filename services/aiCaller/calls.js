'use strict';
/**
 * services/aiCaller/calls.js
 * ============================================================
 * AI TELECALLER — PILOT. The call's life outside the conversation:
 * start (every guard in config.checkCanCall, then Plivo dials), what
 * happens when the AI part ends, the handoff to on-duty people, a human
 * follow-up, and the record from Plivo's hangup report.
 *
 * How the AI part ends: the answer XML is Record -> Stream -> Redirect
 * (/plivo/next). The session writes what should happen next on the AiCall
 * (handing_off, or endRequested) and closes the stream; Plivo then fetches
 * nextXml(), which rings people, hangs up, or apologises. No REST transfer
 * or hangup is involved — a REST call to a call that already moved on was
 * the "handoff transfer failed: 404".
 *
 * Fail-safe rule: anything that goes wrong in the AI part hands the caller
 * to a person; if that cannot happen, the caller hears a polite goodbye and
 * a callback is queued — and if the call drops before any of that, the
 * hangup report queues the callback (finish).
 * ============================================================
 */
const AiCall = require('../../models/AiCall');
const CallbackTask = require('../../models/CallbackTask');
const plivo = require('../plivoService');
const config = require('./config');
const { loadOnDuty, fallbackPhones } = require('../../controllers/callController');

const HUMAN_PART_SECONDS = 1800; // Plivo's cap leaves room for the person's part of the call

const HANDOFF_SAY = 'Connecting you to a SaveLife team member. Please stay on the line.';
const NOBODY_SAY = 'Sorry, nobody from our team is free right now. A SaveLife team member will call you back shortly. Thank you.';
const GOODBYE_SAY = 'Sorry, we could not continue this call. A SaveLife team member will call you back shortly. Thank you.';

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

// ── Decide a handoff (the session then closes the stream) ───
// Only from in_progress, once. Returns whether this call made the decision.
async function handOff(callId, reason) {
  const call = await AiCall.findOneAndUpdate(
    { _id: callId, status: 'in_progress', endRequested: { $ne: true } },
    { $set: { status: 'handing_off', handoff: true, handoffReason: String(reason || 'handoff').slice(0, 300), handoffAt: new Date() } },
    { new: true },
  );
  return !!call;
}

// The assistant finished the call: when the stream closes, hang up.
const requestEnd = (callId) => AiCall.updateOne({ _id: callId, status: 'in_progress' }, { $set: { endRequested: true } });

// The handoff <Dial>: ring the on-duty phones, or apologise and queue.
async function handoffXml(callId) {
  const call = await AiCall.findById(callId).select('+phone handoffReason');
  if (!call) return plivo.hangupXml();
  const numbers = fallbackPhones(await loadOnDuty(), call.phone);
  if (!numbers.length) {
    await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'follow_up' } });
    await queueFollowUp(callId, `Handoff (${call.handoffReason}): nobody on duty`);
    return plivo.speakXml(NOBODY_SAY);
  }
  return plivo.aiHandoffXml({ numbers, actionUrl: plivo.apiUrl(`/api/ai-caller/plivo/handoff-done?call=${callId}`), say: HANDOFF_SAY });
}

// ── The stream ended: what Plivo does next (/plivo/next) ────
//   handing_off            -> ring people (handoffXml)
//   in_progress + endRequested -> hang up (the assistant said goodbye)
//   in_progress otherwise  -> the AI part ended unexpectedly (AI dropped,
//                             our server restarted, Plivo's streamTimeout)
//                             -> hand off to people
//   anything else          -> goodbye + callback queued
async function nextXml(callId) {
  const call = await AiCall.findById(callId).select('status endRequested handoff error');
  if (!call) return plivo.hangupXml();
  if (call.status === 'in_progress' && call.endRequested) return plivo.hangupXml();
  if (call.status === 'in_progress') {
    await handOff(callId, call.error ? `stream ended: ${call.error}` : 'stream ended unexpectedly');
    return handoffXml(callId);
  }
  if (call.status === 'handing_off') return handoffXml(callId);
  await failSafe(callId, call.error || `stream ended in state ${call.status}`);
  return plivo.speakXml(GOODBYE_SAY);
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

// Nothing more can be done on the call: record why, queue a callback.
async function failSafe(callId, error) {
  console.error(`[aiCaller] fail-safe on ${callId}:`, error);
  await AiCall.updateOne(
    { _id: callId, outcome: { $in: [null, 'failed'] } },
    { $set: { outcome: 'follow_up', error: String(error).slice(0, 500) } },
  );
  await queueFollowUp(callId, `AI call ended: ${error}`).catch((err) => console.error('[aiCaller] follow-up queue failed:', err.message));
}

// ── Plivo's hangup report: final status, duration, cost ─────
// A call that ended mid-handoff or after an AI failure without anyone
// taking it still gets its callback here.
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
  const wasAnswered = !!call.answeredAt || answered;
  if (!wasAnswered) {
    Object.assign($set, { status: 'no_answer', outcome: 'no_answer' });
  } else if (call.status !== 'failed') {
    $set.status = 'completed';
  }
  await AiCall.updateOne({ _id: callId }, { $set });

  if (wasAnswered && !call.outcome) {
    if (call.handoff || call.error) {
      await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'follow_up' } });
      await queueFollowUp(callId, call.handoff ? `Call ended during handoff (${call.handoffReason})` : `Call ended: ${call.error}`)
        .catch((err) => console.error('[aiCaller] follow-up queue failed:', err.message));
    } else {
      await AiCall.updateOne({ _id: callId }, { $set: { outcome: 'ended' } });
    }
  }
}

module.exports = {
  startCall, queueFollowUp, handOff, requestEnd, handoffXml, nextXml, handoffDone, failSafe, finish,
  HANDOFF_SAY, NOBODY_SAY, GOODBYE_SAY,
};
