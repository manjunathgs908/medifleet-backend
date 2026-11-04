'use strict';
/**
 * services/incomingBookings.js
 * ============================================================
 * What counts as an "incoming" booking — one the CRM must be alerted to.
 * The single definition, shared by GET /api/trips/incoming (the
 * foreground full-screen ring) and services/bookingPush.js (background Web
 * Push), so the two can never disagree about what rings.
 *
 * Booked, still unassigned, not acknowledged, recent (older is the
 * dispatch board's job, not an alert), and booked BY THE CUSTOMER:
 *   (a) bookedBy unset — website, customer app, WhatsApp; or
 *   (b) a quote link the customer confirmed. Those carry bookedBy (the
 *       operator who sent the quote), so bookedBy alone can't tell them
 *       from a booking an operator typed in. Both of the confirm flow's
 *       own marks are required: bookingSource 'crm' AND a confirmed Quote
 *       pointing at the trip (quoteController.confirmQuote). The Quote is
 *       the proof; bookingSource only narrows the query.
 * A booking an operator typed in the CRM (bookedBy set, no confirmed
 * quote) never counts.
 * ============================================================
 */
const { Trip } = require('../models');
const Quote = require('../models/Quote');

const INCOMING_WINDOW_MS = 30 * 60 * 1000;

const candidateFilter = (now = Date.now()) => ({
  status   : 'booked',
  driver   : null,
  ambulance: null,
  crmAckAt : null,
  createdAt: { $gte: new Date(now - INCOMING_WINDOW_MS) },
  $or      : [{ bookedBy: null }, { bookingSource: 'crm' }],
});

// candidates (from candidateFilter) -> [{ trip, via }] for the ones that
// really are incoming; via is 'customer' or 'quote_link'.
async function selectIncoming(candidates) {
  const withBooker = candidates.filter((t) => t.bookedBy).map((t) => t._id);
  const viaQuoteLink = new Set();
  if (withBooker.length) {
    const quotes = await Quote.find({ trip: { $in: withBooker }, status: 'confirmed' }).select('trip').lean();
    quotes.forEach((q) => viaQuoteLink.add(String(q.trip)));
  }
  return candidates
    .filter((t) => !t.bookedBy || viaQuoteLink.has(String(t._id)))
    .map((trip) => ({ trip, via: trip.bookedBy ? 'quote_link' : 'customer' }));
}

// The live incoming list, oldest first.
async function findIncoming({ limit = 20 } = {}) {
  const candidates = await Trip.find(candidateFilter())
    .populate('dropHospital', 'name')
    .sort({ createdAt: 1 })
    .limit(limit);
  return selectIncoming(candidates);
}

// One trip, if it is incoming right now: { trip, via } or null.
async function incomingTrip(tripId) {
  const trip = await Trip.findOne({ _id: tripId, ...candidateFilter() }).populate('dropHospital', 'name');
  if (!trip) return null;
  const [hit] = await selectIncoming([trip]);
  return hit || null;
}

module.exports = { INCOMING_WINDOW_MS, candidateFilter, selectIncoming, findIncoming, incomingTrip };
