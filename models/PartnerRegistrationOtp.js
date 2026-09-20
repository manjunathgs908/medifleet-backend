/**
 * models/PartnerRegistrationOtp.js
 * ============================================================
 * Phone verification for partner (Owner) registration.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Every other OTP on this platform hangs off a document that already
 * exists — User.otp for a driver, Owner.otp for a returning owner. A
 * partner registering for the first time has neither, and the old code
 * solved that by creating the Owner up front and storing the code on it.
 * That is precisely the bug being removed: an unverified Owner row for any
 * number anyone typed. The code has to live somewhere that is not an
 * account, so it lives here and the Owner is created only after the code
 * is proven.
 *
 * WHY NOT REUSE CustomerOtp OR BookingOtp
 *
 * Same reasoning CustomerOtp gives for not reusing BookingOtp: both are
 * keyed on phone alone, so sharing one collection would let a code issued
 * for one door be spent at another. A customer-app login code must not be
 * redeemable for a partner account. Three flows, three collections, and
 * they cost nothing but a file each.
 *
 * TTL-indexed on otpExpiry, so records delete themselves with no cron —
 * which also means an abandoned registration leaves nothing behind.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Matches CustomerOtp. Enough tries for a mistyped digit, not enough to
// search a six-digit space: five wrong answers and this code is dead, and a
// fresh one costs an SMS, which is the friction a brute-force cannot pay.
const MAX_ATTEMPTS = 5;

const partnerRegistrationOtpSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    // Never selected by default — nothing outside the register handler has
    // any business reading the code, and a stray .find() must not put it in
    // a log line.
    otp      : { type: String, required: true, select: false },
    otpExpiry: { type: Date,   required: true },
    attempts : { type: Number, default: 0 },
  },
  { timestamps: true },
);

// The three failure modes a caller has to tell apart, because the message
// the partner reads differs for each: expired means "ask for another",
// locked means "asking again is the only way forward", wrong means "check
// the SMS".
partnerRegistrationOtpSchema.methods.isExpired = function () {
  return !this.otpExpiry || this.otpExpiry.getTime() <= Date.now();
};

partnerRegistrationOtpSchema.methods.isLocked = function () {
  return (this.attempts || 0) >= MAX_ATTEMPTS;
};

partnerRegistrationOtpSchema.methods.matches = function (candidate) {
  return typeof candidate === 'string' && this.otp === candidate;
};

partnerRegistrationOtpSchema.index({ otpExpiry: 1 }, { expireAfterSeconds: 0 });

partnerRegistrationOtpSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

module.exports = mongoose.model('PartnerRegistrationOtp', partnerRegistrationOtpSchema);
