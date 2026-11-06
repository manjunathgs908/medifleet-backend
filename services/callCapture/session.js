'use strict';
/**
 * services/callCapture/session.js
 * ============================================================
 * LIVE CALL CAPTURE — listen-only. When an operator answers a customer
 * call (callController.markAnswered / dialEvent):
 *
 *   startForCall(logId)  checks config.refusal, creates the CallCapture
 *                        draft and asks Plivo to stream the customer's leg
 *                        (REST, listen-only, both tracks, PCM16 24 kHz) to
 *                        /api/call-capture/stream. The call's own XML is
 *                        never touched, so nothing here can change what
 *                        the caller or the operator hears.
 *   createSession(...)   Plivo's stream: each track to its own transcriber
 *                        (customer / operator); every finished turn goes
 *                        on the draft, and the booking details are
 *                        re-extracted (at most every EXTRACT_GAP_MS), the
 *                        places resolved and the route priced — each
 *                        change published to the CRM at once (subscribe).
 *   end                  the stream closed (the call ended): last turns,
 *                        a final extraction with a summary, and the
 *                        transcript + summary saved on the CallLog.
 *
 * NOTHING here books or dispatches: the draft waits for an operator.
 * Every failure is recorded on the draft (problems) and logged
 * "[callCapture] …"; whatever was captured is kept. It runs in this
 * process (one backend instance) — subscribe() is in-memory.
 * ============================================================
 */
const { EventEmitter } = require('events');
const CallCapture = require('../../models/CallCapture');
const CallLog = require('../../models/CallLog');
const plivo = require('../plivoService');
const { resolvePlaceFromText } = require('../whatsappFlow');
const { quoteTrip } = require('../../controllers/tripController');
const config = require('./config');
const extract = require('./extract');
const { createTranscriber } = require('./transcriber');

const EXTRACT_GAP_MS = 3000;
const MAX_PROBLEMS = 50;
const ROLE = { inbound: 'customer', outbound: 'operator' };

const bus = new EventEmitter();
bus.setMaxListeners(0);
const live = new Map(); // captureId -> session state

// ── Publish / subscribe (the CRM's live panel) ──────────────
// 'update' carries the draft document; 'partial' the words of a turn still
// being spoken.
function publish(id, doc) { bus.emit(String(id), { type: 'update', doc }); }
function subscribe(id, fn) {
  const key = String(id);
  bus.on(key, fn);
  return () => bus.off(key, fn);
}
const isLive = (id) => live.has(String(id));

function noteProblem(doc, where, message) {
  console.warn(`[callCapture] ${where} on capture ${doc._id}: ${message}`);
  doc.problems.push({ at: new Date(), where, message: String(message).slice(0, 500) });
  if (doc.problems.length > MAX_PROBLEMS) doc.problems.splice(0, doc.problems.length - MAX_PROBLEMS);
}

// ── Start ───────────────────────────────────────────────────
async function startForCall(logId, { agentUser, deps = {} } = {}) {
  const streamUrlFor = deps.streamUrl || ((id) => require('../aiCaller/streamServer').captureStreamUrl(id));
  try {
    const log = await CallLog.findById(logId).select('direction callbackEligible providerCallId endedAt');
    const why = config.refusal(log);
    if (why) {
      console.info(`[callCapture] not capturing call ${logId}: ${why}`);
      return null;
    }
    let capture;
    try {
      capture = await CallCapture.create({ callLog: log._id, agentUser, status: 'starting', startedAt: new Date() });
    } catch (err) {
      if (err?.code === 11000) return null; // this call is already being captured
      throw err;
    }
    await CallLog.updateOne({ _id: log._id }, { $set: { callCapture: capture._id } });

    try {
      const r = await plivo.startStream({
        callUuid     : log.providerCallId,
        serviceUrl   : streamUrlFor(capture._id),
        audioTrack   : 'both',
        contentType  : config.AUDIO.contentType,
        streamTimeout: config.MAX_STREAM_SECONDS,
      });
      await CallCapture.updateOne({ _id: capture._id }, { $set: { plivoStreamId: r?.streamId || undefined } });
      console.info(`[callCapture] streaming call ${logId} -> capture ${capture._id} stream=${r?.streamId || '-'}`);
    } catch (err) {
      const message = `Plivo stream not started: ${err.response?.status ? `HTTP ${err.response.status} ` : ''}${JSON.stringify(err.response?.data || err.message).slice(0, 300)}`;
      console.warn(`[callCapture] ${message} (call ${logId})`);
      await CallCapture.updateOne(
        { _id: capture._id, status: 'starting' },
        { $set: { status: 'failed', endedAt: new Date() }, $push: { problems: { at: new Date(), where: 'plivo_stream', message } } },
      );
      const doc = await CallCapture.findById(capture._id);
      if (doc) publish(capture._id, doc);
    }
    return capture._id;
  } catch (err) {
    console.error(`[callCapture] start failed for call ${logId}:`, err.message);
    return null;
  }
}

// ── The stream ──────────────────────────────────────────────
async function createSession({ captureId, plivoWs, deps = {} }) {
  const connect = deps.connectOpenAI; // tests
  const doc = await CallCapture.findById(captureId);
  if (!doc || ['ended', 'failed'].includes(doc.status)) {
    try { plivoWs.close(); } catch { /* gone */ }
    return null;
  }

  const s = {
    doc,
    transcribers: {},
    saving: Promise.resolve(),
    extracting: false,
    again: false,
    lastExtractAt: 0,
    timer: null,
    ended: false,
    endPromise: null,
  };
  live.set(String(doc._id), s);

  const save = () => {
    s.saving = s.saving.then(() => doc.save()).catch((err) => console.error(`[callCapture] save failed on capture ${doc._id}:`, err.message));
    return s.saving;
  };
  const changed = () => { publish(doc._id, doc); return save(); };

  doc.status = 'live';
  await changed();

  // ── Turns ──
  const onTurn = ({ track, text, at }) => {
    const turn = { role: ROLE[track] || 'customer', text, at };
    // Two sides finish turns independently: keep the transcript in time order.
    let i = doc.transcript.length;
    while (i > 0 && new Date(doc.transcript[i - 1].at) > at) i -= 1;
    doc.transcript.splice(i, 0, turn);
    changed();
    scheduleExtract();
  };
  const onPartial = ({ track, delta, itemId }) => {
    bus.emit(String(doc._id), { type: 'partial', role: ROLE[track] || 'customer', itemId, delta });
  };
  const onProblem = ({ track, where, message }) => { noteProblem(doc, `${where}(${ROLE[track] || track})`, message); changed(); };

  const transcriberFor = (track) => {
    if (!s.transcribers[track]) {
      s.transcribers[track] = createTranscriber({ track, onTurn, onPartial, onProblem, ...(connect ? { connect } : {}) });
    }
    return s.transcribers[track];
  };

  // ── Extraction ──
  async function applyPlace(which, text) {
    const optionsKey = `${which}Options`;
    try {
      const r = await resolvePlaceFromText(String(text).slice(0, 200));
      const label = (p) => [p.name, p.address].filter(Boolean).join(', ');
      if (r?.status === 'single') {
        doc[which] = { label: label(r.place), lat: r.place.lat, lng: r.place.lng };
        doc[optionsKey] = [];
      } else {
        doc[which] = undefined;
        doc[optionsKey] = r?.status === 'multiple' ? r.places.slice(0, 5).map((p) => ({ label: label(p), lat: p.lat, lng: p.lng })) : [];
      }
    } catch (err) {
      noteProblem(doc, `place_${which}`, err.message);
    }
  }

  async function applyEstimate() {
    const { pickup, drop } = doc;
    const serviceType = doc.fields.serviceType;
    if (!pickup?.lat || !drop?.lat || !serviceType) return;
    try {
      const q = await quoteTrip({
        pickupLat: pickup.lat, pickupLng: pickup.lng, dropLat: drop.lat, dropLng: drop.lng,
        selectedType: serviceType, tripType: 'one_way', acEnabled: false,
      });
      doc.estimate = q
        ? { fare: q.fare || null, distanceKm: q.distanceKm, durationSec: q.durationSec, fareError: q.fareError || undefined, at: new Date() }
        : { fare: null, fareError: 'No road route between these places', at: new Date() };
    } catch (err) {
      noteProblem(doc, 'estimate', err.message);
    }
  }

  async function runExtract({ final = false } = {}) {
    if (!doc.transcript.some((t) => t.role === 'customer')) return;
    s.extracting = true;
    s.lastExtractAt = Date.now();
    try {
      const turns = doc.transcript.map((t) => ({ role: t.role, text: t.text }));
      const next = await extract.extractFields(turns, { final });
      const current = doc.fields.toObject ? doc.fields.toObject() : { ...doc.fields };
      const { merged, changed: what } = extract.merge(current, next);
      extract.FIELDS.forEach((k) => { doc.fields[k] = merged[k] || ''; });
      doc.extractions += 1;
      if (final && next.summary) doc.summary = next.summary;
      if (what.includes('pickupText')) await applyPlace('pickup', merged.pickupText);
      if (what.includes('dropText')) await applyPlace('drop', merged.dropText);
      if (what.some((k) => ['pickupText', 'dropText', 'serviceType'].includes(k))) await applyEstimate();
    } catch (err) {
      noteProblem(doc, 'extract', err.message);
    } finally {
      s.extracting = false;
    }
    await changed();
  }

  function scheduleExtract() {
    if (s.ended) return;
    if (s.extracting || s.timer) { s.again = true; return; }
    const wait = Math.max(0, s.lastExtractAt + EXTRACT_GAP_MS - Date.now());
    s.timer = setTimeout(async () => {
      s.timer = null;
      s.again = false;
      await runExtract();
      if (s.again && !s.ended) scheduleExtract();
    }, wait);
    s.timer.unref?.();
  }

  // ── End ──
  function end(why) {
    if (s.endPromise) return s.endPromise;
    s.ended = true;
    s.endPromise = (async () => {
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      try {
        await Promise.all(Object.values(s.transcribers).map((t) => t.finish()));
        while (s.extracting) await new Promise((r) => setTimeout(r, 100));
        await runExtract({ final: true });
      } catch (err) {
        noteProblem(doc, 'finish', err.message);
      }
      doc.status = 'ended';
      doc.endedAt = new Date();
      await changed();
      try {
        await CallLog.updateOne({ _id: doc.callLog }, { $set: {
          callCapture: doc._id,
          transcript : doc.transcript.map((t) => ({ role: t.role, text: t.text, at: t.at })),
          summary    : doc.summary || '',
        } });
      } catch (err) {
        console.error(`[callCapture] call log not updated for capture ${doc._id}:`, err.message);
      }
      console.info(`[callCapture] capture ${doc._id} ended (${why}): ${doc.transcript.length} turns, ${doc.extractions} extractions, ${doc.problems.length} problems`);
      live.delete(String(doc._id));
    })();
    return s.endPromise;
  }
  s.end = end;

  plivoWs.on('message', (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.event === 'media' && m.media?.payload) {
      // A stream with one track may not label it: that is the customer.
      transcriberFor(m.media.track === 'outbound' ? 'outbound' : 'inbound').push(m.media.payload);
    } else if (m.event === 'stop') {
      end('stream stopped');
    }
  });
  plivoWs.on('close', () => end('stream closed'));
  plivoWs.on('error', (err) => { noteProblem(doc, 'plivo_socket', err.message); });

  return s;
}

module.exports = { startForCall, createSession, subscribe, isLive, publish, EXTRACT_GAP_MS, _live: live };
