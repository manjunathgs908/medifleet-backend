/**
 * utils/otp.js
 * ============================================================
 * One definition of what a login OTP is and when it is acceptable.
 *
 * Driver, owner and unified login each store the code on their own document
 * (User.otp / Owner.otp) rather than in a shared collection, which is why this
 * is a set of functions bound onto both schemas rather than a model. The point
 * is that the RULES live in one file: three copies of "is this code valid"
 * drift, and the one that drifts is the one that stops counting attempts.
 *
 * WHAT CHANGED AND WHY
 *
 * The codes were four digits with no attempt limit. Ten thousand possibilities
 * against an endpoint that answers all night is not a second factor, it is a
 * formality — a script walks the whole space in minutes. Six digits raises the
 * space, but the cap is what actually closes it: five wrong answers and the
 * code is dead, and getting a fresh one costs an SMS and is rate limited at the
 * route.
 *
 * Nothing here decides HTTP status codes or wording. checkOtp returns a reason
 * and each controller words it for its own audience.
 * ============================================================
 */
'use strict';

// Six digits, generated across the whole range. Building it as
// `1000 + random*9000` (the old four-digit form) can never produce a leading
// zero, which quietly discards a tenth of the space for nothing.
const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;

// Enough for a mistyped digit, not enough to search. The user asks for a new
// code after this, which costs an SMS and passes the route's rate limiter.
const MAX_OTP_ATTEMPTS = 5;

function generateOtp() {
  return String(Math.floor(Math.random() * 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

function otpExpiryFromNow() {
  return new Date(Date.now() + OTP_TTL_MS);
}

/**
 * Bound onto User and Owner as an instance method.
 *
 * @returns {{ok: true} | {ok: false, reason: 'expired'|'locked'|'invalid', attemptsRemaining?: number}}
 *
 * A wrong answer INCREMENTS the counter on `this`; the caller must save the
 * document, or the attempt is not spent and the cap means nothing. Order
 * matters: expiry before lock before comparison, so a correct code offered
 * after five wrong ones is still refused — that sequence is what a successful
 * search looks like, and it must not be rewarded.
 */
function checkOtp(candidate) {
  if (!this.otp || !this.otpExpiry) return { ok: false, reason: 'expired' };
  if (new Date(this.otpExpiry).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if ((this.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) return { ok: false, reason: 'locked' };

  if (this.otp !== String(candidate)) {
    this.otpAttempts = (this.otpAttempts || 0) + 1;
    return {
      ok: false,
      reason: 'invalid',
      attemptsRemaining: Math.max(0, MAX_OTP_ATTEMPTS - this.otpAttempts),
    };
  }
  return { ok: true };
}

/**
 * Spend the code. Called on success so a replay of the same value finds
 * nothing and is answered as expired rather than logging someone in twice.
 */
function clearOtp() {
  this.otp = undefined;
  this.otpExpiry = undefined;
  this.otpAttempts = 0;
}

/** Attach both methods and the attempts path to a schema. */
function applyOtpMethods(schema) {
  schema.add({ otpAttempts: { type: Number, default: 0, select: false } });
  schema.methods.checkOtp = checkOtp;
  schema.methods.clearOtp = clearOtp;
}

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  generateOtp,
  otpExpiryFromNow,
  checkOtp,
  clearOtp,
  applyOtpMethods,
};
