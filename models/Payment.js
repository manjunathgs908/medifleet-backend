'use strict';
/**
 * models/Payment.js
 * ============================================================
 * One receipt: money actually received for a trip. Not a second balance —
 * the trip's Bill (models/index.js) stays the invoice, and its paidAmount /
 * paymentStatus stay the figures every screen reads. Each receipt is
 * written in the same transaction that updates the Bill
 * (services/payments.js), so the Bill's paidAmount is always the sum of
 * its receipts (bills paid before receipts existed keep their paidAmount
 * and are shown as "not itemised").
 *
 * An advance is a receipt taken before the trip has a bill. When the trip
 * completes, its advances are counted into the new bill's paidAmount once
 * and linked to it — never added again.
 *
 * Receipts are never edited or deleted. A mistake needs a correction
 * process (not in this version — see the release notes).
 * ============================================================
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;

const METHODS = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', online: 'Online (Razorpay)' };

const paymentSchema = new Schema(
  {
    receiptNumber: { type: String, required: true, unique: true }, // RCT/2026-27/000001
    trip  : { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    bill  : { type: Schema.Types.ObjectId, ref: 'Bill', index: true }, // unset for an advance until the trip is billed
    kind  : { type: String, enum: ['advance', 'payment'], required: true },

    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    method     : { type: String, enum: Object.keys(METHODS), required: true },
    reference  : { type: String, trim: true },  // UPI ref / bank UTR / gateway payment id
    receivedAt : { type: Date, required: true }, // when the money was received (may be before recordedAt)
    note       : { type: String, trim: true },

    // Who vouches for it: a staff member's word, or the payment provider's
    // signed confirmation.
    verification: { type: String, enum: ['staff_recorded', 'provider_verified'], required: true },
    recordedBy    : { type: Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String },
    provider: {
      name     : String, // 'razorpay'
      paymentId: String,
      orderId  : String,
      orderAmountPaise: Number, // what the order asked for; amountPaise is what was captured
    },

    // The form's one-time key: a double click or a retry of the same
    // submission finds this receipt instead of recording a second one.
    requestId: { type: String },
  },
  { timestamps: { createdAt: 'recordedAt', updatedAt: false } },
);

paymentSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
paymentSchema.index({ 'provider.paymentId': 1 }, { unique: true, partialFilterExpression: { 'provider.paymentId': { $type: 'string' } } });
// A UPI reference / bank UTR / gateway payment id is one payment: the same
// one can't be recorded twice, even by two people at once. (Cash has no
// reference.)
paymentSchema.index({ method: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
paymentSchema.index({ receivedAt: -1 });

paymentSchema.set('toJSON', {
  transform(doc, ret) {
    ret.amount = ret.amountPaise / 100;
    ret.methodLabel = METHODS[ret.method] || ret.method;
    delete ret.requestId;
    return ret;
  },
});

// Receipt number sequence, one per Indian financial year.
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });

// A provider payment that could not simply be recorded as a receipt — its
// order matches no bill, the currency is not INR, or the captured amount
// differs from what was recorded. Money was (or may have been) taken, so it
// is kept here for the owner to review instead of being dropped.
const issueSchema = new Schema(
  {
    provider : { type: String, required: true },   // 'razorpay'
    paymentId: { type: String, required: true },
    orderId  : String,
    reason   : { type: String, required: true },   // unknown_order | currency | amount_differs_from_recorded | bad_amount
    amount   : Number,                             // smallest currency unit, as the provider sent it
    currency : String,
    bill     : { type: Schema.Types.ObjectId, ref: 'Bill' },
    payment  : { type: Schema.Types.ObjectId, ref: 'Payment' },
    detail   : Schema.Types.Mixed,
    resolvedAt: Date,
  },
  { timestamps: true },
);
issueSchema.index({ provider: 1, paymentId: 1, reason: 1 }, { unique: true });

const Payment = mongoose.model('Payment', paymentSchema);
Payment.Counter = mongoose.model('PaymentReceiptCounter', counterSchema);
Payment.Issue = mongoose.model('ProviderPaymentIssue', issueSchema);
Payment.METHODS = METHODS;
module.exports = Payment;
