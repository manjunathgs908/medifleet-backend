/**
 * utils/testOtp.js
 * ============================================================
 * TEMPORARY — REMOVE AFTER DLT APPROVAL.
 *
 * MSG91/DLT template approval is still pending, so real SMS delivery
 * is blocked in production. This lets a small whitelist of test phone
 * numbers log in (driver OR owner) with a fixed OTP instead of a real
 * SMS, so login can be tested end-to-end against the live backend.
 *
 * Controlled entirely by env vars — no code change needed to disable:
 *   TEST_OTP_ENABLED = "true"              (unset/anything else = disabled)
 *   TEST_OTP_NUMBERS = "8884092777,9000000099"  (comma-separated)
 *   TEST_OTP_CODE    = "123456"            (optional, defaults to 123456)
 *
 * Only whitelisted numbers get the fixed code — every other number
 * still goes through the real smsService.sendOtp() path unchanged
 * (and will still fail on DLT, which is expected and fine).
 *
 * Deletion checklist once DLT is approved: delete this file, remove
 * the two `if (isTestOtpNumber(...))` blocks in authController.js and
 * ownerController.js, unset TEST_OTP_ENABLED/TEST_OTP_NUMBERS/
 * TEST_OTP_CODE on Render.
 * ============================================================
 */
'use strict';

function isTestOtpEnabled() {
  return process.env.TEST_OTP_ENABLED === 'true';
}

function isTestOtpNumber(phone) {
  if (!isTestOtpEnabled()) return false;
  const whitelist = (process.env.TEST_OTP_NUMBERS || '')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);
  return whitelist.includes(String(phone));
}

function getTestOtpCode() {
  return process.env.TEST_OTP_CODE || '123456';
}

module.exports = { isTestOtpNumber, getTestOtpCode };
