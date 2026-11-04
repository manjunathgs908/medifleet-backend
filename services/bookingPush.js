'use strict';
/**
 * services/bookingPush.js
 * ============================================================
 * Background Web Push to CRM operators (owners, telecallers) for a new
 * incoming booking, so it reaches them with the CRM in the background or
 * closed. Complements the foreground ring (components/IncomingBookingAlert
 * in the CRM polling GET /api/trips/incoming) — same definition of
 * "incoming" (services/incomingBookings.js), so a booking pushes exactly
 * when it would ring.
 *
 *   - once per booking: Trip.incomingPushAt is claimed with a conditional
 *     update before anything is sent, so a retry or a second caller sends
 *     nothing.
 *   - subscriptions the push service reports gone (404/410) are deleted.
 *   - fire-and-forget: notifyIncomingBooking never throws. A push failure
 *     must never affect a booking.
 *   - off (logged once) until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
 *     VAPID_SUBJECT are all set. The private key lives only in the env.
 * ============================================================
 */
const webpush = require('web-push');
const { Trip } = require('../models');
const PushSubscription = require('../models/PushSubscription');
const { OPERATIONS } = require('../middleware/auth');
const { INCOMING_WINDOW_MS, incomingTrip } = require('./incomingBookings');

let warnedOff = false;
function configured() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    if (!warnedOff) { console.warn('[bookingPush] VAPID_* env not set — booking push is off'); warnedOff = true; }
    return false;
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    return true;
  } catch (err) {
    if (!warnedOff) { console.error('[bookingPush] invalid VAPID_* env — booking push is off:', err.message); warnedOff = true; }
    return false;
  }
}

// What the notification says. No phone number: it shows on a lock screen.
function payloadFor(trip, via) {
  const id = String(trip._id);
  const body = [
    trip.patientName,
    trip.pickup?.address,
    trip.selectedType,
    via === 'quote_link' ? 'quote link' : null,
  ].filter(Boolean).join(' · ');
  return JSON.stringify({
    title: 'New booking',
    body,
    tripId: id,
    url  : `/dispatch?trip=${id}`,
    tag  : `booking-${id}`,
  });
}

// Every subscription of an active owner/telecaller.
async function staffSubscriptions() {
  const subs = await PushSubscription.find({}).populate('user', 'role isActive').lean();
  return subs.filter((s) => s.user && s.user.isActive && OPERATIONS.includes(s.user.role));
}

async function sendIncomingBooking(tripId) {
  if (!configured()) return { sent: 0, skipped: 'not_configured' };

  const hit = await incomingTrip(tripId);
  if (!hit) return { sent: 0, skipped: 'not_incoming' };

  const claimed = await Trip.findOneAndUpdate(
    { _id: hit.trip._id, incomingPushAt: null },
    { $set: { incomingPushAt: new Date() } },
    { new: true, projection: { _id: 1 } },
  );
  if (!claimed) return { sent: 0, skipped: 'already_pushed' };

  const subs = await staffSubscriptions();
  const payload = payloadFor(hit.trip, hit.via);
  // Undelivered past the ring window, it's stale — the push service drops it.
  const options = { TTL: Math.round(INCOMING_WINDOW_MS / 1000), urgency: 'high' };

  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, options)));

  const gone = [];
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { sent += 1; return; }
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) gone.push(subs[i]._id);
    else console.error('[bookingPush] send failed:', code || '', r.reason?.message);
  });
  if (gone.length) await PushSubscription.deleteMany({ _id: { $in: gone } });

  return { sent, failed: results.length - sent, removed: gone.length };
}

// Fire-and-forget entry point for the booking paths.
function notifyIncomingBooking(tripId) {
  return sendIncomingBooking(tripId).catch((err) => {
    console.error('[bookingPush] notifyIncomingBooking failed:', err.message);
    return { sent: 0, error: err.message };
  });
}

module.exports = { notifyIncomingBooking, sendIncomingBooking, configured };
