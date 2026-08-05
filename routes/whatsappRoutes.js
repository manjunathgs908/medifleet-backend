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

module.exports = router;
