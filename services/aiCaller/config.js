'use strict';
/**
 * services/aiCaller/config.js
 * ============================================================
 * AI TELECALLER — PILOT. Every guard that decides whether an outbound AI
 * call may start, in one place. A call starts only if ALL hold:
 *
 *   1. AI_CALLER_ENABLED=true in the server env (the master kill-switch,
 *      off unless set), AND
 *   2. the CRM toggle is on (AiCallerSetting — can only switch it off
 *      further, never on past the env), AND
 *   3. OpenAI + Plivo + a public https base URL are configured, AND
 *   4. the number is on AI_CALL_TEST_NUMBERS (the pilot allowlist — no
 *      other number is ever dialled, whatever the request says), AND
 *   5. the number contacted SaveLife first (an inbound call, a WhatsApp
 *      conversation or lead, or a booking) — service calls in reply to the
 *      customer's own enquiry only, AND
 *   6. no other AI call is in progress (one at a time in the pilot).
 *
 * Re-checked when Plivo answers the call (aiCallerController.answer), so a
 * switch turned off while the phone rings still stops it.
 * ============================================================
 */
const AiCall = require('../../models/AiCall');
const AiCallerSetting = require('../../models/AiCallerSetting');
const CallLog = require('../../models/CallLog');
const WhatsAppLead = require('../../models/WhatsAppLead');
const WhatsAppFunnelEvent = require('../../models/WhatsAppFunnelEvent');
const { Trip } = require('../../models');
const plivo = require('../plivoService');
const { normalisePhone, phoneSuffixQuery } = require('../../utils/phone');

const isMobile = (ten) => /^[6-9]\d{9}$/.test(ten);

const envEnabled = () => process.env.AI_CALLER_ENABLED === 'true';

// AI_CALL_TEST_NUMBERS: comma/space separated Indian mobiles, any format.
function allowlist() {
  return [...new Set(String(process.env.AI_CALL_TEST_NUMBERS || '')
    .split(/[\s,;]+/).map(normalisePhone).filter(isMobile))];
}
const isAllowlisted = (raw) => {
  const ten = normalisePhone(raw);
  return isMobile(ten) && allowlist().includes(ten);
};

async function toggleEnabled() {
  const s = await AiCallerSetting.findOne({ key: 'global' }).lean();
  return !!s?.enabled;
}

// What isn't set up, as env var names — empty when ready.
function missingConfig() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!plivo.isConfigured()) missing.push('PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_NUMBER');
  if (!/^https:\/\//.test(plivo.PUBLIC_API_BASE)) missing.push('PUBLIC_API_BASE_URL (https)');
  if (!allowlist().length) missing.push('AI_CALL_TEST_NUMBERS');
  return missing;
}

// Has this number reached out to SaveLife before? Returns where, or null.
async function contactedUsVia(raw) {
  const suffix = phoneSuffixQuery(raw);
  const checks = [
    ['an incoming call', () => CallLog.exists({ direction: 'inbound', customerPhone: suffix })],
    ['WhatsApp', () => WhatsAppFunnelEvent.exists({ phone: suffix })],
    ['a WhatsApp lead', () => WhatsAppLead.exists({ phone: suffix })],
    ['a booking', () => Trip.exists({ patientPhone: suffix })],
  ];
  for (const [label, check] of checks) {
    if (await check()) return label;
  }
  return null;
}

const ACTIVE_STATES = ['dialing', 'in_progress', 'handing_off'];
const STALE_ACTIVE_MS = 15 * 60 * 1000; // a call "active" longer than this died without a report
const activeCall = () => AiCall.findOne({
  status: { $in: ACTIVE_STATES },
  createdAt: { $gte: new Date(Date.now() - STALE_ACTIVE_MS) },
}).select('_id status createdAt').lean();

const refuse = (code, message) => ({ ok: false, code, message });

// The whole gate. { ok: true, phone } or { ok: false, code, message }.
async function checkCanCall(raw, { atAnswer = false } = {}) {
  if (!envEnabled()) return refuse('env_disabled', 'AI calling is switched off on the server (AI_CALLER_ENABLED is not true).');
  if (!(await toggleEnabled())) return refuse('toggle_off', 'AI calling is switched off in the CRM.');
  const missing = missingConfig();
  if (missing.length) return refuse('not_configured', `Not set up: ${missing.join(', ')}.`);
  const phone = normalisePhone(raw);
  if (!isAllowlisted(phone)) return refuse('not_allowlisted', 'Pilot: this number is not on the AI test-number allowlist. No other number can be called.');
  if (!(await contactedUsVia(phone))) return refuse('no_prior_contact', 'This number has never contacted SaveLife (call, WhatsApp or booking). The pilot only calls people who reached out first.');
  if (!atAnswer && await activeCall()) return refuse('busy', 'Another AI call is in progress. The pilot makes one call at a time.');
  return { ok: true, phone };
}

// ── Call limits and models (env, with pilot defaults) ───────
const maxCallSeconds = () => Math.min(Math.max(Number(process.env.AI_CALL_MAX_SECONDS) || 300, 60), 600);
// GPT-Live: a voice model (session.model) plus a Responses model it
// delegates tool work to (session.delegation.responses.model).
const realtimeModel = () => process.env.AI_REALTIME_MODEL || 'gpt-live-1';
const delegateModel = () => process.env.AI_DELEGATE_MODEL || 'gpt-6-luna';
const realtimeVoice = () => process.env.AI_REALTIME_VOICE || 'marin';
const liveUrl = () => process.env.AI_LIVE_WS_URL || 'wss://api.openai.com/v1/live/sessions';

// Barge-in (session.js): the caller talking over Sahana stops her audio.
// Caller speech = inbound frames louder than AI_BARGE_IN_RMS (16-bit RMS of
// the decoded mu-law) for AI_BARGE_IN_MS — long enough that a backchannel
// ("ಹೂಂ", "ಆ", "ಮೇಡಮ್") does not cut her off. The caller has finished after
// AI_CALLER_DONE_MS of quiet. Tunable on Render without a deploy.
const bounded = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : def; };
const bargeInRms = () => bounded(process.env.AI_BARGE_IN_RMS, 900, 100, 8000);
const bargeInMs = () => bounded(process.env.AI_BARGE_IN_MS, 600, 200, 2000);
const callerDoneMs = () => bounded(process.env.AI_CALLER_DONE_MS, 700, 300, 3000);
// A pending barge-in becomes real after this much caller speech (unless
// their words already show it is more than an acknowledgement).
const bargeInConfirmMs = () => Math.max(bounded(process.env.AI_BARGE_IN_CONFIRM_MS, 1200, 400, 4000), bargeInMs() + 100);

// ── Rough cost — rates from env only, never hardcoded ───────
// AI_COST_*_USD_PER_1M: OpenAI Realtime price per 1M tokens of each kind.
// AI_COST_USD_TO_INR: exchange rate. AI_COST_PLIVO_PAISE_PER_MIN: Plivo's
// all-in per-minute price for the call leg + audio stream, in paise.
// Any missing -> null (shown as "not estimated").
function costRates() {
  const n = (k) => (process.env[k] === undefined || process.env[k] === '' ? NaN : Number(process.env[k]));
  const r = {
    audioIn : n('AI_COST_AUDIO_IN_USD_PER_1M'),
    audioOut: n('AI_COST_AUDIO_OUT_USD_PER_1M'),
    textIn  : n('AI_COST_TEXT_IN_USD_PER_1M'),
    textOut : n('AI_COST_TEXT_OUT_USD_PER_1M'),
    cachedIn: n('AI_COST_CACHED_IN_USD_PER_1M'),
    usdToInr: n('AI_COST_USD_TO_INR'),
    plivoPaisePerMin: n('AI_COST_PLIVO_PAISE_PER_MIN'),
  };
  return Object.values(r).every(Number.isFinite) ? r : null;
}

// Integer paise, or null without rates. Cached input tokens are billed at
// the cached rate instead of the audio/text input rate.
function estimateCostPaise(usage = {}, durationSec = 0) {
  const r = costRates();
  if (!r) return null;
  const u = { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cachedIn: 0, ...usage };
  const uncachedAudioIn = Math.max(0, u.audioIn - u.cachedIn);
  const usd = (uncachedAudioIn * r.audioIn + u.audioOut * r.audioOut + u.textIn * r.textIn
    + u.textOut * r.textOut + u.cachedIn * r.cachedIn) / 1e6;
  const openaiPaise = usd * r.usdToInr * 100;
  const plivoPaise = Math.ceil((durationSec || 0) / 60) * r.plivoPaisePerMin;
  return Math.round(openaiPaise + plivoPaise);
}

module.exports = {
  envEnabled, allowlist, isAllowlisted, toggleEnabled, missingConfig, contactedUsVia,
  activeCall, checkCanCall, maxCallSeconds, realtimeModel, delegateModel, realtimeVoice, liveUrl,
  bargeInRms, bargeInMs, callerDoneMs, bargeInConfirmMs,
  costRates, estimateCostPaise, ACTIVE_STATES,
};
