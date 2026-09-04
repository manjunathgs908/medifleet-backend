/**
 * models/CustomerOtp.js
 * ============================================================
 * Phone verification for the SaveLife customer app (savelife-app).
 *
 * A customer is not a User or an Owner document — the app has no account
 * record, only a verified phone number — so this is a small standalone,
 * phone-keyed record, the same shape BookingOtp uses for the website.
 *
 * WHY NOT REUSE BookingOtp
 *
 * BookingOtp is keyed on phone alone and is consumed by the website's
 * /api/trips/verify-otp. Sharing it would mean an OTP sent for an app login
 * could be spent by the website's verify call and the other way round: one
 * code, two doors. Two collections keep the two flows unable to interfere,
 * and cost nothing but a file.
 *
 * Unlike BookingOtp this one is a LOGIN credential — it ends in a JWT — so it
 * also counts attempts. A six-digit code is a million guesses in principle and
 * far fewer in practice against an endpoint that will answer all night.
 *
 * TTL-indexed on otpExpiry, so expired records delete themselves with no cron.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Enough tries for a mistyped digit, not enough to search the space. Five
// wrong answers and this code is dead: the customer asks for a new one, which
// costs an SMS and is exactly the friction a brute-force attempt cannot pay.
const MAX_ATTEMPTS = 5;

const customerOtpSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    // Never selected by default. Nothing outside verifyOtp has any business
    // reading the code, and a stray .find() must not put it in a log line.
    otp: { type: String, required: true, select: false },
    otpExpiry: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// The three failure modes a caller has to tell apart, because the message a
// customer reads differs for each: expired means "ask for another", locked
// means "asking again is the only way forward", wrong means "check the SMS".
customerOtpSchema.methods.isExpired = function () {
  return !this.otpExpiry || this.otpExpiry.getTime() <= Date.now();
};

customerOtpSchema.methods.isLocked = function () {
  return (this.attempts || 0) >= MAX_ATTEMPTS;
};

customerOtpSchema.methods.matches = function (candidate) {
  return typeof candidate === 'string' && this.otp === candidate;
};

// Auto-delete once otpExpiry has passed — no separate cleanup job needed.
customerOtpSchema.index({ otpExpiry: 1 }, { expireAfterSeconds: 0 });

customerOtpSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

module.exports = mongoose.model('CustomerOtp', customerOtpSchema);
