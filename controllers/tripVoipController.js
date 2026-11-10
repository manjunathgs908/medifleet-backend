/**
 * controllers/tripVoipController.js
 * ============================================================
 * IN-APP (VoIP) customer -> driver calls — who may ask, and Plivo's
 * webhooks. The rules live in services/tripVoip.js.
 *
 *   Customer app (proof: the trip's trackingToken, in the body or the
 *   X-Tracking-Token header, or a customer-app login whose phone is the
 *   trip's — same as POST /api/trips/:id/call):
 *     POST /api/trips/:id/voip/session
 *     GET  /api/trips/:id/voip/:logId          the call's state
 *     POST /api/trips/:id/voip/:logId/end
 *   Driver app (driver login):
 *     GET  /api/calls/driver-voip/login        this device's endpoint login
 *     POST /api/calls/driver-voip/presence     { online }
 *   Plivo, "SaveLife Trip VoIP" application (signature):
 *     ALL  /api/calls/trip-voip-answer         answer URL
 *     ALL  /api/calls/trip-voip-dial?log=      the Dial's action
 *     ALL  /api/calls/trip-voip-dial-event?log=  live: the driver picked up
 *     ALL  /api/calls/trip-voip-hangup         hangup URL
 *
 * No response from here carries a phone number: none is read.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Trip } = require('../models');
const CallLog = require('../models/CallLog');

// Loaded on first use, like tripCallController: the trips router is on
// every booking path and must not pull the Plivo SDK in at require time.
/* eslint-disable global-require */
const voip = () => require('../services/tripVoip');
const tripCallCtrl = () => require('./tripCallController');
const plivoSvc = () => require('../services/plivoService');
/* eslint-enable global-require */

const isCallError = (err) => err?.name === 'TripCallError';
const fail = (res, err) => res.status(err.status).json({ success: false, ok: false, code: err.code, message: err.message });
const notFound = (res, code, message) => res.status(404).json({ success: false, ok: false, code, message });
const sendXml = (res, body) => res.type('text/xml').send(body);
const plivoParams = (req) => (req.method === 'POST' ? (req.body || {}) : (req.query || {}));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && /^[0-9a-f]{24}$/i.test(String(v));

// The driver app's own random device id, kept across launches.
const DEVICE_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const deviceKeyOf = (req) => {
  const k = req.get('X-Device-Key') || req.query?.deviceKey || req.body?.deviceKey;
  return typeof k === 'string' && DEVICE_KEY_RE.test(k) ? k : null;
};
const deviceLabelOf = (req) => String(req.get('X-Device-Label') || req.get('user-agent') || '').slice(0, 200) || undefined;

// The trip, after the caller has proved they are its customer.
async function customerTrip(req, res) {
  if (!isId(req.params.id)) {
    notFound(res, 'TRIP_NOT_FOUND', 'Trip not found.');
    return null;
  }
  const trip = await Trip.findById(req.params.id)
    .select('+trackingToken patientPhone status driver driverConfirmed')
    .populate('driver', 'name');
  if (!trip) {
    notFound(res, 'TRIP_NOT_FOUND', 'Trip not found.');
    return null;
  }
  try {
    tripCallCtrl().assertCustomer(req, trip);
  } catch (err) {
    if (!isCallError(err)) throw err;
    fail(res, err);
    return null;
  }
  return trip;
}

async function tripVoipLog(req, res, trip) {
  const log = isId(req.params.logId) ? await CallLog.findById(req.params.logId) : null;
  if (!log || log.channel !== 'voip' || String(log.trip) !== String(trip._id)) {
    notFound(res, 'CALL_NOT_FOUND', 'Call not found.');
    return null;
  }
  return log;
}

// ============================================================
// @route   POST /api/trips/:id/voip/session  { trackingToken? }
// @desc    Customer taps "Call Driver". Active trip + driver app online ->
//          this trip's Plivo login and what to dial. Otherwise a code the
//          app shows in-app (DRIVER_UNAVAILABLE, TRIP_COMPLETED, ...).
// @access  the trip's customer (trackingToken / customer-app login)
// ============================================================
exports.session = async (req, res, next) => {
  try {
    const trip = await customerTrip(req, res);
    if (!trip) return undefined;
    try {
      const { log, endpoint } = await voip().startSession(trip);
      res.set('Cache-Control', 'no-store');
      return res.json({
        success     : true,
        ok          : true,
        callLogId   : log._id,
        username    : endpoint.username,
        password    : endpoint.password,
        dialTo      : voip().dialToFor(log._id),
        sipHeaders  : { 'X-PH-logId': String(log._id) },
        ringSeconds : voip().ringSeconds(),
        expiresInSec: Math.round(voip().sessionTtlMs() / 1000),
      });
    } catch (err) {
      if (isCallError(err)) return fail(res, err);
      throw err;
    }
  } catch (err) {
    return next(err);
  }
};

// ============================================================
// @route   GET /api/trips/:id/voip/:logId
// @desc    The call's state for the in-call screen: starting / in_progress
//          / ended / failed, with code + message when it failed.
// @access  the trip's customer (X-Tracking-Token header or login)
// ============================================================
exports.status = async (req, res, next) => {
  try {
    const trip = await customerTrip(req, res);
    if (!trip) return undefined;
    const log = await tripVoipLog(req, res, trip);
    if (!log) return undefined;
    const s = voip().publicState(log, trip);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, callLogId: log._id, ok: s.ok, state: s.state, code: s.code || null, message: s.message || null });
  } catch (err) {
    return next(err);
  }
};

// ============================================================
// @route   POST /api/trips/:id/voip/:logId/end
// @desc    The app's End button — also hangs the call up on Plivo's side.
// @access  the trip's customer
// ============================================================
exports.end = async (req, res, next) => {
  try {
    const trip = await customerTrip(req, res);
    if (!trip) return undefined;
    const log = await tripVoipLog(req, res, trip);
    if (!log) return undefined;
    const { hungUp } = await voip().endCall(log);
    return res.json({ success: true, ok: true, callLogId: log._id, hungUp });
  } catch (err) {
    return next(err);
  }
};

// ============================================================
// @route   GET /api/calls/driver-voip/login[?reset=1]
// @header  X-Device-Key (required), X-Device-Label (optional)
// @desc    This driver device's Plivo endpoint login, and a presence
//          check-in (the device can now be rung for its trips' calls).
//          reset=1 after Plivo refuses the login sets a new password.
// @access  Private [driver]
// ============================================================
exports.driverLogin = async (req, res, next) => {
  try {
    const deviceKey = deviceKeyOf(req);
    if (!deviceKey) {
      return res.status(400).json({ success: false, ok: false, code: 'DEVICE_KEY_REQUIRED', message: 'Send this device\'s X-Device-Key (8–64 letters, digits or dashes).' });
    }
    try {
      const doc = await voip().ensureDriverEndpoint(req.user, deviceKey, deviceLabelOf(req), { reset: req.query?.reset === '1' });
      voip().sweepEndedTrips().catch(() => {});
      res.set('Cache-Control', 'no-store');
      return res.json({
        success        : true,
        ok             : true,
        username       : doc.username,
        password       : doc.password,
        sipDomain      : plivoSvc().SIP_DOMAIN,
        onlineForSec   : Math.round(voip().driverOnlineMs() / 1000),
      });
    } catch (err) {
      if (isCallError(err)) return fail(res, err);
      console.error(`[trip-voip] driver endpoint failed user=${req.user._id}: status=${err?.response?.status ?? '-'} ${err?.message || err}`);
      return res.status(502).json({ success: false, ok: false, code: 'PLIVO_FAILED', message: 'Could not set up in-app calling right now. Please try again.' });
    }
  } catch (err) {
    return next(err);
  }
};

// ============================================================
// @route   POST /api/calls/driver-voip/presence  { online: boolean }
// @desc    Keep this device reachable (online: true), or stop in-app rings
//          (false — on logout / going off duty). Without X-Device-Key,
//          applies to all of the driver's devices.
// @access  Private [driver]
// ============================================================
exports.driverPresence = async (req, res, next) => {
  try {
    if (typeof req.body?.online !== 'boolean') {
      return res.status(400).json({ success: false, ok: false, code: 'BAD_ONLINE', message: '"online" must be true or false.' });
    }
    const updated = await voip().setDriverPresence(req.user._id, deviceKeyOf(req), req.body.online);
    return res.json({ success: true, ok: true, online: req.body.online, devices: updated });
  } catch (err) {
    return next(err);
  }
};

// ── Plivo webhooks ("SaveLife Trip VoIP" application) ────────────────────

exports.answer = async (req, res, next) => {
  try {
    const { xml } = await voip().answerCall(plivoParams(req));
    return sendXml(res, xml);
  } catch (err) {
    return next(err);
  }
};

exports.dial = async (req, res, next) => {
  try {
    const logId = isId(req.query.log) ? String(req.query.log) : null;
    const { xml } = await voip().dialFinished(logId, plivoParams(req));
    return sendXml(res, xml);
  } catch (err) {
    return next(err);
  }
};

// The Dial's live callbackUrl: DialAction=answer = the driver picked up.
exports.dialEvent = async (req, res, next) => {
  try {
    const logId = isId(req.query.log) ? String(req.query.log) : null;
    await voip().dialEvent(logId, plivoParams(req));
    return sendXml(res, plivoSvc().emptyXml());
  } catch (err) {
    return next(err);
  }
};

exports.hangup = async (req, res, next) => {
  try {
    await voip().callEnded(plivoParams(req));
    return sendXml(res, plivoSvc().emptyXml());
  } catch (err) {
    return next(err);
  }
};
