'use strict';
/**
 * services/bookingPush.js
 * ============================================================
 * Background Web Push to CRM operators (owners, telecallers) for a new
 * incoming booking, new WhatsApp lead or meaningful WhatsApp conversation,
 * so it reaches them with the CRM in the background or closed.
 * Complements the foreground ring (components/IncomingBookingAlert in the
 * CRM polling GET /api/trips/incoming) — same definitions
 * (services/incomingBookings.js, services/incomingAlerts.js), so each
 * pushes exactly when it would ring.
 *
 *   - once each: Trip.incomingPushAt / WhatsAppLead.alertPushAt /
 *     WhatsAppSession.alertPushAt is claimed with a conditional update
 *     before anything is sent, so a retry or a second caller sends
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
const WhatsAppLead = require('../models/WhatsAppLead');
const WhatsAppSession = require('../models/WhatsAppSession');
const { OPERATIONS } = require('../middleware/auth');
const { INCOMING_WINDOW_MS, incomingTrip } = require('./incomingBookings');
const incomingAlerts = require('./incomingAlerts');

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

  return sendToStaff(payloadFor(hit.trip, hit.via));
}

// WhatsApp lead / meaningful conversation — same checks, own lock
// (alertPushAt on the lead / session). The notification's text and link
// come from the alert item (services/incomingAlerts.js); still no phone.
const WA_BODY = {
  wa_lead: () => 'Asked on WhatsApp for a service with no automated booking — call back',
  wa_chat: (a) => `${a.stage} · WhatsApp`,
};
async function sendWhatsAppAlert(Model, find, id) {
  if (!configured()) return { sent: 0, skipped: 'not_configured' };
  const alert = await find(id);
  if (!alert) return { sent: 0, skipped: 'not_incoming' };
  const claimed = await Model.findOneAndUpdate(
    { _id: alert.id, alertPushAt: null },
    { $set: { alertPushAt: new Date() } },
    { new: true, projection: { _id: 1 } },
  );
  if (!claimed) return { sent: 0, skipped: 'already_pushed' };
  return sendToStaff(JSON.stringify({
    title: alert.title,
    body : WA_BODY[alert.type](alert),
    type : alert.type,
    url  : alert.link,
    tag  : alert.key,
  }));
}
const sendWhatsAppLead = (leadId) => sendWhatsAppAlert(WhatsAppLead, incomingAlerts.incomingLead, leadId);
const sendWhatsAppChat = (sessionId) => sendWhatsAppAlert(WhatsAppSession, incomingAlerts.incomingChat, sessionId);

async function sendToStaff(payload) {
  const subs = await staffSubscriptions();
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

// Fire-and-forget entry points — never reject.
const fireAndForget = (name, send) => (id) => send(id).catch((err) => {
  console.error(`[bookingPush] ${name} failed:`, err.message);
  return { sent: 0, error: err.message };
});
const notifyIncomingBooking = fireAndForget('notifyIncomingBooking', sendIncomingBooking);
const notifyWhatsAppLead    = fireAndForget('notifyWhatsAppLead', sendWhatsAppLead);
const notifyWhatsAppChat    = fireAndForget('notifyWhatsAppChat', sendWhatsAppChat);

module.exports = {
  notifyIncomingBooking, sendIncomingBooking,
  notifyWhatsAppLead, sendWhatsAppLead,
  notifyWhatsAppChat, sendWhatsAppChat,
  configured,
};
