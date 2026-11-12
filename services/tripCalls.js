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
 * DIAL-PAD FLOW (no callback). The app opens the phone's dialer on the
 * trip's `callNumber` (the masking number). The driver or customer calls
 * it from their own SIM; /api/calls/trip-inbound looks the caller's number
 * up -> their one active trip -> dials the OTHER party from the masking
 * number. Only with a DEDICATED masking number (never PLIVO_NUMBER, the
 * CRM line). Same active-trip rule, re-checked when the other side picks
 * up; a call still ringing when the trip ends is hung up, a connected one
 * runs on.
 *
 * Env:
 *   PLIVO_MASKING_NUMBER   dedicated virtual number, 91 + 10 digits. Unset ->
 *                          the callback flow falls back to PLIVO_NUMBER (the
 *                          incoming line); the dial-pad flow is off.
 *   TRIP_CALL_MAX_SECONDS  cap on one bridged call (default 1800)
 *   TRIP_CALL_MAX_PER_10_MIN  calls one trip may start in 10 minutes (default 6)
 *   TRIP_DIAL_RING_SECONDS how long the other side's phone rings on a
 *                          dial-pad call (default 30, 10-60)
 * ============================================================
 */
'use strict';

const CallLog = require('../models/CallLog');
const { Trip, User } = require('../models');
const plivo = require('./plivoService');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const { maskPhone } = require('../utils/customerPhone');

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

// ============================================================
// DIAL-PAD MASKED CALLING (the caller dials the masking number)
// ============================================================
const ENDED_STATUSES = ['completed', 'cancelled'];
const RECENT_ENDED_MS = 24 * 60 * 60 * 1000;
const DIALPAD = 'dialpad';
const CONNECTED = 'agent_answered'; // same word the CRM's liveness code reads as in-call
const DIAL_ACTION_PATH = '/api/calls/trip-inbound-dial';
const DIAL_EVENT_PATH = '/api/calls/trip-inbound-dial-event';

const dialRingSeconds = () => Math.min(60, Math.max(10, Number(process.env.TRIP_DIAL_RING_SECONDS) || 30));

/**
 * The masking number for the dial-pad flow, 91 + 10 digits, or null. It must
 * be set AND differ from PLIVO_NUMBER: that is the CRM line, whose answer URL
 * rings CRM staff, so it can never double as the trip line.
 */
function dedicatedMaskingNumber() {
  const n = digits(process.env.PLIVO_MASKING_NUMBER);
  if (!/^91\d{10}$/.test(n)) return null;
  if (n === plivo.companyNumber()) return null;
  return n;
}

/**
 * What the app's Call button dials: "+91XXXXXXXXXX" while this side may call
 * on this trip (same rule as a call: assertCallable), else null. Null too
 * until a dedicated masking number is configured -- the app then keeps its
 * current call button. The number is the same for every trip; it reveals
 * nobody, since the caller is identified by their own number.
 */
function callNumberFor(trip, from) {
  const n = dedicatedMaskingNumber();
  if (!n || !trip || !plivo.isConfigured()) return null;
  try {
    assertCallable(trip, from);
  } catch (err) {
    if (err instanceof TripCallError) return null;
    throw err;
  }
  return `+${n}`;
}

const helpLine = () => {
  const company = plivo.companyNumber();
  return /^91\d{10}$/.test(company) ? ` For help, call SaveLife on ${company.slice(2).split('').join(' ')}.` : '';
};

// What the caller hears. Spoken by Plivo, then the call ends.
const DIALPAD_MESSAGES = {
  NOT_SET_UP    : () => 'Sorry, trip calls are not available right now. Please try again later.',
  UNKNOWN       : () => `This number only connects calls for an active SaveLife trip, from the phone number registered on that trip.${helpLine()}`,
  TRIP_ENDED    : () => 'Your trip has ended, so this call cannot be connected. Thank you for choosing SaveLife.',
  AMBIGUOUS     : () => `You have more than one active SaveLife trip, so we cannot tell which one to connect.${helpLine()}`,
  NOT_CONFIRMED : () => 'Your ambulance is being confirmed. You can call the driver once they accept the trip.',
  RATE_LIMITED  : () => 'Too many calls on this trip in the last few minutes. Please wait a little and try again.',
  CANNOT_CONNECT: () => `Sorry, this call cannot be connected right now.${helpLine()}`,
  NO_ANSWER     : (other) => `${other === 'driver' ? 'The driver' : 'The customer'} could not answer right now. Please try again in a minute.`,
};

/**
 * Who is calling? Matches the caller's number against ACTIVE trips: as the
 * customer (trip.patientPhone) or as the assigned driver (their login phone
 * or call ring number). Returns
 *   { phone, matches: [{ trip, from }], recentlyEnded }
 * phone is null for a withheld / non-mobile caller. `from` is null when the
 * caller is both the driver and the customer of one trip (never guessed).
 * recentlyEnded (only when nothing matched): they had a trip that completed
 * or was cancelled in the last 24 h, so they hear "your trip has ended".
 */
async function findCallerTrips(raw) {
  const phone = normalisePhone(raw);
  if (/^sip:/i.test(String(raw || '')) || !isMobile(phone)) return { phone: null, matches: [], recentlyEnded: false };

  const suffix = phoneSuffixQuery(phone);
  const drivers = await User.find({ role: 'driver', $or: [{ phone: suffix }, { callPhone: phone }] }).select('_id').lean();
  const driverIds = (drivers || []).map((d) => String(d._id));
  const who = [{ patientPhone: suffix }];
  if (driverIds.length) who.push({ driver: { $in: driverIds } });

  const trips = await Trip.find({ status: { $in: ACTIVE_STATUSES }, $or: who })
    .select('status driver driverConfirmed patientPhone tripNumber')
    .populate('driver', 'name phone callPhone');

  const matches = [];
  for (const trip of trips || []) {
    const asCustomer = normalisePhone(trip.patientPhone) === phone;
    const asDriver = !!trip.driver && driverIds.includes(String(trip.driver._id || trip.driver));
    if (asCustomer && asDriver) matches.push({ trip, from: null });
    else if (asDriver) matches.push({ trip, from: 'driver' });
    else if (asCustomer) matches.push({ trip, from: 'customer' });
  }

  let recentlyEnded = false;
  if (!matches.length) {
    recentlyEnded = !!(await Trip.exists({
      status: { $in: ENDED_STATUSES }, updatedAt: { $gte: new Date(Date.now() - RECENT_ENDED_MS) }, $or: who,
    }));
  }
  return { phone, matches, recentlyEnded };
}

const speak = (key, outcome, arg) => ({ xml: plivo.speakXml(DIALPAD_MESSAGES[key](arg)), outcome });
const changed = (r) => Number(r?.matchedCount ?? r?.n ?? 0) > 0;

/**
 * The masking number's answer URL. Someone dialled it: bridge them to the
 * other party of their active trip, or say why not. Returns
 * { xml, outcome, logId? }. Never puts a number in a log line except masked.
 */
async function bridgeInbound(params = {}) {
  const rawFrom = String(params.From || '');
  const masking = dedicatedMaskingNumber();
  if (!masking || !plivo.isConfigured()) {
    console.warn('[trip-calls] dialpad call but no dedicated PLIVO_MASKING_NUMBER is configured — refused');
    return speak('NOT_SET_UP', 'NOT_SET_UP');
  }

  const found = await findCallerTrips(rawFrom);
  const who = found.phone ? maskPhone(found.phone) : 'withheld/unknown';
  if (!found.phone) {
    console.info(`[trip-calls] dialpad call from ${who} — not a mobile number, refused`);
    return speak('UNKNOWN', 'UNKNOWN_CALLER');
  }
  if (!found.matches.length) {
    console.info(`[trip-calls] dialpad call from ${who} — no active trip${found.recentlyEnded ? ' (trip ended recently)' : ''}`);
    return found.recentlyEnded ? speak('TRIP_ENDED', 'TRIP_ENDED') : speak('UNKNOWN', 'NO_ACTIVE_TRIP');
  }
  if (found.matches.length > 1 || !found.matches[0].from) {
    console.info(`[trip-calls] dialpad call from ${who} — matches ${found.matches.length} active trip role(s): ${found.matches.map((m) => `${m.trip._id}:${m.from || 'both'}`).join(',')} — refused`);
    return speak('AMBIGUOUS', 'AMBIGUOUS');
  }

  const { trip, from } = found.matches[0];
  const other = from === 'driver' ? 'customer' : 'driver';
  let parties;
  try {
    assertCallable(trip, from);
    parties = resolveParties(trip);
    await assertRateLimit(trip._id);
  } catch (err) {
    if (!(err instanceof TripCallError)) throw err;
    console.info(`[trip-calls] dialpad call refused trip=${trip._id} from=${from} code=${err.code}`);
    if (err.code === 'TRIP_COMPLETED' || err.code === 'TRIP_CANCELLED') return speak('TRIP_ENDED', err.code);
    if (err.code === 'DRIVER_NOT_CONFIRMED') return speak('NOT_CONFIRMED', err.code);
    if (err.code === 'RATE_LIMITED') return speak('RATE_LIMITED', err.code);
    return speak('CANNOT_CONNECT', err.code);
  }

  const { driverPhone, customerPhone } = parties;
  const log = await CallLog.create({
    direction    : 'outbound', // as every trip call: CRM "incoming" stats and the callback queue never count it
    provider     : 'plivo',
    channel      : DIALPAD,
    callerId     : masking,
    status       : 'ringing',
    context      : 'trip',
    trip         : trip._id,
    tripMasked   : true,
    tripCallFrom : from,
    firstLeg     : from === 'driver' ? 'agent' : 'customer',
    agentType    : 'driver',
    agentUser    : trip.driver._id,
    agentName    : trip.driver.name,
    agentPhone   : driverPhone,
    customerPhone,
    providerCallId: params.CallUUID || undefined,
    flow         : [`dialpad:${from}_dialled→ringing_${other}`],
  });
  console.info(`[trip-calls] dialpad bridge log=${log._id} trip=${trip._id} from=${from} ringing=${other}`);

  return {
    xml: plivo.bridgeXml({
      numbers     : [from === 'driver' ? customerPhone : driverPhone],
      logId       : log._id,
      callerId    : masking,
      timeout     : dialRingSeconds(),
      timeLimit   : maxSeconds(),
      actionPath  : DIAL_ACTION_PATH,
      callbackPath: DIAL_EVENT_PATH,
    }),
    outcome: 'BRIDGED',
    logId  : log._id,
  };
}

const loadDialpadLog = async (logId) => {
  if (!logId || !/^[0-9a-f]{24}$/i.test(String(logId))) return null;
  const log = await CallLog.findById(logId);
  return log && log.channel === DIALPAD ? log : null;
};

const hangUp = (uuid, why) => (uuid
  ? plivo.hangupCall(uuid).catch((err) => {
    if (err?.response?.status !== 404) console.warn(`[trip-calls] dialpad hang-up (${why}) failed:`, err?.response?.status || err?.message || err);
  })
  : Promise.resolve());

/**
 * The Dial's live report (callbackUrl). DialAction=answer: the other side
 * picked up. Connect only if the trip is still callable and this driver is
 * still on it; otherwise (it ended while the phone rang) hang up.
 */
async function dialpadDialEvent(logId, params = {}) {
  const log = await loadDialpadLog(logId);
  if (!log) return 'NO_LOG';
  if (String(params.DialAction || '').toLowerCase() !== 'answer') return 'IGNORED';

  const trip = log.trip ? await Trip.findById(log.trip).select('status driver driverConfirmed') : null;
  let ok = !!trip && String(trip.driver || '') === String(log.agentUser || '');
  if (ok) {
    try {
      assertCallable(trip, log.tripCallFrom);
    } catch (err) {
      if (!(err instanceof TripCallError)) throw err;
      ok = false;
    }
  }

  if (ok) {
    const r = await CallLog.updateOne({ _id: log._id, status: 'ringing' }, {
      $set : { status: CONNECTED, answeredAt: new Date(), ...(params.DialBLegUUID ? { customerLegId: params.DialBLegUUID } : {}) },
      $push: { flow: 'dialpad:answered→connected' },
    });
    if (changed(r)) return 'CONNECTED';
    // Not ringing any more. If the trip-end hook stopped it a moment ago,
    // make sure it does not connect.
    if (log.status !== 'blocked_trip_inactive') {
      const fresh = await CallLog.findById(log._id).select('status');
      if (fresh?.status !== 'blocked_trip_inactive') return 'IGNORED';
    }
  } else {
    await CallLog.updateOne({ _id: log._id, status: { $in: ['ringing', CONNECTED] } }, {
      $set : { status: 'blocked_trip_inactive' },
      $push: { flow: 'dialpad:answered_after_trip_end→hung_up' },
    });
  }
  await hangUp(log.providerCallId, 'answered after trip end');
  return 'HUNG_UP';
}

const DIAL_FAIL_CUSTOMER = { busy: 'customer_busy', 'no-answer': 'customer_missed', timeout: 'customer_missed', failed: 'customer_failed' };
const LIVE = ['ringing', CONNECTED];

/**
 * The Dial's action: it is over. Records the outcome; what it returns is
 * what the caller hears last.
 */
async function dialpadDialFinished(logId, params = {}) {
  const log = await loadDialpadLog(logId);
  if (!log) return { xml: plivo.hangupXml(), outcome: 'NO_LOG' };
  const dialStatus = String(params.DialStatus || '').toLowerCase();
  const legCause = params.DialBLegHangupCause || params.DialHangupCause;
  const other = log.tripCallFrom === 'driver' ? 'customer' : 'driver';

  if (dialStatus === 'completed') {
    const talk = Number(params.DialBLegDuration ?? params.DialBLegBillDuration);
    // Talked. Also replaces an end status a hang-up report set first. Never
    // a call stopped while RINGING at trip end -- that one did not connect.
    await CallLog.updateOne({ _id: log._id, status: { $in: [...LIVE, 'completed', 'cancelled'] } }, {
      $set: {
        status: 'completed',
        ...(Number.isFinite(talk) ? { talkSec: talk } : {}),
        ...(!log.answeredAt && Number.isFinite(talk) ? { answeredAt: new Date(Date.now() - talk * 1000) } : {}),
        ...(params.DialBLegUUID ? { customerLegId: params.DialBLegUUID } : {}),
        ...(legCause ? { hangupCause: legCause } : {}),
      },
      $push: { flow: 'dialpad:call_completed' },
    });
    return { xml: plivo.hangupXml(), outcome: 'COMPLETED' };
  }

  if (log.status === 'blocked_trip_inactive') return { xml: plivo.hangupXml(), outcome: 'TRIP_ENDED' };

  if (dialStatus === 'cancel') {
    await CallLog.updateOne({ _id: log._id, status: { $in: LIVE } }, {
      $set : { status: 'cancelled' },
      $push: { flow: 'dialpad:caller_hung_up_while_ringing' },
    });
    return { xml: plivo.hangupXml(), outcome: 'CALLER_CANCELLED' };
  }

  const status = other === 'customer' ? (DIAL_FAIL_CUSTOMER[dialStatus] || 'customer_failed') : 'driver_unavailable';
  const r = await CallLog.updateOne({ _id: log._id, status: { $in: LIVE } }, {
    $set : { status, ...(legCause ? { hangupCause: legCause } : {}) },
    $push: { flow: `dialpad:${other}:${dialStatus || 'none'}→${status}` },
  });
  // Stopped at trip end between our read and this update: no "try again".
  if (!changed(r)) {
    const fresh = await CallLog.findById(log._id).select('status');
    if (fresh?.status === 'blocked_trip_inactive') return { xml: plivo.hangupXml(), outcome: 'TRIP_ENDED' };
  }
  console.info(`[trip-calls] dialpad ${other} did not answer log=${log._id} DialStatus=${dialStatus || '-'}`);
  return { ...speak('NO_ANSWER', 'NO_ANSWER', other) };
}

/**
 * The masking number's application hangup URL: the caller's leg has ended.
 * Found by CallUUID (the app-level URL carries no log id). Calls that never
 * got a row (unknown caller, refused) are ignored.
 */
async function dialpadCallEnded(params = {}) {
  const uuid = params.CallUUID;
  if (!uuid) return 'NO_LOG';
  const log = await CallLog.findOne({ providerCallId: uuid, channel: DIALPAD });
  if (!log) return 'NO_LOG';
  const total = Number(params.Duration ?? params.BillDuration);
  await CallLog.updateOne({ _id: log._id, endedAt: null }, {
    $set: {
      endedAt: new Date(),
      ...(Number.isFinite(total) ? { totalSec: total } : {}),
      ...(params.HangupCause && !log.hangupCause ? { hangupCause: params.HangupCause } : {}),
    },
  });
  // The Dial's own report may never come: settle what is still "live".
  await CallLog.updateOne({ _id: log._id, status: CONNECTED }, { $set: { status: 'completed' } });
  await CallLog.updateOne({ _id: log._id, status: 'ringing' }, {
    $set : { status: 'cancelled' },
    $push: { flow: 'dialpad:caller_hung_up_while_ringing' },
  });
  return 'ENDED';
}

/**
 * Trip completed or cancelled (controllers/tripController.js hook). A
 * dial-pad call whose other side is still RINGING is stopped so it never
 * connects; a CONNECTED call is left to run until someone hangs up. Never
 * throws.
 */
async function endRingingDialpadCalls(tripId, reason = 'ended') {
  try {
    const logs = await CallLog.find({ trip: tripId, channel: DIALPAD, status: 'ringing', endedAt: null }).select('_id providerCallId');
    let ringingEnded = 0;
    for (const l of logs || []) {
      const r = await CallLog.updateOne({ _id: l._id, status: 'ringing' }, {
        $set : { status: 'blocked_trip_inactive' },
        $push: { flow: `dialpad:trip_${reason}→ringing_call_ended` },
      });
      if (!changed(r)) continue; // picked up a moment ago -> connected, runs on
      ringingEnded += 1;
      await hangUp(l.providerCallId, `trip ${reason}`);
    }
    if (ringingEnded) console.info(`[trip-calls] trip ${tripId} ${reason}: ended ${ringingEnded} ringing dial-pad call(s)`);
    return { ringingEnded };
  } catch (err) {
    console.error('[trip-calls] ending ringing dial-pad calls failed:', err?.message || err);
    return { ringingEnded: 0, error: true };
  }
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
  // dial-pad flow
  DIALPAD_MESSAGES,
  dialRingSeconds,
  dedicatedMaskingNumber,
  callNumberFor,
  findCallerTrips,
  bridgeInbound,
  dialpadDialEvent,
  dialpadDialFinished,
  dialpadCallEnded,
  endRingingDialpadCalls,
};
