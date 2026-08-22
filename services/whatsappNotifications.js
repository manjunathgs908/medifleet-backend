/**
 * services/whatsappNotifications.js
 * ============================================================
 * Outbound WhatsApp messages for trip lifecycle events -- driver assigned,
 * trip started (dispatched -> en_route), trip completed, plus the customer
 * tracking link. These used to fire only for WhatsApp-origin trips; they
 * now fire for every booking source, because a customer who booked on the
 * website has the same need to know an ambulance is coming. The only gate
 * left is having a patientPhone.
 *
 * Approved message templates (driver_assigned / trip_started /
 * trip_complete), not plain text. Templates are required to message
 * outside Meta's 24h customer-service window, which these three routinely
 * fall outside of -- a trip can sit 'dispatched' for hours before going
 * en_route, and a completed-trip message can land a day after the
 * customer last typed anything. The variable ORDER below is fixed by
 * what Meta approved; changing it silently sends the wrong values into
 * the wrong slots (Meta validates the count, never the meaning).
 *
 * Language: English only. The approved templates exist in 'en' and
 * nothing else, so every customer gets 'en' regardless of
 * trip.whatsappLanguage. That field is still set at booking time (see
 * whatsappFlow.js) and still drives the booking conversation itself --
 * it is only the post-booking notifications that are en-only.
 * TODO: submit kn/hi/te translations of these templates, then send
 * trip.whatsappLanguage (falling back to 'en') instead of TEMPLATE_LANG.
 *
 * TODO: booking_reminder ("Reminder: your ambulance booking {{1}} is
 * scheduled for {{2}}...") is approved but not wired -- it needs a
 * scheduler over scheduleType:'later' trips, which does not exist yet.
 * call_followup (no variables) belongs to the Exotel call trigger, not
 * to trip lifecycle, so it does not live in this file.
 * ============================================================
 */
'use strict';

const { User, Vehicle, Trip } = require('../models');
const Ambulance = require('../models/Ambulance');
const whatsapp = require('./whatsappService');
const { haversineKm } = require('../utils/haversine');

// Every template is approved in English only -- see the language note
// above. Deliberately a constant, not trip.whatsappLanguage: sending a
// language code Meta has no approved translation for fails the send
// outright (error 132001), which would mean silence rather than an
// English message.
const TEMPLATE_LANG = 'en';

// Customer-facing tracking page.
// Built from trip.trackingToken, never the _id: this URL is handed to
// whoever holds the phone, and an ObjectId is guessable from a known
// neighbour. Served by savelife-web's app/track/[token] page against the
// public GET /api/trips/track/:token endpoint.
const TRACK_URL_BASE = 'https://savelife.health/track';

// Same rough straight-line assumption trackTrip uses for its "~6 min
// away" indicator -- not a routed ETA (no Directions call, same quota
// reasoning as there), and only computable when the driver has reported
// a position and the pickup has coordinates.
const ASSUMED_KMPH = 30;
// TODO: replace with a real routed ETA if/when one is computed at
// dispatch time. Until then an assigned driver with no reported position
// (just clocked in, GPS not yet pushed) gets this flat number rather
// than an empty slot -- Meta rejects an empty parameter outright.
const FALLBACK_ETA_MINUTES = 15;

// Meta rejects the ENTIRE template send (error 132000) if any body
// parameter contains a newline, a tab, or 4+ consecutive spaces, and an
// empty string is not an accepted value either. Addresses here come from
// Google Places or from text the customer typed into WhatsApp, so they
// are flattened rather than trusted. A missing value becomes '-' for the
// same reason: a visible dash beats a failed send.
const EMPTY_PARAM = '-';

function param(value) {
  const text = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  return { type: 'text', text: text || EMPTY_PARAM };
}

// Body-only templates (all three below have no header/button variables),
// so components is always a single body block whose parameters are
// positional -- parameters[0] is {{1}}.
function bodyComponents(...values) {
  return [{ type: 'body', parameters: values.map(param) }];
}

// Straight-line minutes from the driver's last reported position to the
// pickup point; null when either end is unknown.
function etaToPickup(trip, driver) {
  const lat = driver?.availability?.lat;
  const lng = driver?.availability?.lng;
  if (lat == null || lng == null) return null;
  if (trip.pickup?.lat == null || trip.pickup?.lng == null) return null;

  const km = haversineKm(lat, lng, trip.pickup.lat, trip.pickup.lng);
  return Math.max(1, Math.round((km / ASSUMED_KMPH) * 60));
}

// trackingToken is select:false, so the trip objects the controllers hand
// us almost never carry it. Resolved here rather than by asking every
// caller to remember `.select('+trackingToken')` — one forgotten call site
// would silently send the customer a '-' instead of a link.
async function trackUrl(trip) {
  let token = trip.trackingToken;
  if (!token && trip._id) {
    const doc = await Trip.findById(trip._id).select('+trackingToken').lean();
    token = doc?.trackingToken;
  }
  return token ? `${TRACK_URL_BASE}/${token}` : null;
}

// ============================================================
// @desc  A driver/vehicle has just been dispatched to this trip. Looks up
//        driver name/phone + vehicle/ambulance registration number itself
//        from trip.driver/trip.vehicle/trip.ambulance -- callers just
//        pass the trip, already-saved with those refs set (see
//        dispatchTripToDriver in tripController.js).
//
//        Template driver_assigned:
//          {{1}} trip number  {{2}} driver name  {{3}} driver phone
//          {{4}} vehicle number  {{5}} ETA minutes
//
//        Note {{3}}: this hands the customer the driver's raw number,
//        which the public trackTrip endpoint deliberately withholds in
//        favour of masked calling (POST /api/call/connect). The approved
//        template has a Phone slot and no way to omit it, so the two
//        channels differ on purpose -- worth revisiting if masked calling
//        becomes the only sanctioned path.
// ============================================================
async function notifyDriverAssigned(trip) {
  // Was gated to WhatsApp-origin trips only. Every booking source now
  // gets the same notification — a customer who booked on the website
  // or over the phone has the same need to know an ambulance is coming.
  if (!trip.patientPhone) return;
  try {
    const [driver, vehicle, ambulance] = await Promise.all([
      trip.driver ? User.findById(trip.driver).select('name phone availability') : null,
      trip.vehicle ? Vehicle.findById(trip.vehicle).select('registrationNumber') : null,
      // Ambulance-sourced dispatch clears trip.vehicle (see
      // assignTripToAmbulance), so this only runs for that path.
      !trip.vehicle && trip.ambulance ? Ambulance.findById(trip.ambulance).select('registrationNumber') : null,
    ]);

    const eta = etaToPickup(trip, driver);

    await whatsapp.sendTemplate(
      trip.patientPhone,
      'driver_assigned',
      TEMPLATE_LANG,
      bodyComponents(
        trip.tripNumber,
        driver?.name,
        driver?.phone,
        vehicle?.registrationNumber || ambulance?.registrationNumber,
        eta == null ? FALLBACK_ETA_MINUTES : eta,
      ),
    );
  } catch (err) {
    console.error('[whatsappNotifications] notifyDriverAssigned failed:', err.message);
  }
}

// ============================================================
// @desc  Trip has gone 'dispatched' -> 'en_route' -- driver heading to
//        pickup. This is the customer's cue to expect the ambulance
//        shortly, so the pickup OTP goes out here (well before the
//        driver needs it) rather than at booking confirmation.
//
//        Template trip_started:
//          {{1}} trip number  {{2}} pickup  {{3}} drop  {{4}} track link
//
// @param otp  trip.pickupOtp -- has {select:false} on the schema, so the
//             caller must fetch it explicitly and pass it in; this
//             function never queries for it itself (keeps it from ever
//             being pulled into a response payload by accident).
//
//        The approved template has no OTP slot, so the OTP follows as a
//        separate plain text. Dropping it is not an option: a WhatsApp
//        customer has no app to read it from, and without it the driver
//        cannot pass pickup verification. Sent after the template so the
//        customer sees the trip context first, and only best-effort --
//        sendText returns null rather than throwing on failure, same as
//        every other send here.
//        TODO: submit a pickup_otp template so this survives outside the
//        24h window too (a plain text there is silently dropped by Meta).
// ============================================================
async function notifyTripStarted(trip, otp) {
  // Was gated to WhatsApp-origin trips only. Every booking source now
  // gets the same notification — a customer who booked on the website
  // or over the phone has the same need to know an ambulance is coming.
  if (!trip.patientPhone) return;
  try {
    await whatsapp.sendTemplate(
      trip.patientPhone,
      'trip_started',
      TEMPLATE_LANG,
      bodyComponents(
        trip.tripNumber,
        trip.pickup?.address,
        trip.dropAddress,
        await trackUrl(trip),
      ),
    );

    if (otp) await whatsapp.sendText(trip.patientPhone, `Pickup OTP: ${otp}`);
  } catch (err) {
    console.error('[whatsappNotifications] notifyTripStarted failed:', err.message);
  }
}

// ============================================================
// @desc  Trip marked completed (completeTrip) -- trip.grandTotal is the
//        final billed amount (fare + wait charges) and trip.distanceKm
//        the final billed distance by the time this is called, both set
//        just before trip.save() in completeTrip.
//
//        Template trip_complete:
//          {{1}} trip number  {{2}} distance km  {{3}} amount
//          {{4}} invoice
//
//        {{4}} falls back to the tracking link, which shows the full bill
//        breakdown once trip.status is 'completed' (see trackTrip's bill
//        block).
//        TODO: send the real invoice PDF instead. completeTrip calls this
//        BEFORE Bill.create, so trip.billId is not even set yet at this
//        point -- wiring a bill URL here means moving this call below bill
//        creation, and there is no hosted invoice document today.
// ============================================================
async function notifyTripCompleted(trip) {
  // Was gated to WhatsApp-origin trips only. Every booking source now
  // gets the same notification — a customer who booked on the website
  // or over the phone has the same need to know an ambulance is coming.
  if (!trip.patientPhone) return;
  try {
    await whatsapp.sendTemplate(
      trip.patientPhone,
      'trip_complete',
      TEMPLATE_LANG,
      bodyComponents(
        trip.tripNumber,
        trip.distanceKm,
        trip.grandTotal,
        await trackUrl(trip),
      ),
    );
  } catch (err) {
    console.error('[whatsappNotifications] notifyTripCompleted failed:', err.message);
  }
}

// ============================================================
// @desc  The customer's live tracking link, sent the moment a driver is
//        assigned. A NEW template rather than a slot bolted onto
//        driver_assigned: that one is already approved and in use, and
//        editing an approved template sends it back through Meta review,
//        taking the working driver-assignment notification down with it.
//
//        Template tracking_link (body-only, one variable):
//          🚑 SaveLife Ambulance
//          Your ambulance has been assigned.
//          Track your ambulance live:
//          {{1}} tracking URL
//
//        Must be submitted and approved in Meta Business Manager before
//        this delivers; an unapproved name is rejected at send time and
//        surfaces here as a skip, not a crash.
//
// @param url  Already built from trip.trackingToken by the caller.
// ============================================================
async function notifyTrackingLink(trip, url) {
  if (!trip.patientPhone) return { skipped: true, reason: 'no patient phone' };
  if (!url) return { skipped: true, reason: 'no tracking url' };

  const res = await whatsapp.sendTemplate(
    trip.patientPhone,
    'tracking_link',
    TEMPLATE_LANG,
    bodyComponents(url),
  );

  // sendMessage swallows Meta's errors and returns null, so a missing
  // result means the send did not happen (most likely: template not yet
  // approved under this name).
  if (!res) return { skipped: true, reason: 'WhatsApp send failed — is the tracking_link template approved?' };
  return res;
}

module.exports = { notifyDriverAssigned, notifyTripStarted, notifyTripCompleted, notifyTrackingLink };
