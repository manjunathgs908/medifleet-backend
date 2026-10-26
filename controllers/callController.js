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
const WebrtcDebugEvent = require('../models/WebrtcDebugEvent');
const plivo        = require('../services/plivoService');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const { phoneFromRef, maskPhone } = require('../utils/customerPhone');

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

// Splits on-duty users into in-app endpoints to ring and phones to ring.
function routeIncoming(users) {
  const sipUsers = [];
  const phones = [];
  for (const u of users) {
    if (u.callMode === 'app' && u.plivoEndpointUsername && isAppOnline(u)) sipUsers.push(u.plivoEndpointUsername);
    else if (isMobile(ringPhoneOf(u))) phones.push(ringPhoneOf(u));
  }
  return { sipUsers, phones };
}
exports.routeIncoming = routeIncoming;

// Every on-duty user's phone — in-app users included — for when nobody
// answers in the app. Then PLIVO_FALLBACK_AGENTS if nobody has one.
function fallbackPhones(users) {
  let phones = [...new Set(users.map(ringPhoneOf).filter(isMobile))];
  if (!phones.length) {
    phones = String(process.env.PLIVO_FALLBACK_AGENTS || '')
      .split(',').map((s) => s.trim()).filter(isMobile);
  }
  return phones.slice(0, MAX_INCOMING_AGENTS);
}
exports.fallbackPhones = fallbackPhones;

const loadOnDuty = () => User.find({ role: 'owner', isActive: true, callDuty: true })
  .select('name phone callPhone callMode appOnlineAt +plivoEndpointUsername +plivoEndpointId')
  .limit(MAX_INCOMING_AGENTS).lean();

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

const NOT_CONFIGURED = 'Calling is not set up: PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_NUMBER (91 followed by 10 digits) are needed on the server.';

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
  const { tripId, leadId, quoteId, whatsappLeadId, customerRef, callLogId } = req.body || {};

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
  if (callLogId) {
    // "Call back" from the call history -- typically a missed incoming call.
    if (!isObjectId(String(callLogId))) throw new CallError(404, 'Call not found.');
    const prior = await CallLog.findById(callLogId).select('+customerPhone trip lead');
    if (!prior?.customerPhone) throw new CallError(404, 'Call not found.');
    return { phone: prior.customerPhone, context: 'call_back', refs: { trip: prior.trip, lead: prior.lead } };
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
const WEBHOOKS = ['answer', 'incoming', 'events', 'recording'];
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

    log.status = 'agent_answered';
    log.answeredAt = new Date();
    if (plivoParams(req).CallUUID) log.providerCallId = plivoParams(req).CallUUID;
    await log.save();

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
    const from = normalisePhone(plivoParams(req).From);

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
    const { sipUsers } = routeIncoming(onDuty);
    const agentPhones = fallbackPhones(onDuty);
    const ringing = agentPhones.length + sipUsers.length;

    // TEMPORARY diagnostic: the decision and its inputs, per in-app user.
    const routing = {
      decision : !ringing ? 'none' : sipUsers.length ? 'app_then_phone' : 'phone',
      decidedAt: new Date(),
      onDuty   : onDuty.length,
      phones   : agentPhones.length,
      appUsers : onDuty.filter((u) => u.callMode === 'app').map((u) => ({
        user          : u._id,
        name          : u.name,
        appOnline     : isAppOnline(u),
        appOnlineAt   : u.appOnlineAt || null,
        hasEndpoint   : !!u.plivoEndpointUsername,
        sipUri        : u.plivoEndpointUsername ? plivo.sipUri(u.plivoEndpointUsername) : null,
        dialled       : sipUsers.includes(u.plivoEndpointUsername),
      })),
    };

    const log = await CallLog.create({
      routing,
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
    });
    plivo.logCall(`inbound app=${sipUsers.length} phones=${agentPhones.length} stage=${sipUsers.length ? 'app' : 'phone'}`, log);

    if (!ringing) return sendXml(res, plivo.speakXml(BUSY_MESSAGE));
    if (sipUsers.length) {
      sendXml(res, plivo.bridgeXml({ sipUsers, logId: log._id, stage: 'app', timeout: plivo.APP_RING_SECONDS }));
      // After answering Plivo, so it cannot delay the call: Plivo's own view
      // of each in-app endpoint right now — registered or not, its user
      // agent, its application.
      snapshotEndpoints(log._id, onDuty).catch(() => {});
      return undefined;
    }
    return sendXml(res, plivo.bridgeXml({ numbers: agentPhones, logId: log._id, stage: 'phone' }));
  } catch (err) {
    next(err);
  }
};


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

      // Stage 1 (in-app) ended without an answer — for ANY reason, or with
      // no status at all. Never strand the caller: ring every on-duty phone
      // now. Only a completed app leg ends the call here.
      if (req.query.stage === 'app' && dialStatus !== 'completed') {
        const phones = fallbackPhones(await loadOnDuty());
        console.info(`[calls] in-app leg not answered (DialStatus=${dialStatus || '-'} cause=${b.DialHangupCause || b.DialBLegHangupCause || '-'}) log=${logId || '-'} — ringing ${phones.length} phone(s)`);
        if (log) {
          // TEMPORARY diagnostic: Plivo's verdict on the in-app leg.
          log.appLeg = {
            sipUris  : (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri),
            ...dialResult(b),
            fellBackToPhones: phones.length,
          };
          log.status = phones.length ? 'ringing' : 'missed';
          if (b.DialBLegHangupCause) log.hangupCause = b.DialBLegHangupCause;
          await log.save();
        }
        if (phones.length && logId) {
          return sendXml(res, plivo.bridgeXml({ numbers: phones, logId, stage: 'phone' }));
        }
        return sendXml(res, plivo.speakXml(BUSY_MESSAGE));
      }

      if (log) {
        // TEMPORARY diagnostic: Plivo's verdict on whichever stage this was.
        if (req.query.stage === 'app') {
          log.appLeg = { sipUris: (log.routing?.appUsers || []).filter((u) => u.dialled).map((u) => u.sipUri), ...dialResult(b) };
        } else if (req.query.stage === 'phone') {
          log.phoneLeg = dialResult(b);
        }
        if (dialStatus === 'completed') {
          log.status = 'completed';
          const talk = Number(b.DialBLegDuration ?? b.DialBLegBillDuration);
          if (Number.isFinite(talk)) log.talkSec = talk;
        } else if (dialStatus) {
          log.status = log.direction === 'inbound'
            ? 'missed'
            : (DIAL_FAIL[dialStatus] || `customer_${dialStatus}`);
        }
        if (b.DialBLegUUID) log.customerLegId = b.DialBLegUUID;
        if (b.DialBLegHangupCause) log.hangupCause = b.DialBLegHangupCause;
        await log.save();
      }
      // A customer whose call nobody picked up hears why before hanging up.
      if (log?.direction === 'inbound' && dialStatus && dialStatus !== 'completed') {
        return sendXml(res, plivo.speakXml('Sorry, our team could not take your call right now. We will call you back shortly.'));
      }
      return sendXml(res, plivo.hangupXml());
    }

    // hangup_url for the whole call.
    if (log) {
      const callStatus = String(b.CallStatus || '').toLowerCase();
      if (['initiated', 'agent_answered', 'ringing'].includes(log.status)) {
        // Ended before the Dial reported anything: the agent never answered
        // (outbound), or the caller gave up while it rang (inbound).
        log.status = log.direction === 'inbound'
          ? 'missed'
          : (log.status === 'agent_answered' ? 'customer_missed' : (AGENT_LEG_FAIL[callStatus] || 'agent_missed'));
      }
      if (b.CallUUID && !log.providerCallId) log.providerCallId = b.CallUUID;
      const total = Number(b.Duration);
      if (Number.isFinite(total)) log.totalSec = total;
      if (b.HangupCause && !log.hangupCause) log.hangupCause = b.HangupCause;
      log.endedAt = new Date();
      await log.save();
      plivo.logCall(`hangup status=${log.status}`, log);
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
    if (logId && (b.RecordUrl || b.RecordingID)) {
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

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const logs = await CallLog.find(filter)
      .select('+customerPhone') // only so toJSON can mask it
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('trip', 'tripNumber patientName')
      .populate('lead', 'patientName');

    return res.json({ success: true, logs });
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
    const log = await CallLog.findById(req.params.id).select('recordingUrl');
    if (!log?.recordingUrl) {
      return res.status(404).json({ success: false, message: 'This call has no recording.' });
    }
    if (!isPlivoMediaUrl(log.recordingUrl)) {
      return res.status(502).json({ success: false, message: 'This recording is not stored with Plivo.' });
    }
    if (!process.env.PLIVO_AUTH_ID || !process.env.PLIVO_AUTH_TOKEN) {
      return res.status(503).json({ success: false, message: 'Recordings cannot be played: Plivo credentials are not set on the server.' });
    }

    let upstream;
    try {
      upstream = await axios.get(log.recordingUrl, {
        auth          : { username: process.env.PLIVO_AUTH_ID, password: process.env.PLIVO_AUTH_TOKEN },
        responseType  : 'stream',
        timeout       : 20000,
        headers       : req.get('range') ? { Range: req.get('range') } : {},
        // Read Plivo's status ourselves so a 401/404 becomes a clear message.
        validateStatus: () => true,
      });
    } catch (err) {
      console.error('[calls] recording fetch failed:', err.message);
      return res.status(502).json({ success: false, message: 'Could not reach Plivo for this recording. Please try again.' });
    }

    if (upstream.status >= 400) {
      upstream.data?.destroy?.();
      const message = upstream.status === 401 || upstream.status === 403
        ? 'Plivo refused the recording request. Check PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN on Render.'
        : upstream.status === 404
          ? 'Plivo no longer has this recording.'
          : 'Could not load this recording from Plivo.';
      return res.status(upstream.status === 404 ? 404 : 502).json({ success: false, message });
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
exports.getMe = async (req, res) => res.json({ success: true, me: meView(req.user) });

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
      if (req.body.callMode === 'phone') update.$unset.appOnlineAt = 1;
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
    return res.json({ success: true, sessions: Object.values(sessions).reverse(), events });
  } catch (err) {
    next(err);
  }
};

exports.webrtcToken = async (req, res, next) => {
  try {
    if (!plivo.isConfigured()) return res.status(503).json({ success: false, message: NOT_CONFIGURED });

    const user = await User.findById(req.user._id).select('name +plivoEndpointId +plivoEndpointUsername +plivoEndpointPassword +plivoEndpointCheck');
    if (!user.plivoEndpointUsername) {
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
      .select('+customerPhone') // only so toJSON can mask it
      .populate('trip', 'tripNumber patientName status')
      .populate('lead', 'patientName');
    if (!log) return res.status(404).json({ success: false, message: 'Call not found.' });
    return res.json({ success: true, log });
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
