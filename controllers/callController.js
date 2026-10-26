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
 *   GET  /logs            CRM call history with recordings.
 *   GET/PUT /duty         CRM staff's own "On call duty" switch.
 *
 * The customer's number exists only here and in Plivo's XML. Clients send a
 * reference, never a number, and every response is the CallLog's JSON form,
 * which strips both numbers (models/CallLog.js). The Plivo webhooks check
 * Plivo's request signature before answering, because /answer's reply
 * contains the customer's number.
 *
 * Exotel stays as the fallback: with no PLIVO_* configuration, a trip call
 * goes through services/exotelService.js exactly as /api/call/connect does.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Trip, Lead, User } = require('../models');
const Ambulance    = require('../models/Ambulance');
const Quote        = require('../models/Quote');
const WhatsAppLead = require('../models/WhatsAppLead');
const CallLog      = require('../models/CallLog');
const plivo        = require('../services/plivoService');
const exotel       = require('../services/exotelService');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const { phoneFromRef } = require('../utils/customerPhone');

// Statuses during which a driver or partner may still reach the customer.
const ACTIVE_TRIP_STATUSES = ['booked', 'dispatched', 'en_route'];
const MAX_INCOMING_AGENTS = 10;

const isMobile = (raw) => /^[6-9]\d{9}$/.test(normalisePhone(raw));
const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);

const sendXml = (res, body) => res.type('text/xml').send(body);

// Who is asking, and from which phone Plivo should ring them.
function agentOf(req) {
  if (req.actorType === 'owner') {
    return { type: 'fleet_owner', owner: req.user._id, name: req.user.name, phone: req.user.phone };
  }
  return {
    type : req.user.role === 'driver' ? 'driver' : 'staff',
    user : req.user._id,
    name : req.user.name,
    phone: req.user.phone,
  };
}

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
      return res.status(400).json({ success: false, message: 'Your account has no valid mobile number to ring. Ask an admin to update it.' });
    }
    if (!isMobile(customer.phone)) {
      return res.status(400).json({ success: false, message: 'This customer has no valid mobile number on record.' });
    }

    const base = {
      direction    : 'outbound',
      agentType    : agent.type,
      agentUser    : agent.user,
      agentOwner   : agent.owner,
      agentName    : agent.name,
      agentPhone   : normalisePhone(agent.phone),
      customerPhone: normalisePhone(customer.phone),
      context      : customer.context,
      ...customer.refs,
    };

    // ── Plivo ──
    if (plivo.isConfigured()) {
      const log = await CallLog.create({ ...base, provider: 'plivo', status: 'initiated' });
      try {
        const { requestId } = await plivo.callAgent({ agentPhone: agent.phone, logId: log._id });
        log.providerRequestId = requestId;
        await log.save();
      } catch (plivoErr) {
        const message = plivo.friendlyError(plivoErr);
        console.error('[calls] Plivo call failed:', plivoErr?.message || plivoErr);
        log.status = 'failed';
        log.error = String(plivoErr?.message || plivoErr).slice(0, 500);
        log.endedAt = new Date();
        await log.save();
        return res.status(502).json({ success: false, message, callLogId: log._id });
      }
      return res.json({
        success  : true,
        provider : 'plivo',
        callLogId: log._id,
        message  : 'Your phone will ring now. Answer it and we will connect you to the customer.',
      });
    }

    // ── Exotel fallback (no Plivo configuration) ──
    if (process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY) {
      const log = await CallLog.create({ ...base, provider: 'exotel', status: 'initiated' });
      try {
        const call = await exotel.connectCall({
          from: agent.phone,
          to  : customer.phone,
          statusCallbackUrl: plivo.apiUrl('/api/call/status'),
        });
        log.providerRequestId = call?.Sid || null;
        await log.save();
      } catch (exoErr) {
        log.status = 'failed';
        log.error = String(exoErr?.response?.data?.RestException?.Message || exoErr.message).slice(0, 500);
        log.endedAt = new Date();
        await log.save();
        return res.status(502).json({ success: false, message: 'Could not connect the call right now. Please try again.' });
      }
      return res.json({ success: true, provider: 'exotel', callLogId: log._id, message: 'Your phone will ring now. Answer it to connect.' });
    }

    return res.status(503).json({ success: false, message: 'Calling is not set up yet: PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_NUMBER are needed on the server.' });
  } catch (err) {
    next(err);
  }
};


// ── Plivo webhooks ─────────────────────────────────────────────────────────
// Signed by Plivo; anything else gets a 403 and no XML.
exports.requirePlivoSignature = (req, res, next) => {
  if (plivo.isValidSignature(req)) return next();
  console.warn('[calls] Rejected unsigned Plivo webhook:', req.method, req.originalUrl);
  return res.status(403).type('text/plain').send('Forbidden');
};

const logIdOf = (req) => (isObjectId(String(req.query.log || '')) ? String(req.query.log) : null);


// ============================================================
// @route   POST /api/calls/answer?log=<id>
// @desc    The agent answered Plivo's call. Dial the customer, record it.
// @access  Plivo (signature)
// ============================================================
exports.answer = async (req, res, next) => {
  try {
    const logId = logIdOf(req);
    const log = logId ? await CallLog.findById(logId).select('+customerPhone') : null;
    if (!log?.customerPhone || log.direction !== 'outbound') {
      return sendXml(res, plivo.speakXml('Sorry, this call could not be connected.'));
    }

    log.status = 'agent_answered';
    log.answeredAt = new Date();
    if (req.body?.CallUUID) log.providerCallId = req.body.CallUUID;
    await log.save();

    return sendXml(res, plivo.bridgeXml({ numbers: [log.customerPhone], logId: log._id }));
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
    const from = normalisePhone(req.body?.From);

    // Link it to what we know about this caller, so the CRM's call history
    // shows "Trip TRP-…" rather than a bare masked number.
    const [trip, lead] = from.length === 10 ? await Promise.all([
      Trip.findOne({ patientPhone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
      Lead.findOne({ phone: phoneSuffixQuery(from) }).sort({ createdAt: -1 }).select('_id'),
    ]) : [null, null];

    const onDuty = await User.find({ role: 'owner', isActive: true, callDuty: true })
      .select('name phone').limit(MAX_INCOMING_AGENTS).lean();
    let agentPhones = onDuty.map((u) => u.phone).filter(isMobile);
    if (!agentPhones.length) {
      agentPhones = String(process.env.PLIVO_FALLBACK_AGENTS || '')
        .split(',').map((s) => s.trim()).filter(isMobile).slice(0, MAX_INCOMING_AGENTS);
    }

    const log = await CallLog.create({
      provider     : 'plivo',
      direction    : 'inbound',
      context      : 'incoming',
      customerPhone: from || undefined,
      providerCallId: req.body?.CallUUID,
      trip         : trip?._id,
      lead         : lead?._id,
      status       : agentPhones.length ? 'ringing' : 'no_agents',
      endedAt      : agentPhones.length ? undefined : new Date(),
    });

    if (!agentPhones.length) {
      return sendXml(res, plivo.speakXml('Thank you for calling SaveLife. All our team members are busy right now. Please call again in a few minutes, or message us on WhatsApp.'));
    }
    return sendXml(res, plivo.bridgeXml({ numbers: agentPhones, logId: log._id }));
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
    const b = req.body || {};
    const logId = logIdOf(req);
    const log = logId
      ? await CallLog.findById(logId)
      : (b.CallUUID ? await CallLog.findOne({ providerCallId: b.CallUUID }) : null);

    if (req.query.leg === 'dial') {
      const dialStatus = String(b.DialStatus || '').toLowerCase();
      if (log) {
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
    const b = req.body || {};
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


// ============================================================
// @route   GET /api/calls/duty   PUT /api/calls/duty { onDuty }
// @desc    The signed-in CRM user's own "On call duty" switch.
// @access  Private [owner]
// ============================================================
exports.getDuty = async (req, res) => res.json({ success: true, onDuty: !!req.user.callDuty });

exports.setDuty = async (req, res, next) => {
  try {
    const onDuty = !!req.body?.onDuty;
    if (onDuty && !isMobile(req.user.phone)) {
      return res.status(400).json({ success: false, message: 'Your account has no valid mobile number to ring.' });
    }
    await User.updateOne({ _id: req.user._id }, { $set: { callDuty: onDuty } });
    return res.json({ success: true, onDuty });
  } catch (err) {
    next(err);
  }
};
