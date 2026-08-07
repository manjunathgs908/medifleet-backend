/**
 * services/whatsappNotifications.js
 * ============================================================
 * Outbound WhatsApp messages for trip lifecycle events -- driver assigned,
 * trip started (dispatched -> en_route), trip completed. Every function
 * is a no-op for anything but a WhatsApp-origin trip (trip.bookingSource
 * === 'whatsapp'): app/CRM customers may not be on WhatsApp at all, so
 * this must never fire for them.
 *
 * Plain text via whatsappService.sendText for now -- fine within Meta's
 * 24h customer-service window (the customer just messaged us to book).
 * TODO: switch to approved message templates once outside that window
 * matters (e.g. a trip that sits 'dispatched' for a long time before
 * going en_route) -- templates are required to message outside 24h.
 *
 * Language: trip.whatsappLanguage, set once at booking time from the
 * session (see whatsappFlow.js) since the session itself is deleted
 * right after booking -- falls back to 'en' if absent (older trips,
 * or a trip that predates this field).
 * ============================================================
 */
'use strict';

const { User, Vehicle } = require('../models');
const Ambulance = require('../models/Ambulance');
const whatsapp = require('./whatsappService');
const { t } = require('./whatsappStrings');

function langOf(trip) {
  return trip.whatsappLanguage || 'en';
}

// ============================================================
// @desc  A driver/vehicle has just been dispatched to this trip. Looks up
//        driver name + vehicle/ambulance registration number itself from
//        trip.driver/trip.vehicle/trip.ambulance -- callers just pass the
//        trip, already-saved with those refs set (see
//        dispatchTripToDriver in tripController.js).
// ============================================================
async function notifyDriverAssigned(trip) {
  if (trip.bookingSource !== 'whatsapp') return;
  try {
    const [driver, vehicle, ambulance] = await Promise.all([
      trip.driver ? User.findById(trip.driver).select('name') : null,
      trip.vehicle ? Vehicle.findById(trip.vehicle).select('registrationNumber') : null,
      // Ambulance-sourced dispatch clears trip.vehicle (see
      // assignTripToAmbulance), so this only runs for that path.
      !trip.vehicle && trip.ambulance ? Ambulance.findById(trip.ambulance).select('registrationNumber') : null,
    ]);

    const lang = langOf(trip);
    let message = t(lang, 'driverAssigned');
    const extraLines = [];
    if (driver?.name) extraLines.push(`Driver: ${driver.name}`);
    const vehicleNumber = vehicle?.registrationNumber || ambulance?.registrationNumber;
    if (vehicleNumber) extraLines.push(`Vehicle: ${vehicleNumber}`);
    if (extraLines.length) message += '\n' + extraLines.join('\n');

    await whatsapp.sendText(trip.patientPhone, message);
  } catch (err) {
    console.error('[whatsappNotifications] notifyDriverAssigned failed:', err.message);
  }
}

// ============================================================
// @desc  Trip has gone 'dispatched' -> 'en_route' -- driver heading to
//        pickup. This is the customer's cue to expect the ambulance
//        shortly, so the pickup OTP goes out here (well before the
//        driver needs it) rather than at booking confirmation.
// @param otp  trip.pickupOtp -- has {select:false} on the schema, so the
//             caller must fetch it explicitly and pass it in; this
//             function never queries for it itself (keeps it from ever
//             being pulled into a response payload by accident).
// ============================================================
async function notifyTripStarted(trip, otp) {
  if (trip.bookingSource !== 'whatsapp') return;
  try {
    const lang = langOf(trip);
    let message = t(lang, 'tripStarted');
    if (otp) message += `\nOTP: ${otp}`;
    await whatsapp.sendText(trip.patientPhone, message);
  } catch (err) {
    console.error('[whatsappNotifications] notifyTripStarted failed:', err.message);
  }
}

// ============================================================
// @desc  Trip marked completed (completeTrip) -- trip.grandTotal is the
//        final billed amount (fare + wait charges) by the time this is
//        called, set just before trip.save() in completeTrip.
// ============================================================
async function notifyTripCompleted(trip) {
  if (trip.bookingSource !== 'whatsapp') return;
  try {
    const lang = langOf(trip);
    let message = t(lang, 'tripCompleted');
    if (trip.grandTotal != null) message += `\nFare: ₹${trip.grandTotal}`;
    await whatsapp.sendText(trip.patientPhone, message);
  } catch (err) {
    console.error('[whatsappNotifications] notifyTripCompleted failed:', err.message);
  }
}

module.exports = { notifyDriverAssigned, notifyTripStarted, notifyTripCompleted };
