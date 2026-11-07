'use strict';
/**
 * services/aiCaller/session.js
 * ============================================================
 * AI TELECALLER — PILOT. One live call's conversation: Plivo's two-way
 * audio stream (8 kHz mu-law) bridged to an OpenAI GPT-Live session
 * (wss://api.openai.com/v1/live/sessions) — a voice model (gpt-live-1)
 * that delegates tool work to a Responses model (AI_DELEGATE_MODEL).
 *
 * GPT-Live protocol (not the older /v1/realtime one):
 *   -> session.start { session: { model, instructions, audio: { format:
 *        audio/pcmu 8000, output: { voice } }, delegation: { type:
 *        'responses', responses: { model, tools, ... } } } }   (strict:
 *        unknown fields are rejected)
 *   <- session.started                          ready; only then send audio
 *   -> session.input_audio.append { audio }     Plivo media, as-is
 *   <- session.output_audio.delta { delta }     -> Plivo playAudio
 *   <- session.input_transcript.delta / session.output_transcript.delta
 *                                               fragments; joined into turns
 *   <- response.event { event: response.output_item.done function_call }
 *   -> response.item.create function_call_output, then response.create
 *   -> session.commentary.append                 text it should say aloud
 *   -> session.close / <- session.closed { usage }
 *
 * Every handshake rejection, error event and close (code + reason) is
 * logged with [aiCaller] and stored on the AiCall (openaiClose /
 * openaiErrors) so a failed call explains itself.
 *
 * Hard rules enforced here, not left to the model:
 *   - the first thing said is the opening: hello, the disclosure
 *     (automated assistant, call recorded) Kannada then English, then
 *     "ambulance ಬೇಕಾ?";
 *   - no medical advice (instructions) — and words of a real medical
 *     emergency from the caller (DISTRESS: unconscious, not breathing...)
 *     hand the call to a person at once. "Urgent" alone never does;
 *   - a hard time limit (config.maxCallSeconds): booked already -> a
 *     goodbye and hang up; otherwise a person ('time_limit');
 *   - GPT-Live dropping mid-call reconnects (MAX_AI_RECONNECTS) with the
 *     conversation so far, and the call carries on;
 *   - ANY failure hands off to a person. The session never transfers or
 *     hangs up through Plivo's REST API: it records the next step on the
 *     AiCall and closes the stream, and Plivo's <Redirect> after <Stream>
 *     fetches it (calls.nextXml).
 * ============================================================
 */
const WebSocket = require('ws');
const AiCall = require('../../models/AiCall');
const config = require('./config');
const calls = require('./calls');
const tools = require('./tools');
const prompt = require('./prompt');
const styleExamples = require('./styleExamples');

const OPENAI_CONNECT_TIMEOUT_MS = 10000; // socket open + session.started
const HANGUP_AFTER_GOODBYE_MS = 8000;    // if Plivo never confirms the goodbye finished playing
const SESSION_CLOSE_WAIT_MS = 3000;      // for session.closed (final usage) after session.close
const TURN_IDLE_MS = 1500;               // a speaker's transcript fragments -> one turn after this quiet
const MAX_AI_RECONNECTS = 2;             // a GPT-Live drop mid-call: reconnect and carry on, up to this many times
const RECENT_TURNS = 40;                 // conversation kept in memory, handed to a reconnected session
const TIME_UP_GOODBYE_MS = 7000;         // time limit after a booking: the goodbye plays, then the call ends
const MAX_TRANSCRIPT = 200;

// The opening, said as soon as the call connects: hello, the disclosure
// (automated assistant, call recorded) in Kannada then English, then the
// question — quick and natural. (Kannada wording to be checked by a native
// speaker before widening the pilot.)
// She is Sahana (ಸಹನ).
const DISCLOSURE_KN = 'ನಮಸ್ಕಾರ, ನಾನು ಸಹನ, SaveLife ನ automated assistant. ಈ ಕರೆ ದಾಖಲಾಗ್ತಿದೆ.';
const DISCLOSURE_EN = "I'm Sahana, SaveLife's automated assistant. This call is recorded.";
const OPENING_QUESTION = 'Ambulance ಬೇಕಾ?';
const OPENING = `${DISCLOSURE_KN} ${DISCLOSURE_EN} ${OPENING_QUESTION}`;
// After GPT-Live reconnected mid-call, and when the time limit ends a call
// that is already booked.
const RESUME_LINE = 'ಕ್ಷಮಿಸಿ, ಲೈನ್ ಸ್ವಲ್ಪ ಕಟ್ ಆಯ್ತು.';
const TIME_UP_BOOKED_LINE = 'ನಿಮ್ಮ ಬುಕ್ಕಿಂಗ್ ಆಗಿದೆ, ನಮ್ಮ ತಂಡ ಸ್ವಲ್ಪ ಹೊತ್ತಲ್ಲಿ ಕರೆ ಮಾಡುತ್ತಾರೆ. ಧನ್ಯವಾದಗಳು!';

// The base rules (prompt.BASE_INSTRUCTIONS); each call's instructions add
// today's IST date with every relative day resolved, and the style
// examples — prompt.buildInstructions, at session.start.
const INSTRUCTIONS = prompt.BASE_INSTRUCTIONS;

// For the delegated Responses model, which runs the tools.
const DELEGATE_INSTRUCTIONS = `
You run the tools for SaveLife's phone assistant. Use only these tools; never answer medical questions — use handoff_to_human for those, for a real medical emergency, or when the caller asks for a person. Never hand off just because the caller says "urgent".
get_quote is the only source of prices. create_booking only after the caller clearly confirmed the read-back details (customer_confirmed true). A freezer box kept at home is never priced: freezer_box_request, then end_call follow_up.
Round trip / up and down / the ambulance must wait: get_quote with round_trip true and wait_hours — quote it, never hand off for it.
Call get_quote as soon as service, pickup and drop are known; pass patient_at when known (hospital = no helper). Say the price its "say" gives (for a home pickup: without and with helper in one go). Answer extra-charge questions from that quote; do not repeat a question already answered.
Nurse: pass nurse_needed; never quote a nurse charge (the team confirms it). Over 1000 km: two drivers are assigned.
Dates: take them from the DATE AND TIME list in the instructions; never ask the caller for a month or year.
Reply briefly in plain words the phone assistant can say aloud.
`.trim();

// Distress words in the caller's own speech -> a person, immediately.
// English, Hindi (Devanagari + romanised), Kannada (+ romanised). A safety
// net behind the model's own instruction, so deliberately broad on the
// acute signs and silent on ordinary booking words ("emergency ambulance").
const DISTRESS = [
  /not breathing|can'?t breathe|unconscious|no pulse|heart attack|chest pain|heavy bleeding|bleeding (a lot|heavily)|seizure|\bfits\b|stroke|collapsed|dying|suicide|poison/i,
  /बेहोश|सांस नहीं|साँस नहीं|खून बह|दौरा पड़|दिल का दौरा|saans nahi|behosh/i,
  /ಉಸಿರಾಡುತ್ತಿಲ್ಲ|ಉಸಿರು ಇಲ್ಲ|ಪ್ರಜ್ಞೆ ಇಲ್ಲ|ಪ್ರಜ್ಞೆ ತಪ್ಪಿ|ಹೃದಯಾಘಾತ|ರಕ್ತಸ್ರಾವ|usiru illa|prajne illa/i,
  /ఊపిరి ఆడటం లేదు|ఊపిరి ఆడట్లేదు|స్పృహ లేదు|స్పృహ తప్పి|గుండెపోటు|రక్తస్రావం/,
  // Tamil (+ romanised)
  /மூச்சு விடவில்லை|மூச்சு இல்லை|மயக்கம்|சுயநினைவு இல்லை|மாரடைப்பு|நெஞ்சு வலி|ரத்தப்போக்கு|இரத்தப்போக்கு|வலிப்பு|moochu illa|mayakkam/i,
  // Malayalam (+ romanised)
  /ശ്വാസമില്ല|ശ്വാസം കിട്ടുന്നില്ല|ബോധമില്ല|ബോധം പോയി|ഹൃദയാഘാതം|നെഞ്ചുവേദന|രക്തസ്രാവം|അപസ്മാരം|bodham illa|shwasam illa/i,
];
const isDistress = (text) => DISTRESS.some((re) => re.test(String(text || '')));

const SCRIPTS = [[/[ಀ-೿]/, 'kn'], [/[ऀ-ॿ]/, 'hi'], [/[ఀ-౿]/, 'te'], [/[஀-௿]/, 'ta'], [/[ഀ-ൿ]/, 'ml']];
const scriptLanguage = (text) => (SCRIPTS.find(([re]) => re.test(text)) || [null, 'en'])[1];

function defaultConnectOpenAI() {
  return new WebSocket(config.liveUrl(), {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
}

// GPT-Live's usage shape is newer than ours: take what matches, keep the rest raw.
function usageFields(u = {}) {
  const inD = u.input_token_details || u.input_tokens_details || {};
  const outD = u.output_token_details || u.output_tokens_details || {};
  return {
    audioIn : inD.audio_tokens || 0,
    textIn  : inD.text_tokens || 0,
    cachedIn: inD.cached_tokens || 0,
    audioOut: outD.audio_tokens || 0,
    textOut : outD.text_tokens || 0,
  };
}

const active = new Map(); // callId -> session (one per call)

async function createSession({ callId, plivoWs, connectOpenAI = defaultConnectOpenAI }) {
  if (active.has(callId)) { plivoWs.close(); return null; }
  const call = await AiCall.findById(callId).select('+phone status');
  if (!call || call.status !== 'in_progress') { plivoWs.close(); return null; }

  const s = {
    callId, phone: call.phone, plivoWs, openai: null,
    streamId: null, socketOpen: false, ready: false, ended: false, ending: false,
    state: {}, timers: [], languageSet: false,
    recent: [], everReady: false, reconnects: 0,
    turns: { caller: '', assistant: '' }, turnTimer: { caller: null, assistant: null },
  };
  active.set(callId, s);
  // This call's instructions: today's IST date (server time) and the real
  // SaveLife calls to copy the style of. Built before connecting, so
  // session.start can go the moment the socket opens.
  const examples = await styleExamples.loadForPrompt();
  s.instructions = prompt.buildInstructions({ now: new Date(), examples });
  s.styleExamples = examples.length;

  const sendPlivo = (msg) => { try { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.send(JSON.stringify(msg)); } catch { /* caller gone */ } };
  const sendAI = (msg) => { try { if (s.openai?.readyState === WebSocket.OPEN) s.openai.send(JSON.stringify(msg)); } catch { /* handled by close */ } };

  const note = (role, text) => {
    if (!text || !String(text).trim()) return;
    if (role !== 'system') {
      s.recent.push({ role, text: String(text).trim().slice(0, 500) });
      if (s.recent.length > RECENT_TURNS) s.recent.shift();
    }
    AiCall.updateOne({ _id: callId }, { $push: { transcript: { $each: [{ role, text: String(text).trim().slice(0, 2000), at: new Date() }], $slice: -MAX_TRANSCRIPT } } })
      .catch((err) => console.error('[aiCaller] transcript write failed:', err.message));
  };
  const recordOpenAIError = (code, message) => {
    console.error(`[aiCaller] OpenAI error on ${callId}: ${code || ''} ${message || ''}`);
    AiCall.updateOne({ _id: callId }, { $push: { openaiErrors: { $each: [{ at: new Date(), code: String(code || ''), message: String(message || '').slice(0, 500) }], $slice: -20 } } }).catch(() => {});
  };

  // Transcript fragments -> turns: a turn is written when that speaker goes
  // quiet for TURN_IDLE_MS or the other speaker starts.
  const flushTurn = (who) => {
    clearTimeout(s.turnTimer[who]);
    s.turnTimer[who] = null;
    const text = s.turns[who];
    s.turns[who] = '';
    note(who, text);
  };
  const addFragment = (who, delta) => {
    if (!delta) return '';
    const other = who === 'caller' ? 'assistant' : 'caller';
    if (s.turns[other]) flushTurn(other);
    s.turns[who] += delta;
    clearTimeout(s.turnTimer[who]);
    s.turnTimer[who] = setTimeout(() => flushTurn(who), TURN_IDLE_MS);
    return s.turns[who];
  };

  // End the conversation. The Plivo stream closes LAST, after the next step
  // is on the AiCall — Plivo's <Redirect> then asks /plivo/next for it.
  const closeOpenAI = () => {
    if (!s.openai || s.openai.readyState !== WebSocket.OPEN) return;
    if (s.ready) {
      sendAI({ type: 'session.close', event_id: 'event_close' });
      setTimeout(() => { try { s.openai.close(1000); } catch { /* gone */ } }, SESSION_CLOSE_WAIT_MS);
    } else {
      try { s.openai.close(1000); } catch { /* gone */ }
    }
  };
  const cleanup = () => {
    if (s.ended) return;
    s.ended = true;
    s.timers.forEach(clearTimeout);
    flushTurn('caller');
    flushTurn('assistant');
    active.delete(callId);
    closeOpenAI();
    try { plivoWs.close(); } catch { /* already closed */ }
  };

  // Anything wrong, or the model asked: a person. Once.
  const handOff = async (reason) => {
    if (s.ended || s.ending) return;
    s.ending = true;
    note('system', `Handoff to a person (${reason})`);
    await calls.handOff(callId, reason);
    cleanup();
  };
  const fallback = async (why) => {
    if (s.ended || s.ending) return;
    await AiCall.updateOne({ _id: callId }, { $set: { error: String(why).slice(0, 500) } }).catch(() => {});
    await handOff(why);
  };

  const endCall = async ({ outcome, summary }) => {
    if (s.ended || s.ending) return;
    s.ending = true;
    note('system', `Call ended by assistant (${outcome})${summary ? `: ${summary}` : ''}`);
    const $set = { summary: String(summary || '').slice(0, 1000) };
    if (!s.state.booked) {
      if (outcome === 'follow_up') $set.outcome = 'follow_up';
      else if (outcome === 'not_needed') $set.outcome = 'ended';
    }
    await AiCall.updateOne({ _id: callId }, { $set });
    await calls.requestEnd(callId);
    if (outcome === 'follow_up' && !s.state.booked) await calls.queueFollowUp(callId, summary).catch(() => {});
    // Let the goodbye finish playing, then close the stream (-> /next -> hang up).
    sendPlivo({ event: 'checkpoint', streamId: s.streamId, name: 'goodbye' });
    s.timers.push(setTimeout(cleanup, HANGUP_AFTER_GOODBYE_MS));
  };

  // ── OpenAI ────────────────────────────────────────────────
  // GPT-Live dropping AFTER the session started (OpenAI closed the socket,
  // a network error) does not end the call: a fresh session is opened —
  // up to MAX_AI_RECONNECTS times — with the same instructions plus the
  // conversation so far, and the call's tool state (quote, booking) stays
  // in s.state. Only a session that never started, or a drop after the
  // reconnects are used up, hands off to a person.
  const resumeInstructions = () => [
    s.instructions,
    'THE LINE DROPPED FOR A MOMENT AND YOU ARE BACK ON THE SAME CALL. Do NOT say the opening again. '
      + 'You have just said a short sorry; continue exactly where the conversation stopped and never ask again for anything already answered.'
      + (s.state.quote ? ' A quote was already given (get_quote ok) — read it back again if needed.' : '')
      + (s.state.booked ? ` The booking is ALREADY made (${s.state.booked}) — do not book again; just say goodbye if nothing else is needed.` : ''),
    `CONVERSATION SO FAR:\n${s.recent.map((t) => `${t.role === 'caller' ? 'Caller' : 'You'}: ${t.text}`).join('\n') || '(nothing yet)'}`,
  ].join('\n\n');

  // The AI side is gone (this socket). Mid-call: reconnect; else a person.
  function aiLost(ws, why) {
    if (s.ended || s.ending || ws?.lost) return;
    if (ws) {
      ws.lost = true;
      try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* gone */ }
    }
    if (!s.everReady || s.reconnects >= MAX_AI_RECONNECTS) {
      fallback(s.reconnects ? `${why} (after ${s.reconnects} reconnect${s.reconnects === 1 ? '' : 's'})` : why);
      return;
    }
    s.reconnects += 1;
    s.ready = false;
    console.warn(`[aiCaller] OpenAI dropped on ${callId}: ${why} — reconnecting (${s.reconnects}/${MAX_AI_RECONNECTS})`);
    note('system', `AI line dropped (${why}) — reconnecting`);
    AiCall.updateOne({ _id: callId }, { $inc: { aiReconnects: 1 } }).catch(() => {});
    s.timers.push(setTimeout(() => { if (!s.ended && !s.ending) connectAI({ resume: true }); }, 300 * s.reconnects));
  }

  function connectAI({ resume = false } = {}) {
    let ws;
    try {
      ws = connectOpenAI();
    } catch (err) {
      aiLost(null, `AI could not ${resume ? 'reconnect' : 'start'} (${err.message})`);
      return;
    }
    s.openai = ws;
    s.socketOpen = false;
    const mine = () => s.openai === ws && !ws.lost; // a replaced socket's events are ignored

    s.timers.push(setTimeout(() => {
      if (mine() && !s.ready) aiLost(ws, s.socketOpen ? 'AI session did not start in time' : 'AI did not connect in time');
    }, OPENAI_CONNECT_TIMEOUT_MS));

    // A refused handshake (wrong URL -> 404, bad key -> 401, no access -> 403):
    // log OpenAI's own answer — this is the line to look for in the logs.
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 1000) body += c; });
      res.on('end', () => {
        if (!mine()) return;
        console.error(`[aiCaller] OpenAI handshake rejected on ${callId}: HTTP ${res.statusCode} ${body}`);
        AiCall.updateOne({ _id: callId }, { $set: { openaiClose: { code: res.statusCode, reason: body.slice(0, 500), at: new Date() } } }).catch(() => {});
        aiLost(ws, `AI handshake rejected: HTTP ${res.statusCode} ${body.slice(0, 300)}`);
      });
    });

    ws.on('open', () => {
      if (!mine()) return;
      s.socketOpen = true;
      sendAI({
        type: 'session.start',
        event_id: resume ? `event_start_${s.reconnects}` : 'event_start',
        session: {
          model: config.realtimeModel(),
          instructions: resume ? resumeInstructions() : s.instructions,
          audio: {
            format: { type: 'audio/pcmu', rate: 8000 },
            output: { voice: config.realtimeVoice() },
          },
          delegation: {
            type: 'responses',
            responses: {
              model: config.delegateModel(),
              instructions: DELEGATE_INSTRUCTIONS,
              tools: tools.definitions(),
              tool_choice: 'auto',
              parallel_tool_calls: false,
            },
          },
        },
      });
    });

    ws.on('message', (raw) => { if (mine()) onAIMessage(ws, raw, { resume }); });
    ws.on('error', (err) => {
      if (!mine()) return;
      console.error(`[aiCaller] OpenAI socket error on ${callId}:`, err.message);
      aiLost(ws, `AI connection error (${err.message})`);
    });
    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      console.info(`[aiCaller] OpenAI socket closed on ${callId}: code=${code} reason=${reason || '(none)'}`);
      if (!mine() || s.ended || s.ending) return;
      AiCall.updateOne({ _id: callId }, { $set: { openaiClose: { code, reason: reason.slice(0, 500), at: new Date() } } }).catch(() => {});
      aiLost(ws, `AI connection closed (code ${code}${reason ? `: ${reason}` : ''})`);
    });
  }

  async function onAIMessage(ws, raw, { resume }) {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    const type = ev.type || '';
    try {
      switch (type) {
        case 'session.started':
          s.ready = true;
          s.everReady = true;
          if (resume) {
            note('system', `AI reconnected (${s.reconnects}/${MAX_AI_RECONNECTS}) — call continues`);
            // A short sorry, then it carries on from the conversation so far.
            sendAI({ type: 'session.commentary.append', event_id: `event_resume_${s.reconnects}`, delegation_id: null, content: RESUME_LINE });
          } else {
            note('system', `AI session started (${config.realtimeModel()} + ${config.delegateModel()}, ${s.styleExamples} style example${s.styleExamples === 1 ? '' : 's'})`);
            // The opening — disclosure, then "ambulance ಬೇಕಾ?": the first thing it says.
            sendAI({ type: 'session.commentary.append', event_id: 'event_disclosure', delegation_id: null, content: OPENING });
          }
          break;
        case 'session.output_audio.delta':
          if (ev.delta) sendPlivo({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: ev.delta } });
          break;
        case 'session.output_transcript.delta':
          addFragment('assistant', ev.delta);
          break;
        case 'session.input_transcript.delta': {
          const turn = addFragment('caller', ev.delta);
          if (!s.languageSet && turn.trim()) {
            s.languageSet = true;
            AiCall.updateOne({ _id: callId }, { $set: { language: scriptLanguage(turn) } }).catch(() => {});
          }
          if (isDistress(turn)) { flushTurn('caller'); await handOff('distress'); }
          break;
        }
        case 'response.event':
          await onResponseEvent(ev);
          break;
        case 'session.closed': {
          const u = ev.usage || ev.session?.usage;
          console.info(`[aiCaller] OpenAI session closed on ${callId}: ${ev.reason || 'no reason given'}`);
          const update = { usageRaw: u || null };
          if (ev.reason) update.openaiClose = { code: null, reason: String(ev.reason).slice(0, 500), at: new Date() };
          if (u) {
            const f = usageFields(u);
            Object.entries(f).forEach(([k, v]) => { if (v) update[`usage.${k}`] = v; });
          }
          AiCall.updateOne({ _id: callId }, { $set: update }).catch(() => {});
          break;
        }
        case 'error':
          recordOpenAIError(ev.error?.code || ev.code, ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 300));
          if (!s.ready) aiLost(ws, `AI refused the session: ${ev.error?.code || ''} ${ev.error?.message || ''}`.trim());
          break;
        default:
          break;
      }
    } catch (err) {
      await fallback(`assistant error (${err.message})`);
    }
  }

  // The time limit (AI_CALL_MAX_SECONDS). Plivo's own stream timeout is set
  // later than this (aiCallerController), so the call always ends HERE,
  // cleanly: booked already -> a short goodbye and hang up; otherwise a
  // person takes over ('time_limit').
  const timeUp = () => {
    if (s.ended || s.ending) return;
    if (s.state.booked) {
      note('system', 'Time limit reached after booking — goodbye');
      sendAI({ type: 'session.commentary.append', event_id: 'event_time_up', delegation_id: null, content: TIME_UP_BOOKED_LINE });
      s.timers.push(setTimeout(() => endCall({ outcome: 'booked', summary: `Booked ${s.state.booked}; call reached the time limit.` }), TIME_UP_GOODBYE_MS));
      return;
    }
    handOff('time_limit');
  };
  s.timers.push(setTimeout(timeUp, config.maxCallSeconds() * 1000));

  connectAI();

  // Delegated work: function calls from the Responses model, usage.
  async function onResponseEvent(ev) {
    const inner = ev.event || {};
    if (inner.type === 'response.completed' && inner.response?.usage) {
      const f = usageFields(inner.response.usage);
      const textIn = inner.response.usage.input_tokens || f.textIn;
      const textOut = inner.response.usage.output_tokens || f.textOut;
      AiCall.updateOne({ _id: callId }, { $inc: { 'usage.textIn': textIn || 0, 'usage.textOut': textOut || 0 } }).catch(() => {});
      return undefined;
    }
    if (inner.type === 'response.failed' || inner.type === 'error') {
      recordOpenAIError(inner.error?.code || inner.response?.error?.code, inner.error?.message || inner.response?.error?.message || inner.type);
      return undefined;
    }
    if (inner.type !== 'response.output_item.done' || inner.item?.type !== 'function_call') return undefined;

    const item = inner.item;
    let args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
    if (item.name === 'handoff_to_human') return handOff(args.reason || 'other');
    if (item.name === 'end_call') return endCall(args);

    const handler = tools.HANDLERS[item.name];
    const output = handler
      ? await handler(args, { callId, phone: s.phone, state: s.state })
      : { ok: false, reason: 'unknown_tool' };
    note('system', `${item.name} -> ${output.ok ? 'ok' : output.reason}`);
    sendAI({ type: 'response.item.create', event_id: `event_out_${item.call_id}`, item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    sendAI({ type: 'response.create', event_id: `event_continue_${item.call_id}` });
    return undefined;
  }

  // ── Plivo ─────────────────────────────────────────────────
  plivoWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === 'start') {
      s.streamId = msg.start?.streamId || msg.streamId || null;
    } else if (msg.event === 'media' && msg.media?.payload) {
      if (s.ready && !s.ending) sendAI({ type: 'session.input_audio.append', audio: msg.media.payload });
    } else if (msg.event === 'playedStream' && msg.name === 'goodbye') {
      cleanup();
    } else if (msg.event === 'stop') {
      cleanup();
    }
  });
  plivoWs.on('close', () => cleanup()); // the caller hung up, or Plivo moved on
  plivoWs.on('error', () => cleanup());

  return s;
}

module.exports = {
  createSession, INSTRUCTIONS, DELEGATE_INSTRUCTIONS, DISCLOSURE_KN, DISCLOSURE_EN, OPENING, RESUME_LINE, TIME_UP_BOOKED_LINE,
  MAX_AI_RECONNECTS, isDistress, scriptLanguage, _active: active,
};
