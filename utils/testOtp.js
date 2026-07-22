/**
 * utils/testOtp.js
 * ============================================================
 * TEMPORARY — REMOVE once real MSG91 SMS delivery is confirmed working
 * (currently blocked: DLT template category issue means MSG91 accepts
 * the send but the SMS doesn't reliably reach real numbers).
 *
 * While enabled, every OTP path (website booking, driver login, owner
 * login) skips the real MSG91 call entirely and uses one fixed code for
 * EVERY phone number — no whitelist. The code is echoed back in the
 * send-otp response so each UI can display/auto-fill it, since there's
 * no real SMS to read it from.
 *
 * Controlled entirely by env vars — no code change needed to flip back:
 *   TEST_OTP_ENABLED = "true"   (unset/anything else = disabled, real MSG91 SMS)
 *   TEST_OTP_CODE    = "1234"   (optional, defaults to 1234)
 *
 * Deletion checklist once real SMS is confirmed working: delete this
 * file, remove the `if (isTestOtpEnabled())` block in tripController.js/
 * authController.js/ownerController.js, unset TEST_OTP_ENABLED/
 * TEST_OTP_CODE on Render.
 * ============================================================
 */
'use strict';

function isTestOtpEnabled() {
  return process.env.TEST_OTP_ENABLED === 'true';
}

function getTestOtpCode() {
  return process.env.TEST_OTP_CODE || '1234';
}

module.exports = { isTestOtpEnabled, getTestOtpCode };
