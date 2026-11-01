'use strict';

// ============================================================
// services/callbackQueue.js — missed incoming calls -> callback tasks.
// ============================================================
// Which calls are queued — only a DEFINITIVELY missed customer call:
//   - incoming (/incoming created it), marked callbackEligible there: a real
//     10-digit mobile, and not one of our own ring phones calling in (a
//     staff test from their own phone);
//   - final status 'missed' (nobody answered) or 'no_agents' (nobody was on
//     duty — the caller heard the busy message);
//   - over for at least CALLBACK_SETTLE_SECONDS, so a late "completed" from
//     Plivo can still win (an early hang-up writes "missed" first).
// Never queued: ringing / in call / "Status unconfirmed" (still 'ringing'
// in the database), answered calls, test rings and every outgoing call
// (outgoing failures such as agent_missed are one leg of OUR call), and
// 'not_routed' calls — Plivo reached us without /incoming deciding who to
// ring, so it says nothing about staff; those are listed separately and a
// person decides (queueCall with `manual`).
//
// Answered after all: if Plivo's report that the call WAS answered arrives
// after it was queued, retractAnswered() marks that call on its task
// (kept, for the record) and stops counting it as missed. A task left with
// no genuinely missed call is withdrawn — not resolved: nobody decided
// anything, there was simply nothing to call back.
//
// Calls from before this feature carry no callbackEligible / callbackReview
// mark, so nothing historical is ever picked up.
//
// Idempotent: Plivo may deliver a report twice and two server instances
// may sweep at once. A call is added to a task only if no task holds it
// yet, and at most one open task per number can exist (unique index) — a
// losing concurrent create retries and joins the winner. That index is
// checked to exist before anything is queued (indexReady): without it the
// queue refuses to create tasks rather than risk duplicates.
//
// When it runs: lazily, from the CRM's own reads (the queue page and its
// nav badge, polled by every open CRM) — throttled to once per
// SWEEP_EVERY_MS per server. The work is durable in the call logs
// themselves (callbackEligible + no callbackTask yet), so a closed CRM or
// a restart only delays it. Tasks carry the CALL's time, so queueing later
// never changes a due time. No background job, and nothing here ever
// places a call or sends a message.
// ============================================================

const CallLog = require('../models/CallLog');
const CallbackTask = require('../models/CallbackTask');
const { normalisePhone } = require('../utils/phone');
const { settleSeconds } = require('../utils/callbackDue');

const FINAL_MISSED = ['missed', 'no_agents'];
// How far back a sweep looks. Bounds every sweep's query; a CRM left
// closed for longer than this leaves older misses unqueued (logged).
const LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const SWEEP_BATCH = 200;
// A call whose hang-up never arrived has no endedAt; one older than this
// with a final missed status is over all the same.
const NO_END_GRACE_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 15 * 1000;
const INDEX_RETRY_MS = 60 * 1000;
const OPEN_INDEX = 'one_open_task_per_number';

const isMobile = (p) => /^[6-9]\d{9}$/.test(p);

// ── The one-open-task-per-number index ──────────────────────────────────
// Mongoose builds indexes in the background and a failed build is silent,
// so it is built here explicitly and then READ BACK from MongoDB. Until it
// is confirmed, nothing is queued and the queue's API answers 503.
let indexState = { ok: false, checkedAt: 0, error: null, inFlight: null };
async function checkIndex() {
  try {
    await CallbackTask.createIndexes();
    const idx = (await CallbackTask.collection.indexes()).find((i) => i.name === OPEN_INDEX);
    const ok = !!idx && idx.unique === true && idx.key?.customerPhone === 1 && idx.partialFilterExpression?.state === 'open';
    if (!ok) throw new Error(`index ${OPEN_INDEX} is missing or not unique/partial on state "open"`);
    indexState = { ok: true, checkedAt: Date.now(), error: null, inFlight: null };
  } catch (err) {
    console.error(`[callbacks] NOT queueing missed calls — the one-open-task index could not be confirmed: ${err?.message || err}`);
    indexState = { ok: false, checkedAt: Date.now(), error: String(err?.message || err), inFlight: null };
  }
  return indexState.ok;
}
function indexReady() {
  if (indexState.ok) return Promise.resolve(true);
  if (indexState.inFlight) return indexState.inFlight;
  if (indexState.checkedAt && Date.now() - indexState.checkedAt < INDEX_RETRY_MS) return Promise.resolve(false);
  indexState.inFlight = checkIndex();
  return indexState.inFlight;
}
const indexError = () => indexState.error;
const _resetIndexCheck = () => { indexState = { ok: false, checkedAt: 0, error: null, inFlight: null }; };

function queueableReason(call, { manual } = {}) {
  if (!call) return 'not_found';
  if (call.direction !== 'inbound') return 'not_inbound';
  if (manual) return call.status === 'not_routed' ? null : 'not_not_routed';
  if (call.context !== 'incoming') return 'not_incoming';
  if (call.callbackEligible !== true) return 'not_eligible';
  if (!FINAL_MISSED.includes(call.status)) return 'not_missed';
  return null;
}

// Adds one call to its number's open task (creating it if needed).
// manual: { _id, name } of the person adding a not_routed call.
// -> { result: 'created' | 'added' | 'already' | 'attached_resolved', task }
//    or { skipped: reason }
async function queueCall(callId, { manual = null, now = new Date() } = {}) {
  if (!(await indexReady())) throw new Error('callback queue unavailable: open-task index not confirmed');
  const call = await CallLog.findById(callId)
    .select('+customerPhone direction context status callbackEligible callbackTask startedAt endedAt createdAt trip lead');
  const reason = queueableReason(call, { manual });
  if (reason) return { skipped: reason };
  const phone = normalisePhone(call.customerPhone);
  if (!isMobile(phone)) return { skipped: 'no_mobile_number' };

  const at = call.startedAt || call.createdAt || now;
  const entry = { call: call._id, at, status: call.status };
  const who = manual ? { by: manual._id, byName: manual.name } : {};
  const about = { ...(call.trip ? { trip: call.trip } : {}), ...(call.lead ? { lead: call.lead } : {}) };

  const finish = async (task, result) => {
    await CallLog.updateOne({ _id: call._id }, {
      $set: {
        callbackTask: task._id,
        ...(manual ? { callbackReview: { state: 'queued', by: manual._id, byName: manual.name, at: now } } : {}),
      },
    });
    return { result, task };
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    // 1. Some task — open, resolved or withdrawn — already holds it: a
    //    repeated report, a replayed webhook or a concurrent sweep. Checked
    //    FIRST, so an old call never moves into a newer open task.
    const holding = await CallbackTask.findOne({ 'calls.call': call._id }).select('_id');
    if (holding) return finish(holding, 'already');

    // 2. The number's open task. rev moves too: someone about to resolve
    //    it must see the new call first.
    const added = await CallbackTask.findOneAndUpdate(
      { customerPhone: phone, state: 'open', 'calls.call': { $ne: call._id } },
      {
        $push: { calls: entry, events: { type: manual ? 'added_manually' : 'missed_again', at: now, ...who, detail: { call: call._id, callAt: at } } },
        $inc : { missedCount: 1, rev: 1 },
        $max : { lastMissedAt: at, lastQueuedAt: now },
        $min : { firstMissedAt: at },
        ...(Object.keys(about).length ? { $set: about } : {}),
      },
      { new: true },
    );
    if (added) return finish(added, 'added');

    // 3. Over BEFORE a person resolved this number's task (queued late):
    //    keep the link there; the resolution already covered it. Never
    //    reopens it. By when the call ENDED: one still ringing while the
    //    task was resolved was missed afterwards — a new task (step 4).
    const resolved = await CallbackTask.findOneAndUpdate(
      { customerPhone: phone, state: 'resolved', 'resolution.at': { $gte: call.endedAt || at }, 'calls.call': { $ne: call._id } },
      {
        $push: { calls: entry, events: { type: 'missed_before_resolution', at: now, detail: { call: call._id, callAt: at } } },
        $inc : { missedCount: 1 },
        $min : { firstMissedAt: at },
      },
      { new: true, sort: { 'resolution.at': 1 } },
    );
    if (resolved) return finish(resolved, 'attached_resolved');

    // 4. A new open task. Losing a race with another delivery (E11000 on
    //    the one-open-task index) goes round and joins the winner's task.
    try {
      const task = await CallbackTask.create({
        customerPhone: phone,
        source: manual ? 'not_routed' : 'missed_call',
        calls: [entry],
        missedCount: 1,
        firstMissedAt: at,
        lastMissedAt: at,
        lastQueuedAt: now,
        ...about,
        events: [{ type: manual ? 'added_manually' : 'created', at: now, ...who, detail: { call: call._id, callAt: at } }],
      });
      return finish(task, 'created');
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error(`callbackQueue: could not queue call ${callId}`);
}

// A queued call that Plivo later reported ANSWERED. Kept on its task and in
// its history, marked answeredLater; it no longer counts as missed. The
// task's missed-call times follow the calls still genuinely missed; an open
// task left with none is withdrawn. Idempotent; safe to call for any call.
// -> 'marked' | 'withdrawn' | 'not_queued' | 'not_answered' | 'already'
async function retractAnswered(callId, { now = new Date() } = {}) {
  const call = await CallLog.findById(callId).select('status direction callbackTask callbackRetractedAt');
  if (!call?.callbackTask || call.direction !== 'inbound') return 'not_queued';
  if (call.status !== 'completed') return 'not_answered';

  const marked = await CallbackTask.findOneAndUpdate(
    { _id: call.callbackTask, calls: { $elemMatch: { call: call._id, answeredLater: { $ne: true } } } },
    {
      $set : { 'calls.$.answeredLater': true, 'calls.$.answeredLaterAt': now },
      $inc : { missedCount: -1, rev: 1 },
      $push: { events: { type: 'call_answered_later', at: now, detail: { call: call._id } } },
    },
    { new: true },
  );
  let result = marked ? 'marked' : 'already';

  // Missed-call times from the calls still missed (rev-guarded, so a miss
  // added at the same moment is not overwritten).
  for (let attempt = 0; marked && attempt < 4; attempt += 1) {
    const task = await CallbackTask.findById(call.callbackTask).select('state rev calls');
    const genuine = (task.calls || []).filter((c) => !c.answeredLater);
    let update;
    if (!genuine.length) {
      if (task.state !== 'open') break; // a person's resolution stands
      update = { $set: { state: 'withdrawn', withdrawn: { at: now, reason: 'call_answered' } }, $inc: { rev: 1 } };
    } else {
      const times = genuine.map((c) => new Date(c.at).getTime());
      update = { $set: { firstMissedAt: new Date(Math.min(...times)), lastMissedAt: new Date(Math.max(...times)) } };
    }
    const r = await CallbackTask.updateOne({ _id: task._id, rev: task.rev }, update);
    if (r.matchedCount) { if (!genuine.length) result = 'withdrawn'; break; }
  }
  await CallLog.updateOne({ _id: call._id, callbackRetractedAt: null }, { $set: { callbackRetractedAt: now } });
  return result;
}

// Queues every settled, eligible missed call not yet in a task, and
// retracts queued calls since reported answered. Each pass is bounded
// (SWEEP_BATCH calls of each kind, LOOKBACK_MS back); the rest follow on
// the next pass.
async function sweep({ now = new Date() } = {}) {
  if (!(await indexReady())) return { blocked: true, error: indexError() };
  const settled = new Date(now.getTime() - settleSeconds() * 1000);
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const [toQueue, toRetract] = await Promise.all([
    CallLog.find({
      callbackEligible: true,
      callbackTask    : null,
      direction       : 'inbound',
      status          : { $in: FINAL_MISSED },
      startedAt       : { $gte: since },
      $or: [
        { endedAt: { $ne: null, $lte: settled } },
        { endedAt: null, startedAt: { $lte: new Date(now.getTime() - NO_END_GRACE_MS) } },
      ],
    }).select('_id').sort({ startedAt: 1 }).limit(SWEEP_BATCH).lean(),
    CallLog.find({
      callbackEligible   : true,
      status             : 'completed',
      startedAt          : { $gte: since },
      callbackTask       : { $ne: null },
      callbackRetractedAt: null,
    }).select('_id').sort({ startedAt: 1 }).limit(SWEEP_BATCH).lean(),
  ]);

  const out = { queued: 0, skipped: 0, retracted: 0, failed: 0 };
  for (const c of toQueue) {
    try {
      const r = await queueCall(c._id, { now });
      if (r.skipped) out.skipped += 1; else out.queued += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[callbacks] could not queue call ${c._id}:`, err?.message || err);
    }
  }
  for (const c of toRetract) {
    try {
      if (['marked', 'withdrawn'].includes(await retractAnswered(c._id, { now }))) out.retracted += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[callbacks] could not retract answered call ${c._id}:`, err?.message || err);
    }
  }
  if (out.queued || out.retracted || out.failed) console.info(`[callbacks] sweep queued=${out.queued} retracted=${out.retracted} skipped=${out.skipped} failed=${out.failed}`);
  return out;
}

// At most one sweep per SWEEP_EVERY_MS per process; concurrent callers
// share the one in flight. Never throws — the read that triggered it goes on.
let lastSweepAt = 0;
let inFlight = null;
function sweepSoon({ now = Date.now() } = {}) {
  if (inFlight) return inFlight;
  if (now - lastSweepAt < SWEEP_EVERY_MS) return Promise.resolve(null);
  lastSweepAt = now;
  inFlight = sweep().catch((err) => {
    console.error('[callbacks] sweep failed:', err?.message || err);
    return null;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
const _resetSweepThrottle = () => { lastSweepAt = 0; inFlight = null; };

module.exports = {
  FINAL_MISSED, SWEEP_BATCH, LOOKBACK_MS, queueableReason, queueCall, retractAnswered, sweep, sweepSoon,
  indexReady, indexError, _resetSweepThrottle, _resetIndexCheck,
};
