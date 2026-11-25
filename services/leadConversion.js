'use strict';
/**
 * services/leadConversion.js
 * ============================================================
 * A booked trip makes its lead converted (moved here unchanged from
 * controllers/tripController.js so a booking from a lead can run it inside
 * the same transaction as the trip — services/leadBooking.js).
 *
 * The booking wins over any lead change made at the same moment. Applied at
 * the lead's current rev, so the history entry records the status and
 * follow-up it really replaced (a change that lands in between is re-read,
 * not overwritten blindly); a dashboard change from before the booking then
 * gets a 409. The follow-up reminder ends; its time stays in the history.
 *
 * Exactly once:
 *  - a lead already linked to THIS trip is left alone (no second history
 *    entry if conversion is attempted again);
 *  - a lead linked to a DIFFERENT trip keeps that link (never overwritten);
 *  - every update is conditional on the lead still being unlinked.
 * With { session } every read and write joins that transaction.
 * ============================================================
 */
const { Lead, User } = require('../models');

const UNLINKED = { $or: [{ convertedTrip: null }, { convertedTrip: { $exists: false } }] };

async function convertLead(leadId, trip, bookedBy, { session } = {}) {
  const s = (q) => (session ? q.session(session) : q);
  const opt = session ? { session } : {};
  const booker = bookedBy ? await s(User.findById(bookedBy).select('name').lean()) : null;
  const entry = (before) => ({
    type: 'status', at: new Date(), by: bookedBy || undefined, byName: booker?.name,
    detail: {
      from: before ? before.status || 'new' : null, to: 'converted', trip: trip.tripNumber,
      ...(before?.nextFollowUpAt ? { followUpCleared: before.nextFollowUpAt } : {}),
    },
  });
  const update = (before) => ({
    $set  : { status: 'converted', convertedTrip: trip._id },
    $unset: { nextFollowUpAt: 1, lostReason: 1 },
    $inc  : { rev: 1 },
    $push : { history: entry(before) },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await s(Lead.findById(leadId).select('status nextFollowUpAt rev convertedTrip').lean());
    if (!before) return { converted: false, reason: 'no_lead' };
    if (before.convertedTrip) {
      if (String(before.convertedTrip) === String(trip._id)) return { converted: false, reason: 'already_this_trip' };
      console.warn(`[leads] lead ${leadId} already linked to trip ${before.convertedTrip}; trip ${trip._id} not linked over it`);
      return { converted: false, reason: 'linked_elsewhere' };
    }
    const rev = before.rev || 0;
    const done = await Lead.findOneAndUpdate({ _id: leadId, ...UNLINKED, ...(rev === 0 ? { rev: { $in: [0, null] } } : { rev }) }, update(before), opt);
    if (done) return { converted: true };
  }
  // Still contended after five tries: convert anyway — the trip exists —
  // but still only over an unlinked lead.
  const done = await Lead.findOneAndUpdate({ _id: leadId, ...UNLINKED }, update(null), opt);
  return { converted: !!done, reason: done ? undefined : 'linked_meanwhile' };
}

module.exports = { convertLead };
