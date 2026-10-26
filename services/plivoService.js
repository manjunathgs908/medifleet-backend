/**
 * services/plivoService.js
 * ============================================================
 * Plivo masked calling. Everything that talks to Plivo or answers it lives
 * here, so controllers/callController.js deals in calls, not in XML or
 * request signatures.
 *
 *   PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN  account credentials
 *   PLIVO_NUMBER                     the company number every customer and
 *                                    every agent sees (918065591088)
 *   PUBLIC_API_BASE_URL              optional; https://api.savelife.health
 *
 * Every masked call goes through here when Plivo is configured, including
 * the legacy /api/call/connect, so customers always see PLIVO_NUMBER.
 * Exotel (services/exotelService.js) is only used by that legacy route,
 * and only while the PLIVO_* variables are missing.
 * ============================================================
 */
'use strict';

const plivo = require('plivo');
const { normalisePhone } = require('../utils/phone');

const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE_URL || 'https://api.savelife.health').replace(/\/+$/, '');

const companyNumber = () => String(process.env.PLIVO_NUMBER || '').replace(/\D/g, '');

// PLIVO_NUMBER must be a full Indian number (91 + 10 digits): it is the
// caller ID on every leg of every call, so a malformed value refuses to
// call rather than showing customers something else.
const isConfigured = () =>
  !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN && /^91\d{10}$/.test(companyNumber()));

let client = null;
function getClient() {
  if (!client) client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);
  return client;
}

// Plivo wants E.164 without the '+'. Every number in this system is an
// Indian mobile, so the last 10 digits plus 91 is the whole rule.
const toE164 = (raw) => {
  const ten = normalisePhone(raw);
  return ten.length === 10 ? `91${ten}` : null;
};

const apiUrl = (path) => `${PUBLIC_API_BASE}${path}`;

// ── Outbound: ring the first party; /answer then dials the other ──────────
// The first party is the agent (click-to-call) or, for the legacy tracking-
// page call, the customer. Either way the call comes FROM the company
// number, and only the call-log id travels in the URLs: /answer looks the
// other number up again, so it is never in a URL, a query string or a
// client.
async function callFirstLeg({ phone, logId }) {
  const res = await getClient().calls.create(
    companyNumber(),
    toE164(phone),
    apiUrl(`/api/calls/answer?log=${logId}`),
    {
      answerMethod : 'POST',
      hangupUrl    : apiUrl(`/api/calls/events?log=${logId}`),
      hangupMethod : 'POST',
      ringTimeout  : 40,
      timeLimit    : 3600,
    },
  );
  return { requestId: res.requestUuid || res.request_uuid || null, callerId: companyNumber() };
}

// One line per call in the Render log, so which provider and caller ID
// handled a call can be read straight off production, never assumed.
const logCall = (what, log) =>
  console.info(`[calls] provider=${log.provider} ${what} log=${log._id} callerId=${log.callerId || '-'} agent=${log.agentType || '-'} context=${log.context}`);

// Plivo's own message on failure is the most useful thing to show, but a
// trial account's refusal deserves a plain explanation.
function friendlyError(err) {
  const raw = String(err?.message || err?.error || err || '').trim();
  if (/verif|trial|sandbox|not allowed to call/i.test(raw)) {
    return 'The Plivo account is on a free trial and can only call verified numbers. Verify this number in the Plivo console, or add credit to call anyone.';
  }
  if (/auth/i.test(raw)) return 'Plivo rejected the account credentials. Check PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN on Render.';
  return `Could not place the call right now${raw ? ` (Plivo: ${raw.slice(0, 160)})` : ''}. Please try again.`;
}

// ── Request signatures ─────────────────────────────────────────────────────
// Every webhook below hands Plivo a customer's number inside its XML, so an
// unsigned request must get nothing. Plivo signs the exact URL it called,
// which is our public URL -- rebuilt from PUBLIC_API_BASE rather than from
// the request's own host, which Render's proxy rewrites.
function isValidSignature(req) {
  const token = process.env.PLIVO_AUTH_TOKEN;
  const signature = req.get('X-Plivo-Signature-V3');
  const nonce = req.get('X-Plivo-Signature-V3-Nonce');
  if (!token || !signature || !nonce) return false;
  try {
    const params = req.method === 'POST' ? (req.body || {}) : {};
    return plivo.validateV3Signature(req.method, apiUrl(req.originalUrl), nonce, token, signature, params);
  } catch {
    return false;
  }
}

// ── XML ────────────────────────────────────────────────────────────────────
const esc = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;

// Record + Dial is Plivo's way to record a bridged call: <Record> placed
// before <Dial> with startOnDialAnswer records the whole conversation from
// the moment the other side picks up, and redirect="false" keeps it from
// taking over the call flow. Both sides see only the company number.
// Dial's action is told the outcome; with redirect it also decides what the
// caller hears after (see dialFinished).
function bridgeXml({ numbers, logId }) {
  const recordUrl = esc(apiUrl(`/api/calls/recording?log=${logId}`));
  const dialUrl = esc(apiUrl(`/api/calls/events?log=${logId}&leg=dial`));
  const nums = numbers.map((n) => `<Number>${esc(toE164(n))}</Number>`).join('');
  return xml(
    `<Record action="${recordUrl}" method="POST" callbackUrl="${recordUrl}" callbackMethod="POST" redirect="false" startOnDialAnswer="true" maxLength="3600" fileFormat="mp3" playBeep="false"/>`
    + `<Dial callerId="${esc(companyNumber())}" action="${dialUrl}" method="POST" redirect="true" timeout="40" timeLimit="3600">${nums}</Dial>`,
  );
}

const speakXml = (text) => xml(`<Speak language="en-IN">${esc(text)}</Speak><Hangup/>`);
const hangupXml = () => xml('<Hangup/>');
const emptyXml = () => xml('');

module.exports = {
  isConfigured, companyNumber, toE164, apiUrl,
  callFirstLeg, logCall, friendlyError, isValidSignature,
  bridgeXml, speakXml, hangupXml, emptyXml,
  PUBLIC_API_BASE,
};
