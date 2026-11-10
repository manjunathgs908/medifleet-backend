/**
 * controllers/tripCallController.js
 * ============================================================
 * Driver <-> customer masked calling. Rules and Plivo placement live in
 * services/tripCalls.js; this file is who-may-ask and the two webhooks.
 *
 *   POST /api/trips/:id/call          the apps (driver or customer)
 *   ALL  /api/calls/trip-answer?log=  Plivo: initiator answered -> bridge
 *   ALL  /api/calls/trip-inbound      Plivo: someone dialled the masking
 *                                     number back -> short message, no bridge
 *
 * WHO MAY ASK
 *   from: 'driver'   the driver's normal login (protect, role driver), and
 *                    the trip must be assigned to them.
 *   from: 'customer' proof the caller IS this trip's customer -- either the
 *                    trip's trackingToken (the secret in their tracking link
 *                    and in the booking response), or a customer-app login
 *                    token whose phone is the trip's number. A bare trip id
 *                    is not enough: ids are not secrets, and this endpoint
 *                    rings real phones on our Plivo bill.
 * ============================================================
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Trip } = require('../models');
const CallLog = require('../models/CallLog');
const { protect, authorize } = require('../middleware/auth');
const { normalisePhone } = require('../utils/phone');

// Loaded on first use, not when routes/trips.js is required: the trips
// router is on every booking path, and it should not pull the Plivo SDK in
// (or fail to boot with it) just because one of its routes places calls.
/* eslint-disable global-require */
const svc = () => require('../services/tripCalls');
const plivoSvc = () => require('../services/plivoService');
/* eslint-enable global-require */
const isTripCallError = (err) => err?.name === 'TripCallError' || err instanceof svc().TripCallError;
const tripCallError = (status, code, message) => new (svc().TripCallError)(status, code, message);
const sendXml = (res, body) => res.type('text/xml').send(body);
const fail = (res, err) => res.status(err.status).json({ success: false, code: err.code, message: err.message });

// ── Auth middleware for POST /api/trips/:id/call ──────────────────────────
// A driver goes through the same protect + authorize('driver') every other
// driver trip action uses. A customer has no User record; their proof is
// checked in startCall against the trip itself.
exports.authenticate = (req, res, next) => {
  const from = req.body?.from;
  if (from === 'driver') return protect(req, res, () => authorize('driver')(req, res, next));
  if (from === 'customer') return next();
  return res.status(400).json({ success: false, code: 'BAD_FROM', message: '"from" must be "driver" or "customer".' });
};

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// A customer-app login token (controllers/appAuthController.js): { phone,
// role: 'customer' }, no id. Returns the 10-digit phone or null.
function customerPhoneFromToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded?.role !== 'customer' || !decoded.phone) return null;
    return normalisePhone(decoded.phone);
  } catch {
    return null;
  }
}

// The trackingToken comes in the JSON body, or -- for a GET, which has no
// body, and so it never sits in a URL -- in the X-Tracking-Token header.
const trackingTokenOf = (req) => req.body?.trackingToken || req.get?.('X-Tracking-Token') || null;

function assertCustomer(req, trip) {
  const given = trackingTokenOf(req);
  if (sameSecret(given, trip.trackingToken)) return;
  const phone = customerPhoneFromToken(req);
  if (phone && phone === normalisePhone(trip.patientPhone)) return;
  if (phone || given) {
    throw tripCallError(403, 'NOT_THIS_TRIP', 'You can only call the driver of your own trip.');
  }
  throw tripCallError(401, 'CUSTOMER_PROOF_REQUIRED', 'Open this trip from your SaveLife booking or tracking link to call the driver.');
}
// Also the in-app call's proof (controllers/tripVoipController.js).
exports.assertCustomer = assertCustomer;

// ============================================================
// @route   POST /api/trips/:id/call
// @body    { from: 'driver' | 'customer', trackingToken? }
// @access  driver login, or the trip's customer (trackingToken / app login)
// ============================================================
exports.startCall = async (req, res, next) => {
  try {
    const { from } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ success: false, code: 'TRIP_NOT_FOUND', message: 'Trip not found.' });
    }
    const trip = await Trip.findById(req.params.id)
      .select('+trackingToken patientPhone status driver driverConfirmed')
      .populate('driver', 'name phone callPhone');
    if (!trip) return res.status(404).json({ success: false, code: 'TRIP_NOT_FOUND', message: 'Trip not found.' });

    try {
      if (from === 'driver') {
        if (!trip.driver || String(trip.driver._id) !== String(req.user._id)) {
          throw tripCallError(403, 'NOT_YOUR_TRIP', 'This trip is not assigned to you.');
        }
      } else {
        assertCustomer(req, trip);
      }
      const { log, callerId, message } = await svc().placeTripCall(trip, from);
      return res.json({
        success  : true,
        callLogId: log._id,
        callerId,
        callerIdDisplay: svc().pretty(callerId),
        message,
      });
    } catch (err) {
      if (isTripCallError(err)) return fail(res, err);
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   ALL /api/calls/trip-answer?log=<id>
// @desc    The initiator picked up. Re-check the trip -- it may have been
//          completed or cancelled while their phone rang -- then dial the
//          other party from the same masking number.
// @access  Plivo (signature)
// ============================================================
exports.answer = async (req, res, next) => {
  try {
    const logId = String(req.query.log || '');
    const log = mongoose.Types.ObjectId.isValid(logId)
      ? await CallLog.findById(logId).select('+customerPhone +agentPhone')
      : null;
    // An in-app call's row never bridges to a phone here.
    if (!log || !log.tripMasked || log.direction !== 'outbound' || log.channel === 'voip') {
      return sendXml(res, plivoSvc().speakXml('Sorry, this call could not be connected.'));
    }
    const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});

    const trip = log.trip ? await Trip.findById(log.trip).select('status driver driverConfirmed') : null;
    let refusal = null;
    if (!trip) refusal = 'Sorry, this trip could not be found.';
    else if (String(trip.driver || '') !== String(log.agentUser || '')) refusal = 'Sorry, the driver on this trip has changed, so this call cannot be connected.';
    else {
      try {
        svc().assertCallable(trip, log.tripCallFrom);
      } catch (err) {
        if (!(isTripCallError(err))) throw err;
        refusal = err.code === 'TRIP_COMPLETED' || err.code === 'TRIP_CANCELLED'
          ? 'This trip has ended, so this call cannot be connected. Thank you for choosing SaveLife.'
          : 'Sorry, this call cannot be connected right now.';
      }
    }

    if (refusal) {
      await CallLog.updateOne({ _id: log._id }, {
        $set: { status: 'blocked_trip_inactive', endedAt: new Date(), ...(params.CallUUID ? { providerCallId: params.CallUUID } : {}) },
      });
      console.info(`[trip-calls] answer refused log=${log._id} trip=${log.trip} status=${trip?.status || '-'}`);
      return sendXml(res, plivoSvc().speakXml(refusal));
    }

    const other = log.firstLeg === 'customer' ? log.agentPhone : log.customerPhone;
    await CallLog.updateOne({ _id: log._id }, {
      $set: { answeredAt: new Date(), ...(params.CallUUID ? { providerCallId: params.CallUUID } : {}) },
    });
    await CallLog.updateOne({ _id: log._id, status: 'initiated' }, { $set: { status: 'agent_answered' } });

    return sendXml(res, plivoSvc().bridgeXml({
      numbers  : [other],
      logId    : log._id,
      callerId : log.callerId,
      timeLimit: svc().maxSeconds(),
    }));
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   ALL /api/calls/trip-inbound
// @desc    Answer URL for the masking number's own Plivo application:
//          someone dialled it back. Nobody is bridged -- the number is
//          not a way to reach a driver or a customer outside the app.
// @access  Plivo (signature)
// ============================================================
exports.inbound = (req, res) => {
  const company = plivoSvc().companyNumber();
  const help = /^91\d{10}$/.test(company) ? ` For help, call ${company.slice(2).split('').join(' ')}.` : '';
  console.info('[trip-calls] inbound call to the masking number — played the redirect message');
  return sendXml(res, plivoSvc().speakXml(`This number only connects calls for a SaveLife trip. Please use the call button in the SaveLife app.${help}`));
};
