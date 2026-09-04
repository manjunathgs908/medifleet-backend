/**
 * controllers/unifiedAuthController.js
 * ============================================================
 * Single phone-only login for the app — replaces LoginScreen's old
 * Driver/Owner tab selection. The backend, not the user, decides which
 * collection a phone belongs to:
 *   - Owner exists                    -> owner session
 *   - No Owner, active driver exists  -> driver session
 *   - Neither exists                  -> register a new Owner (name required)
 *   - Both exist                      -> Owner wins (they can still act as
 *     their own driver via the existing actAsDriver flow)
 *
 * Deliberately a separate file rather than added to authController.js or
 * ownerController.js: those two already have a one-way require
 * (ownerController imports authController.sendTokenResponse for
 * actAsDriver) — making authController require back from ownerController
 * would create a real circular dependency. This file sits above both and
 * reuses their existing token-issuing functions instead of reimplementing
 * them; the send-otp/verify-otp bodies below intentionally mirror
 * authController.sendOtp/verifyOtp and ownerController.sendOtp/verifyOtp
 * almost line-for-line so behavior (test-OTP allowlist, device-binding,
 * new-owner registration) stays identical to those two untouched
 * endpoints — only the "which collection" decision is new.
 * ============================================================
 */
'use strict';

const { User } = require('../models');
const Owner = require('../models/Owner');
const smsService = require('../utils/smsService');
const { generateOtp, otpExpiryFromNow } = require('../utils/otp');
const { sendTokenResponse: issueDriverSession } = require('./authController');
const { issueOwnerSession } = require('./ownerController');

const PHONE_RE = /^[6-9]\d{9}$/;
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * One wording for a failed verification, whichever collection the code was
 * issued on. Distinct answers because the action each calls for differs:
 * expired means ask for another, locked means asking again is the only way
 * forward, invalid means check the SMS and retype.
 */
function otpFailure(res, verdict) {
  if (verdict.reason === 'expired') {
    return res.status(410).json({ success: false, code: 'OTP_EXPIRED', message: 'This code has expired. Please request a new one.' });
  }
  if (verdict.reason === 'locked') {
    return res.status(429).json({ success: false, code: 'OTP_LOCKED', message: 'Too many incorrect attempts. Please request a new code.' });
  }
  const left = verdict.attemptsRemaining;
  return res.status(400).json({
    success: false,
    code: 'OTP_INVALID',
    attemptsRemaining: left,
    message: left > 0
      ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
      : 'Incorrect code. Please request a new one.',
  });
}

async function sendOtpFor(doc, phone, res) {
  const otpExpiry = otpExpiryFromNow();
  const otp = generateOtp();

  doc.otp         = otp;
  doc.otpExpiry   = otpExpiry;
  doc.otpAttempts = 0;   // a resend is a fresh start
  await doc.save({ validateBeforeSave: false });

  await smsService.sendOtp(phone, otp);

  const devPayload = process.env.NODE_ENV === 'development' ? { otp } : {};
  return res.json({
    success: true,
    message: `OTP sent to ${phone}.`,
    role: doc.constructor.modelName === 'Owner' ? 'owner' : 'driver',
    ...devPayload,
  });
}

// ============================================================
// @route   POST /api/auth/unified-send-otp
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    // Owner checked first — priority when a phone matches both.
    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +otpAttempts');
    if (owner) return sendOtpFor(owner, phone, res);

    const driver = await User.findOne({ phone, isActive: true }).select('+otp +otpExpiry +otpAttempts');
    if (driver) return sendOtpFor(driver, phone, res);

    // Neither exists — same "brand new -> register as Owner" path
    // ownerController.sendOtp already has, just reached without a tab.
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required to register a new owner.' });
    }
    const newOwner = new Owner({ phone, name });
    return sendOtpFor(newOwner, phone, res);
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/auth/unified-verify-otp
// @desc    No `role` needed from the client — re-checks Owner-then-User
//          with the same priority order sendOtp used, so the OTP is
//          always validated against whichever collection it was actually
//          issued on.
// @access  Public
// ============================================================
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp, deviceId } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });

    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +otpAttempts +refreshToken');
    if (owner) {
      const verdict = owner.checkOtp(otp);
      if (!verdict.ok) {
        await owner.save({ validateBeforeSave: false });   // spend the attempt
        return otpFailure(res, verdict);
      }
      // Spent on success, so a replay of the same value finds nothing and is
      // answered as expired rather than issuing a second session.
      owner.clearOtp();
      owner.otpVerified = true;
      return issueOwnerSession(owner, 200, res);
    }

    // No isActive filter here — matches authController.verifyOtp exactly
    // (it doesn't re-check isActive at verify time either).
    const driver = await User.findOne({ phone }).select('+otp +otpExpiry +otpAttempts +refreshToken');
    if (driver) {
      const verdict = driver.checkOtp(otp);
      if (!verdict.ok) {
        await driver.save({ validateBeforeSave: false });
        return otpFailure(res, verdict);
      }
      if (driver.role === 'driver') {
        if (!deviceId) {
          return res.status(400).json({ success: false, message: 'deviceId is required.' });
        }
        driver.deviceId = deviceId; // unconditional rebind, same as authController.verifyOtp
      }
      driver.clearOtp();
      return issueDriverSession(driver, 200, res, deviceId);
    }

    // Unknown number. The same answer a wrong code gets, so verify cannot be
    // used to tell which numbers have accounts.
    return res.status(400).json({
      success: false, code: 'OTP_INVALID', message: 'Incorrect code. Please request a new one.',
    });
  } catch (err) {
    next(err);
  }
};
