'use strict';
/**
 * controllers/aiCallerController.js
 * ============================================================
 * AI TELECALLER — PILOT. Mounted at /api/ai-caller (routes/aiCaller.js).
 *
 *   GET  /status            switches, setup gaps, the test allowlist
 *   PUT  /toggle            the CRM kill-switch { enabled }
 *   POST /calls             call one allowlisted test number { phone }
 *   GET  /calls, /calls/:id sessions; one with its transcript
 *     — CRM owner only.
 *
 *   POST /plivo/answer, /next, /hangup, /handoff-done, /recording
 *                           Plivo webhooks, Plivo signature checked.
 * ============================================================
 */
const mongoose = require('mongoose');
const AiCall = require('../models/AiCall');
const AiCallerSetting = require('../models/AiCallerSetting');
const plivo = require('../services/plivoService');
const config = require('../services/aiCaller/config');
const calls = require('../services/aiCaller/calls');
const streamServer = require('../services/aiCaller/streamServer');
const locationRequests = require('../services/locationRequests');

const STREAM_GRACE_SECONDS = 90;
const { maskPhone } = require('../utils/customerPhone');
const { normalisePhone } = require('../utils/phone');

const sendXml = (res, body) => res.type('text/xml').send(body);
const GUARD_STATUS = { env_disabled: 423, toggle_off: 423, not_configured: 503, not_allowlisted: 403, no_prior_contact: 403, busy: 409, dial_failed: 502 };

// ── CRM (owner) ──────────────────────────────────────────────
exports.status = async (req, res, next) => {
  try {
    const [toggle, activeCall] = await Promise.all([config.toggleEnabled(), config.activeCall()]);
    const numbers = await Promise.all(config.allowlist().map(async (n) => ({
      phone: n, phoneMasked: maskPhone(n), contactedVia: await config.contactedUsVia(n),
    })));
    return res.json({
      success     : true,
      envEnabled  : config.envEnabled(),
      toggle,
      enabled     : config.envEnabled() && toggle,
      missing     : config.missingConfig(),
      allowlist   : numbers,
      activeCallId: activeCall ? String(activeCall._id) : null,
      limits      : { maxCallSeconds: config.maxCallSeconds() },
      models      : { realtime: config.realtimeModel(), delegate: config.delegateModel(), voice: config.realtimeVoice() },
      costRatesSet: !!config.costRates(),
      // WhatsApp "share your pickup location" (services/locationRequests).
      whatsappLocation: {
        enabled : locationRequests.enabled(),
        template: process.env.WA_LOCATION_TEMPLATE || null,
      },
    });
  } catch (err) { next(err); }
};

exports.setToggle = async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, message: 'enabled must be true or false.' });
    await AiCallerSetting.findOneAndUpdate(
      { key: 'global' },
      { $set: { enabled: req.body.enabled, updatedBy: req.user._id, updatedByName: req.user.name } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true, toggle: req.body.enabled, enabled: config.envEnabled() && req.body.enabled, envEnabled: config.envEnabled() });
  } catch (err) { next(err); }
};

exports.startCall = async (req, res, next) => {
  try {
    const result = await calls.startCall({ phone: req.body?.phone, user: req.user });
    if (!result.ok) return res.status(GUARD_STATUS[result.code] || 400).json({ success: false, code: result.code, message: result.message });
    return res.status(201).json({ success: true, callId: result.callId });
  } catch (err) { next(err); }
};

exports.listCalls = async (req, res, next) => {
  try {
    const list = await AiCall.find({}).select('-transcript').sort({ createdAt: -1 }).limit(30);
    return res.json({ success: true, calls: list });
  } catch (err) { next(err); }
};

exports.getCall = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
    const call = await AiCall.findById(req.params.id).populate('trip', 'tripNumber status estimatedFare');
    if (!call) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, call });
  } catch (err) { next(err); }
};

// ── Plivo webhooks ───────────────────────────────────────────
function plivoGuard(req, res) {
  const check = plivo.checkSignature(req);
  if (!check.ok) {
    console.warn('[aiCaller] rejected Plivo webhook:', check.reason);
    res.status(403).end();
    return null;
  }
  const id = req.query.call;
  if (!mongoose.isValidObjectId(id)) { sendXml(res, plivo.hangupXml()); return null; }
  return id;
}

// The callee picked up. Every guard again (a switch turned off while it
// rang still stops it), then the recorded two-way stream.
exports.answer = async (req, res, next) => {
  try {
    const id = plivoGuard(req, res);
    if (!id) return undefined;
    const call = await AiCall.findById(id).select('+phone status');
    if (!call || call.status !== 'dialing') return sendXml(res, plivo.hangupXml());
    if (normalisePhone(req.body?.To) !== call.phone) {
      await AiCall.updateOne({ _id: id }, { $set: { status: 'failed', outcome: 'failed', error: 'answered number did not match' } });
      return sendXml(res, plivo.hangupXml());
    }
    const gate = await config.checkCanCall(call.phone, { atAnswer: true });
    if (!gate.ok) {
      await AiCall.updateOne({ _id: id }, { $set: { status: 'failed', outcome: 'failed', error: `stopped at answer: ${gate.code}` } });
      return sendXml(res, plivo.speakXml('Sorry, this call cannot continue. Goodbye.'));
    }
    await AiCall.updateOne({ _id: id }, { $set: { status: 'in_progress', answeredAt: new Date(), plivoCallUuid: req.body?.CallUUID } });
    return sendXml(res, plivo.aiStreamXml({
      streamUrl : streamServer.streamUrl(id),
      recordUrl : plivo.apiUrl(`/api/ai-caller/plivo/recording?call=${id}`),
      nextUrl   : plivo.apiUrl(`/api/ai-caller/plivo/next?call=${id}`),
      // Plivo's stream timeout is a backstop only: STREAM_GRACE_SECONDS
      // after the session's own time limit, so the session always ends the
      // call itself (goodbye after a booking, or a 'time_limit' handoff).
      // Equal to it, Plivo won the race and the call ended mid-sentence as
      // "stream ended unexpectedly".
      maxSeconds: config.maxCallSeconds() + STREAM_GRACE_SECONDS,
    }));
  } catch (err) {
    // Never leave a caller in silence: apologise and hang up.
    console.error('[aiCaller] answer failed:', err.message);
    return sendXml(res, plivo.speakXml('Sorry, this call cannot continue. A SaveLife team member will call you back.'));
  }
};

exports.hangup = async (req, res, next) => {
  try {
    const id = plivoGuard(req, res);
    if (!id) return undefined;
    const b = req.body || {};
    await calls.finish(id, {
      duration: b.BillDuration || b.Duration,
      cause   : b.HangupCause,
      answered: Number(b.Duration) > 0,
    });
    return res.status(200).end();
  } catch (err) { next(err); }
};

// The stream ended (Plivo runs the <Redirect> after <Stream>): hand off,
// hang up, or apologise — calls.nextXml decides from the AiCall.
exports.next = async (req, res) => {
  const id = plivoGuard(req, res);
  if (!id) return undefined;
  try {
    return sendXml(res, await calls.nextXml(id));
  } catch (err) {
    console.error('[aiCaller] next-step XML failed:', err.message);
    await calls.failSafe(id, `next step failed: ${err.message}`).catch(() => {});
    return sendXml(res, plivo.speakXml(calls.GOODBYE_SAY));
  }
};

exports.handoffDone = async (req, res) => {
  const id = plivoGuard(req, res);
  if (!id) return undefined;
  try {
    return sendXml(res, await calls.handoffDone(id, req.body?.DialStatus));
  } catch (err) {
    console.error('[aiCaller] handoff-done failed:', err.message);
    return sendXml(res, plivo.hangupXml());
  }
};

exports.recording = async (req, res) => {
  const id = plivoGuard(req, res);
  if (!id) return undefined;
  const url = req.body?.RecordUrl || req.body?.RecordingUrl;
  if (url) await AiCall.updateOne({ _id: id }, { $set: { recordingUrl: String(url).slice(0, 500) } }).catch(() => {});
  return res.status(200).end();
};
