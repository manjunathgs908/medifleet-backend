'use strict';
/**
 * controllers/callCaptureController.js
 * ============================================================
 * LIVE CALL CAPTURE — the CRM's view of a call's draft (operations staff).
 *
 *   GET /api/call-capture/by-call/:logId   the draft for a call, or
 *                                          { capture: null, reason }
 *   GET /api/call-capture/:id              one draft
 *   GET /api/call-capture/:id/events       live updates (text/event-stream):
 *                                          'capture' = the whole draft,
 *                                          'partial' = words being spoken,
 *                                          'end' = the call is over
 *
 * Read-only: nothing here books anything (that is POST /api/trips with
 * callCaptureId, by the operator). Numbers are masked except for the owner,
 * every update included — each is rendered as THIS request's viewer.
 * ============================================================
 */
const mongoose = require('mongoose');
const CallCapture = require('../models/CallCapture');
const CallLog = require('../models/CallLog');
const session = require('../services/callCapture/session');
const config = require('../services/callCapture/config');
const { runAsViewer } = require('../utils/phoneViewer');
const { maskNumbersInText } = require('../utils/maskNumbersInText');

const HEARTBEAT_MS = 20000;
// A draft still "live" that no stream in this process is filling, and
// untouched this long, was cut off (a server restart): show it as ended,
// with everything it captured.
const STALE_MS = 60 * 1000;

async function settleStale(doc) {
  if (!doc || !['starting', 'live'].includes(doc.status) || session.isLive(doc._id)) return doc;
  if (Date.now() - new Date(doc.updatedAt || doc.createdAt).getTime() < STALE_MS) return doc;
  doc.status = 'ended';
  doc.endedAt = doc.endedAt || new Date();
  doc.problems.push({ at: new Date(), where: 'interrupted', message: 'The capture stopped before the call ended (server restart?). Everything captured until then is kept.' });
  await doc.save();
  return doc;
}

const isId = (v) => mongoose.isValidObjectId(String(v));

exports.byCall = async (req, res, next) => {
  try {
    if (!isId(req.params.logId)) return res.status(404).json({ success: false, message: 'Call not found.' });
    const doc = await settleStale(await CallCapture.findOne({ callLog: req.params.logId }));
    if (doc) return res.json({ success: true, capture: doc });
    // Not (yet) captured: say why, so the panel can.
    const log = await CallLog.findById(req.params.logId).select('direction callbackEligible providerCallId endedAt');
    return res.json({ success: true, capture: null, reason: config.refusal(log) || 'starting' });
  } catch (err) {
    next(err);
  }
};

exports.getOne = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, message: 'Call capture not found.' });
    const doc = await settleStale(await CallCapture.findById(req.params.id));
    if (!doc) return res.status(404).json({ success: false, message: 'Call capture not found.' });
    return res.json({ success: true, capture: doc });
  } catch (err) {
    next(err);
  }
};

exports.events = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, message: 'Call capture not found.' });
    const doc = await settleStale(await CallCapture.findById(req.params.id));
    if (!doc) return res.status(404).json({ success: false, message: 'Call capture not found.' });

    res.writeHead(200, {
      'Content-Type'     : 'text/event-stream',
      'Cache-Control'    : 'no-cache, no-transform',
      Connection         : 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const user = req.user;
    const asViewer = (fn) => runAsViewer(user, fn);
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
    const sendCapture = (d) => send('capture', asViewer(() => d.toJSON()));

    let done = false;
    let unsubscribe = () => {};
    let ping = null;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearInterval(ping);
      try { res.end(); } catch { /* closed */ }
    };

    sendCapture(doc);
    if (['ended', 'failed'].includes(doc.status)) { send('end', {}); return finish(); }

    unsubscribe = session.subscribe(doc._id, (ev) => {
      if (ev.type === 'partial') {
        send('partial', { role: ev.role, itemId: ev.itemId, delta: asViewer(() => maskNumbersInText(ev.delta)) });
        return;
      }
      sendCapture(ev.doc);
      if (['ended', 'failed'].includes(ev.doc.status)) { send('end', {}); finish(); }
    });
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { finish(); } }, HEARTBEAT_MS);
    ping.unref?.();
    req.on('close', finish);
    return undefined;
  } catch (err) {
    return next(err);
  }
};
