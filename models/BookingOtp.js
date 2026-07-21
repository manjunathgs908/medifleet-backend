/**
 * models/BookingOtp.js
 * ============================================================
 * Phone verification for the website's booking form (savelife-web) —
 * a website visitor isn't a User/Owner/Trip document at OTP time, so
 * this is a small standalone, phone-keyed record rather than living on
 * an existing model. One doc per phone (upserted on each send-otp call);
 * TTL-indexed on otpExpiry so expired records clean themselves up with
 * no cron job.
 *
 * Verification itself is enforced client-side in BookForm.js (the
 * "Book" call only fires from the OTP-verify success callback) — this
 * intentionally does NOT gate Trip creation server-side, since
 * POST /api/trips is also used by the CRM/telecaller flow and the
 * customer app, neither of which go through phone-OTP verification.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const bookingOtpSchema = new Schema(
  {
    phone    : { type: String, required: true, index: true },
    otp      : { type: String, required: true },
    otpExpiry: { type: Date, required: true },
  },
  { timestamps: true }
);

bookingOtpSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpiry > Date.now();
};

// Auto-delete once otpExpiry has passed — no separate cleanup job needed.
bookingOtpSchema.index({ otpExpiry: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('BookingOtp', bookingOtpSchema);
