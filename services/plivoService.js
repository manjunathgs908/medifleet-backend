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
 *   PLIVO_APP_ID                     optional; otherwise found from the
 *                                    application linked to PLIVO_NUMBER
 *
 * Every masked call goes through here when Plivo is configured, including
 * the legacy /api/call/connect, so customers always see PLIVO_NUMBER.
 * Exotel (services/exotelService.js) is only used by that legacy route,
 * and only while the PLIVO_* variables are missing.
 * ============================================================
 */
'use strict';

const plivo = require('plivo');
const axios = require('axios');
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
// unsigned request must get nothing. Plivo signs the exact URL it called --
// which is whatever was typed into the Plivo console, so http vs https, a
// trailing slash, or the Render hostname all change it. Each of those
// spellings of OUR endpoint is tried; the HMAC with our auth token is still
// what decides. Returns { ok, reason } so a rejection can say why: a
// silent 403 here is exactly how an incoming call goes unlogged.
function signatureCandidates(req) {
  const [path, query] = req.originalUrl.split('?');
  const q = query ? `?${query}` : '';
  const paths = new Set([path, path.endsWith('/') ? path.slice(0, -1) : `${path}/`]);
  const bases = new Set([PUBLIC_API_BASE, PUBLIC_API_BASE.replace(/^https:/, 'http:')]);
  const host = req.get?.('x-forwarded-host') || req.get?.('host');
  if (host) {
    bases.add(`https://${host}`);
    bases.add(`http://${host}`);
  }
  const urls = [];
  for (const b of bases) for (const p of paths) urls.push(`${b}${p}${q}`);
  return urls;
}

function checkSignature(req) {
  const token = process.env.PLIVO_AUTH_TOKEN;
  const signature = req.get('X-Plivo-Signature-V3');
  const nonce = req.get('X-Plivo-Signature-V3-Nonce');
  if (!token) return { ok: false, reason: 'PLIVO_AUTH_TOKEN is not set on the server' };
  if (!signature || !nonce) return { ok: false, reason: 'request carried no X-Plivo-Signature-V3 headers (not from Plivo)' };
  const params = req.method === 'POST' ? (req.body || {}) : {};
  for (const url of signatureCandidates(req)) {
    try {
      if (plivo.validateV3Signature(req.method, url, nonce, token, signature, params)) return { ok: true, url };
    } catch { /* try the next spelling */ }
  }
  return {
    ok    : false,
    reason: `signature did not match ${apiUrl(req.originalUrl)} (or its http/trailing-slash/host variants) — check the URL in the Plivo console and PLIVO_AUTH_TOKEN`,
  };
}

const isValidSignature = (req) => checkSignature(req).ok;

// ── XML ────────────────────────────────────────────────────────────────────
const esc = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;

// ── In-app (WebRTC) calling ────────────────────────────────────────────────
// Each CRM user who rings in the app gets their own Plivo endpoint. Plivo
// rings it with <User>sip:<username>@phone.plivo.com</User>, and the
// browser registers as that username with an access token issued BY PLIVO
// (POST /JWT/Token/) — never signed locally. These three calls go straight
// to Plivo's REST API so the JSON field names are exactly Plivo's own.
const SIP_DOMAIN = 'phone.plivo.com';
const sipUri = (username) => `sip:${username}@${SIP_DOMAIN}`;

const TOKEN_LIFETIME_SEC = 60 * 60; // the CRM renews 10 minutes before it lapses

const plivoRest = (method, path, data) => axios.request({
  method,
  url    : `https://api.plivo.com/v1/Account/${process.env.PLIVO_AUTH_ID}${path}`,
  auth   : { username: process.env.PLIVO_AUTH_ID, password: process.env.PLIVO_AUTH_TOKEN },
  data,
  timeout: 15000,
});

// Plivo allows letters, numbers and . + @ - _ in an alias, and letters and
// numbers in a username. Both are built from the user's id (a 24-character
// hex ObjectId), never their name: a name with a space is exactly what
// Plivo rejected. The alias also identifies the endpoint for lookup, which
// keeps provisioning idempotent.
const safeId = (userId) => String(userId).toLowerCase().replace(/[^a-z0-9]/g, '');
const endpointAlias = (userId) => `savelife-${safeId(userId)}`;
const endpointBaseUsername = (userId) => `sl${safeId(userId).slice(-12)}`;

// The Plivo Application linked to PLIVO_NUMBER — the one holding our
// /incoming and /events URLs. PLIVO_APP_ID wins if set; otherwise looked up
// from the number and cached. null (not linked) means "app" is left out of
// the token, which Plivo treats as optional.
let cachedAppId;          // undefined = not looked up yet
let appIdLookedUpAt = 0;
const APP_ID_RETRY_MS = 10 * 60 * 1000;

async function applicationId() {
  if (process.env.PLIVO_APP_ID) return process.env.PLIVO_APP_ID;
  if (cachedAppId || (cachedAppId === null && Date.now() - appIdLookedUpAt < APP_ID_RETRY_MS)) return cachedAppId;
  appIdLookedUpAt = Date.now();
  try {
    const { data } = await plivoRest('get', `/Number/${companyNumber()}/`);
    // "application" is a resource URI: /v1/Account/<id>/Application/<appId>/
    const m = String(data?.application || '').match(/Application\/([^/]+)\/?$/);
    cachedAppId = m ? m[1] : null;
    if (!cachedAppId) console.warn(`[calls] Plivo number ${companyNumber()} has no linked application — tokens will omit "app".`);
    else console.info(`[calls] Plivo application for ${companyNumber()}: ${cachedAppId}`);
  } catch (err) {
    cachedAppId = null;
    console.warn(`[calls] could not read Plivo number ${companyNumber()} to find its application:`, err?.response?.status, JSON.stringify(err?.response?.data ?? err?.message));
  }
  return cachedAppId;
}

// Finds this user's endpoint by alias, or creates it. Plivo appends digits
// to the requested username; the real one comes back and is what we keep.
// Returns { id, username, password } — password only when newly created
// (Plivo never returns it later).
async function ensureEndpoint({ userId }) {
  const alias = endpointAlias(userId);

  for (let offset = 0; offset < 1000; offset += 20) {
    const { data } = await plivoRest('get', `/Endpoint/?limit=20&offset=${offset}`);
    const found = (data?.objects || []).find((e) => e.alias === alias);
    if (found) return { id: found.endpoint_id, username: found.username, password: null, existing: true };
    if (!data?.meta?.next) break;
  }

  const crypto = require('crypto');
  const password = crypto.randomBytes(18).toString('base64url');
  const appId = await applicationId();
  const { data } = await plivoRest('post', '/Endpoint/', {
    username: endpointBaseUsername(userId),
    password,
    alias,
    ...(appId ? { app_id: appId } : {}),
  });
  return { id: data?.endpoint_id, username: data?.username, password, existing: false };
}

// Plivo's own record of an endpoint: its exact username, the application
// it is linked to, and whether Plivo sees it registered right now.
async function getEndpoint(endpointId) {
  const { data } = await plivoRest('get', `/Endpoint/${endpointId}/`);
  const appMatch = String(data?.application || '').match(/Application\/([^/]+)\/?$/);
  return {
    username      : data?.username || null,
    alias         : data?.alias || null,
    appId         : appMatch ? appMatch[1] : null,
    sipRegistered : String(data?.sip_registered) === 'true',
    sipUserAgent  : data?.sip_user_agent || null,
    sipExpires    : data?.sip_expires || null,
  };
}

const linkEndpointToApp = (endpointId, appId) => plivoRest('post', `/Endpoint/${endpointId}/`, { app_id: appId });

// Sets a new password on an endpoint (Plivo never returns the old one), for
// classic username/password SIP login when we do not have it stored.
async function resetEndpointPassword(endpointId) {
  const crypto = require('crypto');
  const password = crypto.randomBytes(18).toString('base64url');
  await plivoRest('post', `/Endpoint/${endpointId}/`, { password });
  return password;
}

// Plivo issues the token: POST /JWT/Token/. Both grants are on: with
// receive-only, Plivo held no routable registration for the endpoint
// (sip_registered stayed false), and Plivo's own example grants both. The
// CRM still never places calls from the browser; an outgoing call from an
// endpoint would reach our application's answer URL like any other.
async function issueToken(username) {
  const now = Math.floor(Date.now() / 1000);
  const appId = await applicationId();
  const { data } = await plivoRest('post', '/JWT/Token/', {
    iss: process.env.PLIVO_AUTH_ID,
    sub: username,
    nbf: now,
    exp: now + TOKEN_LIFETIME_SEC,
    per: { voice: { incoming_allow: true, outgoing_allow: true } },
    ...(appId ? { app: appId } : {}),
  });
  const token = data?.token || data?.jwt_token;
  if (!token) throw Object.assign(new Error('Plivo returned no token'), { response: { data } });
  return { token, expiresAt: new Date((now + TOKEN_LIFETIME_SEC) * 1000) };
}

// Record + Dial is Plivo's way to record a bridged call: <Record> placed
// before <Dial> with startOnDialAnswer records the whole conversation from
// the moment the other side picks up, and redirect="false" keeps it from
// taking over the call flow. Both sides see only the company number.
// Dial's action is told the outcome; with redirect it also decides what the
// caller hears after (see dialFinished).
// numbers: phones to ring; sipUsers: in-app endpoints to ring at the same
// time (first to answer takes the call). The call-log id rides along to
// the in-app legs as a SIP header (X-PH-logId), which is how the CRM's
// ringing screen knows which call it is -- never the customer's number.
// stage tags the Dial's action URL so /events knows what just finished:
// 'app' (the in-app try, short timeout, phones follow if nobody answers)
// or 'phone' (the last try). Every stage records whichever leg answers.
const APP_RING_SECONDS = 15;
const PHONE_RING_SECONDS = 40;

function bridgeXml({ numbers = [], sipUsers = [], logId, stage, timeout = PHONE_RING_SECONDS }) {
  const recordUrl = esc(apiUrl(`/api/calls/recording?log=${logId}`));
  const dialUrl = esc(apiUrl(`/api/calls/events?log=${logId}&leg=dial${stage ? `&stage=${stage}` : ''}`));
  const legs = numbers.map((n) => `<Number>${esc(toE164(n))}</Number>`).join('')
    + sipUsers.map((u) => `<User>${esc(sipUri(u))}</User>`).join('');
  const sipHeaders = sipUsers.length ? ` sipHeaders="logId=${esc(logId)}"` : '';
  return xml(
    `<Record action="${recordUrl}" method="POST" callbackUrl="${recordUrl}" callbackMethod="POST" redirect="false" startOnDialAnswer="true" maxLength="3600" fileFormat="mp3" playBeep="false"/>`
    + `<Dial callerId="${esc(companyNumber())}" action="${dialUrl}" method="POST" redirect="true" timeout="${timeout}" timeLimit="3600"${sipHeaders}>${legs}</Dial>`,
  );
}

const speakXml = (text) => xml(`<Speak language="en-IN">${esc(text)}</Speak><Hangup/>`);
const hangupXml = () => xml('<Hangup/>');
const emptyXml = () => xml('');

module.exports = {
  isConfigured, companyNumber, toE164, apiUrl,
  callFirstLeg, logCall, friendlyError, isValidSignature, checkSignature,
  ensureEndpoint, issueToken, applicationId, endpointAlias, sipUri,
  getEndpoint, linkEndpointToApp, resetEndpointPassword,
  APP_RING_SECONDS, PHONE_RING_SECONDS,
  bridgeXml, speakXml, hangupXml, emptyXml,
  PUBLIC_API_BASE,
};
