/**
 * controllers/paymentController.js
 * ============================================================
 * Razorpay integration for online trip payment. Deliberately NOT used
 * to gate booking/dispatch/completion — a trip completes exactly as it
 * always has regardless of payment status; this only drives the
 * OPTIONAL "Pay Online" action a customer can take once the bill exists
 * (see Trip.paymentPreference / trackTrip's bill breakdown, added
 * alongside this file in models/index.js + tripController.js).
 * Cash/manual-UPI collection (today's behavior, recorded via the
 * existing CRM billingController.recordPayment) is always available as
 * a fallback — this never blocks anything.
 *
 * Order-creation + client-side verify below are trip-keyed and PUBLIC
 * (same trust model as trackTrip/rateTrip/customerCancelTrip —
 * possession of the tripId is the only credential the customer app
 * has). The webhook (controllers/paymentWebhookController.js) is a
 * separate, account-wide, Razorpay-authenticated callback — see
 * routes/payments.js.
 * ============================================================
 */
'use strict';

const crypto   = require('crypto');
const Razorpay = require('razorpay');
const { Trip, Bill } = require('../models');

const getClient = () => new Razorpay({
  key_id    : process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Applies a verified/captured payment to a Bill exactly once — shared by
// both verifyPayment (below) and the webhook, since either one might
// arrive first (or, rarely, both — app confirms, then the webhook fires
// too as it's designed to). Idempotent on the Razorpay payment id: a
// second call is a silent no-op, not an error. It is recorded as a
// provider-verified receipt for the order's amount (the balance when the
// order was made) — added to what was already received, never overwriting
// it (services/payments.js).
const markBillPaidOnce = async (bill, { paymentId, orderId, amountPaise, capturedAt }) => {
  const { applyProviderPayment } = require('../services/payments');
  const order = orderOf(bill, orderId || bill.razorpayOrderId);
  return applyProviderPayment(bill, { paymentId, orderId: order?.orderId, amountPaise, orderAmountPaise: order?.amountPaise, capturedAt });
};
exports.markBillPaidOnce = markBillPaidOnce;

// One of this bill's Razorpay orders (every order made is kept: an older
// one can still be paid after a newer one replaced it). Bills from before
// the list existed have just razorpayOrderId / razorpayOrderAmountPaise.
function orderOf(bill, orderId) {
  if (!orderId) return null;
  const listed = (bill.razorpayOrders || []).find((o) => o.orderId === orderId);
  if (listed) return listed;
  if (bill.razorpayOrderId === orderId) {
    return { orderId, amountPaise: bill.razorpayOrderAmountPaise || Math.round(Number(bill.grandTotal) * 100), currency: 'INR' };
  }
  return null;
}
exports.orderOf = orderOf;
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;

// ============================================================
// @route   POST /api/trips/:id/payment/order
// @desc    Creates a Razorpay Order for a completed trip's bill.
//          Amount is always the server-computed bill.grandTotal —
//          never trusts a client-supplied amount.
// @access  Public
// ============================================================
exports.createOrder = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('billId');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status !== 'completed' || !trip.billId) {
      return res.status(400).json({ success: false, message: 'This trip does not have a bill yet.' });
    }

    const bill = trip.billId;
    // The balance still owed — not the whole bill — so an advance or a
    // part-payment already received is never charged again.
    const { balanceOf, requireIndexes, PaymentRefused } = require('../services/payments');
    try { await requireIndexes(); } catch (e) {
      if (e instanceof PaymentRefused) return res.status(503).json({ success: false, message: 'Online payment is unavailable right now — please try again shortly.' });
      throw e;
    }
    const { HospitalInvoice } = require('../models');
    const bal = balanceOf(bill, null, { onInvoice: !!(await HospitalInvoice.exists({ bills: bill._id })) });
    if (bal.state === 'waived' || bal.outstandingPaise <= 0) {
      return res.status(400).json({ success: false, message: 'This bill has already been paid.' });
    }
    if (bal.reconcile.length || bal.onHospitalInvoice) {
      return res.status(400).json({ success: false, message: 'This bill cannot be paid online right now — please contact us.' });
    }

    const order = await getClient().orders.create({
      amount  : bal.outstandingPaise, // paise
      currency: 'INR',
      receipt : trip.tripNumber,
      notes   : { tripId: trip._id.toString(), billId: bill._id.toString() },
    });

    // Kept alongside every earlier order (an atomic push, so two orders made
    // at once are both kept).
    await Bill.updateOne({ _id: bill._id }, {
      $set : { razorpayOrderId: order.id, razorpayOrderAmountPaise: order.amount },
      $push: { razorpayOrders: { orderId: order.id, amountPaise: order.amount, currency: order.currency, createdAt: new Date() } },
    });

    return res.json({
      success : true,
      orderId : order.id,
      amount  : order.amount,
      currency: order.currency,
      keyId   : process.env.RAZORPAY_KEY_ID, // public key — safe client-side; Key Secret never leaves the server
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/trips/:id/payment/verify
// @desc    Called by the app right after Razorpay's native checkout
//          succeeds. Verifies the HMAC-SHA256 signature server-side
//          before trusting anything the client claims — the standard
//          Razorpay Orders-API verification step. The webhook is a
//          backstop for the case this call never arrives (app crash,
//          network drop mid-payment).
// @access  Public
// ============================================================
exports.verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!isText(razorpay_order_id) || !isText(razorpay_payment_id) || !isText(razorpay_signature)) {
      return res.status(400).json({
        success: false,
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.',
      });
    }

    const trip = await Trip.findById(req.params.id).populate('billId');
    if (!trip || !trip.billId) return res.status(404).json({ success: false, message: 'Trip or bill not found.' });
    const bill = trip.billId;

    // Any order made for this bill — including one a newer order replaced.
    if (!orderOf(bill, razorpay_order_id)) {
      return res.status(400).json({ success: false, message: 'Order does not match this trip.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const valid = expectedSignature.length === razorpay_signature.length &&
      crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpay_signature));

    if (!valid) {
      return res.status(400).json({ success: false, message: 'Payment verification failed.' });
    }

    let updated;
    try {
      updated = await markBillPaidOnce(bill, { paymentId: razorpay_payment_id, orderId: razorpay_order_id });
    } catch (e) {
      // Not recorded yet (protections unconfirmed): the payment is genuine
      // and the webhook will record it once they are.
      if (e?.notReady) return res.status(202).json({ success: true, message: 'Payment received — it will be confirmed shortly.', pending: true });
      throw e;
    }

    return res.json({ success: true, message: 'Payment verified.', paymentStatus: updated?.paymentStatus || bill.paymentStatus });
  } catch (err) {
    next(err);
  }
};
