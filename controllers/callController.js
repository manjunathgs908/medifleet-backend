/**
 * controllers/callController.js
 * ============================================================
 * Masked, recorded calling through Plivo — mounted at /api/calls.
 *
 *   POST /click-to-call   an agent (driver, fleet owner, CRM staff) asks to
 *                         call a customer by trip / lead / quote / ref. Plivo
 *                         rings the AGENT; /answer then dials the customer.
 *   POST /answer          Plivo: the agent picked up -> bridge to customer.
 *   POST /incoming        Plivo application answer_url: a customer called
 *                         918065591088 -> ring CRM staff on call duty.
 *   POST /events          Plivo hangup_url and Dial action -> status.
 *   POST /recording       Plivo Record action/callback -> recording URL.
 *   GET  /logs            CRM call history (hasRecording, never the URL).
 *   GET  /:id/recording   streams a recording from Plivo (Basic Auth).
 *   GET/PUT /duty         CRM staff's own "On call duty" switch.
 *   GET/PUT /me           CRM staff's own call settings: ring number + duty.
 *   GET  /config          which provider is live and the caller ID it uses.
 *
 * The customer's number exists only here and in Plivo's XML. Clients send a
 * reference, never a number, and every response is the CallLog's JSON form,
 * which strips both numbers (models/CallLog.js). The Plivo webhooks check
 * Plivo's request signature before answering, because /answer's reply
 * contains the customer's number.
 *
 * Caller ID: every leg of every call here comes from PLIVO_NUMBER — the
 * call to the agent, the <Dial> to the customer, and incoming calls
 * forwarded to staff — and is recorded on the CallLog as callerId. There is
 * deliberately no Exotel fallback on these routes: an Exotel call would
 * show customers the Exotel number. Without Plivo configured they refuse.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const axios    = require('axios');
const { Trip, Lead, User } = require('../models');
const Ambulance    = require('../models/Ambulance');
const Quote        = require('../models/Quote');
const WhatsAppLead = require('../models/WhatsAppLead');
const CallLog      = require('../models/CallLog');
const CallbackTask = require('../models/CallbackTask');
const callbackQueue = require('../services/callbackQueue');
const WebrtcDebugEvent = require('../models/WebrtcDebugEvent');
const WebrtcEndpoint   = require('../models/WebrtcEndpoint');
const plivo        = require('../services/plivoService');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const { phoneFromRef, maskPhone } = require('../utils/customerPhone');
const { phoneLegVerdict } = require('../utils/phoneLegVerdict');
const { ACTIVE_STATUSES, MAX_LIVE_MS, callHasEnded, liveStateOf, PLIVO_CHECK_AFTER_MS } = require('../utils/callLiveness');

// Statuses during which a driver or partner may still reach the customer.
const ACTIVE_TRIP_STATUSES = ['booked', 'dispatched', 'en_route'];
const MAX_INCOMING_AGENTS = 10;

const isMobile = (raw) => /^[6-9]\d{9}$/.test(normalisePhone(raw));
const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);

const sendXml = (res, body) => res.type('text/xml').send(body);

// The phone Plivo rings for a User: their own call ring number when set,
// otherwise the login number. (Fleet Owners have only the one number.)
const ringPhoneOf = (u) => (u?.callPhone && isMobile(u.callPhone) ? u.callPhone : u?.phone);

// Who is asking, and from which phone Plivo should ring them.
function agentOf(req) {
  if (req.actorType === 'owner') {
    return { type: 'fleet_owner', owner: req.user._id, name: req.user.name, phone: req.user.phone };
  }
  return {
    type : req.user.role === 'driver' ? 'driver' : 'staff',
    user : req.user._id,
    name : req.user.name,
    phone: ringPhoneOf(req.user),
  };
}

// An open CRM tab checks in every 30s; two missed check-ins and it counts
// as closed (its user is rung on their phone instead).
const APP_ONLINE_WINDOW_MS = 75 * 1000;
const isAppOnline = (u) => !!u.appOnlineAt && Date.now() - new Date(u.appOnlineAt).getTime() < APP_ONLINE_WINDOW_MS;

const isFresh = (at) => !!at && Date.now() - new Date(at).getTime() < APP_ONLINE_WINDOW_MS;

// The in-app endpoints to ring for one user: every one of their devices
// that is online (WebrtcEndpoint, one per device), plus the older shared
// per-user endpoint while a not-yet-updated CRM is still using it.
function appEndpointsOf(u, devices = []) {
  const own = devices
    .filter((d) => String(d.user) === String(u._id) && isFresh(d.onlineAt))
    .map((d) => d.username);
  if (u.plivoEndpointUsername && isAppOnline(u)) own.push(u.plivoEndpointUsername);
  return [...new Set(own)];
}

// Splits on-duty users into in-app endpoints to ring and phones to ring.
// An in-app user with several devices online is rung on ALL of them at
// once, so whichever screen they are at shows the Answer screen.
function routeIncoming(users, devices = []) {
  const sipUsers = [];
  const phones = [];
  for (const u of users) {
    const own = u.callMode === 'app' ? appEndpointsOf(u, devices) : [];
    if (own.length) sipUsers.push(...own);
    else if (isMobile(ringPhoneOf(u))) phones.push(ringPhoneOf(u));
  }
  return { sipUsers: [...new Set(sipUsers)], phones };
}
exports.routeIncoming = routeIncoming;

// Online device endpoints for the in-app users among `users`.
const loadOnlineDevices = (users) => {
  const ids = users.filter((u) => u.callMode === 'app').map((u) => u._id);
  if (!ids.length) return Promise.resolve([]);
  return WebrtcEndpoint.find({ user: { $in: ids }, onlineAt: { $gte: new Date(Date.now() - APP_ONLINE_WINDOW_MS) } })
    .select('user username device onlineAt deviceKey').lean();
};

// TEMPORARY: server-side steps of a call's delivery, stored with the
// browsers' own events so GET /api/calls/:id/trail can show one timeline.
// Never allowed to break routing: any failure, sync or async, is dropped.
const serverTrail = (event, detail) => {
  try {
    Promise.resolve(WebrtcDebugEvent.create({ event, detail, at: new Date() })).catch(() => {});
  } catch { /* diagnostics only */ }
};

// Every on-duty user's phone — in-app users included — for when nobody
// answers in the app. Then PLIVO_FALLBACK_AGENTS if nobody has one.
// Each subscriber once, however the number is written ("9986844442" and
// "+91 99868 44442" are one phone — two <Number>s for it in one Dial would
// ring it once and get USER_BUSY on the other). Never the caller's own
// number: ringing the phone that is making the call is busy by definition.
function fallbackPhones(users, callerPhone, { envFallback = true } = {}) {
  const caller = normalisePhone(callerPhone);
  const seen = new Set();
  const pick = (list) => list.filter((p) => {
    const n = normalisePhone(p);
    if (!isMobile(p) || seen.has(n) || (caller && n === caller)) return false;
    seen.add(n);
    return true;
  });
  let phones = pick(users.map(ringPhoneOf));
  if (!phones.length && envFallback) {
    phones = pick(String(process.env.PLIVO_FALLBACK_AGENTS || '').split(',').map((s) => s.trim()));
  }
  return phones.slice(0, MAX_INCOMING_AGENTS);
}
exports.fallbackPhones = fallbackPhones;

const callerIsRingPhone = (users, callerPhone) => {
  const caller = normalisePhone(callerPhone);
  return !!caller && users.some((u) => normalisePhone(ringPhoneOf(u)) === caller);
};

// For the call log: whose ring number called in, and — when skipping it
// left no other phone to ring — why nothing rang. Masked number only.
function skippedCallerNote(users, callerPhone, otherPhones) {
  const caller = normalisePhone(callerPhone);
  const owners = users.filter((u) => normalisePhone(ringPhoneOf(u)) === caller).map((u) => u.name).filter(Boolean);
  const masked = maskPhone(caller);
  return {
    ringPhone  : masked,
    ringPhoneOf: owners,
    otherPhones,
    leftNobody : otherPhones === 0,
    message    : otherPhones === 0
      ? `Did not ring ${masked}${owners.length ? ` (${owners.join(', ')}'s ring number)` : ''} — it was the number that called in, and no other phone was on duty. Test from a different phone, or use "Ring my phone now".`
      : `Did not ring ${masked} — it was the number that called in. Rang the other ${otherPhones} on-duty phone(s).`,
  };
}

// ── Phone legs: overlap check and stuck-leg clean-up ──────────────────────
// A leg Plivo still shows "ringing" this long after it started is stuck:
// no Dial of ours rings longer than PHONE_RING_SECONDS, and Plivo gives up
// on an unanswered outbound first leg at 60s. Only RINGING legs are ever
// hung up automatically — a connected conversation never is.
const STUCK_RINGING_SEC = Math.max(plivo.PHONE_RING_SECONDS, 60) + 30;

const legAgeSec = (c) => {
  const t = c?.session_start ? new Date(c.session_start).getTime() : NaN;
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
};
const isRinging = (c) => String(c?.call_status || '').toLowerCase() === 'ringing';

async function hangupLegs(uuids, why) {
  const done = [];
  for (const uuid of uuids) {
    try {
      await plivo.hangupCall(uuid);
      done.push(uuid);
      console.warn(`[calls] auto hang-up of leg ${uuid}: ${why}`);
    } catch (err) {
      const { status } = plivoErrorDetail(err);
      if (status !== 404) console.error(`[calls] auto hang-up of leg ${uuid} failed (status ${status ?? '-'})`);
    }
  }
  return done;
}

const stuckLegs = (live) => live.calls
  .filter((c) => isRinging(c) && (legAgeSec(c) ?? 0) >= STUCK_RINGING_SEC)
  .map((c) => c.callUuid);

// Run right after a phone <Dial> goes out — after Plivo has its XML, so it
// never delays the call. Records on the log whether anything of ours was
// already on one of those numbers: another call log still ringing it (or an
// outbound call ringing it as the agent), or a live Plivo leg to it that
// started before this dial. Also hangs up stuck ringing legs.
async function recordPhoneDial(logId, phones, { callerWasRingPhone = false } = {}) {
  const dialAt = new Date();
  const targets = phones.map(normalisePhone);
  const overlap = {
    dialAt,
    phones: phones.map(maskPhone),
    callerIsRingPhone: callerWasRingPhone,
    ourCalls: [],
    liveLegs: [],
  };
  try {
    const others = await CallLog.find({
      _id: { $ne: logId },
      startedAt: { $gte: new Date(dialAt.getTime() - 10 * 60 * 1000) },
      $or: [
        { direction: 'inbound', status: 'ringing', dialledPhones: { $in: targets } },
        { direction: 'outbound', status: { $in: ['initiated', 'agent_answered'] }, agentPhone: { $in: targets } },
      ],
    }).select('_id direction status startedAt').lean();
    overlap.ourCalls = (others || []).map((o) => ({
      logId: o._id, direction: o.direction, status: o.status,
      ageSec: o.startedAt ? Math.round((dialAt - new Date(o.startedAt)) / 1000) : null,
    }));
  } catch {
    overlap.ourCallsCheck = 'failed';
  }
  try {
    const live = await plivo.listLiveCalls();
    overlap.liveTotal = live.total;
    // Started 3s+ before this dial, so it cannot be this call's own leg.
    overlap.liveLegs = live.calls
      .filter((c) => targets.includes(normalisePhone(c.to)) && legAgeSec(c) != null
        && legAgeSec(c) * 1000 > Date.now() - dialAt.getTime() + 3000)
      .map((c) => ({ callUuid: c.callUuid, to: maskPhone(c.to), status: c.call_status || null, ageSec: legAgeSec(c) }));
    overlap.autoHungUp = await hangupLegs(stuckLegs(live), `ringing over ${STUCK_RINGING_SEC}s`);
  } catch (err) {
    overlap.liveCheck = `failed (status ${plivoErrorDetail(err).status ?? '-'})`;
  }
  await CallLog.updateOne({ _id: logId }, { $set: { overlap } });
  if (overlap.ourCalls.length || overlap.liveLegs.length) {
    console.warn(`[calls] log=${logId} dialled a phone that already had ${overlap.ourCalls.length} call(s) / ${overlap.liveLegs.length} live leg(s) of ours on it`);
  }
  return overlap;
}
exports.recordPhoneDial = recordPhoneDial;

// When an incoming call ends: any leg of it Plivo still has up is released
// — its connected phone leg (DialBLegUUID), and any leg still ringing one of
// the phones it dialled that started with its Dial, unless another call of
// ours is ringing that number right now. Plus the stuck-leg sweep.
async function releaseLegs(logId) {
  const log = await CallLog.findById(logId).select('+dialledPhones customerLegId overlap').lean();
  if (!log) return [];
  const live = await plivo.listLiveCalls();
  const uuids = new Set(stuckLegs(live));
  const liveIds = new Set(live.calls.map((c) => c.callUuid));
  if (log.customerLegId && liveIds.has(log.customerLegId)) uuids.add(log.customerLegId);

  const dialled = log.dialledPhones || [];
  const dialAt = log.overlap?.dialAt ? new Date(log.overlap.dialAt).getTime() : null;
  if (dialled.length && dialAt) {
    const busyElsewhere = await CallLog.find({
      _id: { $ne: logId }, direction: 'inbound', status: 'ringing', dialledPhones: { $in: dialled },
    }).select('+dialledPhones').lean();
    const shared = new Set((busyElsewhere || []).flatMap((o) => o.dialledPhones || []));
    for (const c of live.calls) {
      const to = normalisePhone(c.to);
      const age = legAgeSec(c);
      if (isRinging(c) && dialled.includes(to) && !shared.has(to) && age != null && Date.now() - age * 1000 >= dialAt - 2000) {
        uuids.add(c.callUuid);
      }
    }
  }
  const done = await hangupLegs([...uuids], `outlived call log=${logId}`);
  if (done.length) await CallLog.updateOne({ _id: logId }, { $set: { 'overlap.releasedAtHangup': done } });
  return done;
}
exports.releaseLegs = releaseLegs;

// CRM admins and telecallers on call duty.
const loadOnDuty = () => User.find({ role: { $in: ['owner', 'telecaller'] }, isActive: true, callDuty: true })
  .select('name role phone callPhone callMode speaksEnglish appOnlineAt +plivoEndpointUsername +plivoEndpointId')
  .limit(MAX_INCOMING_AGENTS).lean();
exports.loadOnDuty = loadOnDuty; // also the AI telecaller's human handoff

// The on-duty owner/telecaller whose ring phone is this number, if any.
async function whoseRingPhone(raw) {
  const ten = normalisePhone(raw);
  if (ten.length !== 10) return null;
  const onDuty = await loadOnDuty();
  return (onDuty || []).find((u) => normalisePhone(ringPhoneOf(u)) === ten) || null;
}

// TEMPORARY diagnostic: Plivo's record of each in-app user's endpoint at
// the moment a call is routed to it, saved onto the call's routing.
async function snapshotEndpoints(logId, onDuty) {
  const appUsers = onDuty.filter((u) => u.callMode === 'app' && u.plivoEndpointId);
  if (!appUsers.length) return;
  const appExpected = await plivo.applicationId().catch(() => null);
  const atCall = await Promise.all(appUsers.map(async (u) => {
    try {
      const ep = await plivo.getEndpoint(u.plivoEndpointId);
      return {
        user            : u._id,
        plivoUsernameMatchesDialled: ep.username === u.plivoEndpointUsername,
        dialledLength   : (u.plivoEndpointUsername || '').length,
        plivoLength     : (ep.username || '').length,
        sipRegistered   : ep.sipRegistered,
        sipUserAgent    : ep.sipUserAgent,
        sipExpires      : ep.sipExpires,
        appLinked       : ep.appId,
        appExpected     : appExpected || null,
      };
    } catch (err) {
      return { user: u._id, error: `Plivo endpoint lookup failed (status ${plivoErrorDetail(err).status ?? '-'})` };
    }
  }));
  await CallLog.updateOne({ _id: logId }, { $set: { 'routing.plivoEndpointsAtCall': atCall } });
}

// Plivo's hang-up fields for a whole call (hangup_url), for the
// diagnostics. Numbers masked.
const HANGUP_FIELDS = ['CallStatus', 'HangupCause', 'HangupCauseCode', 'HangupCauseName', 'HangupSource', 'Duration', 'BillDuration', 'AnswerTime', 'EndTime', 'Direction'];
function hangupDetail(b) {
  const out = {};
  for (const k of HANGUP_FIELDS) if (b?.[k] != null && b[k] !== '') out[k] = b[k];
  out.receivedAt = new Date();
  return out;
}

// Plivo's Dial result fields, for the diagnostics. Anything that looks like
// a phone number is masked.
function dialResult(b) {
  const out = {};
  for (const [k, v] of Object.entries(b || {})) {
    if (!k.startsWith('Dial')) continue;
    out[k] = /^\+?\d{10,15}$/.test(String(v)) ? maskPhone(v) : v;
  }
  out.receivedAt = new Date();
  return out;
}

const BUSY_MESSAGE = 'Thank you for calling SaveLife. All our team members are busy right now. Please call again in a few minutes, or message us on WhatsApp.';

// Heard only by someone calling in FROM an on-duty ring number when that
// left no phone to ring — staff testing, never a customer.
const SELF_CALL_MESSAGE = 'You are calling from a SaveLife ring number, so this call was not forwarded to it, and no other phone is on duty. To test your phone, use Ring my phone now in the CRM, or call from a different phone.';

const NOT_CONFIGURED ='Calling is not set up: PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_NUMBER (91 followed by 10 digits) are needed on the server.';

// Logs the call, then has Plivo ring the first party from PLIVO_NUMBER.
// Shared by click-to-call and the legacy /api/call/connect, so there is one
// way a masked call gets placed. Returns { log } or { log, error }.
async function placePlivoCall(fields, firstPhone) {
  const log = await CallLog.create({
    ...fields,
    provider: 'plivo',
    callerId: plivo.companyNumber(),
    status  : 'initiated',
  });
  try {
    const { requestId } = await plivo.callFirstLeg({ phone: firstPhone, logId: log._id });
    log.providerRequestId = requestId;
    await log.save();
    plivo.logCall('outbound placed', log);
    return { log };
  } catch (plivoErr) {
    console.error('[calls] Plivo call failed:', plivoErr?.message || plivoErr);
    log.status = 'failed';
    log.error = String(plivoErr?.message || plivoErr).slice(0, 500);
    log.endedAt = new Date();
    await log.save();
    return { log, error: plivo.friendlyError(plivoErr) };
  }
}
exports.placePlivoCall = placePlivoCall;
exports.ringPhoneOf = ringPhoneOf;

class CallError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Resolves the customer for a click-to-call, enforcing who may call whom:
// a driver only the customer of a live trip assigned to them, a fleet owner
// only on their own ambulances, CRM staff anyone the CRM shows them.
async function resolveCustomer(req, agent) {
  const { tripId, leadId, quoteId, whatsappLeadId, customerRef, callLogId, callbackTaskId } = req.body || {};

  if (tripId) {
    const query = isObjectId(String(tripId)) ? { _id: tripId } : { tripNumber: String(tripId) };
    const trip = await Trip.findOne(query).select('patientPhone driver ambulance status tripNumber');
    if (!trip) throw new CallError(404, 'Trip not found.');

    if (agent.type === 'driver') {
      if (String(trip.driver) !== String(agent.user)) throw new CallError(403, 'This trip is not assigned to you.');
      if (!ACTIVE_TRIP_STATUSES.includes(trip.status)) throw new CallError(400, 'You can only call the customer on an active trip.');
    }
    if (agent.type === 'fleet_owner') {
      const mine = trip.ambulance && await Ambulance.exists({ _id: trip.ambulance, owner: agent.owner });
      if (!mine) throw new CallError(404, 'Trip not found.');
    }
    return { phone: trip.patientPhone, context: 'trip', refs: { trip: trip._id } };
  }

  // Everything below is CRM-only.
  if (agent.type !== 'staff') throw new CallError(400, 'A trip is required to call a customer.');

  if (leadId) {
    if (!isObjectId(String(leadId))) throw new CallError(404, 'Lead not found.');
    const lead = await Lead.findById(leadId).select('phone');
    if (!lead) throw new CallError(404, 'Lead not found.');
    return { phone: lead.phone, context: 'lead', refs: { lead: lead._id } };
  }
  if (quoteId) {
    if (!isObjectId(String(quoteId))) throw new CallError(404, 'Quote not found.');
    const quote = await Quote.findById(quoteId).select('phone trip');
    if (!quote) throw new CallError(404, 'Quote not found.');
    return { phone: quote.phone, context: 'quote', refs: { quote: quote._id, trip: quote.trip || undefined } };
  }
  if (whatsappLeadId) {
    if (!isObjectId(String(whatsappLeadId))) throw new CallError(404, 'Lead not found.');
    const wl = await WhatsAppLead.findById(whatsappLeadId).select('phone');
    if (!wl) throw new CallError(404, 'Lead not found.');
    return { phone: wl.phone, context: 'whatsapp_lead', refs: { whatsappLead: wl._id } };
  }
  if (callbackTaskId) {
    // "Call back" from the callback queue. Only places the call: the task
    // stays open until a person resolves it; this call is listed on it as
    // an attempt (callbackTask).
    if (!isObjectId(String(callbackTaskId))) throw new CallError(404, 'Callback not found.');
    const task = await CallbackTask.findById(callbackTaskId).select('+customerPhone trip lead');
    if (!task?.customerPhone) throw new CallError(404, 'Callback not found.');
    return { phone: task.customerPhone, context: 'call_back', refs: { trip: task.trip, lead: task.lead, callbackTask: task._id } };
  }
  if (callLogId) {
    // "Call back" from the call history -- typically a missed incoming call.
    if (!isObjectId(String(callLogId))) throw new CallError(404, 'Call not found.');
    const prior = await CallLog.findById(callLogId).select('+customerPhone trip lead callbackTask');
    if (!prior?.customerPhone) throw new CallError(404, 'Call not found.');
    // A missed call still waiting in the callback queue: this call counts
    // as an attempt on that task (it does not resolve it).
    const openTask = prior.callbackTask && await CallbackTask.exists({ _id: prior.callbackTask, state: 'open' });
    return { phone: prior.customerPhone, context: 'call_back', refs: { trip: prior.trip, lead: prior.lead, ...(openTask ? { callbackTask: prior.callbackTask } : {}) } };
  }
  if (customerRef) {
    const phone = phoneFromRef(customerRef);
    if (!phone) throw new CallError(400, 'Unknown customer reference.');
    return { phone, context: 'whatsapp', refs: {} };
  }
  throw new CallError(400, 'Say who to call: tripId, leadId, quoteId, whatsappLeadId, callLogId or customerRef.');
}


// ============================================================
// @route   POST /api/calls/click-to-call
// @access  Private [driver | fleet owner | CRM staff]
// ============================================================
exports.clickToCall = async (req, res, next) => {
  try {
    const agent = agentOf(req);
    let customer;
    try {
      customer = await resolveCustomer(req, agent);
    } catch (err) {
      if (err instanceof CallError) return res.status(err.status).json({ success: false, message: err.message });
      throw err;
    }

    if (!isMobile(agent.phone)) {
      return res.status(400).json({ success: false, message: 'Your account has no valid mobile number to ring. Set your call ring number on the Staff page.' });
    }
    if (!isMobile(customer.phone)) {
      return res.status(400).json({ success: false, message: 'This customer has no valid mobile number on record.' });
    }

    // Plivo only. No Exotel fallback here: it would show the customer the
    // Exotel number instead of PLIVO_NUMBER.
    if (!plivo.isConfigured()) {
      return res.status(503).json({ success: false, message: NOT_CONFIGURED });
    }

    const { log, error } = await placePlivoCall({
      direction    : 'outbound',
      firstLeg     : 'agent',
      agentType    : agent.type,
      agentUser    : agent.user,
      agentOwner   : agent.owner,
      agentName    : agent.name,
      agentPhone   : normalisePhone(agent.phone),
      customerPhone: normalisePhone(customer.phone),
      context      : customer.context,
      ...customer.refs,
    }, agent.phone);

    if (error) return res.status(502).json({ success: false, message: error, callLogId: log._id });
    return res.json({
      success  : true,
      provider : 'plivo',
      callerId : log.callerId,
      callLogId: log._id,
      message  : 'Your phone will ring now from 918065591088. Answer it and we will connect you to the customer.',
    });
  } catch (err) {
    next(err);
  }
};


// ── Plivo webhooks ─────────────────────────────────────────────────────────
// Every hit is logged and counted BEFORE the signature check, so "Plivo
// never called us" and "Plivo called us and we refused it" can be told
// apart — from the Render log, or from the CRM via GET /api/calls/config.
// In memory: it covers this server process since its last deploy, which is
// the window anyone checking "did the call just now reach us?" needs.
const WEBHOOKS = ['answer', 'incoming', 'events', 'recording', 'transfer-answer', 'dial-event'];
const SERVER_STARTED_AT = new Date();
const webhookStats = Object.fromEntries(WEBHOOKS.map((w) => [w, {
  hits: 0, accepted: 0, rejected: 0, lastHitAt: null, lastAcceptedAt: null, lastRejectedAt: null, lastRejectReason: null,
}]));
exports.webhookStats = webhookStats;

const webhookName = (req) => String(req.path || '').replace(/^\/+|\/+$/g, '') || 'unknown';

// Signed by Plivo; anything else gets a 403 and no XML.
exports.requirePlivoSignature = (req, res, next) => {
  const name = webhookName(req);
  const stats = webhookStats[name];
  const b = plivoParams(req);
  console.info(`[calls] ${name} webhook hit method=${req.method} callUUID=${b.CallUUID || '-'} direction=${b.Direction || '-'} status=${b.CallStatus || b.DialStatus || '-'} log=${req.query?.log || '-'}`);
  if (stats) { stats.hits += 1; stats.lastHitAt = new Date(); }

  const check = plivo.checkSignature(req);
  if (check.ok) {
    if (stats) { stats.accepted += 1; stats.lastAcceptedAt = new Date(); }
    return next();
  }
  console.warn(`[calls] ${name} webhook REJECTED: ${check.reason}`);
  if (stats) { stats.rejected += 1; stats.lastRejectedAt = new Date(); stats.lastRejectReason = check.reason; }
  return res.status(403).type('text/plain').send('Forbidden');
};

// Plivo sends its fields in the body for POST and in the query for GET --
// whichever the Plivo console is set to.
const plivoParams = (req) => (req.method === 'POST' ? (req.body || {}) : (req.query || {}));

const logIdOf = (req) => (isObjectId(String(req.query.log || '')) ? String(req.query.log) : null);


// ============================================================
// @route   POST /api/calls/answer?log=<id>
// @desc    The first party answered Plivo's call. Dial the other one —
//          normally the customer; the driver when the customer started it
//          (legacy tracking-page call) — from PLIVO_NUMBER, recorded.
// @access  Plivo (signature)
// ============================================================
exports.answer = async (req, res, next) => {
  try {
    const logId = logIdOf(req);
    const log = logId ? await CallLog.findById(logId).select('+customerPhone +agentPhone') : null;
    const other = log?.firstLeg === 'customer' ? log?.agentPhone : log?.customerPhone;
    if (!other || log.direction !== 'outbound') {
      return sendXml(res, plivo.speakXml('Sorry, this call could not be connected.'));
    }

    log.answeredAt = new Date();
    if (plivoParams(req).CallUUID) log.providerCallId = plivoParams(req).CallUUID;
    await log.save();
    await setStatusIf(log, 'agent_answered', { $in: ['initiated'] });

    return sendXml(res, plivo.bridgeXml({ numbers: [other], logId: log._id }));
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/calls/incoming
// @desc    A customer called the company number. Ring every CRM user on
//          call duty at once; the first to answer takes it. Nobody on
//          duty -> PLIVO_FALLBACK_AGENTS (comma-separated numbers).
// @access  Plivo (signature) — set as the Plivo Application's answer_url
// ============================================================
exports.incoming = async (req, res, next) => {
  try {
    // Our in-app endpoints share this application, so a call PLACED from a
    // browser would arrive here as if a customer were calling. The CRM never
    // dials from the browser (outbound is server click-to-call), so such a
    // call is turned away instead of ringing staff and holding legs open.
    const rawFrom = String(plivoParams(req).From || '');
    if (/^sip:/i.test(rawFrom)) {
      console.warn(`[calls] incoming from a SIP endpoint (browser-originated) — hung up, not routed. callUUID=${plivoParams(req).CallUUID || '-'}`);
      return sendXml(res, plivo.hangupXml());
    }

    const from = normalisePhone(rawFrom);

    // Link it to what we know about this caller, so the CRM's call history
    // shows "Trip TRP-…" rather than a bare masked number.
    const [trip, lead] = from.length === 10 ? await Promise.all([
      Trip.findOne({ patientPhone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
      Lead.findOne({ phone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
    ]) : [null, null];

    // Two stages, so a call is never dropped because an app wasn't there:
    //   1. In-app users whose CRM is checking in ring in the app for
    //      APP_RING_SECONDS (first to answer takes it).
    //   2. If nobody answers in the app — logged out, backgrounded and
    //      asleep, offline, mic blocked, anything — the Dial's action
    //      (/events, stage=app) rings every on-duty phone instead, in-app
    //      users' own phones included.
    // With nobody online in the app, stage 2 runs straight away. All legs
    // show PLIVO_NUMBER as the caller and are recorded.
    const onDuty = await loadOnDuty();
    const devices = await loadOnlineDevices(onDuty);
    const { sipUsers } = routeIncoming(onDuty, devices);
    const agentPhones = fallbackPhones(onDuty, from);
    const callerWasRingPhone = callerIsRingPhone(onDuty, from);
    const ringing = agentPhones.length + sipUsers.length;

    // TEMPORARY diagnostic: the decision and its inputs, per in-app user.
    const routing = {
      decision : !ringing ? 'none' : sipUsers.length ? 'app_then_phone' : 'phone',
      decidedAt: new Date(),
      onDuty   : onDuty.length,
      phones   : agentPhones.length,
      // The phones the phone <Dial> rings (masked) — now, or after the app
      // stage. With phoneLeg's DialStatus/DialHangupCause this tells
      // "the phone was busy" apart from "the phone was never dialled".
      phoneTargets: agentPhones.map(maskPhone),
      // The caller is one of the ring numbers (e.g. a test call from it):
      // that number is left out of this call's phone Dial.
      callerIsRingPhone: callerWasRingPhone,
      // Only when no app rings first: then whether skipping it left nobody.
      ...(callerWasRingPhone && !sipUsers.length ? { skippedCaller: skippedCallerNote(onDuty, from, agentPhones.length) } : {}),
      dutyUsers   : onDuty.map((u) => ({
        user          : u._id,
        name          : u.name,
        callMode      : u.callMode || 'phone',
        ringPhone     : maskPhone(ringPhoneOf(u)),
        ringPhoneValid: isMobile(ringPhoneOf(u)),
      })),
      appUsers : onDuty.filter((u) => u.callMode === 'app').map((u) => ({
        user          : u._id,
        name          : u.name,
        appOnline     : appEndpointsOf(u, devices).length > 0,
        appOnlineAt   : u.appOnlineAt || null,
        hasEndpoint   : !!u.plivoEndpointUsername,
        // The older shared endpoint (only rung while a not-yet-updated CRM
        // checks in on it).
        sipUri        : u.plivoEndpointUsername ? plivo.sipUri(u.plivoEndpointUsername) : null,
        dialled       : sipUsers.includes(u.plivoEndpointUsername),
        // Each of this user's devices online right now — all rung together.
        devices       : devices.filter((d) => String(d.user) === String(u._id)).map((d) => ({
          device  : d.device,
          sipUri  : plivo.sipUri(d.username),
          onlineAt: d.onlineAt,
          dialled : sipUsers.includes(d.username),
        })),
      })),
    };

    const log = await CallLog.create({
      routing,
      flow   : [!ringing ? (callerWasRingPhone ? 'skipped_caller_ring_phone→busy_message' : 'busy_message') :sipUsers.length ? `app:${plivo.APP_RING_SECONDS}s` : `phones:${agentPhones.length}:${plivo.PHONE_RING_SECONDS}s`],
      provider     : 'plivo',
      callerId     : plivo.companyNumber(),
      direction    : 'inbound',
      context      : 'incoming',
      customerPhone: from || undefined,
      providerCallId: plivoParams(req).CallUUID,
      trip         : trip?._id,
      lead         : lead?._id,
      status       : ringing ? 'ringing' : 'no_agents',
      endedAt      : ringing ? undefined : new Date(),
      // Phones go straight into this call's Dial only when no app rings first.
      dialledPhones: ringing && !sipUsers.length ? agentPhones.map(normalisePhone) : undefined,
      // A customer's call, so a miss goes to the callback queue — not a
      // staff member testing from their own ring phone.
      callbackEligible: isMobile(from) && !callerWasRingPhone ? true : undefined,
    });
    plivo.logCall(`inbound app=${sipUsers.length} phones=${agentPhones.length} stage=${sipUsers.length ? 'app' : 'phone'}`, log);
    serverTrail('server:incoming_routed', {
      logId   : String(log._id),
      decision: routing.decision,
      appEndpoints: devices.filter((d) => sipUsers.includes(d.username)).map((d) => ({ device: d.device, deviceKey: d.deviceKey }))
        .concat(onDuty.filter((u) => u.plivoEndpointUsername && sipUsers.includes(u.plivoEndpointUsername)).map((u) => ({ device: 'shared endpoint (older CRM build)', user: u.name }))),
      phones  : agentPhones.length,
    });

    if (!ringing) return sendXml(res, plivo.speakXml(callerWasRingPhone ? SELF_CALL_MESSAGE : BUSY_MESSAGE));
    if (sipUsers.length) {
      sendXml(res, plivo.bridgeXml({ sipUsers, logId: log._id, stage: 'app', timeout: plivo.APP_RING_SECONDS }));
      // After answering Plivo, so it cannot delay the call: Plivo's own view
      // of each in-app endpoint right now — registered or not, its user
      // agent, its application.
      snapshotEndpoints(log._id, onDuty).catch(() => {});
      return undefined;
    }
    sendXml(res, plivo.bridgeXml({ numbers: agentPhones, logId: log._id, stage: 'phone' }));
    recordPhoneDial(log._id, agentPhones, { callerWasRingPhone }).catch(() => {});
    return undefined;
  } catch (err) {
    next(err);
  }
};


// Status and end time are written ONLY by these single conditional updates,
// never by log.save(): two Plivo webhooks handled at the same moment each
// load the call, and a plain save of the later one would overwrite the
// other's outcome. The condition is checked by MongoDB atomically, so a
// final outcome cannot be reopened. The in-memory log follows only when the
// update applied.
async function setStatusIf(log, status, whenStatus) {
  const r = await CallLog.updateOne({ _id: log._id, status: whenStatus }, { $set: { status } });
  if (r?.matchedCount > 0) log.status = status;
  return r?.matchedCount > 0;
}
async function markEndedIfNot(log, at) {
  const r = await CallLog.updateOne({ _id: log._id, endedAt: null }, { $set: { endedAt: at } });
  if (r?.matchedCount > 0 && !log.endedAt) log.endedAt = at;
}

// Plivo's outcome words -> ours.
const AGENT_LEG_FAIL = { busy: 'agent_busy', 'no-answer': 'agent_missed', timeout: 'agent_missed', failed: 'failed', cancel: 'cancelled' };
const DIAL_FAIL      = { busy: 'customer_busy', 'no-answer': 'customer_missed', timeout: 'customer_missed', failed: 'customer_failed', cancel: 'cancelled' };

// ============================================================
// @route   POST /api/calls/events?log=<id>[&leg=dial]
// @desc    leg=dial: the <Dial> finished (DialStatus, talk time). Its reply
//          decides what the caller hears next. Otherwise: Plivo's
//          hangup_url for the whole call.
// @access  Plivo (signature)
// ============================================================
exports.events = async (req, res, next) => {
  try {
    const b = plivoParams(req);
    const logId = logIdOf(req);
    const log = logId
      ? await CallLog.findById(logId)
      : (b.CallUUID ? await CallLog.findOne({ providerCallId: b.CallUUID }) : null);

    if (req.query.leg === 'dial') {
      const dialStatus = String(b.DialStatus || '').toLowerCase();

      // The call was transferred from the CRM: this is the report of the
      // ORIGINAL Dial, which the transfer ended. It never rings phones or
      // hangs up — the customer's leg is on the transfer's XML now.
      if (log && ['app', 'phone'].includes(req.query.stage) && transferTookOver(log)) {
        return sendXml(res, await originalDialAfterTransfer(log, b, dialStatus, req.query.stage));
      }

      // Stage 1 (in-app) ended without an answer — for ANY reason, or with
      // no status at all. Never strand the caller: ring every on-duty phone
      // now. Only a completed app leg ends the call here.
      if (req.query.stage === 'app' && dialStatus !== 'completed') {
        // Plivo's hang-up for the whole call can arrive BEFORE this report
        // (the caller hung up while the app was ringing). The call is over:
        // don't set it back to "ringing" and don't dial phones for it — that
        // left calls stuck as Ringing with nothing ever reporting again.
        if (log && callHasEnded(log)) {
          log.appLeg = { sipUris: (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri), ...dialResult(b) };
          log.flow = [...(log.flow || []), `app:${dialStatus || 'none'}(after hangup — not redialled)`];
          await log.save();
          console.info(`[calls] in-app leg report after the call ended log=${logId} status=${log.status} — no phone dial`);
          return sendXml(res, plivo.hangupXml());
        }
        const onDuty = await loadOnDuty();
        const phones = fallbackPhones(onDuty, b.From);
        const callerWasRingPhone = callerIsRingPhone(onDuty, b.From);
        console.info(`[calls] in-app leg not answered (DialStatus=${dialStatus || '-'} cause=${b.DialHangupCause || b.DialBLegHangupCause || '-'}) log=${logId || '-'} — ringing ${phones.length} phone(s)`);
        if (log) {
          // TEMPORARY diagnostic: Plivo's verdict on the in-app leg.
          log.appLeg = {
            sipUris  : (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri),
            ...dialResult(b),
            fellBackToPhones: phones.length,
          };
          serverTrail('server:app_leg', { logId: String(log._id), DialStatus: dialStatus || null, DialHangupCause: b.DialHangupCause || b.DialBLegHangupCause || null, fellBackToPhones: phones.length });
          log.flow = [...(log.flow || []), `app:${dialStatus || 'none'}→${phones.length ? `phones:${phones.length}:${plivo.PHONE_RING_SECONDS}s` : callerWasRingPhone ? 'skipped_caller_ring_phone→busy_message' : 'busy_message'}`];
          if (callerWasRingPhone) log.routing = { ...(log.routing || {}), skippedCaller: skippedCallerNote(onDuty, b.From, phones.length) };
          if (b.DialBLegHangupCause) log.hangupCause = b.DialBLegHangupCause;
          if (phones.length) log.dialledPhones = phones.map(normalisePhone);
          await log.save();
          // Still active: it stays "ringing" while phones ring. Nobody to ring:
          // missed — unless a concurrent report already ended it.
          if (!phones.length) await setStatusIf(log, 'missed', { $in: ACTIVE_STATUSES });
        }
        if (phones.length && logId) {
          sendXml(res, plivo.bridgeXml({ numbers: phones, logId, stage: 'phone' }));
          recordPhoneDial(logId, phones, { callerWasRingPhone }).catch(() => {});
          return undefined;
        }
        return sendXml(res, plivo.speakXml(callerWasRingPhone ? SELF_CALL_MESSAGE : BUSY_MESSAGE));
      }

      if (log) {
        // TEMPORARY diagnostic: Plivo's verdict on whichever stage this was.
        if (req.query.stage === 'app') {
          log.appLeg = { sipUris: (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri), ...dialResult(b) };
          serverTrail('server:app_leg', { logId: String(log._id), DialStatus: dialStatus || null, answered: dialStatus === 'completed' });
        } else if (req.query.stage === 'phone') {
          log.phoneLeg = dialResult(b);
          const v = phoneLegVerdict(log.phoneLeg, log.overlap);
          console.info(`[calls] phone leg log=${logId} DialStatus=${dialStatus || '-'} DialRingStatus=${b.DialRingStatus ?? '-'} cause=${b.DialHangupCause || '-'} verdict=${v?.code}`);
        }
        const stage = req.query.stage || 'dial';
        const endsWithSorry = log.direction === 'inbound' && dialStatus && dialStatus !== 'completed';
        log.flow = [...(log.flow || []), `${stage}:${dialStatus === 'completed' ? 'answered' : (dialStatus || 'none')}${endsWithSorry ? '→sorry_message' : ''}`];
        let nextStatus = null;
        if (dialStatus === 'completed') {
          nextStatus = 'completed';
          const talk = Number(b.DialBLegDuration ?? b.DialBLegBillDuration);
          if (Number.isFinite(talk)) log.talkSec = talk;
          // An incoming call answered on a ring PHONE: Plivo says which
          // number picked up; that number's on-duty owner answered it. (An
          // in-app answer is claimed by the CRM itself: POST /:id/answered.)
          if (log.direction === 'inbound' && req.query.stage === 'phone' && !log.agentUser && b.DialBLegTo) {
            const answeredBy = await whoseRingPhone(b.DialBLegTo);
            if (answeredBy) {
              log.agentUser = answeredBy._id;
              log.agentName = answeredBy.name;
              log.agentType = 'staff';
            }
            // The Dial reports at the END of the call: picked up talk-time ago.
            if (!log.answeredAt) log.answeredAt = new Date(Date.now() - (Number.isFinite(talk) ? talk * 1000 : 0));
          }
        } else if (dialStatus) {
          nextStatus = log.direction === 'inbound'
            ? 'missed'
            : (DIAL_FAIL[dialStatus] || `customer_${dialStatus}`);
        }
        if (b.DialBLegUUID) log.customerLegId = b.DialBLegUUID;
        if (b.DialBLegHangupCause) log.hangupCause = b.DialBLegHangupCause;
        await log.save();
        // A connected call is never turned back into a failure by a late,
        // repeated or concurrent report; "completed" may replace a missed
        // set by a hang-up that arrived first.
        const applied = nextStatus ? await setStatusIf(log, nextStatus, { $ne: 'completed' }) : false;
        // Already in the callback queue as missed, but answered after all:
        // take it off at once (the queue's sweep also catches it if this fails).
        if (applied && nextStatus === 'completed' && log.direction === 'inbound' && log.callbackTask) {
          callbackQueue.retractAnswered(log._id).catch((err) => console.error(`[calls] callback retract failed log=${log._id}:`, err?.message || err));
        }
      }
      // A customer whose call nobody picked up hears why before hanging up.
      if (log?.direction === 'inbound' && dialStatus && dialStatus !== 'completed') {
        return sendXml(res, plivo.speakXml('Sorry, our team could not take your call right now. We will call you back shortly.'));
      }
      return sendXml(res, plivo.hangupXml());
    }

    // hangup_url for the whole call. A hang-up for some OTHER leg (a dialled
    // phone or app) is noted, but does not end this call.
    if (log && log.providerCallId && b.CallUUID && b.CallUUID !== log.providerCallId) {
      console.info(`[calls] hang-up of another leg (${b.CallUUID}) for log=${log._id} — call left as ${log.status}`);
      return sendXml(res, plivo.emptyXml());
    }
    if (log) {
      const callStatus = String(b.CallStatus || '').toLowerCase();
      // Ended before the Dial reported anything: the agent never answered
      // (outbound), or the caller gave up while it rang (inbound). Applied
      // below only if the call is STILL active at that moment.
      const finalStatus = log.direction === 'inbound'
        ? 'missed'
        : (log.status === 'agent_answered' ? 'customer_missed' : (AGENT_LEG_FAIL[callStatus] || 'agent_missed'));
      if (log.context === 'test_ring') log.flow = [...(log.flow || []), `test_ring:${callStatus || 'ended'}`];
      if (b.CallUUID && !log.providerCallId) log.providerCallId = b.CallUUID;
      const total = Number(b.Duration);
      if (Number.isFinite(total)) log.totalSec = total;
      if (b.HangupCause && !log.hangupCause) log.hangupCause = b.HangupCause;
      // TEMPORARY diagnostic: Plivo's full hang-up report for the whole
      // call — e.g. HangupCauseCode 5030 is its concurrency limit.
      log.hangup = hangupDetail(b);
      await log.save();
      await setStatusIf(log, finalStatus, { $in: ACTIVE_STATUSES });
      // A repeated hang-up report keeps the first end time.
      await markEndedIfNot(log, new Date());
      // The customer hung up while their call was being transferred.
      const ringingTransfer = (log.transfers || []).findIndex((t) => t?.outcome === 'ringing');
      if (ringingTransfer >= 0) {
        await CallLog.updateOne(
          { _id: log._id, [`transfers.${ringingTransfer}.outcome`]: 'ringing' },
          // Nobody took it: queued for a callback (unless Plivo then reports
          // it answered — see transferAnswer).
          { $set: { [`transfers.${ringingTransfer}.outcome`]: 'caller_hung_up', [`transfers.${ringingTransfer}.endedAt`]: new Date(), transferUnanswered: new Date() } },
        );
      }
      plivo.logCall(`hangup status=${log.status} cause=${b.HangupCauseName || b.HangupCause || '-'} code=${b.HangupCauseCode || '-'} source=${b.HangupSource || '-'}`, log);
      // No leg of this call may outlive it.
      if (log.direction === 'inbound') releaseLegs(log._id).catch(() => {});
    } else if (String(b.Direction || '').toLowerCase() === 'inbound' && b.CallUUID) {
      // An incoming call we have no log for: /incoming never ran for it
      // (Plivo's number not linked to our application, or the answer
      // webhook was rejected). Log it from the hangup anyway, so it shows
      // in the CRM's Call Logs instead of vanishing — marked as not routed
      // by the CRM, since nothing here decided who it rang.
      const from = normalisePhone(b.From);
      const [trip, lead] = from.length === 10 ? await Promise.all([
        Trip.findOne({ patientPhone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
        Lead.findOne({ phone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
      ]) : [null, null];
      const total = Number(b.Duration);
      const created = await CallLog.create({
        provider      : 'plivo',
        callerId      : normalisePhone(b.To).length === 10 ? `91${normalisePhone(b.To)}` : plivo.companyNumber(),
        direction     : 'inbound',
        context       : 'incoming',
        customerPhone : from || undefined,
        providerCallId: b.CallUUID,
        trip          : trip?._id,
        lead          : lead?._id,
        status        : 'not_routed',
        hangupCause   : b.HangupCause,
        totalSec      : Number.isFinite(total) ? total : undefined,
        startedAt     : b.StartTime ? new Date(b.StartTime) : new Date(),
        endedAt       : new Date(),
        // Not queued automatically — nothing here rang staff. Listed under
        // "Not routed by CRM" for a person to add or dismiss.
        callbackReview: isMobile(from) ? { state: 'pending' } : undefined,
      });
      console.warn(`[calls] inbound call ${b.CallUUID} reached hangup with no /incoming log — logged as not_routed (log=${created._id}). Check the Plivo number is linked to the "SaveLife CRM" application.`);
    } else {
      console.info(`[calls] events webhook: no call log for callUUID=${b.CallUUID || '-'} direction=${b.Direction || '-'}`);
    }
    return sendXml(res, plivo.emptyXml());
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/calls/recording?log=<id>
// @desc    <Record> action and file-ready callback: store where the
//          recording is. Both may arrive; the second is a harmless repeat.
// @access  Plivo (signature)
// ============================================================
exports.recording = async (req, res, next) => {
  try {
    const b = plivoParams(req);
    const logId = logIdOf(req);
    // A part recorded after a transfer (part = the transfer's index).
    const part = /^\d{1,2}$/.test(String(req.query.part ?? '')) ? Number(req.query.part) : null;
    if (logId && part != null && (b.RecordUrl || b.RecordingID)) {
      const set = {};
      if (b.RecordUrl) set['recordings.$.url'] = b.RecordUrl;
      if (b.RecordingID) set['recordings.$.id'] = b.RecordingID;
      const sec = Number(b.RecordingDuration);
      if (Number.isFinite(sec) && sec >= 0) set['recordings.$.sec'] = sec;
      // The action and the file-ready callback can arrive together: the
      // part's entry is added once, then filled.
      await CallLog.updateOne({ _id: logId, 'recordings.part': { $ne: part } }, { $push: { recordings: { part } } });
      await CallLog.updateOne({ _id: logId, 'recordings.part': part }, { $set: set });
    } else if (logId && (b.RecordUrl || b.RecordingID)) {
      const update = {};
      if (b.RecordUrl) update.recordingUrl = b.RecordUrl;
      if (b.RecordingID) update.recordingId = b.RecordingID;
      const sec = Number(b.RecordingDuration);
      if (Number.isFinite(sec) && sec >= 0) update.recordingSec = sec;
      await CallLog.updateOne({ _id: logId }, { $set: update });
    }
    return sendXml(res, plivo.emptyXml());
  } catch (err) {
    next(err);
  }
};


// ── Live transfer ──────────────────────────────────────────────────────────
// A cold transfer of a connected incoming call. The person on the call
// presses Transfer in the CRM; Plivo moves the customer's leg onto
// /transfer-answer, which plays a hold message and rings, in order, until
// someone answers:
//   english    — on-duty telecallers marked "speaks English" (Staff page)
//   all        — every on-duty telecaller
//   back_app   — ring-back: the normal incoming group in the app, the
//                person who transferred included
//   back_phone — ring-back: every on-duty phone
// Each step is skipped when it has nobody to ring. Nobody at all: the
// customer hears the usual sorry message. The person who transferred is
// never rung by the telecaller steps. Numbers stay masked: every leg shows
// PLIVO_NUMBER, and the in-app ring screen gets only the call-log id.
const TRANSFER_STEPS = ['english', 'all', 'back_app', 'back_phone'];
const TRANSFER_ANSWERED = ['answered', 'rang_back'];
const TRANSFER_HOLD_MESSAGE = 'Please hold while we transfer your call to a colleague.';
const TRANSFER_STILL_HOLD_MESSAGE = 'Please continue to hold.';
const TRANSFER_RING_BACK_MESSAGE = 'Please hold. We are connecting you back to our team.';
const SORRY_MESSAGE = 'Sorry, our team could not take your call right now. We will call you back shortly.';

// Who has the call now: whoever last took it as a transfer, else whoever
// answered it in the CRM.
function transferHolder(log) {
  const taken = (log.transfers || []).filter((t) => t?.answeredBy && TRANSFER_ANSWERED.includes(t.outcome));
  return taken.length ? taken[taken.length - 1].answeredBy : log.agentUser;
}

// The legs for a set of users — in the app where their app is online,
// otherwise their ring phone — never the caller's own number.
function legsOf(users, devices, callerPhone) {
  const { sipUsers } = routeIncoming(users, devices);
  const numbers = fallbackPhones(users.filter((u) => u.callMode !== 'app' || !appEndpointsOf(u, devices).length), callerPhone, { envFallback: false });
  const reach = users.filter((u) => (u.callMode === 'app' && appEndpointsOf(u, devices).length) || numbers.some((n) => normalisePhone(n) === normalisePhone(ringPhoneOf(u))));
  return { sipUsers, numbers, users: reach.map((u) => u._id) };
}

// The telecallers a transfer by `byId` can ring: English speakers, and all.
function transferPlan(onDuty, devices, byId, callerPhone) {
  const others = onDuty.filter((u) => u.role === 'telecaller' && String(u._id) !== String(byId));
  return {
    english: legsOf(others.filter((u) => u.speaksEnglish), devices, callerPhone),
    all    : legsOf(others, devices, callerPhone),
  };
}
exports.transferPlan = transferPlan;

async function stepLegs(log, entry, step) {
  const onDuty = await loadOnDuty();
  const devices = await loadOnlineDevices(onDuty);
  if (step === 'english' || step === 'all') {
    const plan = transferPlan(onDuty, devices, entry.by, log.customerPhone);
    if (step === 'english') return plan.english;
    // Everyone available was already rung as an English speaker.
    const rung = new Set((entry.englishRung || []).map(String));
    if ((entry.steps || []).includes('english') && plan.all.users.every((id) => rung.has(String(id)))) return { sipUsers: [], numbers: [], users: [] };
    return plan.all;
  }
  if (step === 'back_app') return { sipUsers: routeIncoming(onDuty, devices).sipUsers, numbers: [], users: [] };
  return { sipUsers: [], numbers: fallbackPhones(onDuty, log.customerPhone), users: [] };
}

// The XML for the first step from `fromIdx` on that has anyone to ring; the
// sorry message when none has.
async function serveTransferFrom(log, t, fromIdx) {
  const entry = log.transfers[t];
  const served = entry.steps || [];
  for (let k = fromIdx; k < TRANSFER_STEPS.length; k += 1) {
    const step = TRANSFER_STEPS[k];
    const legs = await stepLegs(log, entry, step);
    if (!legs.sipUsers.length && !legs.numbers.length) continue;
    const ringBack = step.startsWith('back_');
    const say = !served.length ? TRANSFER_HOLD_MESSAGE
      : ringBack && !served.some((s) => s.startsWith('back_')) ? TRANSFER_RING_BACK_MESSAGE
        : TRANSFER_STILL_HOLD_MESSAGE;
    await CallLog.updateOne({ _id: log._id }, {
      $set : { [`transfers.${t}.step`]: step, ...(step === 'english' ? { [`transfers.${t}.englishRung`]: legs.users } : {}) },
      $push: { [`transfers.${t}.steps`]: step, flow: `transfer${t}:${step}:${legs.sipUsers.length + legs.numbers.length}` },
    });
    serverTrail('server:transfer_step', { logId: String(log._id), transfer: t, step, app: legs.sipUsers.length, phones: legs.numbers.length });
    const timeout = step === 'back_app' ? plivo.APP_RING_SECONDS : step === 'back_phone' ? plivo.PHONE_RING_SECONDS : plivo.TRANSFER_RING_SECONDS;
    return plivo.transferXml({ numbers: legs.numbers, sipUsers: legs.sipUsers, logId: log._id, transfer: t, step, say, timeout });
  }
  await CallLog.updateOne(
    { _id: log._id, [`transfers.${t}.outcome`]: 'ringing' },
    // The caller needed help and got none: queued for a callback.
    { $set: { [`transfers.${t}.outcome`]: 'not_answered', [`transfers.${t}.endedAt`]: new Date(), transferUnanswered: new Date() }, $push: { flow: `transfer${t}:nobody→sorry_message` } },
  );
  console.warn(`[calls] transfer ${t} of log=${log._id}: nobody answered, ring-back included — sorry message`);
  return plivo.speakXml(SORRY_MESSAGE);
}

// The original Dial ends when its call is transferred. A transfer that is
// under way (or done) means that Dial's report must not ring phones or hang
// up. A transfer that FAILED leaves the original call as it was.
const transferTookOver = (log) => (log.transfers || []).some((t) => t && (t.servedAt || t.outcome !== 'failed'));

async function originalDialAfterTransfer(log, b, dialStatus, stage) {
  const set = {};
  if (dialStatus === 'completed') {
    const talk = Number(b.DialBLegDuration ?? b.DialBLegBillDuration);
    if (Number.isFinite(talk)) set.talkSec = talk;
  }
  if (stage === 'app') set.appLeg = { sipUris: (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri), ...dialResult(b) };
  else set.phoneLeg = dialResult(b);
  await CallLog.updateOne({ _id: log._id }, { $set: set, $push: { flow: `${stage}:${dialStatus === 'completed' ? 'answered' : (dialStatus || 'none')}→transferred` } });
  // The person who had the call dropped before Plivo moved the customer
  // (the Dial ended first, so this reply is the customer's XML): start the
  // transfer here. Only once — /transfer-answer and this race for servedAt.
  const t = (log.transfers || []).findIndex((x) => x?.outcome === 'ringing');
  if (t >= 0) {
    const claimed = await CallLog.updateOne(
      { _id: log._id, [`transfers.${t}.servedAt`]: { $exists: false } },
      { $set: { [`transfers.${t}.servedAt`]: new Date(), [`transfers.${t}.servedBy`]: 'dial_action' } },
    );
    if (claimed?.modifiedCount > 0) {
      const fresh = await CallLog.findById(log._id).select('+customerPhone');
      return serveTransferFrom(fresh, t, 0);
    }
  }
  return plivo.emptyXml();
}

// The person who picked up a transfer leg, from Plivo's DialBLegTo: a ring
// phone, or an in-app endpoint.
async function whoAnsweredLeg(raw) {
  const s = String(raw || '');
  const sip = s.match(/^sip:([^@]+)@/i);
  if (!sip) return whoseRingPhone(s);
  const dev = await WebrtcEndpoint.findOne({ username: sip[1] }).select('user').lean();
  const user = dev?.user
    ? await User.findById(dev.user).select('name').lean()
    : await User.findOne({ plivoEndpointUsername: sip[1] }).select('name').lean();
  return user || null;
}

// ============================================================
// @route   POST /api/calls/:id/transfer
// @desc    Transfer a connected incoming call to the other telecallers
//          (English speakers first). Only the person on the call — who
//          answered it in the CRM, or took it as a transfer — may. With
//          nobody to transfer to, or if Plivo refuses, nothing changes and
//          the caller stays connected to them.
// @access  Private [owner, telecaller]
// ============================================================
exports.transferCall = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Call not found.' });
    const log = await CallLog.findById(req.params.id).select('+customerPhone');
    if (!log) return res.status(404).json({ success: false, message: 'Call not found.' });
    if (log.provider !== 'plivo' || log.direction !== 'inbound' || log.context !== 'incoming' || !log.providerCallId) {
      return res.status(400).json({ success: false, reason: 'not_transferable', message: 'Only an incoming customer call can be transferred.' });
    }
    if (log.endedAt) return res.status(409).json({ success: false, reason: 'ended', message: 'This call has already ended.' });
    const transfers = log.transfers || [];
    if (transfers.some((t) => t?.outcome === 'ringing')) {
      return res.status(409).json({ success: false, reason: 'in_progress', message: 'This call is already being transferred.' });
    }
    const holder = transferHolder(log);
    if (!holder || String(holder) !== String(req.user._id)) {
      return res.status(403).json({ success: false, reason: 'not_on_call', message: 'Only the person on this call can transfer it.' });
    }
    // Answered on their phone: that phone must still be on the call.
    const onPhone = heldOnPhone(log);
    if (onPhone && log.answeredLegEndedAt) {
      return res.status(409).json({ success: false, reason: 'ended', message: 'Your phone has already hung up on this call.' });
    }

    const onDuty = await loadOnDuty();
    const devices = await loadOnlineDevices(onDuty);
    const plan = transferPlan(onDuty, devices, req.user._id, log.customerPhone);
    if (!plan.all.users.length) {
      console.info(`[calls] transfer of log=${log._id} refused: no other telecaller available`);
      return res.status(409).json({ success: false, reason: 'no_one_available', message: 'No other telecaller is on call duty right now. You are still connected to the caller.' });
    }

    // One transfer at a time: the update applies only if no other transfer
    // was added since this call was read (a double press, two tabs).
    const t = transfers.length;
    const entry = { by: req.user._id, byName: req.user.name, at: new Date(), targets: plan.all.users, englishAvailable: plan.english.users.length, steps: [], outcome: 'ringing' };
    const added = await CallLog.updateOne(
      {
        _id: log._id,
        endedAt: null,
        status: { $in: [...ACTIVE_STATUSES, 'completed'] },
        $expr: { $eq: [{ $size: { $ifNull: ['$transfers', []] } }, t] },
      },
      // Someone already talked to the caller: the call is answered, whatever
      // the transfer does next.
      { $push: { transfers: entry, flow: `transfer${t}:requested` }, $set: { status: 'completed' } },
    );
    if (!added?.modifiedCount) {
      return res.status(409).json({ success: false, reason: 'in_progress', message: 'This call is already being transferred, or has ended.' });
    }

    try {
      await plivo.transferCall(log.providerCallId, plivo.apiUrl(`/api/calls/transfer-answer?log=${log._id}&t=${t}`));
    } catch (err) {
      const { status } = plivoErrorDetail(err);
      // Plivo may have moved the call after all (its reply was lost): then
      // /transfer-answer has run, and the transfer stands.
      const failed = await CallLog.updateOne(
        { _id: log._id, [`transfers.${t}.outcome`]: 'ringing', [`transfers.${t}.servedAt`]: { $exists: false } },
        { $set: { [`transfers.${t}.outcome`]: 'failed', [`transfers.${t}.error`]: `Plivo transfer failed (status ${status ?? '-'})`, [`transfers.${t}.endedAt`]: new Date() }, $push: { flow: `transfer${t}:failed(${status ?? '-'})` } },
      );
      if (failed?.modifiedCount > 0) {
        // Answered on a phone: the call (or that phone) may have just hung
        // up while the CRM still showed Transfer. Say so rather than "you
        // are still connected".
        if (onPhone) {
          const now = await CallLog.findById(log._id).select('endedAt answeredLegEndedAt').lean();
          if (status === 404 || now?.endedAt || now?.answeredLegEndedAt) {
            console.info(`[calls] transfer of log=${log._id} too late: the call or the phone had already hung up (status ${status ?? '-'})`);
            return res.status(409).json({ success: false, reason: 'ended', message: 'This call ended before it could be transferred.' });
          }
        }
        console.error(`[calls] transfer of log=${log._id} failed at Plivo (status ${status ?? '-'}) — caller left with ${req.user.name}`);
        return res.status(502).json({ success: false, reason: 'plivo_failed', message: 'The transfer did not go through. You are still connected to the caller.' });
      }
    }
    // Plivo drops the phone that had the call when it moves the customer;
    // if that phone is somehow still on a few seconds later, hang it up.
    if (onPhone && log.answeredLegId) {
      setTimeout(() => { dropAnsweredPhoneLeg(log._id).catch(() => {}); }, PHONE_LEG_DROP_MS).unref?.();
    }
    plivo.logCall(`transfer ${t} by=${req.user._id} english=${plan.english.users.length} all=${plan.all.users.length}${onPhone ? ' from=phone' : ''}`, log);
    return res.json({
      success: true,
      transfer: t,
      englishAvailable: plan.english.users.length,
      available: plan.all.users.length,
      message: plan.english.users.length
        ? `Transferring — ringing ${plan.english.users.length} English-speaking telecaller(s) first.`
        : `Transferring — ringing ${plan.all.users.length} telecaller(s).`,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/calls/transfer-answer?log=<id>&t=<n>[&done=<step>]
// @desc    The customer's XML during transfer n. Without done: Plivo just
//          moved the customer here — play the hold message and ring the
//          first step. With done: that step's Dial finished — answered
//          (record who took it) or ring the next step.
// @access  Plivo (signature)
// ============================================================
exports.transferAnswer = async (req, res, next) => {
  const logId = logIdOf(req);
  try {
    const b = plivoParams(req);
    const t = /^\d{1,2}$/.test(String(req.query.t ?? '')) ? Number(req.query.t) : -1;
    const log = logId ? await CallLog.findById(logId).select('+customerPhone') : null;
    const entry = log?.transfers?.[t];
    if (!entry) {
      console.error(`[calls] transfer-answer for unknown transfer log=${logId || '-'} t=${req.query.t ?? '-'}`);
      return sendXml(res, plivo.speakXml(SORRY_MESSAGE));
    }
    const done = TRANSFER_STEPS.includes(req.query.done) ? req.query.done : null;

    if (!done) {
      // Plivo moved the customer here, so this transfer happened — even if
      // its API reply was lost and the entry was marked failed.
      await CallLog.updateOne({ _id: log._id }, {
        $set: { [`transfers.${t}.servedAt`]: entry.servedAt || new Date(), ...(entry.outcome === 'failed' ? { [`transfers.${t}.outcome`]: 'ringing' } : {}) },
        ...(entry.outcome === 'failed' ? { $unset: { [`transfers.${t}.error`]: '', [`transfers.${t}.endedAt`]: '' } } : {}),
      });
      if (entry.servedAt && (entry.steps || []).length) {
        // Already started from the original Dial's report: keep ringing.
        console.warn(`[calls] transfer ${t} of log=${log._id} served twice — continuing`);
      }
      const fresh = await CallLog.findById(log._id).select('+customerPhone');
      return sendXml(res, await serveTransferFrom(fresh, t, 0));
    }

    const dialStatus = String(b.DialStatus || '').toLowerCase();
    if (dialStatus === 'completed') {
      const talk = Number(b.DialBLegDuration ?? b.DialBLegBillDuration);
      const set = {
        [`transfers.${t}.outcome`]: done.startsWith('back_') ? 'rang_back' : 'answered',
        [`transfers.${t}.endedAt`]: new Date(),
      };
      if (Number.isFinite(talk)) set[`transfers.${t}.talkSec`] = talk;
      // Answered on a phone, or the CRM's claim never arrived: Plivo says
      // which leg picked up.
      if (!entry.answeredBy) {
        const who = await whoAnsweredLeg(b.DialBLegTo);
        if (who) {
          set[`transfers.${t}.answeredBy`] = who._id;
          set[`transfers.${t}.answeredByName`] = who.name;
          set[`transfers.${t}.answeredIn`] = /^sip:/i.test(String(b.DialBLegTo || '')) ? 'app' : 'phone';
        }
        if (!entry.answeredAt) set[`transfers.${t}.answeredAt`] = new Date(Date.now() - (Number.isFinite(talk) ? talk * 1000 : 0));
      }
      // Answered after all (its report came after the hang-up): not a
      // caller to call back. Off the queue if it was already put there.
      await CallLog.updateOne({ _id: log._id }, { $set: set, $unset: { transferUnanswered: '' }, $push: { flow: `transfer${t}:${done}:answered` } });
      if (log.transferUnanswered && log.callbackTask) {
        callbackQueue.retractAnswered(log._id).catch((err) => console.error(`[calls] callback retract failed log=${log._id}:`, err?.message || err));
      }
      return sendXml(res, plivo.hangupXml());
    }

    // Not answered. The customer hung up meanwhile: nothing more to ring.
    if (log.endedAt) return sendXml(res, plivo.hangupXml());
    // A claim from the CRM that Plivo says never connected is withdrawn.
    const unset = entry.answeredBy ? { [`transfers.${t}.answeredBy`]: '', [`transfers.${t}.answeredByName`]: '', [`transfers.${t}.answeredAt`]: '', [`transfers.${t}.answeredIn`]: '' } : {};
    await CallLog.updateOne({ _id: log._id }, {
      $set: { [`transfers.${t}.outcome`]: 'ringing' },
      ...(entry.answeredBy ? { $unset: unset } : {}),
      $push: { flow: `transfer${t}:${done}:${dialStatus || 'none'}` },
    });
    const fresh = await CallLog.findById(log._id).select('+customerPhone');
    return sendXml(res, await serveTransferFrom(fresh, t, TRANSFER_STEPS.indexOf(done) + 1));
  } catch (err) {
    // Never leave the customer in silence: say sorry, and log it.
    console.error(`[calls] transfer-answer failed log=${logId || '-'}:`, err?.message || err);
    if (logId) CallLog.updateOne({ _id: logId }, { $push: { flow: 'transfer:error→sorry_message' } }).catch(() => {});
    return sendXml(res, plivo.speakXml(SORRY_MESSAGE));
  }
};


// ── Transfer of a call answered on a phone ─────────────────────────────────
// Ring mode "My phone": the call is answered on the native dialer, not in
// the CRM. The phone Dial's callbackUrl tells us live who picked up (and
// when that phone hangs up); the CRM polls GET /my-live and shows the call
// with Transfer, which is the same transfer as in the app.

// The person who has the call now answered it on their own phone (nobody
// has taken it as a transfer since).
function heldOnPhone(log) {
  if (log?.answeredIn !== 'phone' || !log.agentUser) return false;
  return String(transferHolder(log)) === String(log.agentUser)
    && !(log.transfers || []).some((t) => t?.answeredBy && TRANSFER_ANSWERED.includes(t.outcome));
}

// Plivo drops the phone leg itself when it moves the customer; this is the
// backstop if it is still on after this long (as the app hangs up its own
// leg after 5s).
const PHONE_LEG_DROP_MS = 5 * 1000;
exports.PHONE_LEG_DROP_MS = PHONE_LEG_DROP_MS;

async function dropAnsweredPhoneLeg(logId) {
  const log = await CallLog.findById(logId).select('answeredLegId answeredLegEndedAt').lean();
  if (!log?.answeredLegId || log.answeredLegEndedAt) return false;
  // Only that one phone leg — never the customer's, never a transfer leg.
  // Already gone (404) is fine: hangupLegs says nothing about it.
  const done = await hangupLegs([log.answeredLegId], `phone still on after transfer log=${logId}`);
  if (done.length) {
    await CallLog.updateOne({ _id: logId, answeredLegEndedAt: null }, { $set: { answeredLegEndedAt: new Date() }, $push: { flow: 'phone:dropped_after_transfer' } });
  }
  return done.length > 0;
}
exports.dropAnsweredPhoneLeg = dropAnsweredPhoneLeg;

// ============================================================
// @route   POST /api/calls/dial-event?log=<id>&stage=phone
// @desc    The phone Dial's callbackUrl: a phone picked up
//          (DialAction=answer) or hung up (DialAction=hangup). On answer,
//          the on-duty person whose ring phone it is has the call — as the
//          Dial's end report would say, but now, while it lasts. First
//          answer wins; an answer already recorded is never replaced.
//          Nothing here changes what the caller hears.
// @access  Plivo (signature)
// ============================================================
exports.dialEvent = async (req, res, next) => {
  try {
    const b = plivoParams(req);
    const logId = logIdOf(req);
    const action = String(b.DialAction || '').toLowerCase();
    const legId = b.DialBLegUUID ? String(b.DialBLegUUID) : null;
    if (!logId || req.query.stage !== 'phone') return sendXml(res, plivo.emptyXml());

    if (action === 'answer' || action === 'connected') {
      const log = await CallLog.findById(logId).select('direction context agentUser answeredAt answeredLegId endedAt');
      if (!log || log.direction !== 'inbound' || log.endedAt) return sendXml(res, plivo.emptyXml());
      // 'connected' follows 'answer' for the same leg: recorded once.
      if (log.answeredLegId) return sendXml(res, plivo.emptyXml());
      const who = b.DialBLegTo ? await whoseRingPhone(b.DialBLegTo) : null;
      const now = new Date();
      const set = { answeredIn: 'phone', ...(legId ? { answeredLegId: legId } : {}) };
      let r;
      if (who) {
        r = await CallLog.updateOne(
          { _id: log._id, agentUser: { $exists: false }, answeredLegId: { $exists: false } },
          { $set: { ...set, agentUser: who._id, agentName: who.name, agentType: 'staff', answeredAt: now }, $push: { flow: 'phone:answered(live)' } },
        );
      } else {
        // A phone that is nobody's on-duty ring phone (PLIVO_FALLBACK_AGENTS):
        // the call is shown to nobody, but its answer time is still right.
        r = await CallLog.updateOne(
          { _id: log._id, agentUser: { $exists: false }, answeredLegId: { $exists: false } },
          { $set: { ...set, ...(log.answeredAt ? {} : { answeredAt: now }) }, $push: { flow: 'phone:answered(live, not a ring phone)' } },
        );
      }
      serverTrail('server:phone_answered', { logId: String(log._id), user: who ? String(who._id) : null, recorded: r?.modifiedCount > 0 });
      return sendXml(res, plivo.emptyXml());
    }

    if (action === 'hangup' && legId) {
      // Only the phone that had the call; another phone's leg ending (it
      // rang and stopped) is not recorded.
      const r = await CallLog.updateOne(
        { _id: logId, answeredLegId: legId, answeredLegEndedAt: null },
        { $set: { answeredLegEndedAt: new Date() }, $push: { flow: 'phone:hung_up(live)' } },
      );
      if (r?.modifiedCount > 0) serverTrail('server:phone_hung_up', { logId });
    }
    return sendXml(res, plivo.emptyXml());
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/calls/my-live
// @desc    The incoming call the signed-in user answered on their own
//          phone and is still on, if any — masked, as GET /:id — with
//          whether they can transfer it now. call: null when there is none.
//          Polled by the CRM every few seconds.
// @access  Private [owner, telecaller]
// ============================================================
exports.myLiveCall = async (req, res, next) => {
  try {
    const log = await CallLog.findOne({
      // createdAt is indexed: only calls young enough to still be live.
      createdAt         : { $gte: new Date(Date.now() - MAX_LIVE_MS) },
      direction         : 'inbound',
      context           : 'incoming',
      agentUser         : req.user._id,
      answeredIn        : 'phone',
      endedAt           : null,
      answeredLegEndedAt: null,
    })
      .sort({ createdAt: -1 })
      .select('+customerPhone') // for toJSON: masked, or in full for a CRM owner
      .populate('trip', 'tripNumber patientName status')
      .populate('lead', 'patientName');
    // Taken by a colleague as a transfer: no longer this user's call.
    if (!log || !heldOnPhone(log)) return res.json({ success: true, call: null });
    const transfers = log.transfers || [];
    const ringing = transfers.some((t) => t?.outcome === 'ringing');
    const last = transfers[transfers.length - 1];
    return res.json({
      success: true,
      call: {
        id          : log._id,
        answeredAt  : log.answeredAt,
        transferring: ringing,
        canTransfer : !ringing,
        // The last attempt that left the caller with this user, if any.
        lastTransferFailed: last?.outcome === 'failed' ? true : undefined,
        log,
      },
    });
  } catch (err) {
    next(err);
  }
};


// Plivo's live call ids, cached briefly — the Call Logs page polls every 30s.
// At most one Plivo request per 20s across all open CRMs: concurrent
// requests share one lookup, and a failure is remembered for the same 20s
// (it then flags nothing).
const LIVE_IDS_TTL_MS = 20 * 1000;
let liveIdsCache = { at: 0, ids: null, error: null, inFlight: null };
async function liveCallIds() {
  const fresh = Date.now() - liveIdsCache.at < LIVE_IDS_TTL_MS;
  if (fresh && liveIdsCache.error) throw liveIdsCache.error;
  if (fresh && liveIdsCache.ids) return liveIdsCache.ids;
  if (!liveIdsCache.inFlight) {
    liveIdsCache.inFlight = plivo.listLiveCallIds()
      .then((ids) => { liveIdsCache = { at: Date.now(), ids: new Set(ids), error: null, inFlight: null }; return liveIdsCache.ids; })
      .catch((err) => { liveIdsCache = { at: Date.now(), ids: null, error: err, inFlight: null }; throw err; });
  }
  return liveIdsCache.inFlight;
}
exports._resetLiveIdsCache = () => { liveIdsCache = { at: 0, ids: null, error: null, inFlight: null }; };

// For calls still marked active, older than a few minutes, with a Plivo id:
// flag those Plivo no longer has live (doc.$locals, read by toJSON). If
// Plivo can't be asked, nothing is flagged.
async function markNotLiveOnPlivo(logs) {
  const now = Date.now();
  const candidates = (logs || []).filter((l) => {
    const state = liveStateOf(l, { now })?.state;
    return l.providerCallId && (state === 'active' || state === 'in_call')
      && now - new Date(l.startedAt || l.createdAt || now).getTime() > PLIVO_CHECK_AFTER_MS;
  });
  if (!candidates.length || !plivo.isConfigured()) return;
  try {
    const live = await liveCallIds();
    for (const l of candidates) {
      if (!live.has(l.providerCallId)) {
        l.$locals = l.$locals || {};
        l.$locals.notLiveOnPlivo = true;
      }
    }
  } catch (err) {
    console.warn(`[calls] could not read Plivo live calls for status check (status ${plivoErrorDetail(err).status ?? '-'})`);
  }
}
exports.markNotLiveOnPlivo = markNotLiveOnPlivo;


// ============================================================
// @route   GET /api/calls/logs?tripId=&leadId=&quoteId=&whatsappLeadId=&customerRef=&direction=&limit=
// @desc    CRM call history, newest first, with recordings. Numbers are
//          masked by CallLog's JSON form.
// @access  Private [owner]
// ============================================================
exports.listLogs = async (req, res, next) => {
  try {
    const { tripId, leadId, quoteId, whatsappLeadId, customerRef, direction } = req.query;
    const filter = {};
    if (tripId && isObjectId(tripId)) filter.trip = tripId;
    if (leadId && isObjectId(leadId)) filter.lead = leadId;
    if (quoteId && isObjectId(quoteId)) filter.quote = quoteId;
    if (whatsappLeadId && isObjectId(whatsappLeadId)) filter.whatsappLead = whatsappLeadId;
    if (customerRef) {
      const phone = phoneFromRef(customerRef);
      if (!phone) return res.json({ success: true, logs: [] });
      filter.customerPhone = normalisePhone(phone);
    }
    if (['inbound', 'outbound'].includes(direction)) filter.direction = direction;
    // Calls handled by one staff member (answered incoming, or placed). The
    // owner may pick anyone; a telecaller only themselves — someone else's
    // list is their performance.
    if (req.query.agent) {
      const agent = String(req.query.agent);
      if (!isObjectId(agent)) return res.status(400).json({ success: false, message: 'Unknown staff member.' });
      if (req.user.role !== 'owner' && agent !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'You can filter by your own calls only.' });
      }
      // Or took it as a transfer.
      filter.$or = [{ agentUser: agent }, { 'transfers.answeredBy': new mongoose.Types.ObjectId(agent) }];
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const logs = await CallLog.find(filter)
      .select('+customerPhone') // for toJSON: masked, or in full for a CRM owner
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('trip', 'tripNumber patientName')
      .populate('lead', 'patientName');

    // A call still marked active that Plivo no longer has live has ended
    // without its final report: shown as "Status unconfirmed" (read only —
    // nothing is written back).
    await markNotLiveOnPlivo(logs);

    return res.json({ success: true, logs });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/performance?from=<ISO>&to=<ISO>
// @desc    Who took the calls in a period. Per person (each telecaller and
//          owner): incoming calls they answered (in the app, or on their
//          ring phone — Plivo says which number picked up), average time to
//          answer, and calls they placed / that connected. For the team:
//          total incoming, and missed — calls NOBODY answered, counted once
//          for the team, never against one person.
//          The owner sees every person; a telecaller only their own row
//          (and the team totals, which name nobody).
// @access  Private [owner, telecaller]
// ============================================================
const PERFORMANCE_MAX_DAYS = 93;
const MISSED_STATUSES = ['missed', 'no_agents', 'not_routed'];

exports.performance = async (req, res, next) => {
  try {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      return res.status(400).json({ success: false, message: 'Give a valid from/to period.' });
    }
    if (to - from > PERFORMANCE_MAX_DAYS * 24 * 3600 * 1000) {
      return res.status(400).json({ success: false, message: `Pick a period of at most ${PERFORMANCE_MAX_DAYS} days.` });
    }
    const isOwner = req.user.role === 'owner';

    const [calls, staff] = await Promise.all([
      CallLog.find({ startedAt: { $gte: from, $lt: to }, context: { $ne: 'test_ring' } })
        .select('direction status agentUser transfers startedAt answeredAt endedAt createdAt').lean(),
      isOwner
        ? User.find({ role: { $in: ['owner', 'telecaller'] }, isActive: true }).select('name role').lean()
        : Promise.resolve([{ _id: req.user._id, name: req.user.name, role: req.user.role }]),
    ]);

    const rows = new Map((staff || []).map((u) => [String(u._id), {
      user: u._id, name: u.name, role: u.role,
      answered: 0, answerSecTotal: 0, answerSecCount: 0, placed: 0, connected: 0,
    }]));
    const team = { incoming: 0, answered: 0, answeredUnattributed: 0, missed: 0, inProgress: 0, unconfirmed: 0 };

    for (const c of calls || []) {
      const row = c.agentUser ? rows.get(String(c.agentUser)) : null;
      if (c.direction === 'inbound') {
        team.incoming += 1;
        if (c.status === 'completed') {
          team.answered += 1;
          if (!c.agentUser) team.answeredUnattributed += 1;
          if (row) {
            row.answered += 1;
            if (c.answeredAt && c.startedAt) {
              const sec = (new Date(c.answeredAt) - new Date(c.startedAt)) / 1000;
              if (sec >= 0 && sec < 600) { row.answerSecTotal += sec; row.answerSecCount += 1; }
            }
          }
          // Each person who took it as a transfer is credited too — once per
          // call, however many times it came back to them. The team counts
          // the call once. A transfer ring nobody picked up counts against
          // nobody.
          const credited = new Set(row ? [String(c.agentUser)] : []);
          for (const t of c.transfers || []) {
            const by = t?.answeredBy ? String(t.answeredBy) : null;
            if (!by || !TRANSFER_ANSWERED.includes(t.outcome) || credited.has(by)) continue;
            credited.add(by);
            const tRow = rows.get(by);
            if (tRow) tRow.answered += 1;
          }
        } else if (MISSED_STATUSES.includes(c.status)) {
          team.missed += 1;
        } else if (liveStateOf(c)?.state === 'unconfirmed') {
          // Ended, but its outcome never arrived — neither answered nor missed.
          team.unconfirmed += 1;
        } else {
          team.inProgress += 1;
        }
      } else if (row) {
        row.placed += 1;
        if (c.status === 'completed') row.connected += 1;
      }
    }

    const people = [...rows.values()].map(({ answerSecTotal, answerSecCount, ...r }) => ({
      ...r,
      avgAnswerSec: answerSecCount ? Math.round(answerSecTotal / answerSecCount) : null,
    })).sort((a, b) => b.answered - a.answered || String(a.name).localeCompare(String(b.name)));

    return res.json({ success: true, from, to, scope: isOwner ? 'team' : 'self', team, people });
  } catch (err) {
    next(err);
  }
};


// Only ever fetch from Plivo's own hosts with our credentials. The URL came
// from a signed Plivo webhook, but a stored value is still never trusted
// to send PLIVO_AUTH_TOKEN somewhere else.
function isPlivoMediaUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'plivo.com' || u.hostname.endsWith('.plivo.com'));
  } catch {
    return false;
  }
}

// Passed through so the player can seek and the browser can show length.
const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

// ============================================================
// @route   GET /api/calls/:id/recording
// @desc    Streams one call's recording from Plivo to a signed-in CRM user.
//          Fetched with PLIVO_AUTH_ID/PLIVO_AUTH_TOKEN as Basic Auth, which
//          is what Plivo requires once "Basic Auth For Recording URLs" is
//          on (and is harmless while it is off). The Plivo URL itself never
//          reaches the browser. A Range header is forwarded for seeking.
// @access  Private [owner]
// ============================================================
exports.streamRecording = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) {
      return res.status(404).json({ success: false, message: 'Recording not found.' });
    }
    const found = await CallLog.findById(req.params.id).select('recordingUrl recordingSec status talkSec recordings');
    // ?part=<n>: the part recorded after transfer n. Without it: the call's
    // first part, as before.
    let log = found;
    if (found && req.query?.part != null) {
      const part = /^\d{1,2}$/.test(String(req.query.part)) ? Number(req.query.part) : NaN;
      const rec = (found.recordings || []).find((r) => Number(r?.part) === part);
      if (!rec?.url) return res.status(404).json({ success: false, reason: 'none', message: 'This part of the call has no recording.' });
      log = { _id: found._id, status: found.status, recordingUrl: rec.url, recordingSec: rec.sec, talkSec: rec.sec };
    }
    // Recording starts only when someone answers (<Record startOnDialAnswer>),
    // so an unanswered call has nothing to fetch — even if Plivo posted a URL.
    const answered = log?.status === 'completed' || Number(log?.talkSec) > 0 || Number(log?.recordingSec) > 0;
    if (log && !answered) {
      return res.status(404).json({ success: false, reason: 'not_answered', message: 'No recording — this call was not answered.' });
    }
    if (!log?.recordingUrl) {
      return res.status(404).json({ success: false, reason: 'none', message: 'This call has no recording.' });
    }
    if (!isPlivoMediaUrl(log.recordingUrl)) {
      return res.status(502).json({ success: false, message: 'This recording is not stored with Plivo.' });
    }
    if (!process.env.PLIVO_AUTH_ID || !process.env.PLIVO_AUTH_TOKEN) {
      return res.status(503).json({ success: false, message: 'Recordings cannot be played: Plivo credentials are not set on the server.' });
    }

    const fetchRecording = (withAuth) => axios.get(log.recordingUrl, {
      ...(withAuth ? { auth: { username: process.env.PLIVO_AUTH_ID, password: process.env.PLIVO_AUTH_TOKEN } } : {}),
      responseType  : 'stream',
      timeout       : 20000,
      headers       : req.get('range') ? { Range: req.get('range') } : {},
      // Read Plivo's status ourselves so a 401/404 becomes a clear message.
      validateStatus: () => true,
    });

    let upstream;
    try {
      // With Basic Auth (needed once "Basic Auth For Recording URLs" is on).
      // If that is refused, once more without: with the setting off, a media
      // link can redirect to storage that rejects an extra Authorization
      // header, and storage answers a missing file with 403 as well.
      upstream = await fetchRecording(true);
      if (upstream.status === 401 || upstream.status === 403) {
        console.warn(`[calls] recording ${log._id}: Plivo answered ${upstream.status} with Basic Auth — retrying without`);
        upstream.data?.destroy?.();
        upstream = await fetchRecording(false);
      }
    } catch (err) {
      console.error('[calls] recording fetch failed:', err.message);
      return res.status(502).json({ success: false, message: 'Could not reach Plivo for this recording. Please try again.' });
    }

    if (upstream.status >= 400) {
      upstream.data?.destroy?.();
      console.error(`[calls] recording ${log._id}: Plivo answered ${upstream.status}`);
      const message = upstream.status === 401
        ? 'Plivo refused the recording request (401). Check PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN on Render.'
        : upstream.status === 403
          ? 'Plivo would not return this recording (403) — it may not exist, or Basic Auth for recordings needs PLIVO_AUTH_ID/PLIVO_AUTH_TOKEN checked.'
          : upstream.status === 404
            ? 'Plivo no longer has this recording.'
            : `Could not load this recording from Plivo (${upstream.status}).`;
      return res.status(upstream.status === 404 ? 404 : 502).json({ success: false, plivoStatus: upstream.status, message });
    }

    res.status(upstream.status);
    for (const h of PASSTHROUGH_HEADERS) {
      if (upstream.headers?.[h]) res.setHeader(h, upstream.headers[h]);
    }
    if (!upstream.headers?.['content-type']) res.setHeader('content-type', 'audio/mpeg');
    // A call recording is personal data: never cached by a browser or proxy.
    res.setHeader('cache-control', 'private, no-store');

    upstream.data.on('error', (err) => {
      console.error('[calls] recording stream error:', err.message);
      res.destroy(err);
    });
    // Stop pulling from Plivo if the user closes the player.
    res.on('close', () => upstream.data.destroy?.());
    upstream.data.pipe(res);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/duty   PUT /api/calls/duty { onDuty }
// @desc    The signed-in CRM user's own "On call duty" switch.
// @access  Private [owner]
// ============================================================
exports.getDuty = async (req, res) => res.json({ success: true, onDuty: !!req.user.callDuty });

exports.setDuty = async (req, res, next) => {
  try {
    const onDuty = !!req.body?.onDuty;
    if (onDuty && !isMobile(ringPhoneOf(req.user))) {
      return res.status(400).json({ success: false, message: 'Your account has no valid mobile number to ring. Set your call ring number on the Staff page.' });
    }
    // Going off duty also drops in-app presence, so nothing rings this app.
    await User.updateOne({ _id: req.user._id }, onDuty
      ? { $set: { callDuty: true } }
      : { $set: { callDuty: false }, $unset: { appOnlineAt: 1 } });
    if (!onDuty) await WebrtcEndpoint.updateMany({ user: req.user._id }, { $unset: { onlineAt: 1 } });
    return res.json({ success: true, onDuty });
  } catch (err) {
    next(err);
  }
};


// The signed-in user's own call settings. Their own numbers only — this is
// not a customer number, and nobody else's.
const meView = (u) => ({
  callPhone  : u.callPhone || null,                // what they set
  loginPhone : u.phone || null,                    // the fallback
  ringPhone  : ringPhoneOf(u) || null,             // what Plivo actually rings
  usingLogin : !u.callPhone,
  onDuty     : !!u.callDuty,
  callMode   : u.callMode || 'phone',              // 'app' | 'phone'
  appOnline  : isAppOnline(u),                     // an open CRM is checking in
  callerId   : plivo.companyNumber() || null,      // what customers see
});

// ============================================================
// @route   GET /api/calls/me   PUT /api/calls/me { callPhone }
// @desc    View / set your own call ring number — the phone Plivo rings
//          for your click-to-calls and, while on call duty, incoming calls.
//          Separate from the login number. Empty clears it (back to the
//          login number).
// @access  Private [owner]
// ============================================================
exports.getMe = async (req, res, next) => {
  try {
    const me = meView(req.user);
    // Online counts any of the user's devices checking in, not just the
    // older shared endpoint.
    const devicesOnline = await WebrtcEndpoint.countDocuments({
      user: req.user._id, onlineAt: { $gte: new Date(Date.now() - APP_ONLINE_WINDOW_MS) },
    });
    me.appOnline = me.appOnline || devicesOnline > 0;
    me.devicesOnline = devicesOnline;
    return res.json({ success: true, me });
  } catch (err) {
    next(err);
  }
};

// Body may carry callPhone, callMode, or both; whatever is absent is left
// as it is.
exports.setMe = async (req, res, next) => {
  try {
    const update = { $set: {}, $unset: {} };

    if ('callPhone' in (req.body || {})) {
      const raw = req.body.callPhone;
      const cleared = raw === null || raw === undefined || String(raw).trim() === '';
      const callPhone = cleared ? null : normalisePhone(raw);
      if (!cleared && !/^[6-9]\d{9}$/.test(callPhone)) {
        return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
      }
      if (cleared) update.$unset.callPhone = 1; else update.$set.callPhone = callPhone;
    }
    if ('callMode' in (req.body || {})) {
      if (!['app', 'phone'].includes(req.body.callMode)) {
        return res.status(400).json({ success: false, message: 'callMode must be "app" or "phone".' });
      }
      update.$set.callMode = req.body.callMode;
      if (req.body.callMode === 'phone') {
        update.$unset.appOnlineAt = 1;
        await WebrtcEndpoint.updateMany({ user: req.user._id }, { $unset: { onlineAt: 1 } });
      }
    }
    if (!Object.keys(update.$set).length) delete update.$set;
    if (!Object.keys(update.$unset).length) delete update.$unset;
    if (!update.$set && !update.$unset) return res.json({ success: true, me: meView(req.user) });

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('phone callPhone callDuty callMode appOnlineAt');
    return res.json({ success: true, me: meView(user) });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/webrtc/token
// @desc    Lets this CRM tab register with Plivo to receive calls in the
//          browser. Creates the user's endpoint on first use; returns a
//          receive-only access token for it (no password). The CRM renews
//          it before expiresAt.
// @access  Private [owner]
// ============================================================
// The Plivo SDK rejects with errors whose `message` can itself be an object
// (Plivo's JSON error body), which printed as "[object Object]". Pull out
// the HTTP status and the real body, whatever shape the error took.
function plivoErrorDetail(err) {
  const status = err?.response?.status ?? err?.status ?? err?.statusCode ?? null;
  const raw = err?.response?.data ?? err?.response?.body ?? err?.message ?? err;
  let text;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    text = String(raw);
  }
  // An Error instance stringifies to "{}"; fall back to its own fields.
  if (!text || text === '{}') text = String(err?.message || err?.name || err);
  return { status, text };
}
exports.plivoErrorDetail = plivoErrorDetail;

// TEMPORARY diagnostic + self-repair, run on every token request:
//   - the username Plivo has for our stored endpoint id must be exactly the
//     one we dial in <User> and sign as JWT "sub"; on any mismatch Plivo's
//     wins and is saved;
//   - Plivo requires the endpoint to be linked to the same application the
//     token names in "app"; if it is not, it is re-linked.
// Reports lengths and flags only — no username, no password.
async function verifyEndpoint(user) {
  const check = { checkedAt: new Date(), storedLength: (user.plivoEndpointUsername || '').length };
  try {
    if (!user.plivoEndpointId) {
      check.error = 'no endpoint id stored';
    } else {
      const ep = await plivo.getEndpoint(user.plivoEndpointId);
      const appExpected = await plivo.applicationId();
      Object.assign(check, {
        plivoLength       : (ep.username || '').length,
        match             : ep.username === user.plivoEndpointUsername,
        appExpected       : appExpected || null,
        appLinked         : ep.appId || null,
        appMatches        : !!appExpected && ep.appId === appExpected,
        sipRegistered     : ep.sipRegistered,
        sipUserAgent      : ep.sipUserAgent,
        usernameCorrected : false,
        appRelinked       : false,
      });
      if (ep.username && ep.username !== user.plivoEndpointUsername) {
        console.warn(`[calls] endpoint username mismatch for user=${user._id}: stored ${check.storedLength} chars, Plivo ${check.plivoLength} chars — using Plivo's`);
        user.plivoEndpointUsername = ep.username;
        check.usernameCorrected = true;
      }
      if (appExpected && ep.appId !== appExpected) {
        await plivo.linkEndpointToApp(user.plivoEndpointId, appExpected);
        check.appRelinked = true;
        check.appLinked = appExpected;
        check.appMatches = true;
        console.warn(`[calls] endpoint for user=${user._id} was linked to app ${ep.appId || 'none'} — re-linked to ${appExpected}`);
      }
    }
  } catch (err) {
    const { status, text } = plivoErrorDetail(err);
    check.error = `Plivo endpoint lookup failed (status ${status ?? '-'})`;
    console.error(`[calls] endpoint verify failed for user=${user._id}: status=${status ?? '-'} detail=${text}`);
  }
  user.plivoEndpointCheck = check;
  try { await user.save(); } catch (e) { console.error('[calls] could not save endpoint check:', e.message); }
  return check;
}
exports.verifyEndpoint = verifyEndpoint;

// ── TEMPORARY: in-app calling debug capture ─────────────────────────────
// Anything token-shaped (JWTs, long opaque strings) is replaced before
// saving: the point is to see events and reasons, not credentials.
const redact = (v, depth = 0) => {
  if (v == null || depth > 4) return v;
  if (typeof v === 'string') {
    if (/^eyJ[\w-]+\.[\w-]+\./.test(v) || v.length > 300) return `[redacted ${v.length} chars]`;
    return v;
  }
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) {
      out[k] = /token|password|secret|jwt|authorization/i.test(k) ? '[redacted]' : redact(x, depth + 1);
    }
    return out;
  }
  return v;
};

const clip = (s, n) => (s == null ? undefined : String(s).slice(0, n));

async function saveDebugEvents(user, events) {
  const docs = events.slice(0, 50).map((e) => ({
    user     : user._id,
    userName : user.name,
    sessionId: clip(e.sessionId, 64),
    device   : clip(e.device, 200),
    event    : clip(e.event, 64) || 'unknown',
    reason   : clip(typeof e.reason === 'string' ? e.reason : e.reason == null ? undefined : JSON.stringify(redact(e.reason)), 500),
    detail   : redact(e.detail),
    clientAt : e.at ? new Date(e.at) : undefined,
  }));
  if (docs.length) await WebrtcDebugEvent.insertMany(docs, { ordered: false });
  return docs.length;
}

// ============================================================
// @route   POST /api/calls/webrtc/debug { events: [{ event, reason, detail, at, sessionId, device }] }
// @route   GET  /api/calls/webrtc/debug?all=1&limit=200
// @desc    TEMPORARY: what the Plivo SDK did in each CRM tab. GET returns
//          the signed-in user's events (all users with all=1), newest
//          first, plus one line per browser session — two sessions active
//          at once on one endpoint is the two-device registration clash.
// @access  Private [owner]
// ============================================================
exports.postWebrtcDebug = async (req, res, next) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const saved = await saveDebugEvents(req.user, events);
    return res.json({ success: true, saved });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/calls/:id/trail
// @desc    TEMPORARY: one incoming call's in-app delivery, as one
//          timeline: what the server routed (which device endpoints, how
//          many phones), Plivo's verdict on the in-app leg, and every
//          browser session's own events during the call (did it get
//          onIncomingCall, did the ring-tone fallback run, was the Answer
//          screen shown/cleared, was it answered) with its device label.
//          Read from the server-side capture, so it survives reloads.
// @access  Private [owner]
// ============================================================
const TRAIL_EVENTS = /^(server:|ui:|call:login|onIncomingCall|onIncomingCallCanceled|onIncomingCallIgnored|onCallAnswered|onCallTerminated|onCallFailed|onLogin|onLogout|onLoginFailed|onConnectionChange)/;

exports.getCallTrail = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Call not found.' });
    const log = await CallLog.findById(req.params.id).select('startedAt endedAt createdAt direction status routing').lean();
    if (!log) return res.status(404).json({ success: false, message: 'Call not found.' });

    const start = new Date(new Date(log.startedAt || log.createdAt).getTime() - 5000);
    const end = new Date(new Date(log.endedAt || (new Date(log.startedAt || log.createdAt).getTime() + 3 * 60 * 1000)).getTime() + 15000);
    const logId = String(log._id);

    const events = (await WebrtcDebugEvent.find({ at: { $gte: start, $lte: end } }).sort({ at: 1 }).limit(1000).lean())
      .filter((e) => TRAIL_EVENTS.test(e.event));

    // Per browser session: what happened to this call there.
    const sessions = {};
    for (const e of events) {
      if (!e.sessionId) continue;
      const s = sessions[e.sessionId] ||= {
        sessionId: e.sessionId, device: e.device, user: e.userName,
        gotIncoming: false, gotThisCall: false, answerScreenShown: false, ringtoneFallback: false,
        cleared: [], answered: false, ended: false,
      };
      const mentionsCall = JSON.stringify(e.detail || '').includes(logId);
      if (e.event === 'onIncomingCall') { s.gotIncoming = true; if (mentionsCall) s.gotThisCall = true; }
      if (e.event === 'ui:incoming_shown') { s.answerScreenShown = true; if (mentionsCall) s.gotThisCall = true; }
      if (e.event === 'ui:ringtone_without_event') s.ringtoneFallback = true;
      if (e.event === 'ui:incoming_cleared' || e.event === 'onIncomingCallCanceled') s.cleared.push(e.event === 'onIncomingCallCanceled' ? 'canceled by Plivo' : (e.detail?.[0]?.why || 'cleared'));
      if (e.event === 'onCallAnswered' || e.event === 'ui:in_call') s.answered = true;
      if (e.event === 'onCallTerminated' || e.event === 'ui:call_ended') s.ended = true;
    }

    return res.json({
      success: true,
      call: { _id: log._id, status: log.status, startedAt: log.startedAt, endedAt: log.endedAt, decision: log.routing?.decision || null },
      window: { from: start, to: end },
      sessions: Object.values(sessions),
      events: events.map((e) => ({
        at: e.clientAt || e.at, event: e.event, reason: e.reason, device: e.device, sessionId: e.sessionId, user: e.userName,
        detail: e.detail,
      })),
    });
  } catch (err) {
    next(err);
  }
};

exports.getWebrtcDebug = async (req, res, next) => {
  try {
    const filter = req.query.all === '1' ? {} : { user: req.user._id };
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const events = await WebrtcDebugEvent.find(filter).sort({ at: -1 }).limit(limit).lean();

    const sessions = {};
    for (const e of [...events].reverse()) {
      const s = sessions[e.sessionId || '-'] ||= {
        sessionId: e.sessionId || null, user: e.userName, device: e.device,
        firstAt: e.at, lastAt: e.at, events: 0, lastLogin: null, lastLogout: null, lastLoginFailed: null, lastState: null,
      };
      s.lastAt = e.at;
      s.events += 1;
      if (e.event === 'onLogin') s.lastLogin = e.at;
      if (e.event === 'onLogout') s.lastLogout = { at: e.at, reason: e.reason || null };
      if (e.event === 'onLoginFailed') s.lastLoginFailed = { at: e.at, reason: e.reason || null };
      if (e.event === 'state') s.lastState = { at: e.at, ...e.detail };
    }
    // This user's in-app devices and which are checking in right now.
    const deviceFilter = req.query.all === '1' ? {} : { user: req.user._id };
    const devices = (await WebrtcEndpoint.find(deviceFilter).sort({ lastUsedAt: -1 }).lean()).map((d) => ({
      user: d.user, device: d.device, deviceKey: d.deviceKey, lastUsedAt: d.lastUsedAt,
      onlineAt: d.onlineAt || null, online: isFresh(d.onlineAt),
    }));
    return res.json({ success: true, devices, sessions: Object.values(sessions).reverse(), events });
  } catch (err) {
    next(err);
  }
};

const loadEndpointUser = (id) => User.findById(id)
  .select('name +plivoEndpointId +plivoEndpointUsername +plivoEndpointPassword +plivoEndpointCheck');

// Makes sure the user has their Plivo endpoint, creating or finding it the
// first time. Returns nothing on success, or the 502 response already sent.
async function ensureUserEndpoint(user, res) {
  if (user.plivoEndpointUsername) return undefined;
  try {
    // Finds the endpoint by its alias first, so a retry after a
    // half-finished attempt reuses it instead of making another.
    const ep = await plivo.ensureEndpoint({ userId: user._id });
    if (!ep.username) throw new Error('Plivo returned no endpoint username');
    user.plivoEndpointId = ep.id;
    user.plivoEndpointUsername = ep.username;
    if (ep.password) user.plivoEndpointPassword = ep.password;
    await user.save();
    console.info(`[calls] ${ep.existing ? 'reused' : 'created'} Plivo endpoint ${ep.username} for user=${user._id}`);
    return undefined;
  } catch (err) {
    const { status, text } = plivoErrorDetail(err);
    // Plivo's full error stays in the server log; the browser gets the
    // stage and status only.
    console.error(`[calls] endpoint setup failed: status=${status ?? '-'} detail=${text}`, err);
    return res.status(502).json({
      success: false, stage: 'endpoint', plivoStatus: status,
      message: `Could not set up in-app calling with Plivo (endpoint, status ${status ?? '-'}). Calls will ring your phone.`,
    });
  }
}

// ── Per-device endpoints ─────────────────────────────────────────────────
// The CRM sends a device key (X-Device-Key) it keeps in localStorage; each
// device gets its own Plivo endpoint and registration (models/
// WebrtcEndpoint.js). Requests without one — CRM builds from before this —
// keep using the shared per-user endpoint.
const DEVICE_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_DEVICES_PER_USER = 5;
const deviceKeyOf = (req) => {
  const k = req.get('X-Device-Key') || req.query?.deviceKey || req.body?.deviceKey;
  return typeof k === 'string' && DEVICE_KEY_RE.test(k) ? k : null;
};
const deviceLabelOf = (req) => clip(req.get('X-Device-Label') || req.get('user-agent'), 200);

// Plivo's record of one endpoint vs what we would dial: corrects the
// username to Plivo's and re-links the endpoint to our application if
// needed (Plivo requires endpoint and token "app" to match). Lengths and
// flags only — no username, no password.
async function checkEndpointRecord(endpointId, username) {
  const check = { checkedAt: new Date(), storedLength: (username || '').length };
  let corrected = null;
  try {
    const ep = await plivo.getEndpoint(endpointId);
    const appExpected = await plivo.applicationId();
    Object.assign(check, {
      plivoLength: (ep.username || '').length, match: ep.username === username,
      appExpected: appExpected || null, appLinked: ep.appId || null,
      appMatches: !!appExpected && ep.appId === appExpected,
      sipRegistered: ep.sipRegistered, sipUserAgent: ep.sipUserAgent,
      usernameCorrected: false, appRelinked: false,
    });
    if (ep.username && ep.username !== username) { corrected = ep.username; check.usernameCorrected = true; }
    if (appExpected && ep.appId !== appExpected) {
      await plivo.linkEndpointToApp(endpointId, appExpected);
      Object.assign(check, { appRelinked: true, appLinked: appExpected, appMatches: true });
    }
  } catch (err) {
    const { status, text } = plivoErrorDetail(err);
    check.error = `Plivo endpoint lookup failed (status ${status ?? '-'})`;
    console.error(`[calls] endpoint check failed: status=${status ?? '-'} detail=${text}`);
  }
  return { check, corrected };
}

// This device's endpoint: found, or created (and the user's oldest device
// endpoint retired past MAX_DEVICES_PER_USER), checked against Plivo, and
// with a password set if missing or if Plivo just refused it (reset).
async function ensureDeviceEndpoint(user, deviceKey, device, { reset = false } = {}) {
  let doc = await WebrtcEndpoint.findOne({ user: user._id, deviceKey }).select('+password');
  if (!doc) {
    const existing = await WebrtcEndpoint.find({ user: user._id }).sort({ lastUsedAt: 1 }).select('endpointId').lean();
    for (const old of existing.slice(0, Math.max(0, existing.length - MAX_DEVICES_PER_USER + 1))) {
      if (old.endpointId) await plivo.deleteEndpoint(old.endpointId).catch(() => {});
      await WebrtcEndpoint.deleteOne({ _id: old._id });
      console.info(`[calls] retired oldest device endpoint for user=${user._id} (max ${MAX_DEVICES_PER_USER})`);
    }
    const ep = await plivo.ensureEndpoint({ userId: user._id, deviceKey });
    if (!ep.username) throw new Error('Plivo returned no endpoint username');
    doc = await WebrtcEndpoint.create({
      user: user._id, deviceKey, device, endpointId: ep.id, username: ep.username, password: ep.password || undefined,
    });
    console.info(`[calls] ${ep.existing ? 'reused' : 'created'} device endpoint ${ep.username} for user=${user._id}`);
  }

  const { check, corrected } = doc.endpointId
    ? await checkEndpointRecord(doc.endpointId, doc.username)
    : { check: { error: 'no endpoint id stored' }, corrected: null };
  if (corrected) doc.username = corrected;

  if (!doc.password || reset) {
    doc.password = await plivo.resetEndpointPassword(doc.endpointId);
    // Never the password itself — only that it changed.
    console.info(`[calls] set new device endpoint password for user=${user._id} (${reset ? 'login rejected' : 'none stored'})`);
  }
  doc.device = device || doc.device;
  doc.lastUsedAt = new Date();
  await doc.save();
  return { doc, endpointCheck: check };
}
exports.ensureDeviceEndpoint = ensureDeviceEndpoint;

// How the CRM logs in to Plivo for in-app calling:
//   'password' — classic SIP registration with the endpoint's own
//                username/password. The default: on our (India-region)
//                account it is the only login Plivo actually registers —
//                with a token, Plivo kept the endpoint "Not registered"
//                and inbound calls never reached the browser.
//   'token'    — access token from Plivo's JWT API. Kept, behind the flag,
//                to switch back to if Plivo fixes token registration.
// Set with PLIVO_WEBRTC_LOGIN on Render; a browser may also ask for one
// explicitly (localStorage plivoLoginMode) to compare the two.
const LOGIN_MODES = ['token', 'password'];
const serverLoginMode = () => (LOGIN_MODES.includes(process.env.PLIVO_WEBRTC_LOGIN) ? process.env.PLIVO_WEBRTC_LOGIN : 'password');

// ============================================================
// @route   GET /api/calls/webrtc/login?mode=token|password[&reset=1]
// @desc    Which login the CRM should use for in-app calling, and for
//          'password' the signed-in user's OWN endpoint username and
//          password (over HTTPS, to that user only — never anyone else's,
//          never cached, never logged). A missing stored password is set
//          on Plivo and stored first; reset=1 (sent by the CRM after Plivo
//          rejects a login) does the same even if one is stored.
// @access  Private [owner]
// ============================================================
exports.webrtcLogin = async (req, res, next) => {
  try {
    if (!plivo.isConfigured()) return res.status(503).json({ success: false, message: NOT_CONFIGURED });
    const mode = LOGIN_MODES.includes(req.query.mode) ? req.query.mode : serverLoginMode();
    if (mode === 'token') return res.json({ success: true, mode });

    // This device's own endpoint (the CRM sends its device key).
    const deviceKey = deviceKeyOf(req);
    if (deviceKey) {
      let ensured;
      try {
        ensured = await ensureDeviceEndpoint(req.user, deviceKey, deviceLabelOf(req), { reset: req.query.reset === '1' });
      } catch (err) {
        const { status, text } = plivoErrorDetail(err);
        console.error(`[calls] device endpoint setup failed: status=${status ?? '-'} detail=${text}`);
        return res.status(502).json({
          success: false, stage: 'endpoint', plivoStatus: status,
          message: `Could not set up in-app calling with Plivo for this device (status ${status ?? '-'}). Calls will ring your phone.`,
        });
      }
      saveDebugEvents(req.user, [{
        event: 'server:credentials_issued', sessionId: req.get('X-Client-Session'), device: deviceLabelOf(req),
        detail: { endpointCheck: ensured.endpointCheck, deviceKey, perDevice: true }, at: new Date(),
      }]).catch(() => {});
      res.set('Cache-Control', 'no-store');
      return res.json({
        success : true,
        mode,
        perDevice: true,
        username: ensured.doc.username,
        password: ensured.doc.password,
        endpointCheck: ensured.endpointCheck,
      });
    }

    const user = await loadEndpointUser(req.user._id);
    const failed = await ensureUserEndpoint(user, res);
    if (failed) return failed;
    const endpointCheck = await verifyEndpoint(user);

    const forceReset = req.query.reset === '1';
    if (!user.plivoEndpointPassword || forceReset) {
      try {
        user.plivoEndpointPassword = await plivo.resetEndpointPassword(user.plivoEndpointId);
        await user.save();
        // Never the password itself — only that it changed.
        console.info(`[calls] set new Plivo endpoint password for user=${user._id} (${forceReset ? 'login rejected' : 'none stored'})`);
      } catch (err) {
        const { status, text } = plivoErrorDetail(err);
        console.error(`[calls] endpoint password reset failed: status=${status ?? '-'} detail=${text}`);
        return res.status(502).json({
          success: false, stage: 'password', plivoStatus: status,
          message: `Could not prepare in-app calling credentials (status ${status ?? '-'}). Calls will ring your phone.`,
        });
      }
    }

    saveDebugEvents(user, [{
      event: 'server:credentials_issued', sessionId: req.get('X-Client-Session'), device: req.get('user-agent'),
      detail: { endpointCheck }, at: new Date(),
    }]).catch(() => {});
    res.set('Cache-Control', 'no-store');
    return res.json({
      success : true,
      mode,
      username: user.plivoEndpointUsername,
      password: user.plivoEndpointPassword,
      endpointCheck,
    });
  } catch (err) {
    next(err);
  }
};

exports.webrtcToken = async (req, res, next) => {
  try {
    if (!plivo.isConfigured()) return res.status(503).json({ success: false, message: NOT_CONFIGURED });

    // Token mode on a device with its own endpoint signs for that endpoint.
    const deviceKey = deviceKeyOf(req);
    if (deviceKey) {
      try {
        const { doc, endpointCheck } = await ensureDeviceEndpoint(req.user, deviceKey, deviceLabelOf(req));
        const { token, expiresAt } = await plivo.issueToken(doc.username);
        return res.json({ success: true, token, expiresAt, endpointCheck, perDevice: true });
      } catch (err) {
        const { status, text } = plivoErrorDetail(err);
        console.error(`[calls] device token failed: status=${status ?? '-'} detail=${text}`);
        return res.status(502).json({
          success: false, stage: 'token', plivoStatus: status,
          message: `Could not get an in-app calling token from Plivo (status ${status ?? '-'}). Calls will ring your phone.`,
        });
      }
    }

    const user = await loadEndpointUser(req.user._id);
    const failed = await ensureUserEndpoint(user, res);
    if (failed) return failed;

    // Check what we will dial and sign against Plivo's own record of the
    // endpoint. Never blocks the token: a failed check is reported, not fatal.
    const endpointCheck = await verifyEndpoint(user);

    try {
      const { token, expiresAt } = await plivo.issueToken(user.plivoEndpointUsername);
      // TEMPORARY: which browser session asked, so two devices sharing one
      // endpoint are visible in GET /api/calls/webrtc/debug.
      saveDebugEvents(user, [{
        event    : 'server:token_issued',
        sessionId: req.get('X-Client-Session'),
        device   : req.get('user-agent'),
        detail   : { endpointCheck },
        at       : new Date(),
      }]).catch(() => {});
      return res.json({ success: true, token, expiresAt, endpointCheck });
    } catch (err) {
      const { status, text } = plivoErrorDetail(err);
      console.error(`[calls] Plivo JWT token failed: status=${status ?? '-'} detail=${text}`, err);
      return res.status(502).json({
        success: false, stage: 'token', plivoStatus: status,
        message: `Could not get an in-app calling token from Plivo (status ${status ?? '-'}). Calls will ring your phone.`,
      });
    }
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/calls/webrtc/presence { online }
// @desc    Check-in from a CRM tab that is registered with Plivo and has
//          microphone access (online: true, every 30s), or leaving
//          (online: false). Incoming calls ring this user in the app only
//          while check-ins are fresh; otherwise on their phone.
// @access  Private [owner]
// ============================================================
exports.webrtcPresence = async (req, res, next) => {
  try {
    const online = !!req.body?.online;
    const deviceKey = deviceKeyOf(req);
    if (deviceKey) {
      // This device only — the user's other devices keep their own state.
      await WebrtcEndpoint.updateOne({ user: req.user._id, deviceKey }, online
        ? { $set: { onlineAt: new Date() } }
        : { $unset: { onlineAt: 1 } });
      return res.json({ success: true, online, perDevice: true });
    }
    await User.updateOne({ _id: req.user._id }, online
      ? { $set: { appOnlineAt: new Date() } }
      : { $unset: { appOnlineAt: 1 } });
    return res.json({ success: true, online });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/:id
// @desc    One call, masked — what the in-app ringing screen shows.
// @access  Private [owner]
// ============================================================
exports.getCall = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Call not found.' });
    const log = await CallLog.findById(req.params.id)
      .select('+customerPhone') // for toJSON: masked, or in full for a CRM owner
      .populate('trip', 'tripNumber patientName status')
      .populate('lead', 'patientName');
    if (!log) return res.status(404).json({ success: false, message: 'Call not found.' });
    return res.json({ success: true, log });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/calls/test-ring
// @desc    "Ring my phone now (test)": Plivo rings the signed-in user's
//          ring number from the company number and, if answered, says it
//          is a test and hangs up. Nothing recorded, no customer involved —
//          so the phone path can be checked without a second phone to
//          call in from. The CRM polls GET /:id for the outcome.
// @access  Private [owner]
// ============================================================
const TEST_RING_MESSAGE = 'This is a SaveLife test call. Your ring number works. Goodbye.';
const TEST_RING_GAP_MS = 30 * 1000;

exports.testRing = async (req, res, next) => {
  try {
    if (!plivo.isConfigured()) return res.status(503).json({ success: false, message: NOT_CONFIGURED });
    const phone = ringPhoneOf(req.user);
    if (!isMobile(phone)) {
      return res.status(400).json({ success: false, message: 'Set a valid ring number first.' });
    }
    // One test at a time per user — each is a real Plivo call.
    const recent = await CallLog.findOne({
      context: 'test_ring', agentUser: req.user._id,
      startedAt: { $gte: new Date(Date.now() - TEST_RING_GAP_MS) },
    }).select('_id').lean();
    if (recent) {
      return res.status(429).json({ success: false, message: 'A test call was placed in the last 30 seconds. Wait for it to finish.' });
    }

    const log = await CallLog.create({
      provider  : 'plivo',
      direction : 'outbound',
      firstLeg  : 'agent',
      context   : 'test_ring',
      agentType : 'staff',
      agentUser : req.user._id,
      agentName : req.user.name,
      agentPhone: normalisePhone(phone),
      callerId  : plivo.companyNumber(),
      status    : 'initiated',
      flow      : [`test_ring:${plivo.PHONE_RING_SECONDS}s`],
    });
    try {
      const { requestId } = await plivo.callTestRing({ phone, logId: log._id });
      log.providerRequestId = requestId;
      await log.save();
      plivo.logCall('test ring placed', log);
    } catch (plivoErr) {
      console.error('[calls] test ring failed:', plivoErr?.message || plivoErr);
      log.status = 'failed';
      log.error = String(plivoErr?.message || plivoErr).slice(0, 500);
      log.endedAt = new Date();
      await log.save();
      return res.status(502).json({ success: false, message: plivo.friendlyError(plivoErr), callLogId: log._id });
    }
    return res.json({
      success  : true,
      callLogId: log._id,
      ringPhone: maskPhone(phone),
      callerId : log.callerId,
      message  : `Ringing ${maskPhone(phone)} from ${log.callerId} now.`,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/calls/test-answer?log=<id>
// @desc    The test call was answered: say so, hang up. No Dial, no Record.
// @access  Plivo (signature)
// ============================================================
exports.testAnswer = async (req, res, next) => {
  try {
    const logId = logIdOf(req);
    const log = logId ? await CallLog.findById(logId) : null;
    if (log?.context === 'test_ring') {
      log.answeredAt = new Date();
      if (plivoParams(req).CallUUID) log.providerCallId = plivoParams(req).CallUUID;
      log.flow = [...(log.flow || []), 'test_ring:answered'];
      await log.save();
      await setStatusIf(log, 'completed', { $ne: 'completed' });
    }
    return sendXml(res, plivo.speakXml(TEST_RING_MESSAGE));
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/calls/:id/answered
// @desc    The CRM user who answered an incoming call in the app — Plivo's
//          Dial does not say which of the ringing legs picked up.
// @access  Private [owner]
// ============================================================
exports.markAnswered = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Call not found.' });
    // Answering a transferred call: the transfer that is ringing records who
    // took it (first answer wins). The call's original agent is unchanged.
    const current = await CallLog.findById(req.params.id, 'direction transfers');
    const t = current?.direction === 'inbound' ? (current.transfers || []).findIndex((x) => x?.outcome === 'ringing') : -1;
    if (t >= 0) {
      const step = current.transfers[t].step;
      const r = await CallLog.updateOne(
        { _id: req.params.id, [`transfers.${t}.outcome`]: 'ringing' },
        { $set: {
          [`transfers.${t}.outcome`]       : String(step || '').startsWith('back_') ? 'rang_back' : 'answered',
          [`transfers.${t}.answeredBy`]    : req.user._id,
          [`transfers.${t}.answeredByName`]: req.user.name,
          [`transfers.${t}.answeredAt`]    : new Date(),
          [`transfers.${t}.answeredIn`]    : 'app',
        } },
      );
      return res.json({ success: true, claimed: r?.modifiedCount > 0, transfer: t });
    }
    const updated = await CallLog.findOneAndUpdate(
      // First answer wins, matching Plivo: a later claim changes nothing.
      { _id: req.params.id, direction: 'inbound', agentUser: { $exists: false } },
      { $set: { agentUser: req.user._id, agentName: req.user.name, agentType: 'staff', answeredAt: new Date() } },
      { new: true },
    );
    return res.json({ success: true, claimed: !!updated });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/plivo/live
// @desc    Every call Plivo has live on the account right now — each one
//          counts toward its simultaneous-call limit. Matched to our call
//          logs where possible; numbers masked. A call nobody here knows
//          about, or one far older than any real call, is a stuck leg.
// @access  Private [owner]
// ============================================================
exports.liveCalls = async (req, res, next) => {
  try {
    if (!plivo.isConfigured()) return res.status(503).json({ success: false, message: NOT_CONFIGURED });
    let live;
    try {
      live = await plivo.listLiveCalls();
    } catch (err) {
      const { status, text } = plivoErrorDetail(err);
      console.error(`[calls] live call list failed: status=${status ?? '-'} detail=${text}`);
      return res.status(502).json({ success: false, plivoStatus: status, message: `Could not read live calls from Plivo (status ${status ?? '-'}).` });
    }

    // Legs stuck ringing are hung up on sight, and left out of the list.
    const autoHungUp = await hangupLegs(stuckLegs(live), `ringing over ${STUCK_RINGING_SEC}s (seen on the Live calls panel)`);
    if (autoHungUp.length) {
      live = { total: Math.max(0, live.total - autoHungUp.length), calls: live.calls.filter((c) => !autoHungUp.includes(c.callUuid)) };
    }

    const uuids = live.calls.map((c) => c.callUuid);
    const logs = uuids.length
      ? await CallLog.find({ $or: [{ providerCallId: { $in: uuids } }, { customerLegId: { $in: uuids } }] })
        .select('_id providerCallId customerLegId direction status context startedAt').lean()
      : [];
    const byUuid = new Map();
    for (const l of logs) {
      if (l.providerCallId) byUuid.set(l.providerCallId, l);
      if (l.customerLegId) byUuid.set(l.customerLegId, l);
    }
    const mask = (v) => (/^\+?\d{10,15}$/.test(String(v || '')) ? maskPhone(v) : v || null);

    return res.json({
      success: true,
      total  : live.total,
      autoHungUp: autoHungUp.length,
      stuckAfterSec: STUCK_RINGING_SEC,
      calls  : live.calls.map((c) => {
        const log = byUuid.get(c.callUuid);
        const started = c.session_start ? new Date(c.session_start) : null;
        return {
          callUuid  : c.callUuid,
          direction : c.direction || null,
          from      : mask(c.from),
          to        : mask(c.to),
          status    : c.call_status || null,
          startedAt : started && !Number.isNaN(started.getTime()) ? started : null,
          ageSec    : started && !Number.isNaN(started.getTime()) ? Math.round((Date.now() - started.getTime()) / 1000) : null,
          callLog   : log ? { _id: log._id, direction: log.direction, status: log.status, context: log.context } : null,
          error     : c.error || undefined,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/calls/plivo/live/:uuid/hangup
// @desc    Hang up one live Plivo call — for clearing a stuck leg that
//          holds the simultaneous-call limit. One at a time, by id, so a
//          real conversation is never cut off in bulk.
// @access  Private [owner]
// ============================================================
exports.hangupLiveCall = async (req, res, next) => {
  try {
    const uuid = String(req.params.uuid || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(uuid)) return res.status(400).json({ success: false, message: 'Not a Plivo call id.' });
    try {
      await plivo.hangupCall(uuid);
    } catch (err) {
      const { status, text } = plivoErrorDetail(err);
      console.error(`[calls] hangup ${uuid} failed: status=${status ?? '-'} detail=${text}`);
      return res.status(status === 404 ? 404 : 502).json({
        success: false, plivoStatus: status,
        message: status === 404 ? 'That call has already ended.' : `Plivo could not hang up that call (status ${status ?? '-'}).`,
      });
    }
    console.info(`[calls] live call ${uuid} hung up by user=${req.user._id}`);
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/calls/config
// @desc    Which provider masked calls use right now, and the caller ID
//          customers see — so the CRM can show it rather than assume it.
// @access  Private [owner]
// ============================================================
exports.getConfig = async (req, res) => res.json({
  success : true,
  provider: plivo.isConfigured() ? 'plivo' : 'none',
  callerId: plivo.isConfigured() ? plivo.companyNumber() : null,
  // The only remaining Exotel path: /api/call/connect, and only while
  // Plivo is not configured.
  legacyExotelActive: !plivo.isConfigured() && !!(process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY),
  // The URLs the Plivo application must use, and what each webhook has
  // seen since this server last started — "never hit" means Plivo is not
  // sending to us; "rejected" carries the reason.
  incomingAnswerUrl: plivo.apiUrl('/api/calls/incoming'),
  hangupUrl        : plivo.apiUrl('/api/calls/events'),
  webhooks         : webhookStats,
  serverStartedAt  : SERVER_STARTED_AT,
});
