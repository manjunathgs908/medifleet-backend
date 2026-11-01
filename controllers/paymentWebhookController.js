/**
 * controllers/paymentWebhookController.js
 * ============================================================
 * Razorpay webhook — an account-wide callback URL Razorpay calls
 * directly (not triggered by either app), authenticated by an
 * X-Razorpay-Signature header computed with a SEPARATE secret
 * (RAZORPAY_WEBHOOK_SECRET, set when the webhook is configured in the
 * Razorpay dashboard) — distinct from RAZORPAY_KEY_SECRET used for
 * order/payment verification in paymentController.js. Requires the raw
 * request body (see server.js's express.json({verify}) callback, which
 * stashes it on req.rawBody) since the HMAC must be computed over the
 * exact bytes Razorpay sent, not a re-serialized parsed object.
 *
 * This is a backstop, not the primary path — paymentController.
 * verifyPayment (called by the app right after checkout) already marks
 * bills paid in the normal case. This exists for when that call never
 * arrives (app crash, network drop). markBillPaidOnce is idempotent, so
 * it's safe if both fire.
 * ============================================================
 */
'use strict';

const crypto = require('crypto');
const { Bill } = require('../models');
const { markBillPaidOnce, orderOf } = require('./paymentController');
const { noteProviderIssue } = require('../services/payments');

exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature || !req.rawBody) {
      return res.status(400).json({ success: false, message: 'Missing signature or body.' });
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('hex');

    const valid = typeof signature === 'string' && expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

    if (!valid) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
    }

    // A captured payment is money taken. It is recorded as a receipt when it
    // matches one of a bill's orders in INR; anything else is kept as a
    // provider issue for the owner to review — never silently dropped.
    const event = req.body;
    if (event?.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity || {};
      const paymentId = typeof payment.id === 'string' ? payment.id : null;
      const orderId = typeof payment.order_id === 'string' ? payment.order_id : null;
      const amount = payment.amount;
      if (!paymentId) {
        console.error('Razorpay webhook: payment.captured without a payment id — ignored');
        return res.status(200).json({ success: true });
      }
      const issue = (reason, extra = {}) => noteProviderIssue({ paymentId, orderId, reason, amount, currency: payment.currency, ...extra });
      const bill = orderId ? await Bill.findOne({ $or: [{ 'razorpayOrders.orderId': orderId }, { razorpayOrderId: orderId }] }) : null;
      const order = bill && orderOf(bill, orderId);
      if (!bill || !order) {
        await issue('unknown_order');
      } else if (payment.currency !== 'INR' || (order.currency && order.currency !== 'INR')) {
        await issue('currency', { bill: bill._id });
      } else if (!Number.isInteger(amount) || amount <= 0) {
        await issue('bad_amount', { bill: bill._id });
      } else {
        const capturedAt = Number.isInteger(payment.created_at) ? new Date(payment.created_at * 1000) : undefined;
        await markBillPaidOnce(bill, { paymentId, orderId, amountPaise: amount, capturedAt });
        if (amount !== order.amountPaise) await issue('amount_differs_from_order', { bill: bill._id, detail: { orderAmountPaise: order.amountPaise } });
      }
    }

    // Always 200 quickly for events we handled — Razorpay retries on
    // non-2xx responses.
    return res.status(200).json({ success: true });
  } catch (err) {
    // 500 so Razorpay retries — safe since markBillPaidOnce is idempotent.
    console.error('Razorpay webhook error:', err);
    return res.status(500).json({ success: false, message: 'Webhook processing error.' });
  }
};
