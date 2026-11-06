'use strict';
/**
 * services/callCapture/config.js
 * ============================================================
 * LIVE CALL CAPTURE — when a call may be captured, and the model settings.
 * A call is captured only if ALL hold:
 *
 *   1. CALL_CAPTURE_ENABLED=true in the server env (off unless set), AND
 *   2. OpenAI + Plivo + a public https base URL are configured, AND
 *   3. it is a CUSTOMER call: inbound, from a real mobile, not a staff
 *      member's own ring phone (CallLog.callbackEligible — set by
 *      /api/calls/incoming on exactly that rule), not a SIP endpoint, AND
 *   4. it has Plivo's call id and has not ended.
 *
 *   AI_TRANSCRIBE_MODEL      default gpt-live-transcribe
 *   AI_TRANSCRIBE_LANGUAGES  optional ISO codes, e.g. "kn,en,hi"
 *   AI_TRANSCRIBE_WS_URL     default wss://api.openai.com/v1/realtime?intent=transcription
 *   AI_EXTRACT_MODEL         default gpt-6-astra
 * ============================================================
 */
const plivo = require('../plivoService');

const enabled = () => process.env.CALL_CAPTURE_ENABLED === 'true';

function missingConfig() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!plivo.isConfigured()) missing.push('PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_NUMBER');
  if (!/^https:\/\//.test(plivo.PUBLIC_API_BASE)) missing.push('PUBLIC_API_BASE_URL (https)');
  return missing;
}

// Why this call is not captured, or null when it may be.
function refusal(log) {
  if (!enabled()) return 'disabled (CALL_CAPTURE_ENABLED is not true)';
  const missing = missingConfig();
  if (missing.length) return `not configured: ${missing.join(', ')}`;
  if (!log) return 'call not found';
  if (log.direction !== 'inbound') return 'not an inbound call';
  if (log.callbackEligible !== true) return 'not a customer call';
  if (!log.providerCallId) return 'no Plivo call id';
  if (log.endedAt) return 'call already ended';
  return null;
}

const transcribeModel = () => process.env.AI_TRANSCRIBE_MODEL || 'gpt-live-transcribe';
const transcribeUrl = () => process.env.AI_TRANSCRIBE_WS_URL || 'wss://api.openai.com/v1/realtime?intent=transcription';
const transcribeLanguages = () => String(process.env.AI_TRANSCRIBE_LANGUAGES || '')
  .split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const extractModel = () => process.env.AI_EXTRACT_MODEL || 'gpt-6-astra';

// Plivo streams the customer's leg: 'inbound' is the customer's voice,
// 'outbound' what the customer hears — the operator.
const AUDIO = { contentType: 'audio/x-l16;rate=24000', rate: 24000 };
const MAX_STREAM_SECONDS = 3600;

module.exports = {
  enabled, missingConfig, refusal,
  transcribeModel, transcribeUrl, transcribeLanguages, extractModel,
  AUDIO, MAX_STREAM_SECONDS,
};
