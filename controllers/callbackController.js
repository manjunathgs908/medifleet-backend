/**
 * controllers/callbackController.js
 * ============================================================
 * Missed-call callback queue — mounted at /api/callbacks, CRM operations
 * staff only (owner, telecaller). See services/callbackQueue.js for which
 * calls become tasks.
 *
 *   GET  /                      open (or ?state=resolved) tasks, with each
 *                               task's missed calls, callback attempts,
 *                               later connected calls and due time
 *   GET  /summary               { open, overdue } for the nav badge
 *   GET  /assignees             who a task can be assigned to
 *   PATCH /:id/assign           { userId | null, rev }
 *   PATCH /:id/schedule         { at | null, rev }  (India time if no zone)
 *   POST /:id/resolve           { outcome, note, rev }
 *   GET  /not-routed            "Not routed by CRM" calls awaiting a decision
 *   POST /not-routed/:callId/queue    add one to the queue
 *   POST /not-routed/:callId/dismiss  { note } — not a customer to call back
 *
 * Every change is conditional on the task still being open at the `rev`
 * the operator was looking at: two people acting on one task at once get
 * one success and one 409 with the current task — never a silent
 * overwrite. Who and when goes into the task's events.
 *
 * Nothing here places a call or sends a message: callbacks go through POST
 * /api/calls/click-to-call { callbackTaskId }, which never resolves a task.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { User } = require('../models');
const CallLog = require('../models/CallLog');
const CallbackTask = require('../models/CallbackTask');
const { OUTCOMES, NOTE_REQUIRED } = require('../models/CallbackTask');
const { OPERATIONS } = require('../middleware/auth');
const { dueStateOf, dueMinutes } = require('../utils/callbackDue');
const { parseScheduleDate } = require('../utils/dispatchUrgency');
const { normalisePhone } = require('../utils/phone');
const queue = require('../services/callbackQueue');

const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const NOTE_MAX = 500;
const SCHEDULE_MAX_DAYS = 30;
const NOT_ROUTED_DAYS = 7;

// Plain, number-free summary of one of our calls.
const callSummary = (c) => ({
  _id: c._id,
  direction: c.direction,
  context: c.context,
  status: c.status,
  startedAt: c.startedAt,
  answeredAt: c.answeredAt,
  endedAt: c.endedAt,
  talkSec: c.talkSec,
  agentName: c.agentName,
  error: c.error,
});

// Adds what a person needs to act: due time, the missed calls' CURRENT
// status, callback attempts, and connected calls with this number since
// the first miss (evidence only — the task stays open until resolved).
async function decorate(tasks, { now = Date.now() } = {}) {
  if (!tasks.length) return [];
  const ids = tasks.map((t) => t._id);
  const phones = [...new Set(tasks.map((t) => normalisePhone(t.customerPhone)).filter(Boolean))];
  const since = new Date(Math.min(...tasks.map((t) => new Date(t.firstMissedAt || t.createdAt).getTime())));
  const missedIds = tasks.flatMap((t) => (t.calls || []).map((c) => c.call));

  const [attempts, connected, missedNow] = await Promise.all([
    CallLog.find({ callbackTask: { $in: ids }, direction: 'outbound' })
      .select('callbackTask direction context status startedAt answeredAt endedAt talkSec agentName error')
      .sort({ startedAt: 1 }).lean(),
    phones.length
      ? CallLog.find({ customerPhone: { $in: phones }, status: 'completed', startedAt: { $gte: since } })
        .select('+customerPhone direction context status startedAt answeredAt endedAt talkSec agentName callbackTask')
        .sort({ startedAt: 1 }).lean()
      : [],
    CallLog.find({ _id: { $in: missedIds } }).select('status').lean(),
  ]);
  const statusNow = new Map(missedNow.map((c) => [String(c._id), c.status]));

  return tasks.map((t) => {
    const json = t.toJSON();
    const phone = normalisePhone(t.customerPhone);
    const first = new Date(t.firstMissedAt || t.createdAt).getTime();
    json.calls = (json.calls || []).map((c) => ({ ...c, statusNow: statusNow.get(String(c.call)) || c.status }));
    json.attempts = attempts.filter((a) => String(a.callbackTask) === String(t._id)).map(callSummary);
    // (A call on this task that was answered after all is in json.calls,
    // marked answeredLater — not repeated here as a separate connection.)
    const own = new Set((t.calls || []).map((c) => String(c.call)));
    json.connectedAfter = connected
      .filter((c) => normalisePhone(c.customerPhone) === phone && new Date(c.startedAt).getTime() >= first && !own.has(String(c._id)))
      .map((c) => ({ ...callSummary(c), wasAttempt: String(c.callbackTask || '') === String(t._id) }));
    json.due = dueStateOf(t, { now });
    return json;
  });
}

const summaryOf = (tasks, now = Date.now()) => ({
  open: tasks.length,
  overdue: tasks.filter((t) => dueStateOf(t, { now })?.overdue).length,
});

// ============================================================
// @route   GET /api/callbacks?state=open|resolved
// @desc    resolved also lists withdrawn tasks (every call on them turned
//          out to be answered).
// ============================================================

// Without the one-open-task index confirmed nothing is queued; say so
// instead of showing a queue that silently stopped filling.
const UNAVAILABLE = 'The callback queue is unavailable: its database index could not be confirmed. Missed calls are kept in Call Logs and will be queued once this is fixed.';
async function ready(res) {
  if (await queue.indexReady()) return true;
  res.status(503).json({ success: false, message: UNAVAILABLE });
  return false;
}

exports.list = async (req, res, next) => {
  try {
    if (!(await ready(res))) return undefined;
    await queue.sweepSoon();
    const resolved = req.query.state === 'resolved';
    const tasks = await CallbackTask.find({ state: resolved ? { $in: ['resolved', 'withdrawn'] } : 'open' })
      .select('+customerPhone')
      .sort(resolved ? { updatedAt: -1 } : { lastMissedAt: -1 })
      .limit(resolved ? 50 : 300)
      .populate('trip', 'tripNumber patientName')
      .populate('lead', 'patientName');
    const open = resolved
      ? await CallbackTask.find({ state: 'open' }).select('state firstMissedAt lastMissedAt lastQueuedAt nextCallbackAt scheduledAt').lean()
      : tasks;
    return res.json({
      success: true,
      config: { dueMinutes: dueMinutes() },
      counts: summaryOf(open),
      tasks: await decorate(tasks),
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/callbacks/summary — the nav badge
// ============================================================
exports.summary = async (req, res, next) => {
  try {
    if (!(await ready(res))) return undefined;
    await queue.sweepSoon();
    const open = await CallbackTask.find({ state: 'open' }).select('state firstMissedAt lastMissedAt lastQueuedAt nextCallbackAt scheduledAt').lean();
    return res.json({ success: true, ...summaryOf(open), dueMinutes: dueMinutes() });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/callbacks/assignees — operations staff, names only
// ============================================================
exports.assignees = async (req, res, next) => {
  try {
    const users = await User.find({ role: { $in: OPERATIONS }, isActive: true }).select('name role').sort({ name: 1 }).lean();
    return res.json({ success: true, users: users.map((u) => ({ _id: u._id, name: u.name, role: u.role })) });
  } catch (err) {
    next(err);
  }
};

// One guarded change to an open task. `build(task)` validates against the
// task as the operator saw it and returns { update, event } or { status,
// message }. Applied only if the task is still open at that rev.
async function change(req, res, next, build) {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(404).json({ success: false, message: 'Callback not found.' });
    const rev = Number(req.body?.rev);
    if (!Number.isInteger(rev)) return res.status(400).json({ success: false, message: 'Reload the callback queue and try again.' });

    const current = await CallbackTask.findById(id).select('+customerPhone');
    if (!current) return res.status(404).json({ success: false, message: 'Callback not found.' });

    const conflict = async (task) => {
      const [fresh] = await decorate([task]);
      const last = [...(task.events || [])].reverse().find((e) => e.byName) || null;
      const sys = [...(task.events || [])].reverse().find((e) => ['missed_again', 'added_manually', 'call_answered_later'].includes(e.type));
      let message;
      if (task.state === 'resolved') message = `Already resolved by ${task.resolution?.byName || 'someone else'}.`;
      else if (task.state === 'withdrawn') message = 'This call was answered after all — there is nothing to call back.';
      else if (sys?.type === 'call_answered_later' && (!last || sys.at > last.at)) message = 'One of these calls was reported answered just now — check it, then try again.';
      else if (sys && (!last || sys.at > last.at)) message = 'This customer called again and was missed just now — check the latest call, then try again.';
      else message = `${last?.byName || 'Someone'} changed this callback just now — check it, then try again.`;
      return res.status(409).json({ success: false, message, task: fresh });
    };
    if (current.state !== 'open' || current.rev !== rev) return conflict(current);

    const built = await build(current);
    if (built.status) return res.status(built.status).json({ success: false, message: built.message });

    const at = new Date();
    const updated = await CallbackTask.findOneAndUpdate(
      { _id: id, state: 'open', rev },
      {
        ...built.update,
        $inc : { rev: 1 },
        $push: { events: { ...built.event, at, by: req.user._id, byName: req.user.name } },
      },
      { new: true },
    ).select('+customerPhone').populate('trip', 'tripNumber patientName').populate('lead', 'patientName');
    if (!updated) {
      const latest = await CallbackTask.findById(id).select('+customerPhone');
      return latest ? conflict(latest) : res.status(404).json({ success: false, message: 'Callback not found.' });
    }
    const [task] = await decorate([updated]);
    return res.json({ success: true, task });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// @route   PATCH /api/callbacks/:id/assign  { userId | null, rev }
// ============================================================
exports.assign = (req, res, next) => change(req, res, next, async (task) => {
  const { userId } = req.body || {};
  if (userId === null || userId === '') {
    if (!task.assignedTo) return { status: 400, message: 'This callback is not assigned to anyone.' };
    return {
      update: { $unset: { assignedTo: 1, assignedToName: 1 } },
      event : { type: 'unassigned', detail: { from: task.assignedToName || null } },
    };
  }
  if (!isObjectId(String(userId))) return { status: 400, message: 'Pick a staff member.' };
  const user = await User.findOne({ _id: userId, role: { $in: OPERATIONS }, isActive: true }).select('name').lean();
  if (!user) return { status: 400, message: 'That person cannot take callbacks.' };
  if (String(task.assignedTo || '') === String(user._id)) return { status: 400, message: `Already assigned to ${user.name}.` };
  return {
    update: { $set: { assignedTo: user._id, assignedToName: user.name } },
    event : { type: 'assigned', detail: { from: task.assignedToName || null, to: user.name, toUser: user._id } },
  };
});

// ============================================================
// @route   PATCH /api/callbacks/:id/schedule  { at | null, rev }
// ============================================================
exports.schedule = (req, res, next) => change(req, res, next, async (task) => {
  const raw = req.body?.at;
  if (raw === null || raw === '') {
    if (!task.nextCallbackAt) return { status: 400, message: 'No callback time is set.' };
    return {
      update: { $unset: { nextCallbackAt: 1, scheduledAt: 1 } },
      event : { type: 'schedule_cleared', detail: { from: task.nextCallbackAt } },
    };
  }
  const at = parseScheduleDate(raw);
  if (!at) return { status: 400, message: 'Give a valid callback time.' };
  const now = Date.now();
  if (at.getTime() < now - 60 * 1000) return { status: 400, message: 'Pick a callback time in the future.' };
  if (at.getTime() > now + SCHEDULE_MAX_DAYS * 24 * 3600 * 1000) return { status: 400, message: `Pick a time within ${SCHEDULE_MAX_DAYS} days.` };
  return {
    update: { $set: { nextCallbackAt: at, scheduledAt: new Date(now) } },
    event : { type: 'scheduled', detail: { at, from: task.nextCallbackAt || null } },
  };
});

// ============================================================
// @route   POST /api/callbacks/:id/resolve  { outcome, note, rev }
// ============================================================
exports.resolve = (req, res, next) => change(req, res, next, async () => {
  const outcome = String(req.body?.outcome || '');
  if (!OUTCOMES[outcome]) return { status: 400, message: 'Pick what happened.' };
  const note = String(req.body?.note || '').trim();
  if (note.length > NOTE_MAX) return { status: 400, message: `Keep the note under ${NOTE_MAX} characters.` };
  if (NOTE_REQUIRED.includes(outcome) && !note) return { status: 400, message: `Add a short reason for "${OUTCOMES[outcome]}".` };
  const at = new Date();
  return {
    update: { $set: { state: 'resolved', resolution: { outcome, note: note || undefined, at, by: req.user._id, byName: req.user.name } } },
    event : { type: 'resolved', detail: { outcome, note: note || undefined } },
  };
});

// ============================================================
// @route   GET /api/callbacks/not-routed
// @desc    Incoming calls Plivo reported only at hang-up: /incoming never
//          ran, so no staff were rung. Kept apart from the queue; a person
//          adds or dismisses each. Only calls marked when logged (never
//          older ones).
// ============================================================
exports.notRouted = async (req, res, next) => {
  try {
    const calls = await CallLog.find({
      direction: 'inbound',
      status: 'not_routed',
      'callbackReview.state': 'pending',
      startedAt: { $gte: new Date(Date.now() - NOT_ROUTED_DAYS * 24 * 3600 * 1000) },
    }).select('+customerPhone').sort({ startedAt: -1 }).limit(50)
      .populate('trip', 'tripNumber patientName').populate('lead', 'patientName');
    return res.json({ success: true, days: NOT_ROUTED_DAYS, calls });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/callbacks/not-routed/:callId/queue
// ============================================================
exports.queueNotRouted = async (req, res, next) => {
  try {
    if (!(await ready(res))) return undefined;
    const { callId } = req.params;
    if (!isObjectId(callId)) return res.status(404).json({ success: false, message: 'Call not found.' });
    const call = await CallLog.findById(callId).select('status direction callbackReview callbackTask');
    if (!call || call.direction !== 'inbound' || call.status !== 'not_routed') return res.status(404).json({ success: false, message: 'Call not found.' });
    if (call.callbackReview?.state === 'dismissed') {
      return res.status(409).json({ success: false, message: `Already dismissed by ${call.callbackReview.byName || 'someone else'}.` });
    }
    const r = await queue.queueCall(callId, { manual: { _id: req.user._id, name: req.user.name } });
    if (r.skipped) return res.status(400).json({ success: false, message: 'This call has no mobile number to call back.' });
    const task = await CallbackTask.findById(r.task._id).select('+customerPhone').populate('trip', 'tripNumber patientName').populate('lead', 'patientName');
    const [decorated] = await decorate([task]);
    return res.json({ success: true, result: r.result, task: decorated });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/callbacks/not-routed/:callId/dismiss  { note }
// ============================================================
exports.dismissNotRouted = async (req, res, next) => {
  try {
    const { callId } = req.params;
    if (!isObjectId(callId)) return res.status(404).json({ success: false, message: 'Call not found.' });
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ success: false, message: 'Add a short reason for dismissing it.' });
    if (note.length > NOTE_MAX) return res.status(400).json({ success: false, message: `Keep the note under ${NOTE_MAX} characters.` });
    const r = await CallLog.updateOne(
      { _id: callId, direction: 'inbound', status: 'not_routed', 'callbackReview.state': 'pending' },
      { $set: { callbackReview: { state: 'dismissed', note, by: req.user._id, byName: req.user.name, at: new Date() } } },
    );
    if (!r?.matchedCount) return res.status(409).json({ success: false, message: 'Someone already handled this call — reload the list.' });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports._decorate = decorate;
