/**
 * routes/whatsappRoutes.js
 * ============================================================
 * WhatsApp Cloud API webhook — mounted at /api/whatsapp (see server.js).
 * GET /webhook  — Meta's one-time subscription verification handshake.
 * POST /webhook — actual inbound message/status callbacks.
 *
 * POST /webhook must ack within Meta's ~5s window or Meta retries the
 * same delivery, which would run the flow handler twice for one real
 * message (a duplicate booking, in the worst case) -- so this responds
 * res.sendStatus(200) BEFORE doing any signature verification, parsing,
 * or flow dispatch, all of which happen after as fire-and-forget from
 * the response's perspective.
 *
 * Signature check reuses server.js's existing req.rawBody (originally
 * added for paymentWebhookController's Razorpay HMAC check, via
 * express.json's verify callback) and the same createHmac +
 * length-guarded timingSafeEqual pattern as that webhook -- WhatsApp's
 * header is prefixed 'sha256=', Razorpay's isn't, otherwise identical.
 * ============================================================
 */
'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const whatsappFlow = require('../services/whatsappFlow');
const WhatsAppFunnelEvent = require('../models/WhatsAppFunnelEvent');
const WhatsAppSession = require('../models/WhatsAppSession');
const WhatsAppCallLog = require('../models/WhatsAppCallLog');
const { protect, authorize } = require('../middleware/auth');

const CALL_OUTCOMES = ['booked', 'followup', 'not_interested', 'no_answer'];
// Rules used by both POST /call-outcome (log a call) and GET /conversations
// (needsCall) -- kept in one place so they can't drift apart.
const MAX_NO_ANSWER_ATTEMPTS = 3;
const NO_ANSWER_RETRY_MS = 2 * 60 * 60 * 1000; // 2 hours

// Last ~1000 processed wamids -- Meta can redeliver the same message
// (network retry, or our own >5s response in some edge case) even though
// we ack fast; without this a redelivered message would run the flow
// handler a second time. Set for O(1) lookup, queue alongside it purely
// to know which id to evict once the Set grows past the cap (a Set alone
// has no insertion-order-based removal).
const MAX_DEDUPE_IDS = 1000;
const seenMessageIds = new Set();
const seenMessageIdsQueue = [];

function isDuplicateMessage(id) {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  seenMessageIdsQueue.push(id);
  if (seenMessageIdsQueue.length > MAX_DEDUPE_IDS) {
    const oldest = seenMessageIdsQueue.shift();
    seenMessageIds.delete(oldest);
  }
  return false;
}

// Same createHmac('sha256', secret).update(rawBody).digest('hex') +
// length-guarded timingSafeEqual shape as paymentWebhookController's
// Razorpay check -- see that file's own comment for why the length
// check has to come first (timingSafeEqual throws, doesn't return false,
// on mismatched buffer lengths).
function isValidSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !rawBody || !process.env.WA_APP_SECRET) return false;
  const signature = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const expected = crypto
    .createHmac('sha256', process.env.WA_APP_SECRET)
    .update(rawBody)
    .digest('hex');

  return expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ============================================================
// @route   GET /api/whatsapp/webhook
// @desc    Meta's subscription verification handshake -- called once
//          when the webhook URL is configured in the Meta App dashboard.
// @access  Public
// ============================================================
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================
// @route   POST /api/whatsapp/webhook
// @desc    Inbound message/status callbacks from WhatsApp Cloud API.
// @access  Public (authenticated via X-Hub-Signature-256, not a token)
// ============================================================
router.post('/webhook', (req, res) => {
  // Ack first -- see file header. Nothing below this line may run before
  // it, and nothing below it may throw back into this handler (it's a
  // detached async IIFE specifically so an error there can never affect
  // the response already sent).
  res.sendStatus(200);

  (async () => {
    try {
      if (!isValidSignature(req.headers['x-hub-signature-256'], req.rawBody)) {
        console.warn('[whatsapp webhook] Invalid or missing signature -- dropping payload.');
        return;
      }

      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const messages = value?.messages;

      // No `messages` array means this delivery is a status callback
      // (sent/delivered/read) rather than an actual inbound message --
      // Meta posts both shapes to the same URL. Not handled yet.
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      for (const message of messages) {
        if (!message?.id || isDuplicateMessage(message.id)) continue;
        try {
          await whatsappFlow.handleMessage(message);
        } catch (err) {
          console.error('[whatsapp webhook] handleMessage failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[whatsapp webhook] Processing failed:', err.message);
    }
  })();
});

// ============================================================
// @route   GET /api/whatsapp/funnel
// @desc    Funnel/drop-off analytics for the WhatsApp booking flow, read
//          from WhatsAppFunnelEvent (WhatsAppSession itself TTL-expires 30
//          minutes after last activity, so it can't back this report --
//          see that model's own comment).
// @access  Private [owner] -- the two routes above are intentionally
//          public/webhook-authenticated (Meta's verify_token + HMAC
//          signature, not a user login), which doesn't apply to an
//          admin-facing analytics endpoint returning customer phone
//          numbers; protect+authorize('owner') is the CRM-read pattern
//          routes/whatsappLeads.js already uses for this same WhatsApp
//          feature area.
//
// Query params:
//   days - lookback window in days (default 7)
// ============================================================
router.get('/funnel', protect, authorize('owner'), async (req, res, next) => {
  try {
    const parsedDays = parseInt(req.query.days, 10);
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { FUNNEL_STEPS, TERMINAL_STEP } = whatsappFlow;

    const [result] = await WhatsAppFunnelEvent.aggregate([
      { $match: { enteredAt: { $gte: cutoff } } },

      // Ascending so $last below reflects each phone's truly most recent
      // event in the window.
      { $sort: { enteredAt: 1 } },

      // One row per phone: latest step/language/serviceLabel/enteredAt,
      // whether this phone ever logged the terminal step (regardless of
      // whether it's their most recent event), and the full distinct set
      // of steps they've ever logged -- feeds reachedByStep below without
      // a second pass over the raw events.
      {
        $group: {
          _id: '$phone',
          lastStep: { $last: '$step' },
          language: { $last: '$language' },
          serviceLabel: { $last: '$serviceLabel' },
          lastSeenAt: { $last: '$enteredAt' },
          reachedTerminal: { $max: { $cond: [{ $eq: ['$step', TERMINAL_STEP] }, 1, 0] } },
          stepsSeen: { $addToSet: '$step' },
        },
      },

      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                totalConversations: { $sum: 1 },
                completed: { $sum: '$reachedTerminal' },
              },
            },
          ],
          reachedByStep: [
            { $unwind: '$stepsSeen' },
            { $group: { _id: '$stepsSeen', reached: { $sum: 1 } } },
          ],
          droppedByStep: [
            { $match: { reachedTerminal: 0 } },
            { $group: { _id: '$lastStep', droppedHere: { $sum: 1 } } },
          ],
          dropoffs: [
            { $match: { reachedTerminal: 0 } },
            { $sort: { lastSeenAt: -1 } },
            { $limit: 200 },
            {
              $project: {
                _id: 0,
                phone: '$_id',
                lastStep: 1,
                language: 1,
                serviceLabel: 1,
                lastSeenAt: 1,
                minutesSince: { $round: [{ $divide: [{ $subtract: ['$$NOW', '$lastSeenAt'] }, 60000] }, 1] },
              },
            },
          ],
        },
      },
    ]);

    const overview = result.overview[0] || { totalConversations: 0, completed: 0 };
    const reachedMap = Object.fromEntries(result.reachedByStep.map((r) => [r._id, r.reached]));
    const droppedMap = Object.fromEntries(result.droppedByStep.map((r) => [r._id, r.droppedHere]));

    const steps = FUNNEL_STEPS.map((step) => ({
      step,
      reached: reachedMap[step] || 0,
      droppedHere: droppedMap[step] || 0,
    }));

    res.json({
      success: true,
      totalConversations: overview.totalConversations,
      completed: overview.completed,
      steps,
      dropoffs: result.dropoffs,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// @route   POST /api/whatsapp/call-outcome
// @desc    Logs the outcome of an ops call-back to a WhatsApp customer.
//          Permanent, append-only -- see models/WhatsAppCallLog.js.
// @access  Private [owner] -- same reasoning as /funnel above.
//
// Body: { phone, outcome, followUpAt, note, tripId }
// ============================================================
router.post('/call-outcome', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { phone, outcome, followUpAt, note, tripId } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'phone is required.' });
    }

    if (!CALL_OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        success: false,
        message: `outcome must be one of: ${CALL_OUTCOMES.join(', ')}.`,
      });
    }

    // followUpAt is only meaningful (and only ever persisted) for
    // outcome:'followup' -- required and must be in the future there,
    // silently dropped to null for every other outcome even if the client
    // sent one.
    let followUpDate = null;
    if (outcome === 'followup') {
      followUpDate = followUpAt ? new Date(followUpAt) : null;
      if (!followUpDate || Number.isNaN(followUpDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'followUpAt is required and must be a valid date when outcome is followup.',
        });
      }
      if (followUpDate <= new Date()) {
        return res.status(400).json({ success: false, message: 'followUpAt must be in the future.' });
      }
    }

    const log = await WhatsAppCallLog.create({
      phone,
      outcome,
      followUpAt: followUpDate,
      note,
      calledBy: req.user._id,
      tripId: tripId || null,
    });

    res.json({ success: true, log });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// @route   GET /api/whatsapp/conversations
// @desc    One row per distinct phone active in the window -- their latest
//          known state, whether they ever completed a booking, and whether
//          a live (non-TTL-expired) WhatsAppSession still exists for them.
//          Same data source and reasoning as /funnel above (WhatsAppSession
//          TTL-expires, WhatsAppFunnelEvent doesn't).
// @access  Private [owner] -- same reasoning as /funnel above.
//
// Query params:
//   days   - lookback window in days (default 7)
//   status - all | dropped | completed (default all)
//   bucket - all | needs_call | done (default all) -- needsCall/done are
//            computed from WhatsAppCallLog, independent of status, and
//            combine with it (both filters apply together).
// ============================================================
router.get('/conversations', protect, authorize('owner'), async (req, res, next) => {
  try {
    const parsedDays = parseInt(req.query.days, 10);
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const status = ['all', 'dropped', 'completed'].includes(req.query.status) ? req.query.status : 'all';
    const bucket = ['all', 'needs_call', 'done'].includes(req.query.bucket) ? req.query.bucket : 'all';

    const { TERMINAL_STEP, STEP_LABELS } = whatsappFlow;

    const rowsMatch = {};
    if (status === 'completed')   rowsMatch.completed = true;
    if (status === 'dropped')     rowsMatch.completed = false;
    if (bucket === 'needs_call')  rowsMatch.needsCall = true;
    if (bucket === 'done')        { rowsMatch.needsCall = false; rowsMatch.hasCallLog = true; }

    const rowsPipeline = [];
    if (Object.keys(rowsMatch).length > 0) rowsPipeline.push({ $match: rowsMatch });
    rowsPipeline.push(
      { $sort: { lastSeenAt: -1 } },
      { $limit: 300 },
      {
        $project: {
          _id: 0,
          phone: '$_id',
          lastStep: 1,
          language: 1,
          serviceLabel: 1,
          firstSeenAt: 1,
          lastSeenAt: 1,
          completed: 1,
          isLive: 1,
          minutesSince: { $round: [{ $divide: [{ $subtract: ['$$NOW', '$lastSeenAt'] }, 60000] }, 1] },
          lastOutcome: 1,
          lastCalledAt: 1,
          followUpAt: 1,
          noAnswerCount: 1,
          needsCall: 1,
        },
      },
    );

    const [result] = await WhatsAppFunnelEvent.aggregate([
      { $match: { enteredAt: { $gte: cutoff } } },

      // Ascending so $first/$last below give each phone's true first/most
      // recent event in the window.
      { $sort: { enteredAt: 1 } },

      {
        $group: {
          _id: '$phone',
          lastStep: { $last: '$step' },
          language: { $last: '$language' },
          serviceLabel: { $last: '$serviceLabel' },
          firstSeenAt: { $first: '$enteredAt' },
          lastSeenAt: { $last: '$enteredAt' },
          // "Ever reached the terminal step in this window", not "is the
          // terminal step their latest event" -- same reasoning as /funnel's
          // reachedTerminal. Boolean $max works because false < true in
          // BSON comparison order, so this is true if ANY event in the
          // group was the terminal step.
          completed: { $max: { $cond: [{ $eq: ['$step', TERMINAL_STEP] }, true, false] } },
        },
      },

      // Cross-reference the live (non-TTL-expired) session collection --
      // .collection.name rather than a hardcoded 'whatsappsessions' string,
      // so this can't drift from whatever Mongoose actually calls it.
      {
        $lookup: {
          from: WhatsAppSession.collection.name,
          localField: '_id',
          foreignField: 'phone',
          as: 'liveSession',
        },
      },
      { $addFields: { isLive: { $gt: [{ $size: '$liveSession' }, 0] } } },

      // Per-phone call-log summary -- a $lookup pipeline (not the simple
      // localField/foreignField form) because this needs the MOST RECENT
      // log's outcome/date plus a count of no_answer logs, not the raw
      // array of logs. Yields 0 or 1 documents per phone.
      {
        $lookup: {
          from: WhatsAppCallLog.collection.name,
          let: { phone: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$phone', '$$phone'] } } },
            { $sort: { createdAt: -1 } },
            {
              $group: {
                _id: '$phone',
                lastOutcome: { $first: '$outcome' },
                lastCalledAt: { $first: '$createdAt' },
                followUpAt: { $first: '$followUpAt' },
                noAnswerCount: { $sum: { $cond: [{ $eq: ['$outcome', 'no_answer'] }, 1, 0] } },
              },
            },
          ],
          as: 'callLogSummary',
        },
      },
      {
        $addFields: {
          hasCallLog: { $gt: [{ $size: '$callLogSummary' }, 0] },
          lastOutcome: { $ifNull: [{ $arrayElemAt: ['$callLogSummary.lastOutcome', 0] }, null] },
          lastCalledAt: { $ifNull: [{ $arrayElemAt: ['$callLogSummary.lastCalledAt', 0] }, null] },
          followUpAt: { $ifNull: [{ $arrayElemAt: ['$callLogSummary.followUpAt', 0] }, null] },
          noAnswerCount: { $ifNull: [{ $arrayElemAt: ['$callLogSummary.noAnswerCount', 0] }, 0] },
        },
      },
      // needsCall -- see models/WhatsAppCallLog.js's own rules, mirrored
      // here in the pipeline (no call log at all; a followup whose
      // followUpAt has passed; or a no_answer under the retry cap and
      // over NO_ANSWER_RETRY_MS since the last attempt).
      {
        $addFields: {
          needsCall: {
            $or: [
              { $eq: ['$hasCallLog', false] },
              {
                $and: [
                  { $eq: ['$lastOutcome', 'followup'] },
                  { $ne: ['$followUpAt', null] },
                  { $lt: ['$followUpAt', '$$NOW'] },
                ],
              },
              {
                $and: [
                  { $eq: ['$lastOutcome', 'no_answer'] },
                  { $lt: ['$noAnswerCount', MAX_NO_ANSWER_ATTEMPTS] },
                  { $lt: ['$lastCalledAt', { $subtract: ['$$NOW', NO_ANSWER_RETRY_MS] }] },
                ],
              },
            ],
          },
        },
      },

      {
        $facet: {
          counts: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                completed: { $sum: { $cond: ['$completed', 1, 0] } },
                dropped: { $sum: { $cond: ['$completed', 0, 1] } },
                live: { $sum: { $cond: ['$isLive', 1, 0] } },
                needsCall: { $sum: { $cond: ['$needsCall', 1, 0] } },
                done: {
                  $sum: {
                    $cond: [{ $and: [{ $eq: ['$needsCall', false] }, { $eq: ['$hasCallLog', true] }] }, 1, 0],
                  },
                },
              },
            },
          ],
          rows: rowsPipeline,
        },
      },
    ]);

    const counts = result.counts[0] || { total: 0, completed: 0, dropped: 0, live: 0, needsCall: 0, done: 0 };
    const conversations = result.rows.map((row) => ({
      phone: row.phone,
      lastStep: row.lastStep,
      lastStepLabel: STEP_LABELS[row.lastStep] || row.lastStep,
      language: row.language,
      serviceLabel: row.serviceLabel,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      minutesSince: row.minutesSince,
      completed: row.completed,
      isLive: row.isLive,
      lastOutcome: row.lastOutcome,
      lastCalledAt: row.lastCalledAt,
      followUpAt: row.followUpAt,
      noAnswerCount: row.noAnswerCount,
      needsCall: row.needsCall,
    }));

    res.json({
      success: true,
      counts: {
        total: counts.total,
        completed: counts.completed,
        dropped: counts.dropped,
        live: counts.live,
      },
      callCounts: {
        needsCall: counts.needsCall,
        done: counts.done,
      },
      conversations,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
