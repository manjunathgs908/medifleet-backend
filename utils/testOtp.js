/**
 * utils/testOtp.js
 * ============================================================
 * TEMPORARY — REMOVE once real MSG91 SMS delivery is confirmed working
 * (currently blocked: DLT template category issue means MSG91 accepts
 * the send but the SMS doesn't reliably reach real numbers).
 *
 * Customer booking flow ONLY (controllers/tripController.js's
 * sendBookingOtp) — driver login and owner login always use real OTP now,
 * no bypass. While enabled AND the phone is in the TEST_OTP_NUMBERS
 * whitelist, the booking OTP path skips the real MSG91 call and uses one
 * fixed code. The code is echoed back in the send-otp response so the UI
 * can display/auto-fill it, since there's no real SMS to read it from.
 *
 * Controlled entirely by env vars — no code change needed to flip back:
 *   TEST_OTP_ENABLED = "true"          (unset/anything else = disabled, real MSG91 SMS)
 *   TEST_OTP_CODE     = "1234"          (optional, defaults to 1234)
 *   TEST_OTP_NUMBERS  = "8884092777,9845474037"  (comma-separated allowlist;
 *                        unset = no number qualifies — fails closed, not open)
 *
 * Deletion checklist once real SMS is confirmed working: delete this
 * file, remove the `if (isTestOtpEnabled() && isTestOtpNumber(phone))`
 * block in tripController.js, unset TEST_OTP_ENABLED/TEST_OTP_CODE/
 * TEST_OTP_NUMBERS on Render.
 * ============================================================
 */
'use strict';

function isTestOtpEnabled() {
  return process.env.TEST_OTP_ENABLED === 'true';
}

function getTestOtpCode() {
  return process.env.TEST_OTP_CODE || '1234';
}

// True only if `phone` is in the TEST_OTP_NUMBERS comma-separated
// allowlist. Unset TEST_OTP_NUMBERS means no number qualifies — fail
// closed, not open, so the bypass can never silently apply to every phone
// number again.
function isTestOtpNumber(phone) {
  const raw = process.env.TEST_OTP_NUMBERS;
  if (!raw) return false;
  const numbers = raw.split(',').map(n => n.trim()).filter(Boolean);
  return numbers.includes(String(phone));
}

module.exports = { isTestOtpEnabled, getTestOtpCode, isTestOtpNumber };
