/**
 * controllers/leadController.js
 * ============================================================
 * Leads Dashboard (/api/leads): the lead list plus follow-up work on a lead.
 *
 *   GET   /                     ?status=&view=unassigned|due_today|overdue|mine&assignedTo=
 *   GET   /summary              counts for the dashboard and the nav badge
 *   GET   /:id                  one lead (+ customerRef) — mobile lead details
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
const { Lead, User, Trip } = require('../models');
const CallbackTask = require('../models/CallbackTask');
const { OPERATIONS } = require('../middleware/auth');
const { parseScheduleDate } = require('../utils/dispatchUrgency');
const { ACTIVE_STATUSES, isActive, followUpStateOf, viewFilter, VIEWS } = require('../utils/leadFollowUp');
const { customerRef } = require('../utils/customerPhone');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const LeadClaim = require('../models/LeadClaim');

const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const LEAD_STATUSES = Lead.schema.path('status').enumValues;
const NOTE_MAX = 1000;
const REASON_MAX = 500;
const FOLLOW_UP_MAX_DAYS = 180;
const LIST_MAX = 500;
const PAGE_MAX = 100;

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
    // Opaque link to the customer overview (never the number).
    try { if (l.phone) json.customerRef = customerRef(l.phone); } catch { /* not a usable number */ }
    return json;
  });
}

async function countsFor(userId, now = Date.now()) {
  const v = (name) => viewFilter(name, { now, userId });
  const nobody = { $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] };
  const [unassigned, dueToday, overdue, mine, fresh, mineOverdue, mineDueToday, unassignedOverdue, unassignedDueToday] = await Promise.all([
    ...['unassigned', 'due_today', 'overdue', 'mine'].map((n) => Lead.countDocuments(v(n))),
    // Additive (mobile CRM home): leads in status "new" — the same set
    // GET /api/leads?status=new lists, so a count and its list always agree.
    Lead.countDocuments({ status: 'new' }),
    // Additive (personal My Work badge): the overdue / due_today views,
    // narrowed to this user, or to nobody — exactly what the list returns
    // for ?view=overdue&assignedTo=<me> (and the unassigned equivalent).
    Lead.countDocuments({ ...v('overdue'), assignedTo: userId }),
    Lead.countDocuments({ ...v('due_today'), assignedTo: userId }),
    Lead.countDocuments({ $and: [v('overdue'), nobody] }),
    Lead.countDocuments({ $and: [v('due_today'), nobody] }),
  ]);
  return { unassigned, dueToday, overdue, mine, new: fresh, mineOverdue, mineDueToday, unassignedOverdue, unassignedDueToday };
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
    // assignedTo=none (additive): leads nobody is assigned to, combinable
    // with a view (e.g. unassigned AND overdue, for My Work).
    if (assignedTo === 'none') {
      filter.$and = [...(filter.$and || []), { $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] }];
    } else if (assignedTo !== undefined && assignedTo !== '') {
      if (!isObjectId(assignedTo)) return res.status(400).json({ success: false, message: 'Unknown staff member.' });
      if (view === 'unassigned') return res.json({ success: true, leads: [] });
      filter.assignedTo = assignedTo;
    }
    // ?page=&limit= (additive): stable pages through every match, with the
    // total counted on the same filter. Without them the response is as
    // before (plain status tabs return every lead; views stop at 500).
    if (req.query.page !== undefined || req.query.limit !== undefined) {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
      const stable = { ...sort, _id: sort.nextFollowUpAt ? 1 : -1 };
      const [total, rows] = await Promise.all([
        Lead.countDocuments(filter),
        Lead.find(filter).sort(stable).skip((page - 1) * limit).limit(limit),
      ]);
      return res.json({
        success: true,
        leads: await decorate(rows),
        page: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total },
      });
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
// @route   GET /api/leads/:id
// @desc    One lead, decorated exactly like a list row (masked number:
//          full only for the owner, via the Lead toJSON), plus its
//          customerRef — the opaque token GET /api/whatsapp/customer/:ref
//          (customer history) and click-to-call accept. Same audience as
//          the list (owner + telecaller); the number itself is never added.
// ============================================================
exports.getOne = async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const [json] = await decorate([lead]);
    let ref = null;
    try { ref = lead.phone ? customerRef(lead.phone) : null; } catch { ref = null; }
    // Already booked: the booking it became, so the screen can open it
    // instead of offering another booking from this lead.
    let booking = null;
    if (lead.convertedTrip) {
      const t = await Trip.findById(lead.convertedTrip).select('tripNumber status createdAt').lean();
      booking = t ? { _id: t._id, tripNumber: t.tripNumber, status: t.status, createdAt: t.createdAt } : { _id: lead.convertedTrip };
    } else {
      // An older booking the lead never recorded (Trip.leadId = this lead,
      // convertedTrip unset): shown as a booking that needs review, so the
      // screen opens it instead of offering a second one. Read only — the
      // lead is not changed (services/leadBooking.js).
      const { count, trips } = await require('../services/leadBooking').tripsOfLead(lead._id); // eslint-disable-line global-require
      if (count) booking = { ...trips[0], needsReview: true, tripCount: count };
    }
    return res.json({ success: true, lead: { ...json, customerRef: ref, booking } });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/leads
// @body    { patientName, phone, message?, source?, assignToMe?, confirmDuplicate? }
// @desc    A lead added by hand (owner / telecaller). Same model, statuses
//          and masking as every other lead; records source, who added it
//          and when (history 'created' + createdBy).
//          Possible duplicates — any lead already on this number — are
//          returned (409 DUPLICATE, masked) instead of silently creating a
//          second record or merging; the operator can open the existing
//          lead, or resend with confirmDuplicate: true to add a new one.
//          No unique-phone rule: existing duplicates are left as they are.
//          A per-number claim in the same transaction means two people
//          saving the same number at once are serialised: the second sees
//          the first one's lead as a possible duplicate.
// ============================================================
const MANUAL_SOURCES = ['manual', 'walk_in', 'referral', 'inbound_call'];
const NAME_MAX = 100;
const MESSAGE_MAX = 1000;
exports.create = async (req, res, next) => {
  try {
    const b = req.body || {};
    const patientName = typeof b.patientName === 'string' ? b.patientName.trim().slice(0, NAME_MAX) : '';
    const phone = normalisePhone(typeof b.phone === 'string' ? b.phone : '');
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, MESSAGE_MAX) : '';
    const source = b.source === undefined || b.source === '' ? 'manual' : b.source;
    if (!patientName) return res.status(400).json({ success: false, code: 'NAME_REQUIRED', message: 'Enter the customer’s name.' });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, code: 'PHONE_INVALID', message: 'Enter a 10-digit Indian mobile number.' });
    if (typeof source !== 'string' || !MANUAL_SOURCES.includes(source)) return res.status(400).json({ success: false, code: 'SOURCE_INVALID', message: 'Unknown lead source.' });

    const now = new Date();
    const by = { by: req.user._id, byName: req.user.name };
    const doc = {
      source, phone, patientName, ...(message ? { message } : {}),
      status: 'new', receivedAt: now, rev: 0,
      createdBy: req.user._id, createdByName: req.user.name,
      ...(b.assignToMe ? { assignedTo: req.user._id, assignedToName: req.user.name } : {}),
      history: [
        { type: 'created', at: now, ...by, detail: { source } },
        ...(b.assignToMe ? [{ type: 'assigned', at: now, ...by, detail: { to: req.user.name } }] : []),
      ],
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let created = null;
      let duplicates = [];
      const session = await Lead.startSession();
      try {
        await session.withTransaction(async () => {
          created = null; duplicates = [];
          await LeadClaim.updateOne({ _id: `manual:${phone}` }, { $inc: { hits: 1 } }, { upsert: true, session });
          if (!b.confirmDuplicate) {
            duplicates = await Lead.find({ phone: phoneSuffixQuery(phone) }).sort({ createdAt: -1 }).limit(5).session(session);
            if (duplicates.length) return;
          }
          [created] = await Lead.create([doc], { session });
        });
      } catch (err) {
        if (err?.code !== 11000) throw err; // the claim's first insert raced: try again
        continue;
      } finally {
        await session.endSession();
      }
      if (duplicates.length) {
        return res.status(409).json({
          success: false, code: 'DUPLICATE',
          message: 'A lead with this number already exists. Open it, or add a new lead anyway.',
          duplicates: await decorate(duplicates),
        });
      }
      console.info(`[leads] created by hand lead=${created._id} source=${source} by=${req.user._id}`);
      const [json] = await decorate([created]);
      return res.status(201).json({ success: true, lead: json });
    }
    return res.status(409).json({ success: false, code: 'BUSY', message: 'Someone is saving a lead for this number right now. Try again in a moment.' });
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
