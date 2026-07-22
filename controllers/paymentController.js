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
const { Trip } = require('../models');

const getClient = () => new Razorpay({
  key_id    : process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Applies a verified/captured payment to a Bill exactly once — shared by
// both verifyPayment (below) and the webhook, since either one might
// arrive first (or, rarely, both — app confirms, then the webhook fires
// too as it's designed to). Idempotent: a second call on an
// already-paid bill is a silent no-op, not an error.
const markBillPaidOnce = async (bill, { paymentId }) => {
  if (bill.paymentStatus === 'paid') return bill;
  bill.paidAmount        = bill.grandTotal;
  bill.paymentMode       = 'online';
  bill.paymentStatus     = 'paid';
  bill.paidAt            = new Date();
  bill.razorpayPaymentId = paymentId;
  await bill.save();
  return bill;
};
exports.markBillPaidOnce = markBillPaidOnce;

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
    if (bill.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'This bill has already been paid.' });
    }

    const order = await getClient().orders.create({
      amount  : Math.round(bill.grandTotal * 100), // paise
      currency: 'INR',
      receipt : trip.tripNumber,
      notes   : { tripId: trip._id.toString(), billId: bill._id.toString() },
    });

    bill.razorpayOrderId = order.id;
    await bill.save();

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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.',
      });
    }

    const trip = await Trip.findById(req.params.id).populate('billId');
    if (!trip || !trip.billId) return res.status(404).json({ success: false, message: 'Trip or bill not found.' });
    const bill = trip.billId;

    if (bill.razorpayOrderId !== razorpay_order_id) {
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

    await markBillPaidOnce(bill, { paymentId: razorpay_payment_id });

    return res.json({ success: true, message: 'Payment verified.', paymentStatus: bill.paymentStatus });
  } catch (err) {
    next(err);
  }
};
