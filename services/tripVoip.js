/**
 * services/tripVoip.js
 * ============================================================
 * IN-APP (VoIP) customer -> driver calls for a trip — Phase 1.
 *
 *   1. The customer app asks POST /api/trips/:id/voip/session. If the trip
 *      is active and the driver's app is online, it gets this trip's own
 *      Plivo endpoint login, a call-log id and what to dial.
 *   2. The app logs in with Plivo's SDK and dials. Plivo asks the "SaveLife
 *      Trip VoIP" application's answer URL (/api/calls/trip-voip-answer),
 *      which re-checks everything and rings ONLY the driver's in-app
 *      endpoints. There is no phone leg anywhere: if the driver's app does
 *      not answer, the call ends as DRIVER_UNAVAILABLE. Nothing ever dials
 *      a real number.
 *   3. The trip completes or is cancelled -> closeTripVoip(): any live call
 *      is hung up and the trip's customer endpoint is deleted from Plivo.
 *
 * Neither phone number is read, stored or sent by anything in this file.
 * Recording is whatever the shared bridge (plivoService.bridgeXml) does.
 *
 * Env:
 *   PLIVO_TRIP_VOIP_APP_ID       the "SaveLife Trip VoIP" Plivo application.
 *                                Unset -> in-app calls answer NOT_CONFIGURED.
 *   TRIP_VOIP_RING_SECONDS       how long the driver's app rings (default 25)
 *   TRIP_VOIP_DRIVER_ONLINE_MIN  how long a driver app's last check-in counts
 *                                as reachable (default 720 = 12 h: the app is
 *                                woken by Plivo's push, so it need not be open)
 *   TRIP_VOIP_SESSION_TTL_SEC    how long a session may wait to be dialled
 *                                (default 120)
 *   TRIP_CALL_MAX_SECONDS / TRIP_CALL_MAX_PER_10_MIN  shared with phone calls
 * ============================================================
 */
'use strict';

const crypto = require('crypto');
const CallLog = require('../models/CallLog');
const TripVoipEndpoint = require('../models/TripVoipEndpoint');
const { Trip } = require('../models');
const plivo = require('./plivoService');
const tripCalls = require('./tripCalls');

const { TripCallError, ACTIVE_STATUSES } = tripCalls;

const MAX_DRIVER_DEVICES = 3;
const LIVE_STATUSES = ['initiated', 'ringing'];

const appId = () => String(process.env.PLIVO_TRIP_VOIP_APP_ID || '').trim() || null;
const isConfigured = () => plivo.isConfigured() && !!appId();
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const ringSeconds = () => clamp(process.env.TRIP_VOIP_RING_SECONDS, 10, 60, 25);
const driverOnlineMs = () => clamp(process.env.TRIP_VOIP_DRIVER_ONLINE_MIN, 1, 7 * 24 * 60, 720) * 60 * 1000;
const sessionTtlMs = () => clamp(process.env.TRIP_VOIP_SESSION_TTL_SEC, 30, 900, 120) * 1000;

// What the app dials. Plivo sends every call from these endpoints to our
// answer URL whatever the destination; the log id also rides in the
// X-PH-logId header. Never a number, never another endpoint.
const dialToFor = (logId) => `tripvoip${logId}`;
const DIAL_TO_RE = /tripvoip([0-9a-f]{24})/i;

const MESSAGES = {
  DRIVER_UNAVAILABLE: 'Driver is not reachable right now. Please try again.',
  TRIP_ENDED        : 'This trip has ended, so this call cannot be connected.',
  NOT_CONNECTED     : 'Sorry, this call could not be connected.',
  SESSION_EXPIRED   : 'This call took too long to start. Please tap Call again.',
  DRIVER_CHANGED    : 'The driver on this trip has changed. Please tap Call again.',
};

const unavailable = () => new TripCallError(409, 'DRIVER_UNAVAILABLE', MESSAGES.DRIVER_UNAVAILABLE);
const notConfigured = () => new TripCallError(503, 'NOT_CONFIGURED', 'In-app calling is not set up on the server right now.');

const randomPassword = () => crypto.randomBytes(18).toString('base64url');
const hex = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, '');
const plivoStatusOf = (err) => err?.response?.status;

// ── Driver endpoints (one per driver device) ─────────────────────────────

/** The driver's in-app endpoints that may be rung right now. */
async function driverOnlineEndpoints(driverId) {
  if (!driverId) return [];
  return TripVoipEndpoint.find({
    kind: 'driver', user: driverId, onlineAt: { $gte: new Date(Date.now() - driverOnlineMs()) },
  }).select('username').lean();
}

/**
 * This driver device's endpoint: found or created, linked to the Trip VoIP
 * application, with a password (new if missing or `reset`), and marked
 * online. Returns the document with its password.
 */
async function ensureDriverEndpoint(user, deviceKey, device, { reset = false, retried = false } = {}) {
  if (!isConfigured()) throw notConfigured();
  const app = appId();
  let doc = await TripVoipEndpoint.findOne({ kind: 'driver', user: user._id, deviceKey }).select('+password');

  if (!doc) {
    const existing = await TripVoipEndpoint.find({ kind: 'driver', user: user._id })
      .sort({ lastUsedAt: 1 }).select('endpointId').lean();
    for (const old of existing.slice(0, Math.max(0, existing.length - MAX_DRIVER_DEVICES + 1))) {
      await plivo.deleteEndpoint(old.endpointId).catch(() => {});
      await TripVoipEndpoint.deleteOne({ _id: old._id });
      console.info(`[trip-voip] retired oldest driver device endpoint user=${user._id}`);
    }
    const password = randomPassword();
    const ep = await plivo.createEndpoint({
      username: `sld${hex(user._id).slice(-7)}${hex(deviceKey).slice(0, 6)}`,
      password,
      alias   : `slvoip-d-${hex(user._id)}-${hex(deviceKey).slice(0, 12)}`,
      appId   : app,
    });
    try {
      doc = await TripVoipEndpoint.create({
        kind: 'driver', user: user._id, deviceKey, device, endpointId: ep.id, username: ep.username, password, appId: app,
      });
      console.info(`[trip-voip] created driver endpoint for user=${user._id}`);
    } catch (err) {
      // Two logins from one device at once: keep the first, drop ours.
      await plivo.deleteEndpoint(ep.id).catch(() => {});
      if (err?.code !== 11000) throw err;
      doc = await TripVoipEndpoint.findOne({ kind: 'driver', user: user._id, deviceKey }).select('+password');
    }
  }

  try {
    if (doc.appId !== app) {
      await plivo.linkEndpointToApp(doc.endpointId, app);
      doc.appId = app;
    }
    if (!doc.password || reset) {
      doc.password = await plivo.resetEndpointPassword(doc.endpointId);
      console.info(`[trip-voip] new driver endpoint password user=${user._id} (${reset ? 'login rejected' : 'none stored'})`);
    }
  } catch (err) {
    // Deleted on Plivo's side (console clean-up): start this device afresh, once.
    if (plivoStatusOf(err) === 404 && !retried) {
      await TripVoipEndpoint.deleteOne({ _id: doc._id });
      return ensureDriverEndpoint(user, deviceKey, device, { reset, retried: true });
    }
    throw err;
  }

  doc.device = device || doc.device;
  doc.onlineAt = new Date();
  doc.lastUsedAt = new Date();
  await doc.save();
  return doc;
}

/** Presence from the driver app: online refreshes, offline stops in-app rings. */
async function setDriverPresence(userId, deviceKey, online) {
  const filter = { kind: 'driver', user: userId, ...(deviceKey ? { deviceKey } : {}) };
  const res = await TripVoipEndpoint.updateMany(filter, online
    ? { $set: { onlineAt: new Date() } }
    : { $unset: { onlineAt: 1 } });
  return res.modifiedCount ?? res.nModified ?? 0;
}

// ── Customer endpoint (one per trip) ─────────────────────────────────────

async function ensureCustomerEndpoint(trip) {
  const app = appId();
  let doc = await TripVoipEndpoint.findOne({ kind: 'customer', trip: trip._id }).select('+password');
  if (doc && doc.password) {
    doc.lastUsedAt = new Date();
    await doc.save();
    return doc;
  }
  if (doc) {
    doc.password = await plivo.resetEndpointPassword(doc.endpointId);
    await doc.save();
    return doc;
  }
  const password = randomPassword();
  const ep = await plivo.createEndpoint({
    username: `slc${hex(trip._id).slice(-10)}`,
    password,
    alias   : `slvoip-c-${hex(trip._id)}`,
    appId   : app,
  });
  try {
    doc = await TripVoipEndpoint.create({
      kind: 'customer', trip: trip._id, endpointId: ep.id, username: ep.username, password, appId: app,
    });
    console.info(`[trip-voip] created customer endpoint for trip=${trip._id}`);
    return doc;
  } catch (err) {
    await plivo.deleteEndpoint(ep.id).catch(() => {});
    if (err?.code !== 11000) throw err;
    return TripVoipEndpoint.findOne({ kind: 'customer', trip: trip._id }).select('+password');
  }
}

// ── Session: the customer taps "Call Driver" ─────────────────────────────

/**
 * `trip` must carry status, driver (populated: _id, name), driverConfirmed.
 * The caller has already proved this is the trip's customer.
 * Returns { log, endpoint } or throws TripCallError.
 */
async function startSession(trip) {
  tripCalls.assertCallable(trip, 'customer');
  if (!isConfigured()) throw notConfigured();
  sweepEndedTrips().catch(() => {});

  const online = await driverOnlineEndpoints(trip.driver._id);
  if (!online.length) {
    console.info(`[trip-voip] session refused trip=${trip._id}: driver app offline`);
    throw unavailable();
  }
  await tripCalls.assertRateLimit(trip._id);

  let endpoint;
  try {
    endpoint = await ensureCustomerEndpoint(trip);
  } catch (err) {
    if (err instanceof TripCallError) throw err;
    console.error(`[trip-voip] customer endpoint failed trip=${trip._id}: status=${plivoStatusOf(err) ?? '-'} ${err?.message || err}`);
    throw new TripCallError(502, 'PLIVO_FAILED', 'Could not start the in-app call right now. Please try again.');
  }

  const log = await CallLog.create({
    direction   : 'outbound',
    provider    : 'plivo',
    channel     : 'voip',
    status      : 'initiated',
    context     : 'trip',
    trip        : trip._id,
    tripMasked  : true,
    tripCallFrom: 'customer',
    firstLeg    : 'customer',
    agentType   : 'driver',
    agentUser   : trip.driver._id,
    agentName   : trip.driver.name,
    flow        : [`voip:session:driver_devices=${online.length}`],
  });
  console.info(`[trip-voip] session log=${log._id} trip=${trip._id} driverDevices=${online.length}`);
  return { log, endpoint };
}

// ── The answer URL: the customer's app dialled ───────────────────────────

const usernameFromSip = (raw) => {
  const s = String(raw || '').trim();
  const m = s.match(/^sips?:([^@;]+)@/i);
  return m ? m[1] : s;
};

// Plivo hands X-PH-* SIP headers to the answer URL as parameters; spelling
// of the case is not guaranteed.
function headerParam(params, name) {
  const want = name.toLowerCase();
  const key = Object.keys(params || {}).find((k) => k.toLowerCase() === want);
  return key ? params[key] : undefined;
}

function logIdFromParams(params) {
  const h = String(headerParam(params, 'X-PH-logId') || '');
  if (/^[0-9a-f]{24}$/i.test(h)) return h;
  const m = String(params?.To || '').match(DIAL_TO_RE);
  return m ? m[1] : null;
}

/**
 * Decides one incoming call from a Trip VoIP endpoint. Returns
 * { xml, outcome } — outcome for tests and the log line only.
 */
async function answerCall(params) {
  const refuse = async (log, status, code, say) => {
    if (log) {
      await CallLog.updateOne({ _id: log._id, status: { $in: LIVE_STATUSES } }, {
        $set: { status, endedAt: new Date(), ...(params.CallUUID && !log.providerCallId ? { providerCallId: params.CallUUID } : {}) },
        $push: { flow: `voip:answer_refused:${code}` },
      });
    }
    console.info(`[trip-voip] answer refused log=${log?._id || '-'} code=${code}`);
    return { xml: plivo.speakXml(say), outcome: code };
  };

  const logId = logIdFromParams(params);
  const log = logId ? await CallLog.findById(logId) : null;
  if (!log || log.channel !== 'voip' || !log.tripMasked || !log.trip) {
    return refuse(null, null, 'NO_SESSION', MESSAGES.NOT_CONNECTED);
  }

  // Only from THIS trip's customer endpoint.
  const caller = usernameFromSip(params.From);
  const endpoint = await TripVoipEndpoint.findOne({ kind: 'customer', trip: log.trip }).select('username').lean();
  if (!endpoint || !caller || endpoint.username !== caller) {
    return refuse(log, 'blocked_wrong_caller', 'WRONG_CALLER', MESSAGES.NOT_CONNECTED);
  }

  // One session, one call, used promptly.
  if (log.status !== 'initiated' || log.providerCallId) {
    return refuse(null, null, 'SESSION_USED', MESSAGES.NOT_CONNECTED);
  }
  if (Date.now() - new Date(log.startedAt).getTime() > sessionTtlMs()) {
    return refuse(log, 'expired', 'SESSION_EXPIRED', MESSAGES.SESSION_EXPIRED);
  }

  const trip = await Trip.findById(log.trip).select('status driver driverConfirmed');
  if (!trip) return refuse(log, 'blocked_trip_inactive', 'TRIP_NOT_FOUND', MESSAGES.NOT_CONNECTED);
  try {
    tripCalls.assertCallable(trip, 'customer');
  } catch (err) {
    if (!(err instanceof TripCallError)) throw err;
    const ended = err.code === 'TRIP_COMPLETED' || err.code === 'TRIP_CANCELLED';
    return refuse(log, 'blocked_trip_inactive', err.code, ended ? MESSAGES.TRIP_ENDED : MESSAGES.NOT_CONNECTED);
  }
  if (String(trip.driver || '') !== String(log.agentUser || '')) {
    return refuse(log, 'blocked_driver_changed', 'DRIVER_CHANGED', MESSAGES.DRIVER_CHANGED);
  }

  const online = await driverOnlineEndpoints(trip.driver);
  if (!online.length) {
    return refuse(log, 'driver_unavailable', 'DRIVER_UNAVAILABLE', MESSAGES.DRIVER_UNAVAILABLE);
  }

  // Claim the session atomically: a replayed webhook cannot ring twice.
  const claimed = await CallLog.findOneAndUpdate(
    { _id: log._id, status: 'initiated', providerCallId: { $exists: false } },
    {
      $set : { status: 'ringing', ...(params.CallUUID ? { providerCallId: params.CallUUID } : {}) },
      $push: { flow: `voip:ringing_driver_app:${online.length}:${ringSeconds()}s` },
    },
    { new: true },
  );
  if (!claimed) return refuse(null, null, 'SESSION_USED', MESSAGES.NOT_CONNECTED);

  console.info(`[trip-voip] ringing driver app log=${log._id} trip=${trip._id} devices=${online.length}`);
  return {
    outcome: 'RINGING',
    xml    : plivo.bridgeXml({
      sipUsers  : online.map((e) => e.username),
      logId     : log._id,
      timeout   : ringSeconds(),
      timeLimit : tripCalls.maxSeconds(),
      actionPath: '/api/calls/trip-voip-dial',
      sipHeaders: { tripId: String(trip._id) },
      callerName: 'SaveLife Customer',
    }),
  };
}

// Hung up by closeTripVoip (the trip completed / was cancelled mid-call)?
const closedByTrip = (log) => (log.flow || []).some((f) => /^voip:trip_/.test(f));

// ── The Dial's action: did the driver's app answer? ──────────────────────

async function dialFinished(logId, params) {
  const log = logId ? await CallLog.findById(logId) : null;
  if (!log || log.channel !== 'voip') return { xml: plivo.hangupXml(), outcome: 'NO_LOG' };
  const dialStatus = String(params.DialStatus || '').toLowerCase();
  const legCause = params.DialBLegHangupCause || params.DialHangupCause;

  if (dialStatus === 'completed') {
    const talk = Number(params.DialBLegDuration ?? params.DialBLegBillDuration);
    // May replace an end status a hang-up report set first: they talked.
    await CallLog.updateOne(
      { _id: log._id, status: { $in: [...LIVE_STATUSES, 'customer_cancelled', 'blocked_trip_inactive'] } },
      {
        $set: {
          status: 'completed',
          ...(Number.isFinite(talk) ? { talkSec: talk, answeredAt: new Date(Date.now() - talk * 1000) } : {}),
          ...(params.DialBLegUUID ? { customerLegId: params.DialBLegUUID } : {}),
          ...(legCause ? { hangupCause: legCause } : {}),
        },
        $push: { flow: 'voip:driver_answered' },
      },
    );
    return { xml: plivo.hangupXml(), outcome: 'COMPLETED' };
  }

  // The customer gave up while it rang.
  if (dialStatus === 'cancel') {
    await CallLog.updateOne({ _id: log._id, status: { $in: LIVE_STATUSES } }, {
      $set : { status: 'customer_cancelled' },
      $push: { flow: 'voip:caller_hung_up_while_ringing' },
    });
    return { xml: plivo.hangupXml(), outcome: 'CUSTOMER_CANCELLED' };
  }

  if (closedByTrip(log)) {
    await CallLog.updateOne({ _id: log._id, status: { $in: LIVE_STATUSES } }, { $set: { status: 'blocked_trip_inactive' } });
    return { xml: plivo.hangupXml(), outcome: 'TRIP_ENDED' };
  }

  // Not answered, busy, declined, unreachable — no phone fallback, ever.
  await CallLog.updateOne({ _id: log._id, status: { $in: LIVE_STATUSES } }, {
    $set : { status: 'driver_unavailable', ...(legCause ? { hangupCause: legCause } : {}) },
    $push: { flow: `voip:driver_app:${dialStatus || 'none'}→driver_unavailable` },
  });
  console.info(`[trip-voip] driver app did not answer log=${log._id} DialStatus=${dialStatus || '-'}`);
  return { xml: plivo.speakXml(MESSAGES.DRIVER_UNAVAILABLE), outcome: 'DRIVER_UNAVAILABLE' };
}

// ── The application's hangup URL ─────────────────────────────────────────

async function callEnded(params) {
  const logId = logIdFromParams(params);
  let log = logId ? await CallLog.findById(logId) : null;
  if (!log && params.CallUUID) log = await CallLog.findOne({ providerCallId: params.CallUUID, channel: 'voip' });
  if (!log || log.channel !== 'voip') {
    console.info(`[trip-voip] hangup with no in-app call log (CallUUID=${params.CallUUID || '-'})`);
    return 'NO_LOG';
  }
  // A hang-up for another leg (the driver's app) does not end the call.
  if (log.providerCallId && params.CallUUID && params.CallUUID !== log.providerCallId) return 'OTHER_LEG';

  const total = Number(params.Duration);
  await CallLog.updateOne({ _id: log._id, endedAt: null }, {
    $set: { endedAt: new Date(), ...(Number.isFinite(total) ? { totalSec: total } : {}), ...(params.HangupCause ? { hangupCause: log.hangupCause || params.HangupCause } : {}) },
  });
  // Ended before the Dial reported: the customer hung up first — or the
  // trip ended and closeTripVoip hung it up.
  await CallLog.updateOne({ _id: log._id, status: { $in: LIVE_STATUSES } }, {
    $set : { status: closedByTrip(log) ? 'blocked_trip_inactive' : 'customer_cancelled' },
    $push: { flow: 'voip:ended_before_dial_report' },
  });
  return 'ENDED';
}

// ── The app's view of one call ───────────────────────────────────────────

const STATE_OF = {
  initiated             : { state: 'starting', ok: true },
  ringing               : { state: 'in_progress', ok: true },
  completed             : { state: 'ended', ok: true, code: 'COMPLETED' },
  customer_cancelled    : { state: 'ended', ok: true, code: 'CANCELLED' },
  driver_unavailable    : { state: 'failed', ok: false, code: 'DRIVER_UNAVAILABLE', message: MESSAGES.DRIVER_UNAVAILABLE },
  expired               : { state: 'failed', ok: false, code: 'SESSION_EXPIRED', message: MESSAGES.SESSION_EXPIRED },
  blocked_driver_changed: { state: 'failed', ok: false, code: 'DRIVER_CHANGED', message: MESSAGES.DRIVER_CHANGED },
  blocked_wrong_caller  : { state: 'failed', ok: false, code: 'NOT_CONNECTED', message: MESSAGES.NOT_CONNECTED },
};

function publicState(log, trip) {
  if (log.status === 'blocked_trip_inactive') {
    const code = trip?.status === 'completed' ? 'TRIP_COMPLETED' : trip?.status === 'cancelled' ? 'TRIP_CANCELLED' : 'TRIP_NOT_ACTIVE';
    return { state: 'failed', ok: false, code, message: MESSAGES.TRIP_ENDED };
  }
  const s = STATE_OF[log.status] || { state: 'ended', ok: false, code: 'NOT_CONNECTED', message: MESSAGES.NOT_CONNECTED };
  // A live row older than any call can last is over, whatever it says.
  if (LIVE_STATUSES.includes(log.status) && log.endedAt) return { state: 'ended', ok: true };
  return s;
}

/** The app's End button: hang the call up on Plivo's side too. */
async function endCall(log) {
  if (!LIVE_STATUSES.includes(log.status) || log.endedAt) return { hungUp: false };
  let hungUp = false;
  if (log.providerCallId) {
    try {
      await plivo.hangupCall(log.providerCallId);
      hungUp = true;
    } catch (err) {
      if (plivoStatusOf(err) !== 404) console.warn(`[trip-voip] hangup failed log=${log._id}: status=${plivoStatusOf(err) ?? '-'}`);
    }
  }
  await CallLog.updateOne({ _id: log._id, status: 'initiated' }, {
    $set: { status: 'customer_cancelled', endedAt: new Date() }, $push: { flow: 'voip:ended_by_app_before_dial' },
  });
  if (log.status === 'ringing') await CallLog.updateOne({ _id: log._id }, { $push: { flow: 'voip:ended_by_app' } });
  return { hungUp };
}

// ── Trip completed / cancelled ───────────────────────────────────────────

/**
 * Hangs up every live in-app call of the trip and deletes the trip's
 * customer endpoint from Plivo (so its login stops working). Never throws:
 * it runs after a trip has already been completed or cancelled.
 */
async function closeTripVoip(tripId, reason = 'ended') {
  const result = { hungUp: 0, endpointDeleted: false };
  try {
    const live = await CallLog.find({ trip: tripId, channel: 'voip', status: { $in: LIVE_STATUSES }, endedAt: null })
      .select('status providerCallId').lean();
    for (const log of live) {
      if (log.providerCallId) {
        try {
          await plivo.hangupCall(log.providerCallId);
          result.hungUp += 1;
        } catch (err) {
          if (plivoStatusOf(err) !== 404) console.warn(`[trip-voip] trip-end hangup failed log=${log._id}: status=${plivoStatusOf(err) ?? '-'}`);
        }
      }
      await CallLog.updateOne({ _id: log._id, status: 'initiated' }, {
        $set: { status: 'blocked_trip_inactive', endedAt: new Date() },
      });
      await CallLog.updateOne({ _id: log._id }, { $push: { flow: `voip:trip_${reason}→hung_up` } });
    }

    const ep = await TripVoipEndpoint.findOne({ kind: 'customer', trip: tripId }).select('endpointId').lean();
    if (ep) {
      try {
        await plivo.deleteEndpoint(ep.endpointId);
      } catch (err) {
        // Kept for the next sweep to retry. The answer URL refuses it anyway:
        // its trip is no longer active.
        if (plivoStatusOf(err) !== 404) {
          console.warn(`[trip-voip] endpoint delete failed trip=${tripId}: status=${plivoStatusOf(err) ?? '-'}`);
          return result;
        }
      }
      await TripVoipEndpoint.deleteOne({ _id: ep._id });
      result.endpointDeleted = true;
    }
    if (live.length || ep) console.info(`[trip-voip] closed trip=${tripId} (${reason}) hungUp=${result.hungUp} endpointDeleted=${result.endpointDeleted}`);
  } catch (err) {
    console.error(`[trip-voip] closeTripVoip failed trip=${tripId}:`, err?.message || err);
  }
  return result;
}

// Backstop for any path that ends a trip without the hook (or a failed
// Plivo delete): customer endpoints whose trip is no longer active are
// closed. Runs at most every 5 minutes, piggy-backed on sessions/logins.
const SWEEP_EVERY_MS = 5 * 60 * 1000;
let lastSweepAt = 0;
async function sweepEndedTrips({ force = false } = {}) {
  if (!force && Date.now() - lastSweepAt < SWEEP_EVERY_MS) return 0;
  lastSweepAt = Date.now();
  const eps = await TripVoipEndpoint.find({ kind: 'customer' }).select('trip').limit(500).lean();
  if (!eps.length) return 0;
  const trips = await Trip.find({ _id: { $in: eps.map((e) => e.trip) } }).select('status').lean();
  const active = new Set(trips.filter((t) => ACTIVE_STATUSES.includes(t.status)).map((t) => String(t._id)));
  const ended = eps.filter((e) => !active.has(String(e.trip)));
  for (const e of ended) await closeTripVoip(e.trip, 'sweep');
  return ended.length;
}
const _resetSweep = () => { lastSweepAt = 0; };

module.exports = {
  MESSAGES,
  LIVE_STATUSES,
  appId,
  isConfigured,
  ringSeconds,
  driverOnlineMs,
  sessionTtlMs,
  dialToFor,
  driverOnlineEndpoints,
  ensureDriverEndpoint,
  setDriverPresence,
  ensureCustomerEndpoint,
  startSession,
  answerCall,
  dialFinished,
  callEnded,
  publicState,
  endCall,
  closeTripVoip,
  sweepEndedTrips,
  usernameFromSip,
  logIdFromParams,
  _resetSweep,
};
