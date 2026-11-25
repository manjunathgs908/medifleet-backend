/**
 * controllers/callbackController.js
 * ============================================================
 * Missed-call callback queue — mounted at /api/callbacks, CRM operations
 * staff only (owner, telecaller). See services/callbackQueue.js for which
 * calls become tasks.
 *
 *   GET  /                      open (or ?state=resolved) tasks, with each
 *                               task's missed calls, callback attempts,
 *                               later connected calls and due time. Open
 *                               tasks come most urgent first (due time);
 *                               ?page=&limit=&assignee=all|me|unassigned|<id>
 *                               &due=all|overdue|today|due pages through the
 *                               whole queue with accurate totals
 *   GET  /summary               { open, overdue } for the nav badge, plus
 *                               personal / unassigned counts
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
const { istDayBounds } = require('../utils/leadFollowUp');
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
      // (A transfer nobody took is not "got through".)
      ? CallLog.find({ customerPhone: { $in: phones }, status: 'completed', transferUnanswered: null, startedAt: { $gte: since } })
        .select('+customerPhone direction context status startedAt answeredAt endedAt talkSec agentName callbackTask')
        .sort({ startedAt: 1 }).lean()
      : [],
    CallLog.find({ _id: { $in: missedIds } }).select('status transferUnanswered').lean(),
  ]);
  const statusNow = new Map(missedNow.map((c) => [String(c._id), c.transferUnanswered ? queue.TRANSFER_UNANSWERED : c.status]));

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

// ── Open-queue ordering, filters and totals ──────────────────────
// Every open task's timing fields are small, so the whole open queue is
// read once and ordered by the canonical due rule (utils/callbackDue
// dueStateOf — the same rule the badge and each task's `due` use). The full
// records are then loaded only for the rows returned. Most urgent first:
// due time ascending, _id as the tie-break, so pages never shift or repeat.
const SLIM = 'state firstMissedAt lastMissedAt lastQueuedAt nextCallbackAt scheduledAt assignedTo';
const LEGACY_OPEN_MAX = 300;
const PAGE_MAX = 100;
const ASSIGNEE = ['all', 'me', 'unassigned'];
const DUE = ['all', 'overdue', 'today', 'due']; // due = overdue or later today (India day)

async function openQueue(now = Date.now()) {
  const slim = await CallbackTask.find({ state: 'open' }).select(SLIM).lean();
  const end = istDayBounds(now).end.getTime();
  return slim.map((t) => {
    const due = dueStateOf(t, { now });
    const dueAt = due ? due.dueAt.getTime() : Number.POSITIVE_INFINITY;
    return { _id: t._id, assignedTo: t.assignedTo ? String(t.assignedTo) : null, dueAt, overdue: !!due?.overdue, today: !due?.overdue && dueAt < end };
  }).sort((a, b) => (a.dueAt - b.dueAt) || String(a._id).localeCompare(String(b._id)));
}

// Accurate totals for the whole open queue, whatever page is loaded.
// mine* = assigned to this user; unassigned* = nobody's yet (kept apart
// from personal work).
function totalsOf(rows, userId) {
  const me = userId ? String(userId) : null;
  const t = { open: rows.length, overdue: 0, dueToday: 0, mine: 0, mineOverdue: 0, mineDueToday: 0, unassigned: 0, unassignedOverdue: 0, unassignedDueToday: 0 };
  for (const r of rows) {
    if (r.overdue) t.overdue += 1;
    if (r.today) t.dueToday += 1;
    if (me && r.assignedTo === me) { t.mine += 1; if (r.overdue) t.mineOverdue += 1; if (r.today) t.mineDueToday += 1; }
    if (!r.assignedTo) { t.unassigned += 1; if (r.overdue) t.unassignedOverdue += 1; if (r.today) t.unassignedDueToday += 1; }
  }
  return t;
}

// Full records for these ids, in this order.
async function loadInOrder(ids) {
  if (!ids.length) return [];
  const docs = await CallbackTask.find({ _id: { $in: ids } })
    .select('+customerPhone')
    .populate('trip', 'tripNumber patientName')
    .populate('lead', 'patientName');
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

// Paged mode is used when any of these is given; otherwise the list keeps
// its original shape (the desktop Callbacks page).
const PAGED_KEYS = ['page', 'limit', 'assignee', 'due'];
function pagedParams(q) {
  const assignee = q.assignee === undefined || q.assignee === '' ? 'all' : q.assignee;
  if (typeof assignee !== 'string' || (!ASSIGNEE.includes(assignee) && !isObjectId(assignee))) return { error: 'Unknown assignee filter.' };
  const due = q.due === undefined || q.due === '' ? 'all' : q.due;
  if (typeof due !== 'string' || !DUE.includes(due)) return { error: 'Unknown due filter.' };
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(q.limit, 10) || 25));
  return { assignee, due, page, limit };
}

exports.list = async (req, res, next) => {
  try {
    if (!(await ready(res))) return undefined;
    await queue.sweepSoon();
    const resolved = req.query.state === 'resolved';
    const paged = !resolved && PAGED_KEYS.some((k) => req.query[k] !== undefined);

    if (resolved) {
      const tasks = await CallbackTask.find({ state: { $in: ['resolved', 'withdrawn'] } })
        .select('+customerPhone')
        .sort({ updatedAt: -1 })
        .limit(50)
        .populate('trip', 'tripNumber patientName')
        .populate('lead', 'patientName');
      const open = await CallbackTask.find({ state: 'open' }).select('state firstMissedAt lastMissedAt lastQueuedAt nextCallbackAt scheduledAt').lean();
      return res.json({ success: true, config: { dueMinutes: dueMinutes() }, counts: summaryOf(open), tasks: await decorate(tasks) });
    }

    const now = Date.now();
    const rows = await openQueue(now);
    const totals = totalsOf(rows, req.user?._id);

    if (!paged) {
      // Original shape for the desktop page: the most URGENT open tasks
      // (it was the newest 300, which hid the oldest overdue ones), with
      // counts over the whole queue, not just the rows returned.
      const take = rows.slice(0, LEGACY_OPEN_MAX);
      return res.json({
        success: true,
        config: { dueMinutes: dueMinutes() },
        counts: { open: totals.open, overdue: totals.overdue },
        totals,
        truncated: Math.max(0, rows.length - take.length),
        tasks: await decorate(await loadInOrder(take.map((r) => r._id))),
      });
    }

    const p = pagedParams(req.query);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    const me = String(req.user?._id || '');
    // Filters BEFORE pagination, so a page and its total always agree.
    const matched = rows.filter((r) => {
      if (p.assignee === 'me' && r.assignedTo !== me) return false;
      if (p.assignee === 'unassigned' && r.assignedTo) return false;
      if (isObjectId(p.assignee) && r.assignedTo !== p.assignee) return false;
      if (p.due === 'overdue' && !r.overdue) return false;
      if (p.due === 'today' && !r.today) return false;
      if (p.due === 'due' && !r.overdue && !r.today) return false;
      return true;
    });
    const start = (p.page - 1) * p.limit;
    const slice = matched.slice(start, start + p.limit);
    return res.json({
      success: true,
      config: { dueMinutes: dueMinutes() },
      counts: { open: totals.open, overdue: totals.overdue },
      totals,
      filters: { assignee: p.assignee, due: p.due },
      page: { page: p.page, limit: p.limit, total: matched.length, pages: Math.max(1, Math.ceil(matched.length / p.limit)), hasMore: start + p.limit < matched.length },
      tasks: await decorate(await loadInOrder(slice.map((r) => r._id)), { now }),
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
    const rows = await openQueue();
    const t = totalsOf(rows, req.user?._id);
    // open/overdue exactly as before; the rest added for the personal
    // My Work badge — same due rule and India day as the list's filters.
    return res.json({
      success: true, open: t.open, overdue: t.overdue, dueMinutes: dueMinutes(),
      dueToday: t.dueToday, mine: t.mine, mineOverdue: t.mineOverdue, mineDueToday: t.mineDueToday,
      unassigned: t.unassigned, unassignedOverdue: t.unassignedOverdue, unassignedDueToday: t.unassignedDueToday,
    });
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
