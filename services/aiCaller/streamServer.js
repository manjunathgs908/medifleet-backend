'use strict';
/**
 * services/aiCaller/streamServer.js
 * ============================================================
 * AI TELECALLER — PILOT. The websocket Plivo's <Stream> connects to
 * (wss://<api>/api/ai-caller/stream?call=&exp=&sig=). Plivo cannot send
 * headers on a stream, so the URL carries its own proof: an HMAC of the
 * AiCall id + expiry with AI_STREAM_SECRET (falling back to JWT_SECRET),
 * valid STREAM_TTL_MS. Anything else on this path is refused before the
 * upgrade; other paths are left alone exactly as before.
 * ============================================================
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const plivo = require('../plivoService');

const PATH = '/api/ai-caller/stream';
const STREAM_TTL_MS = 10 * 60 * 1000;

const secret = () => process.env.AI_STREAM_SECRET || process.env.JWT_SECRET || '';
const sign = (callId, exp) => crypto.createHmac('sha256', secret()).update(`ai-stream.${callId}.${exp}`).digest('hex');

function streamUrl(callId, { now = Date.now() } = {}) {
  const exp = now + STREAM_TTL_MS;
  const base = plivo.PUBLIC_API_BASE.replace(/^http/, 'ws');
  return `${base}${PATH}?call=${encodeURIComponent(callId)}&exp=${exp}&sig=${sign(callId, exp)}`;
}

// The AiCall id this request may stream for, or null.
function verify(rawUrl, { now = Date.now() } = {}) {
  let u;
  try { u = new URL(rawUrl, 'http://localhost'); } catch { return null; }
  if (u.pathname !== PATH || !secret()) return null;
  const callId = u.searchParams.get('call');
  const exp = Number(u.searchParams.get('exp'));
  const sig = u.searchParams.get('sig') || '';
  if (!callId || !/^[a-f0-9]{24}$/i.test(callId) || !Number.isFinite(exp) || exp < now) return null;
  const want = Buffer.from(sign(callId, exp), 'hex');
  const got = Buffer.from(sig, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? callId : null;
}

function attach(server, { createSession } = {}) {
  const start = createSession || require('./session').createSession;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!String(req.url || '').startsWith(PATH)) return; // not ours
    const callId = verify(req.url);
    if (!callId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      Promise.resolve(start({ callId, plivoWs: ws })).catch((err) => {
        console.error('[aiCaller] session start failed:', err.message);
        try { ws.close(); } catch { /* already closed */ }
      });
    });
  });
  return wss;
}

module.exports = { PATH, streamUrl, verify, attach, STREAM_TTL_MS };
