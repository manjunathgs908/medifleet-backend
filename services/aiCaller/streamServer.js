'use strict';
/**
 * services/aiCaller/streamServer.js
 * ============================================================
 * The websockets Plivo's audio streams connect to:
 *
 *   /api/ai-caller/stream?call=&exp=&sig=     AI TELECALLER pilot
 *                                             (<Stream>, two-way)
 *   /api/call-capture/stream?cap=&exp=&sig=   LIVE CALL CAPTURE
 *                                             (REST stream, listen-only)
 *
 * Plivo cannot send headers on a stream, so the URL carries its own proof:
 * an HMAC of the record id + expiry (per path) with AI_STREAM_SECRET
 * (falling back to JWT_SECRET), valid STREAM_TTL_MS. Anything else on
 * these paths is refused before the upgrade; other paths are left alone
 * exactly as before.
 * ============================================================
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const plivo = require('../plivoService');

const PATH = '/api/ai-caller/stream';
const CAPTURE_PATH = '/api/call-capture/stream';
const STREAM_TTL_MS = 10 * 60 * 1000;

const secret = () => process.env.AI_STREAM_SECRET || process.env.JWT_SECRET || '';
const sign = (purpose, id, exp) => crypto.createHmac('sha256', secret()).update(`${purpose}.${id}.${exp}`).digest('hex');

// Each path: its query parameter and what its signature is for.
const ROUTES = {
  [PATH]        : { param: 'call', purpose: 'ai-stream' },
  [CAPTURE_PATH]: { param: 'cap', purpose: 'call-capture' },
};

function signedUrl(path, id, now) {
  const { param, purpose } = ROUTES[path];
  const exp = now + STREAM_TTL_MS;
  const base = plivo.PUBLIC_API_BASE.replace(/^http/, 'ws');
  return `${base}${path}?${param}=${encodeURIComponent(id)}&exp=${exp}&sig=${sign(purpose, id, exp)}`;
}

function verifyAt(path, rawUrl, now) {
  let u;
  try { u = new URL(rawUrl, 'http://localhost'); } catch { return null; }
  if (u.pathname !== path || !secret()) return null;
  const { param, purpose } = ROUTES[path];
  const id = u.searchParams.get(param);
  const exp = Number(u.searchParams.get('exp'));
  const sig = u.searchParams.get('sig') || '';
  if (!id || !/^[a-f0-9]{24}$/i.test(id) || !Number.isFinite(exp) || exp < now) return null;
  const want = Buffer.from(sign(purpose, id, exp), 'hex');
  const got = Buffer.from(sig, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? id : null;
}

const streamUrl = (callId, { now = Date.now() } = {}) => signedUrl(PATH, String(callId), now);
const captureStreamUrl = (captureId, { now = Date.now() } = {}) => signedUrl(CAPTURE_PATH, String(captureId), now);
// The AiCall / CallCapture id this request may stream for, or null.
const verify = (rawUrl, { now = Date.now() } = {}) => verifyAt(PATH, rawUrl, now);
const verifyCapture = (rawUrl, { now = Date.now() } = {}) => verifyAt(CAPTURE_PATH, rawUrl, now);

function attach(server, { createSession, createCaptureSession } = {}) {
  const startAi = createSession || ((args) => require('./session').createSession(args));
  const startCapture = createCaptureSession || ((args) => require('../callCapture/session').createSession(args));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = String(req.url || '');
    const path = url.startsWith(PATH) ? PATH : url.startsWith(CAPTURE_PATH) ? CAPTURE_PATH : null;
    if (!path) return; // not ours
    const id = path === PATH ? verify(url) : verifyCapture(url);
    if (!id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const start = path === PATH ? () => startAi({ callId: id, plivoWs: ws }) : () => startCapture({ captureId: id, plivoWs: ws });
      Promise.resolve().then(start).catch((err) => {
        console.error(`[${path === PATH ? 'aiCaller' : 'callCapture'}] session start failed:`, err.message);
        try { ws.close(); } catch { /* already closed */ }
      });
    });
  });
  return wss;
}

module.exports = { PATH, CAPTURE_PATH, streamUrl, captureStreamUrl, verify, verifyCapture, attach, STREAM_TTL_MS };
