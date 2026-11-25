'use strict';
/**
 * services/leadBooking.js
 * ============================================================
 * Booking from a lead (CRM staff: Lead details -> Dispatch with leadId).
 *
 *   claim(leadId, user)          -> { ok, claim, lead } | { ok: false, status, code, message, booking? }
 *   withPhone(body, lead)         the lead's number filled in SERVER-SIDE when
 *                                 the form left it blank (telecallers only ever
 *                                 see the masked number); a typed number wins
 *   createWithClaim(claim, tripData, convert)
 *                                 ONE transaction: the claim must still belong
 *                                 to this attempt -> no trip may already carry
 *                                 this lead -> trip created -> claim done
 *                                 (with the trip) -> lead converted, its history
 *                                 entry written (convert(trip, session)).
 *                                 All or nothing.
 *   settle(claim)                 after a failure: frees this attempt's claim
 *                                 if still pending (no trip can exist for it)
 *   statusOf(leadId)              the lead's booking state, for a 409 answer
 *   tripsOfLead(leadId)           trips that carry this lead (Trip.leadId)
 *
 * Guarantees
 *  - One booking per lead through this flow; a lead's existing link is never
 *    overwritten (services/leadConversion.js).
 *  - Concurrent submissions: one holds the claim, the others get 409
 *    IN_PROGRESS (or ALREADY_BOOKED once it is done).
 *  - No half-done state: the trip, the claim's completion and the lead's
 *    conversion + history commit together, so a crash between them is
 *    impossible and the conversion history is written exactly once.
 *  - An expired claim may be taken over by a new attempt; if the older attempt
 *    later resumes, its transaction finds the claim is no longer its own and
 *    aborts -> no second trip (409, with the lead's current state).
 *  - Older "orphaned" bookings: a trip whose leadId is this lead but which the
 *    lead never recorded (convertedTrip unset) — e.g. created before this
 *    flow, when the trip was saved and the lead update then failed. Trip.leadId
 *    is written only by the booking itself (POST /api/trips with leadId), so it
 *    is a reliable link; names and numbers are never used to guess one. Such a
 *    lead is refused (409 ALREADY_BOOKED, needsReview: true, with the trip(s))
 *    so staff check the existing booking instead of creating a second one.
 *    Nothing is repaired or rewritten: the lead keeps its status and history
 *    and the old trip is left exactly as it is.
 *  - Bookings without a leadId (normal Dispatch, website, repeat bookings) are
 *    not affected.
 * ============================================================
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Lead, Trip } = require('../models');
const LeadBookingClaim = require('../models/LeadBookingClaim');
const { OPERATIONS } = require('../middleware/auth');

// A pending claim younger than this belongs to an attempt still running.
const STALE_MS = 5 * 60 * 1000;
// Trips listed in a review answer (the count is always exact).
const REVIEW_LIST_MAX = 5;

const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });
const bookingOf = (t) => (t ? { _id: t._id, tripNumber: t.tripNumber, status: t.status, ...(t.createdAt ? { createdAt: t.createdAt } : {}) } : null);
const tripById = (id) => (id ? Trip.findById(id).select('tripNumber status').lean() : null);
const ALREADY = (booking) => fail(409, 'ALREADY_BOOKED', 'This lead is already booked.', { booking });
const IN_PROGRESS = () => fail(409, 'IN_PROGRESS', 'This lead is being booked right now. Check Dispatch in a moment.');

// Trips that carry this lead, oldest first (+ exact count). Read-only.
async function tripsOfLead(leadId, { session } = {}) {
  if (!mongoose.isValidObjectId(String(leadId))) return { count: 0, trips: [] };
  const filter = { leadId: new mongoose.Types.ObjectId(String(leadId)) };
  const q = Trip.find(filter).select('tripNumber status createdAt').sort({ createdAt: 1, _id: 1 }).limit(REVIEW_LIST_MAX).lean();
  const c = Trip.countDocuments(filter);
  if (session) { q.session(session); c.session(session); }
  const [trips, count] = await Promise.all([q, c]);
  return { count, trips: trips.map(bookingOf) };
}

// A lead that already has a trip it never recorded: refuse, show the trip(s),
// ask for a review. Same code as an ordinary booked lead, so every screen that
// already opens "the existing booking" keeps doing so.
function NEEDS_REVIEW({ count, trips }) {
  const first = trips[0];
  const which = first?.tripNumber ? `booking ${first.tripNumber}` : 'a booking';
  const more = count > 1 ? ` (and ${count - 1} more)` : '';
  return fail(409, 'ALREADY_BOOKED',
    `This lead already has ${which}${more}, but the lead was never marked as booked. Check that booking before booking again.`,
    { booking: { ...first, needsReview: true }, needsReview: true, reason: 'trip_not_recorded_on_lead', tripCount: count, bookings: trips });
}

async function statusOf(leadId, { now = Date.now() } = {}) {
  const lead = mongoose.isValidObjectId(String(leadId)) ? await Lead.findById(leadId).select('convertedTrip').lean() : null;
  if (lead?.convertedTrip) return ALREADY(bookingOf(await tripById(lead.convertedTrip)) || { _id: lead.convertedTrip });
  const held = await LeadBookingClaim.findById(String(leadId)).lean();
  if (held?.state === 'done') return ALREADY(bookingOf(await tripById(held.trip)) || { _id: held.trip });
  const existing = await tripsOfLead(leadId);
  if (existing.count) return NEEDS_REVIEW(existing);
  if (held && now - new Date(held.at).getTime() < STALE_MS) return IN_PROGRESS();
  return null;
}

async function claim(leadId, user, { now = Date.now() } = {}) {
  if (!user || !OPERATIONS.includes(user.role)) return fail(403, 'FORBIDDEN', 'Only CRM staff can book from a lead.');
  if (!mongoose.isValidObjectId(String(leadId))) return fail(404, 'LEAD_NOT_FOUND', 'Lead not found.');
  const lead = await Lead.findById(leadId);
  if (!lead) return fail(404, 'LEAD_NOT_FOUND', 'Lead not found.');
  if (lead.convertedTrip) return ALREADY(bookingOf(await tripById(lead.convertedTrip)) || { _id: lead.convertedTrip });
  // Older orphaned booking (see header). Checked again inside the
  // transaction, so one created after this read is still caught.
  const existing = await tripsOfLead(lead._id);
  if (existing.count) return NEEDS_REVIEW(existing);

  const id = String(lead._id);
  const token = crypto.randomBytes(12).toString('hex');
  const at = new Date(now);
  try {
    await LeadBookingClaim.create({ _id: id, state: 'pending', token, at, by: user._id });
    return { ok: true, claim: { leadId: id, token, at }, lead };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const held = await LeadBookingClaim.findById(id).lean();
  if (!held) return IN_PROGRESS();
  if (held.state === 'done') return ALREADY(bookingOf(await tripById(held.trip)) || { _id: held.trip });
  if (now - new Date(held.at).getTime() < STALE_MS) return IN_PROGRESS();
  // Expired: no trip exists for a pending claim (trip + completion are one
  // transaction), so a new attempt may take it over — only one of them.
  const taken = await LeadBookingClaim.findOneAndUpdate(
    { _id: id, state: 'pending', token: held.token },
    { $set: { token, at, by: user._id } },
    { new: true },
  );
  if (!taken) return IN_PROGRESS();
  return { ok: true, claim: { leadId: id, token, at }, lead };
}

function withPhone(body, lead) {
  const typed = String(body.patientPhone ?? '').trim();
  const out = { ...body, leadId: String(lead._id) };
  if (!out.patientName && lead.patientName) out.patientName = lead.patientName;
  if (typed && !typed.includes('•')) return out;
  return { ...out, patientPhone: lead.phone || typed };
}

function claimLost() {
  const e = new Error('The booking claim for this lead was taken over by another attempt.');
  e.code = 'LEAD_CLAIM_LOST';
  return e;
}
function leadHasTrip() {
  const e = new Error('A trip already carries this lead.');
  e.code = 'LEAD_HAS_TRIP';
  return e;
}

async function createWithClaim(c, tripData, convert) {
  const session = await LeadBookingClaim.startSession();
  try {
    let trip = null;
    await session.withTransaction(async () => {
      trip = null;
      // Still ours? (An expired claim taken over by a newer attempt is not.)
      const own = await LeadBookingClaim.updateOne(
        { _id: c.leadId, token: c.token, state: 'pending' },
        { $set: { state: 'done', doneAt: new Date() } },
        { session },
      );
      if (!(own?.matchedCount > 0)) throw claimLost();
      // No trip may already carry this lead (an older orphaned booking, or
      // one written outside this flow since the claim was taken).
      const prior = await Trip.findOne({ leadId: new mongoose.Types.ObjectId(String(c.leadId)) }).select('_id').session(session).lean();
      if (prior) throw leadHasTrip();
      [trip] = await Trip.create([tripData], { session });
      await LeadBookingClaim.updateOne({ _id: c.leadId, token: c.token }, { $set: { trip: trip._id } }, { session });
      await convert(trip, session);
    });
    return trip;
  } finally {
    await session.endSession();
  }
}

// After a failure: free this attempt's claim if it is still pending. (A
// claim marked done committed together with its trip, so it is kept.)
async function settle(c) {
  const r = await LeadBookingClaim.deleteOne({ _id: c.leadId, token: c.token, state: 'pending' });
  return { released: (r?.deletedCount ?? 0) > 0 };
}

module.exports = { claim, withPhone, createWithClaim, settle, statusOf, tripsOfLead, STALE_MS };
