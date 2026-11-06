'use strict';
/**
 * services/callCapture/transcriber.js
 * ============================================================
 * LIVE CALL CAPTURE — one OpenAI realtime TRANSCRIPTION session for one
 * side of the call (customer or operator). Listen-only: nothing is ever
 * sent back into the call.
 *
 *   wss://api.openai.com/v1/realtime?intent=transcription (no model in the
 *   URL), then session.update { type:'transcription', model in the
 *   session }. Audio is PCM16 24 kHz — exactly what Plivo streams with
 *   content_type audio/x-l16;rate=24000, so it is passed on as-is.
 *
 * gpt-live-transcribe has no turn detection of its own (turn_detection
 * must be null), so turns are cut HERE: a simple energy check on the audio
 * commits the buffer after SILENCE_MS of quiet following speech, and at
 * MAX_TURN_MS at the latest. Each committed turn comes back as
 * ...input_audio_transcription.completed and is handed to onTurn with the
 * server time its commit was sent.
 *
 * Failures are reported through onProblem and never thrown: a socket that
 * drops is reconnected (MAX_RECONNECTS), and audio is buffered meanwhile.
 * ============================================================
 */
const WebSocket = require('ws');
const config = require('./config');

const SILENCE_MS = 700;
const MAX_TURN_MS = 15000;
const MIN_SPEECH_MS = 200;      // less than this is a click, not a turn
const SPEECH_RMS = 500;         // PCM16 level above which a 20 ms frame is speech
const MAX_PENDING_BYTES = 24000 * 2 * 20; // 20 s of audio held while (re)connecting
const MAX_RECONNECTS = 2;
const CONNECT_TIMEOUT_MS = 10000;

const PROMPT = 'A phone call to SaveLife Health Services, an ambulance company in Bengaluru, India: '
  + 'booking an ambulance — patient name, phone number, pickup area or landmark, hospital, time. '
  + 'Kannada, English, Hindi, Tamil or Telugu.';

function defaultConnect(url) {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
}

// Root-mean-square level of a little-endian PCM16 buffer.
function rms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

function sessionUpdate() {
  const languages = config.transcribeLanguages();
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: config.AUDIO.rate },
          transcription: {
            model: config.transcribeModel(),
            prompt: PROMPT,
            ...(languages.length ? { languages } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

function createTranscriber({ track, onTurn, onPartial, onProblem, connect = defaultConnect, now = () => Date.now() }) {
  let ws = null;
  let open = false;
  let closed = false;
  let reconnects = 0;
  let pending = [];          // base64 chunks waiting for the socket
  let pendingBytes = 0;
  // The turn being heard.
  let speechMs = 0;
  let silenceMs = 0;
  let turnMs = 0;
  const commitAt = new Map(); // item_id -> server time of its commit
  let commitsSent = 0;
  let commitOnOpen = false;   // a turn ended while the socket was not open
  let unresolved = 0;         // commits not yet transcribed (or failed)
  let drainWaiters = [];

  const problem = (where, message) => { try { onProblem?.({ track, where, message: String(message).slice(0, 500) }); } catch { /* never throws */ } };
  const settle = () => {
    if (unresolved > 0) return;
    const w = drainWaiters; drainWaiters = [];
    w.forEach((fn) => fn());
  };

  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch (e) { problem('openai_send', e.message); } };

  function connectNow() {
    open = false;
    try { ws = connect(config.transcribeUrl()); } catch (e) { problem('openai_connect', e.message); return; }
    const timer = setTimeout(() => { if (!open) { problem('openai_connect', 'timed out'); try { ws.terminate?.(); } catch { /* gone */ } } }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => problem('openai_handshake', `HTTP ${res.statusCode} ${body.slice(0, 300)}`));
    });
    ws.on('open', () => {
      clearTimeout(timer);
      open = true;
      send(sessionUpdate());
      const queued = pending; pending = []; pendingBytes = 0;
      queued.forEach((audio) => send({ type: 'input_audio_buffer.append', audio }));
      if (commitOnOpen) { commitOnOpen = false; sendCommit(); }
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      switch (m.type) {
        case 'input_audio_buffer.committed':
          if (m.item_id) commitAt.set(m.item_id, commitAt.get(m.item_id) || now());
          break;
        case 'conversation.item.input_audio_transcription.delta':
          if (m.delta) { try { onPartial?.({ track, itemId: m.item_id, delta: m.delta }); } catch { /* display only */ } }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const at = commitAt.get(m.item_id) || now();
          commitAt.delete(m.item_id);
          unresolved = Math.max(0, unresolved - 1);
          const text = String(m.transcript || '').trim();
          if (text) { try { onTurn({ track, text, at: new Date(at), itemId: m.item_id }); } catch (e) { problem('on_turn', e.message); } }
          settle();
          break;
        }
        case 'conversation.item.input_audio_transcription.failed':
          unresolved = Math.max(0, unresolved - 1);
          problem('transcription_failed', m.error?.message || 'a turn could not be transcribed');
          settle();
          break;
        case 'error':
          problem('openai_error', `${m.error?.code || ''} ${m.error?.message || ''}`.trim());
          break;
        default:
      }
    });
    ws.on('error', (e) => problem('openai_socket', e.message));
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      open = false;
      if (closed) return;
      problem('openai_closed', `code=${code} reason=${String(reason || '') || '-'}`);
      // Turns committed on the dead socket will never come back.
      unresolved = 0; commitAt.clear(); settle();
      if (reconnects < MAX_RECONNECTS) {
        reconnects += 1;
        setTimeout(() => { if (!closed) connectNow(); }, 500 * reconnects).unref?.();
      }
    });
  }

  function sendCommit() {
    commitsSent += 1;
    unresolved += 1;
    send({ type: 'input_audio_buffer.commit' });
  }
  function commit() {
    speechMs = 0; silenceMs = 0; turnMs = 0;
    // Not connected yet (or reconnecting): the turn's audio is held in
    // `pending` and committed right after it is sent.
    if (!open) { commitOnOpen = true; return; }
    sendCommit();
  }

  // One Plivo media payload (base64 PCM16 24 kHz, ~20 ms).
  function push(base64) {
    if (closed || !base64) return;
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch { return; }
    const ms = (buf.length / 2 / config.AUDIO.rate) * 1000;

    if (open) send({ type: 'input_audio_buffer.append', audio: base64 });
    else if (pendingBytes + buf.length <= MAX_PENDING_BYTES) { pending.push(base64); pendingBytes += buf.length; }

    const speaking = rms(buf) >= SPEECH_RMS;
    if (speaking) { speechMs += ms; silenceMs = 0; } else if (speechMs > 0) silenceMs += ms;
    if (speechMs > 0) turnMs += ms;

    if (speechMs >= MIN_SPEECH_MS && (silenceMs >= SILENCE_MS || turnMs >= MAX_TURN_MS)) commit();
    else if (speechMs > 0 && speechMs < MIN_SPEECH_MS && silenceMs >= SILENCE_MS) { speechMs = 0; silenceMs = 0; turnMs = 0; }
  }

  // The call ended: transcribe what is left, wait (up to waitMs) for the
  // last turns, then close.
  function finish({ waitMs = 4000 } = {}) {
    if (closed) return Promise.resolve();
    if (speechMs >= MIN_SPEECH_MS) commit();
    return new Promise((resolve) => {
      const done = () => {
        closed = true;
        try { ws?.close(); } catch { /* gone */ }
        resolve();
      };
      if (unresolved === 0) return done();
      const t = setTimeout(done, waitMs);
      t.unref?.();
      drainWaiters.push(() => { clearTimeout(t); done(); });
      return undefined;
    });
  }

  connectNow();
  return { push, finish, stats: () => ({ commitsSent, open }) };
}

module.exports = { createTranscriber, sessionUpdate, rms, SILENCE_MS, MAX_TURN_MS, SPEECH_RMS, PROMPT };
