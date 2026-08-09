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
const mongoose = require('mongoose');
const router = express.Router();
const whatsappFlow = require('../services/whatsappFlow');
const WhatsAppFunnelEvent = require('../models/WhatsAppFunnelEvent');
const WhatsAppSession = require('../models/WhatsAppSession');
const WhatsAppCallLog = require('../models/WhatsAppCallLog');
const { Trip, Lead } = require('../models');
const { normalisePhone, phoneSuffixQuery } = require('../utils/phone');
const { protect, authorize } = require('../middleware/auth');

const CALL_OUTCOMES = ['booked', 'followup', 'not_interested', 'no_answer'];

// Rules used by both POST /call-outcome (log a call) and GET /conversations
// (needsCall) -- kept in one place so they can't drift apart.
const MAX_NO_ANSWER_ATTEMPTS = 3;
const NO_ANSWER_RETRY_MS = 2 * 60 * 60 * 1000; // 2 hours

// ============================================================
// Ads-pipeline Lead mirroring -- POST /call-outcome's side effect of
// surfacing WhatsApp conversations in the CRM Leads Dashboard alongside
// Google/Facebook/inbound-call leads (models/index.js's Lead model,
// routes/leads.js). Phone matching here goes through the same shared
// utils/phone.js normalisePhone as everywhere else in this file and in
// controllers/telephonyController.js -- so a WhatsApp number and an
// inbound-call number for the same person converge on one Lead.
const OUTCOME_TO_LEAD_STATUS = {
  booked: 'converted',
  followup: 'contacted',
  not_interested: 'lost',
  no_answer: 'contacted',
};

// Finds a Trip by whatever the caller put in WhatsAppCallLog.tripId --
// that field is a free-text String (see models/WhatsAppCallLog.js's own
// comment: the ops caller may type either a Trip's _id or its human
// tripNumber), so this tries both. mongoose.Types.ObjectId.isValid guards
// the _id branch -- comparing an arbitrary non-ObjectId string against an
// ObjectId-typed field throws a CastError rather than just not matching.
async function findTripForCallOutcome(tripId) {
  if (!tripId) return null;
  const query = mongoose.Types.ObjectId.isValid(tripId)
    ? { $or: [{ _id: tripId }, { tripNumber: tripId }] }
    : { tripNumber: tripId };
  return Trip.findOne(query);
}

// Mirrors one call outcome onto the ads Lead pipeline. Read-then-write
// (not a single findOneAndUpdate/upsert) because appending to notes -- a
// plain String field, not an array -- needs the CURRENT value in hand
// first; same overall create-vs-update shape as
// controllers/telephonyController.js's inboundCallWebhook.
async function upsertWhatsAppLead({ phone, outcome, note, tripId, calledByUserId }) {
  const normalisedPhone = normalisePhone(phone);
  const calledAt = new Date();

  const [existingLead, latestServiceEvent, trip] = await Promise.all([
    // Exact match, not phoneSuffixQuery -- both sides of this comparison
    // go through normalisePhone every time, so they're guaranteed to
    // agree exactly; the fuzzier suffix match is for reconciling against
    // data this route doesn't control (Trip.patientPhone, Lead entries
    // written by other channels).
    Lead.findOne({ source: 'whatsapp', phone: normalisedPhone }),
    // Raw (un-normalised) phone -- WhatsAppFunnelEvent always stores the
    // wa_id Meta sent, never the telephony-style normalised form.
    WhatsAppFunnelEvent.findOne({ phone, serviceLabel: { $ne: null } }).sort({ enteredAt: -1 }),
    outcome === 'booked' ? findTripForCallOutcome(tripId) : Promise.resolve(null),
  ]);

  const serviceLabel = latestServiceEvent?.serviceLabel || null;
  const status = OUTCOME_TO_LEAD_STATUS[outcome];
  const trimmedNote = note?.trim();
  const noteEntry = trimmedNote ? `[${calledAt.toISOString()}] ${trimmedNote}` : null;
  const callHistoryEntry = { direction: 'outbound', status: outcome, calledAt };

  if (existingLead) {
    existingLead.status = status;
    if (serviceLabel) existingLead.message = serviceLabel; // else leave as-is
    if (noteEntry) {
      existingLead.notes = existingLead.notes ? `${existingLead.notes}\n${noteEntry}` : noteEntry;
    }
    existingLead.assignedTo = calledByUserId;
    if (trip) existingLead.convertedTrip = trip._id;
    existingLead.callHistory.push(callHistoryEntry);
    await existingLead.save();
    return existingLead;
  }

  return Lead.create({
    source: 'whatsapp',
    phone: normalisedPhone,
    status,
    message: serviceLabel || undefined,
    notes: noteEntry || undefined,
    assignedTo: calledByUserId,
    convertedTrip: trip?._id,
    callHistory: [callHistoryEntry],
    receivedAt: calledAt,
  });
}

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

    // Side effect: mirror this outcome onto the ads Lead pipeline so
    // WhatsApp conversations show up in the Leads Dashboard too. Logging
    // the call (above) is the primary action -- a failure here must never
    // turn an already-successfully-logged call into an error response.
    try {
      await upsertWhatsAppLead({ phone, outcome, note, tripId, calledByUserId: req.user._id });
    } catch (err) {
      // Full error (err, not err.message) -- console.error prints a
      // ValidationError's .errors detail and the stack trace, not just the
      // top-level message, which is what actually pinpoints which field/
      // path failed. This was the only reason this bug was invisible.
      console.error('[whatsapp call-outcome] Lead upsert failed:', err);
    }

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
          isReturning: 1,
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
      // isReturning -- a call log already exists (so this phone was
      // reached AND given an outcome -- booked/not_interested/followup/
      // no_answer all count) but they've since sent a NEW message, later
      // than that call. Without this, a phone marked not_interested or
      // booked would never resurface in needs_call even after messaging
      // the bot again days later with fresh intent. Gated on hasCallLog:
      // a phone with NO call log at all is caught by the first needsCall
      // branch below already ("never called"), not "returning".
      {
        $addFields: {
          isReturning: {
            $and: [
              { $eq: ['$hasCallLog', true] },
              { $ne: ['$lastCalledAt', null] },
              { $gt: ['$lastSeenAt', '$lastCalledAt'] },
            ],
          },
        },
      },
      // needsCall -- see models/WhatsAppCallLog.js's own rules, mirrored
      // here in the pipeline (no call log at all; a followup whose
      // followUpAt has passed; a no_answer under the retry cap and over
      // NO_ANSWER_RETRY_MS since the last attempt; or isReturning above).
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
              { $eq: ['$isReturning', true] },
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
      isReturning: row.isReturning,
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

// ============================================================
// @route   GET /api/whatsapp/customer/:phone
// @desc    Full permanent history for one customer across every WhatsApp
//          conversation, ops call, and Trip -- no date limit, unlike
//          /funnel and /conversations above. Phone matching goes through
//          utils/phone.js (normalisePhone/phoneSuffixQuery) because
//          WhatsApp-side collections and Trip.patientPhone do not
//          reliably share one format -- see that module's own comment
//          for the full investigation.
// @access  Private [owner] -- same reasoning as /funnel above.
// ============================================================
router.get('/customer/:phone', protect, authorize('owner'), async (req, res, next) => {
  try {
    const normalized = normalisePhone(req.params.phone);
    if (normalized.length !== 10) {
      return res.status(400).json({ success: false, message: 'phone must contain at least 10 digits.' });
    }
    const phoneQuery = phoneSuffixQuery(req.params.phone);
    const { TERMINAL_STEP, STEP_LABELS } = whatsappFlow;

    const [events, calls, trips] = await Promise.all([
      // Ascending -- the conversation-segmentation walk below needs
      // chronological order.
      WhatsAppFunnelEvent.find({ phone: phoneQuery }).sort({ enteredAt: 1 }).lean(),
      WhatsAppCallLog.find({ phone: phoneQuery }).sort({ createdAt: -1 }).populate('calledBy', 'name').lean(),
      Trip.find({ patientPhone: phoneQuery }).sort({ createdAt: -1 }).lean(),
    ]);

    // Segments this phone's full event history into discrete conversations.
    // startFreshSession (services/whatsappFlow.js) is the ONLY place that
    // ever logs an AWAITING_LANGUAGE event, and it runs at exactly every
    // conversation-start boundary (first-ever message, a TTL-expired
    // restart, or a mid-flow "hi"/"menu" reset) -- so each AWAITING_LANGUAGE
    // event marks where a new conversation begins. The `|| length === 0`
    // fallback only matters for a phone whose very first-ever logged event
    // predates that guarantee (shouldn't happen going forward, but avoids
    // silently dropping data if it ever does).
    const conversationBuckets = [];
    for (const ev of events) {
      if (ev.step === 'AWAITING_LANGUAGE' || conversationBuckets.length === 0) {
        conversationBuckets.push([]);
      }
      conversationBuckets[conversationBuckets.length - 1].push(ev);
    }

    const conversations = conversationBuckets
      .map((bucket) => {
        const last = bucket[bucket.length - 1];
        return {
          startedAt: bucket[0].enteredAt,
          lastStep: last.step,
          lastStepLabel: STEP_LABELS[last.step] || last.step,
          serviceLabel: last.serviceLabel,
          completed: bucket.some((ev) => ev.step === TERMINAL_STEP),
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt); // newest first

    const callRows = calls.map((c) => ({
      createdAt: c.createdAt,
      outcome: c.outcome,
      followUpAt: c.followUpAt,
      note: c.note,
      calledBy: c.calledBy?.name || null,
      tripId: c.tripId,
    }));

    const tripRows = trips.map((t) => ({
      tripNumber: t.tripNumber,
      createdAt: t.createdAt,
      status: t.status,
      // No field literally named "serviceType" on Trip -- mapped from the
      // actual field, selectedType (see models/index.js's own comment on
      // it: "Vehicle/service type id, matched against Pricing.serviceType").
      serviceType: t.selectedType,
      pickup: t.pickup,
      // No single "drop" field either -- Trip stores dropAddress/dropLat/
      // dropLng as separate top-level fields (dropHospital is a Hospital
      // ref, unrelated), assembled into one object here.
      drop: { address: t.dropAddress || null, lat: t.dropLat ?? null, lng: t.dropLng ?? null },
      // No single "fare" field -- grandTotal (final billed amount, set at
      // completion) when present, else estimatedFare (the booking-time
      // quote) for a trip that hasn't completed yet.
      fare: t.grandTotal ?? t.estimatedFare ?? null,
    }));

    const summary = {
      firstSeenAt: events[0]?.enteredAt || null,
      totalConversations: conversations.length,
      completedBookings: conversations.filter((c) => c.completed).length,
      totalTrips: trips.length,
      cancelledTrips: trips.filter((t) => t.status === 'cancelled').length,
      totalCallsMade: calls.length,
      lastOutcome: calls[0]?.outcome || null, // calls already sorted newest first
    };

    res.json({
      success: true,
      phone: normalized,
      summary,
      conversations,
      calls: callRows,
      trips: tripRows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
