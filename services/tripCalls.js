/**
 * services/tripCalls.js
 * ============================================================
 * Driver <-> customer masked calling for a trip (Ola/Uber style).
 *
 *   POST /api/trips/:id/call  { from: 'driver' | 'customer' }
 *
 * Plivo rings the INITIATOR's real phone from the masking number; when they
 * answer, /api/calls/trip-answer re-checks the trip and dials the OTHER
 * party from the same number. Both sides only ever see the masking number:
 * real numbers are read from the trip here, stored on the CallLog
 * (select:false), and never put in a URL, a response or a log line.
 *
 * A trip is callable only while it is active (booked / dispatched /
 * en_route) and has a driver. Completed or cancelled -> refused, both when
 * the call is requested and again when the first party picks up, so a call
 * started seconds before completion cannot connect after it.
 *
 * Env:
 *   PLIVO_MASKING_NUMBER   dedicated virtual number, 91 + 10 digits. Unset ->
 *                          falls back to PLIVO_NUMBER (the incoming line),
 *                          which works but means a redial reaches the CRM.
 *   TRIP_CALL_MAX_SECONDS  cap on one bridged call (default 1800)
 *   TRIP_CALL_MAX_PER_10_MIN  calls one trip may start in 10 minutes (default 6)
 * ============================================================
 */
'use strict';

const CallLog = require('../models/CallLog');
const plivo = require('./plivoService');
const { normalisePhone } = require('../utils/phone');

const ACTIVE_STATUSES = ['booked', 'dispatched', 'en_route'];
const RATE_WINDOW_MS = 10 * 60 * 1000;

const isMobile = (raw) => /^[6-9]\d{9}$/.test(normalisePhone(raw));
// Same rule as callController.ringPhoneOf: a driver's call ring number when
// valid, else their login phone.
const ringPhoneOf = (u) => (u?.callPhone && isMobile(u.callPhone) ? u.callPhone : u?.phone);

const digits = (v) => String(v || '').replace(/\D/g, '');

function maskingNumber() {
  const dedicated = digits(process.env.PLIVO_MASKING_NUMBER);
  if (/^91\d{10}$/.test(dedicated)) return { number: dedicated, dedicated: true };
  return { number: plivo.companyNumber(), dedicated: false };
}

const maxSeconds = () => Math.max(60, Number(process.env.TRIP_CALL_MAX_SECONDS) || 1800);
const maxPerWindow = () => Math.max(1, Number(process.env.TRIP_CALL_MAX_PER_10_MIN) || 6);

// "+91 80 1234 5678"-ish, for the message the app shows. Display only.
const pretty = (n) => (/^91\d{10}$/.test(n) ? `+91 ${n.slice(2, 7)} ${n.slice(7)}` : n);

class TripCallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TripCallError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Can these two talk right now? Throws TripCallError with a sentence the app
 * shows as-is. `from` decides one extra rule: the customer cannot call
 * before the driver has accepted (dispatched && !driverConfirmed) -- the
 * tracking screen still shows "searching" then and hides the driver.
 */
function assertCallable(trip, from) {
  if (trip.status === 'completed') {
    throw new TripCallError(409, 'TRIP_COMPLETED', 'This trip is complete, so calls between the driver and the customer are closed.');
  }
  if (trip.status === 'cancelled') {
    throw new TripCallError(409, 'TRIP_CANCELLED', 'This trip was cancelled, so calls between the driver and the customer are closed.');
  }
  if (!ACTIVE_STATUSES.includes(trip.status)) {
    throw new TripCallError(409, 'TRIP_NOT_ACTIVE', 'Calls are only possible while the trip is active.');
  }
  if (!trip.driver) {
    throw new TripCallError(409, 'NO_DRIVER', 'No driver is assigned to this trip yet.');
  }
  if (from === 'customer' && trip.status === 'dispatched' && !trip.driverConfirmed) {
    throw new TripCallError(409, 'DRIVER_NOT_CONFIRMED', 'Your ambulance is being confirmed. You can call the driver once they accept the trip.');
  }
}

/** The real numbers, from the trip only. Throws if either is unusable. */
function resolveParties(trip) {
  const driverPhone = normalisePhone(ringPhoneOf(trip.driver));
  const customerPhone = normalisePhone(trip.patientPhone);
  if (!isMobile(driverPhone)) {
    throw new TripCallError(400, 'DRIVER_PHONE_INVALID', 'The driver on this trip has no valid mobile number.');
  }
  if (!isMobile(customerPhone)) {
    throw new TripCallError(400, 'CUSTOMER_PHONE_INVALID', 'This trip has no valid customer mobile number.');
  }
  if (driverPhone === customerPhone) {
    throw new TripCallError(400, 'SAME_NUMBER', 'The driver and the customer have the same number on this trip.');
  }
  return { driverPhone, customerPhone };
}

/**
 * A trip's id travels in the customer app, so cap how often one trip can
 * ring anybody -- cheap protection against a stuck button or abuse. Phone
 * calls and in-app calls (services/tripVoip.js) share the one budget: both
 * are tripMasked rows.
 */
async function assertRateLimit(tripId) {
  const recent = await CallLog.countDocuments({
    trip: tripId, tripMasked: true, startedAt: { $gte: new Date(Date.now() - RATE_WINDOW_MS) },
  });
  if (recent >= maxPerWindow()) {
    throw new TripCallError(429, 'RATE_LIMITED', 'Too many calls on this trip in the last few minutes. Please wait a little and try again.');
  }
}

/**
 * Validate, rate-limit, log and ring the initiator. `trip` must have
 * driver populated with name/phone/callPhone and carry patientPhone,
 * status and driverConfirmed.
 *
 * Returns { log, callerId, message } or throws TripCallError.
 */
async function placeTripCall(trip, from) {
  if (!['driver', 'customer'].includes(from)) {
    throw new TripCallError(400, 'BAD_FROM', '"from" must be "driver" or "customer".');
  }
  assertCallable(trip, from);
  const { driverPhone, customerPhone } = resolveParties(trip);

  if (!plivo.isConfigured()) {
    throw new TripCallError(503, 'NOT_CONFIGURED', 'Calling is not set up on the server right now.');
  }

  await assertRateLimit(trip._id);

  const { number: callerId, dedicated } = maskingNumber();
  const log = await CallLog.create({
    direction    : 'outbound',
    provider     : 'plivo',
    callerId,
    status       : 'initiated',
    context      : 'trip',
    trip         : trip._id,
    tripMasked   : true,
    tripCallFrom : from,
    // Same fields the existing trip calls use: agent = the driver,
    // firstLeg = whoever started it, so the events webhook and the CRM's
    // Call Logs read these rows without any change.
    firstLeg     : from === 'driver' ? 'agent' : 'customer',
    agentType    : 'driver',
    agentUser    : trip.driver._id,
    agentName    : trip.driver.name,
    agentPhone   : driverPhone,
    customerPhone,
  });

  try {
    const { requestId } = await plivo.callFirstLeg({
      phone     : from === 'driver' ? driverPhone : customerPhone,
      logId     : log._id,
      callerId,
      answerPath: '/api/calls/trip-answer',
      timeLimit : maxSeconds(),
    });
    log.providerRequestId = requestId;
    await log.save();
    console.info(`[trip-calls] placed log=${log._id} trip=${trip._id} from=${from} callerId=${callerId} dedicated=${dedicated}`);
  } catch (err) {
    console.error(`[trip-calls] Plivo call failed log=${log._id}:`, err?.message || err);
    log.status = 'failed';
    log.error = String(err?.message || err).slice(0, 500);
    log.endedAt = new Date();
    await log.save();
    throw new TripCallError(502, 'PLIVO_FAILED', plivo.friendlyError(err));
  }

  const other = from === 'driver' ? 'the customer' : 'the driver';
  return {
    log,
    callerId,
    message: `Your phone will ring now from ${pretty(callerId)}. Answer it and we will connect you to ${other}.`,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  TripCallError,
  assertCallable,
  resolveParties,
  assertRateLimit,
  placeTripCall,
  maskingNumber,
  maxSeconds,
  maxPerWindow,
  pretty,
};
