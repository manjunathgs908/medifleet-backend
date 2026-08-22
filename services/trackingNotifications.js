/**
 * services/trackingNotifications.js
 * ============================================================
 * Sends the customer their live-tracking link the moment a driver is
 * assigned -- over SMS and WhatsApp, both reusing the integrations that
 * already exist (MSG91 via utils/smsService, Meta Cloud API via
 * services/whatsappService). No new provider, no second GPS or messaging
 * stack.
 *
 * Once per trip, not once per assignment. The trip's trackingLinkSentAt
 * is claimed with a conditional update before anything is sent, so a
 * reassignment, a retry, or two concurrent dispatches cannot produce a
 * second message. If neither channel actually managed to send, the claim
 * is released again -- otherwise a trip that failed while the DLT/Meta
 * templates were still pending approval could never be notified at all.
 *
 * Deliberately never includes the pickup OTP, the driver's raw phone, or
 * any internal trip data: the link itself resolves to the public
 * token endpoint, which is already scoped to what a customer may see.
 * ============================================================
 */
'use strict';

const { Trip } = require('../models');
const smsService = require('../utils/smsService');
const whatsappNotifications = require('./whatsappNotifications');

// www, not apex: the Jio/TrueConnect DLT whitelist is registered
// against www.savelife.health, and DLT matches the URL in the SMS body
// as text — an apex link is judged unwhitelisted even though it would
// 308 to the same page. www is also what production serves directly.
const TRACK_URL_BASE = `${process.env.PUBLIC_TRACKING_BASE_URL || 'https://www.savelife.health'}/track`;

// Resolved here rather than taken off the passed trip: trackingToken is
// select:false, so the trip objects the dispatch path hands us do not
// carry it.
async function resolveTrackingUrl(tripId) {
  const doc = await Trip.findById(tripId).select('+trackingToken').lean();
  return doc?.trackingToken ? `${TRACK_URL_BASE}/${doc.trackingToken}` : null;
}

/**
 * @param trip  A saved Trip with patientPhone and _id. Called
 *              fire-and-forget from dispatchTripToDriver.
 */
async function notifyTrackingLink(trip) {
  if (!trip?._id || !trip.patientPhone) return { skipped: true, reason: 'no patient phone' };

  const url = await resolveTrackingUrl(trip._id);
  if (!url) {
    console.warn(`[trackingNotifications] trip ${trip._id} has no trackingToken — nothing to send.`);
    return { skipped: true, reason: 'no trackingToken' };
  }

  // Claim first. Anything after this point is guarded against a second
  // dispatch of the same trip.
  const claim = await Trip.updateOne(
    { _id: trip._id, trackingLinkSentAt: null },
    { $set: { trackingLinkSentAt: new Date() } },
  );
  if (claim.modifiedCount !== 1) {
    return { skipped: true, reason: 'already sent' };
  }

  // Both channels, independently — one being unapproved or down must not
  // stop the other.
  const [sms, wa] = await Promise.allSettled([
    smsService.sendTrackingSms(trip.patientPhone, url),
    whatsappNotifications.notifyTrackingLink(trip, url),
  ]);

  const sent = [];
  if (sms.status === 'fulfilled' && sms.value && !sms.value.skipped) sent.push('sms');
  if (wa.status === 'fulfilled' && wa.value && !wa.value.skipped) sent.push('whatsapp');

  if (sms.status === 'rejected') console.error('[trackingNotifications] SMS failed:', sms.reason?.message);
  if (wa.status === 'rejected') console.error('[trackingNotifications] WhatsApp failed:', wa.reason?.message);
  if (sms.value?.skipped) console.warn('[trackingNotifications] SMS skipped:', sms.value.reason);
  if (wa.value?.skipped) console.warn('[trackingNotifications] WhatsApp skipped:', wa.value.reason);

  if (sent.length === 0) {
    // Nothing went out. Release the claim so the next assignment (or a
    // later one, once the templates are approved) can try again rather
    // than this trip being permanently marked as notified.
    await Trip.updateOne({ _id: trip._id }, { $set: { trackingLinkSentAt: null, trackingLinkChannels: [] } });
    return { sent: [], released: true };
  }

  await Trip.updateOne({ _id: trip._id }, { $set: { trackingLinkChannels: sent } });
  console.log(`[trackingNotifications] trip ${trip._id}: tracking link sent via ${sent.join(' + ')}`);
  return { sent };
}

module.exports = { notifyTrackingLink, resolveTrackingUrl, TRACK_URL_BASE };
