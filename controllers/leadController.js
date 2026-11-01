/**
 * controllers/leadController.js
 * ============================================================
 * Leads Dashboard (/api/leads): the lead list plus follow-up work on a lead.
 *
 *   GET   /                     ?status=&view=unassigned|due_today|overdue|mine&assignedTo=
 *   GET   /summary              counts for the dashboard and the nav badge
 *   GET   /assignees            who a lead can be assigned to
 *   PATCH /:id/assign           { userId | null, rev }
 *   PATCH /:id/follow-up        { at | null, rev }  (India time if no zone)
 *   PATCH /:id/status           { status, reason?, rev }  (reason required for lost)
 *   POST  /:id/notes            { text }
 *
 * Assignment, follow-up and status changes apply only at the `rev` the
 * operator was looking at: of two people acting on one lead at once, one
 * succeeds and the other gets a 409 with the current lead — never a silent
 * overwrite. Each is recorded in the lead's history with who and when.
 * Notes are append-only and need no rev.
 *
 * Follow-ups are CRM reminders only: nothing here calls or messages anyone.
 * Missed-call callbacks (/api/callbacks) stay separate; a lead only shows
 * an open callback that is already linked to it by the call log.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Lead, User } = require('../models');
const CallbackTask = require('../models/CallbackTask');
const { OPERATIONS } = require('../middleware/auth');
const { parseScheduleDate } = require('../utils/dispatchUrgency');
const { ACTIVE_STATUSES, isActive, followUpStateOf, viewFilter, VIEWS } = require('../utils/leadFollowUp');

const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const LEAD_STATUSES = Lead.schema.path('status').enumValues;
const NOTE_MAX = 1000;
const REASON_MAX = 500;
const FOLLOW_UP_MAX_DAYS = 180;
const LIST_MAX = 500;

// Leads written before rev existed have none: they count as rev 0.
const revFilter = (rev) => (rev === 0 ? { rev: { $in: [0, null] } } : { rev });

// Adds what the desk needs: the follow-up state now, the assignee's name
// (older assignments stored only the id) and an open missed-call callback
// already linked to this lead.
async function decorate(leads, { now = Date.now() } = {}) {
  if (!leads.length) return [];
  const missingNames = [...new Set(leads.filter((l) => l.assignedTo && !l.assignedToName).map((l) => String(l.assignedTo)))];
  const [users, callbacks] = await Promise.all([
    missingNames.length ? User.find({ _id: { $in: missingNames } }).select('name').lean() : [],
    CallbackTask.find({ state: 'open', lead: { $in: leads.map((l) => l._id) } }).select('lead').lean(),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const callbackFor = new Map(callbacks.map((c) => [String(c.lead), c._id]));
  return leads.map((l) => {
    const json = typeof l.toJSON === 'function' ? l.toJSON() : { ...l };
    if (json.assignedTo && !json.assignedToName) json.assignedToName = names.get(String(json.assignedTo)) || null;
    json.followUp = followUpStateOf(l, now);
    json.openCallback = callbackFor.get(String(l._id)) || null;
    return json;
  });
}

async function countsFor(userId, now = Date.now()) {
  const [unassigned, dueToday, overdue, mine] = await Promise.all(
    ['unassigned', 'due_today', 'overdue', 'mine'].map((v) => Lead.countDocuments(viewFilter(v, { now, userId }))),
  );
  return { unassigned, dueToday, overdue, mine };
}

// ============================================================
// @route   GET /api/leads
// @desc    ?status=new|contacted|converted|lost|spam (or all / none: every
//          lead, as before). ?view= narrows to active leads that are
//          unassigned, due later today, overdue, or assigned to me.
// ============================================================
exports.list = async (req, res, next) => {
  try {
    const filter = {};
    const { status, view, assignedTo } = req.query;
    if (status !== undefined && status !== '' && status !== 'all') {
      if (typeof status !== 'string' || !LEAD_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Unknown lead status "${status}".` });
      }
      filter.status = status;
    }
    let sort = { createdAt: -1 };
    if (view !== undefined && view !== '' && view !== 'all') {
      if (typeof view !== 'string' || !VIEWS.includes(view)) {
        return res.status(400).json({ success: false, message: 'Unknown lead view.' });
      }
      const v = viewFilter(view, { userId: req.user?._id });
      // A status that the view excludes (e.g. lost + overdue) finds nothing.
      if (filter.status && !ACTIVE_STATUSES.includes(filter.status)) return res.json({ success: true, leads: [] });
      Object.assign(filter, v, filter.status ? { status: filter.status } : {});
      if (view === 'due_today' || view === 'overdue') sort = { nextFollowUpAt: 1 };
    }
    if (assignedTo !== undefined && assignedTo !== '') {
      if (!isObjectId(assignedTo)) return res.status(400).json({ success: false, message: 'Unknown staff member.' });
      if (view === 'unassigned') return res.json({ success: true, leads: [] });
      filter.assignedTo = assignedTo;
    }
    // The plain status tabs return every lead, as they always have.
    let query = Lead.find(filter).sort(sort);
    if (view || assignedTo) query = query.limit(LIST_MAX);
    const leads = await query;
    return res.json({ success: true, leads: await decorate(leads) });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/leads/summary
// ============================================================
exports.summary = async (req, res, next) => {
  try {
    return res.json({ success: true, counts: await countsFor(req.user._id) });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/leads/assignees — active operations staff, names only
// ============================================================
exports.assignees = async (req, res, next) => {
  try {
    const users = await User.find({ role: { $in: OPERATIONS }, isActive: true }).select('name role').sort({ name: 1 }).lean();
    return res.json({ success: true, users: users.map((u) => ({ _id: u._id, name: u.name, role: u.role })) });
  } catch (err) {
    next(err);
  }
};

const lastChanger = (lead) => [...(lead.history || [])].reverse().find((e) => e.byName)?.byName;

// One guarded change. `build(lead)` validates against the lead as the
// operator saw it and returns { update, event } or { status, message }.
async function change(req, res, next, build) {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const rev = Number(req.body?.rev);
    if (!Number.isInteger(rev) || rev < 0) return res.status(400).json({ success: false, message: 'Reload the Leads Dashboard and try again.' });

    const conflict = async (lead) => {
      const [fresh] = await decorate([lead]);
      return res.status(409).json({
        success: false,
        message: `${lastChanger(lead) || 'Someone'} changed this lead just now — check it, then try again.`,
        lead: fresh,
      });
    };

    const current = await Lead.findById(id);
    if (!current) return res.status(404).json({ success: false, message: 'Lead not found.' });
    if ((current.rev || 0) !== rev) return conflict(current);

    const built = await build(current);
    if (built.status) return res.status(built.status).json({ success: false, message: built.message });

    const updated = await Lead.findOneAndUpdate(
      { _id: id, ...revFilter(rev) },
      {
        ...built.update,
        $inc : { rev: 1 },
        $push: { history: { ...built.event, at: new Date(), by: req.user._id, byName: req.user.name } },
      },
      { new: true },
    );
    if (!updated) {
      const latest = await Lead.findById(id);
      return latest ? conflict(latest) : res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const [lead] = await decorate([updated]);
    return res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// @route   PATCH /api/leads/:id/assign  { userId | null, rev }
// ============================================================
exports.assign = (req, res, next) => change(req, res, next, async (lead) => {
  const { userId } = req.body || {};
  const fromName = lead.assignedToName || (lead.assignedTo ? (await User.findById(lead.assignedTo).select('name').lean())?.name : null) || null;
  if (userId === null || userId === '') {
    if (!lead.assignedTo) return { status: 400, message: 'This lead is not assigned to anyone.' };
    return {
      update: { $unset: { assignedTo: 1, assignedToName: 1 } },
      event : { type: 'unassigned', detail: { from: fromName } },
    };
  }
  if (!isObjectId(String(userId))) return { status: 400, message: 'Pick a staff member.' };
  const user = await User.findOne({ _id: String(userId), role: { $in: OPERATIONS }, isActive: true }).select('name').lean();
  if (!user) return { status: 400, message: 'That person cannot take leads (not an active CRM staff member).' };
  if (String(lead.assignedTo || '') === String(user._id)) return { status: 400, message: `Already assigned to ${user.name}.` };
  return {
    update: { $set: { assignedTo: user._id, assignedToName: user.name } },
    event : { type: 'assigned', detail: { from: fromName, to: user.name, toUser: user._id } },
  };
});

// ============================================================
// @route   PATCH /api/leads/:id/follow-up  { at | null, rev }
// @desc    `at` without a time zone ("2026-11-02T10:30") is India time.
// ============================================================
exports.followUp = (req, res, next) => change(req, res, next, async (lead) => {
  const raw = req.body?.at;
  if (raw === null || raw === '') {
    if (!lead.nextFollowUpAt) return { status: 400, message: 'No follow-up is set.' };
    return {
      update: { $unset: { nextFollowUpAt: 1 } },
      event : { type: 'follow_up_cleared', detail: { from: lead.nextFollowUpAt } },
    };
  }
  if (lead.convertedTrip) return { status: 400, message: 'This lead was booked as a trip — it needs no follow-up.' };
  if (!isActive(lead.status)) return { status: 400, message: `This lead is ${lead.status} — reopen it before setting a follow-up.` };
  const at = typeof raw === 'string' ? parseScheduleDate(raw) : undefined;
  if (!at) return { status: 400, message: 'Give a valid follow-up date and time.' };
  const now = Date.now();
  if (at.getTime() < now - 60 * 1000) return { status: 400, message: 'Pick a follow-up time in the future.' };
  if (at.getTime() > now + FOLLOW_UP_MAX_DAYS * 24 * 3600 * 1000) return { status: 400, message: `Pick a time within ${FOLLOW_UP_MAX_DAYS} days.` };
  return {
    update: { $set: { nextFollowUpAt: at } },
    event : { type: 'follow_up_set', detail: { at, from: lead.nextFollowUpAt || null } },
  };
});

// ============================================================
// @route   PATCH /api/leads/:id/status  { status, reason?, rev }
// @desc    Any status can be chosen, as before, with two rules: Lost needs
//          a reason, and a lead booked as a trip stays converted. Leaving
//          new/contacted clears the follow-up time (kept in history), so
//          converted and lost leads never remind anyone.
// ============================================================
exports.setStatus = (req, res, next) => change(req, res, next, async (lead) => {
  const status = req.body?.status;
  if (typeof status !== 'string' || !LEAD_STATUSES.includes(status)) return { status: 400, message: 'Pick a valid status.' };
  const from = lead.status || 'new';
  if (lead.convertedTrip && status !== 'converted') {
    return { status: 400, message: 'This lead was booked as a trip — it stays converted.' };
  }
  if (status === from) return { status: 400, message: `This lead is already ${status}.` };
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length > REASON_MAX) return { status: 400, message: `Keep the reason under ${REASON_MAX} characters.` };
  if (status === 'lost' && !reason) return { status: 400, message: 'Give a reason for marking this lead lost.' };

  const $set = { status };
  const $unset = {};
  if (status === 'lost') $set.lostReason = reason;
  else if (lead.lostReason) $unset.lostReason = 1;
  const clearsFollowUp = !isActive(status) && lead.nextFollowUpAt;
  if (clearsFollowUp) $unset.nextFollowUpAt = 1;
  return {
    update: { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
    event : {
      type: 'status',
      detail: {
        from, to: status,
        ...(status === 'lost' ? { reason } : {}),
        ...(clearsFollowUp ? { followUpCleared: lead.nextFollowUpAt } : {}),
      },
    },
  };
});

// ============================================================
// @route   POST /api/leads/:id/notes  { text }
// ============================================================
exports.addNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ success: false, message: 'Write a note first.' });
    if (text.length > NOTE_MAX) return res.status(400).json({ success: false, message: `Keep the note under ${NOTE_MAX} characters.` });
    const updated = await Lead.findByIdAndUpdate(
      id,
      { $push: { followUpNotes: { text, at: new Date(), by: req.user._id, byName: req.user.name } } },
      { new: true },
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const [lead] = await decorate([updated]);
    return res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/leads/:id
// @desc    Retired: it wrote whatever the request body held (any field,
//          no history, no conflict check). The dashboard now uses the
//          routes above; an out-of-date CRM tab is told to reload.
// ============================================================
exports.legacyUpdate = (req, res) => res.status(410).json({
  success: false,
  message: 'This screen is out of date — reload the CRM to update leads.',
});
