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
 * almost line-for-line so behavior (test-OTP mode, device-binding,
 * new-owner registration) stays identical to those two untouched
 * endpoints — only the "which collection" decision is new.
 * ============================================================
 */
'use strict';

const { User } = require('../models');
const Owner = require('../models/Owner');
const smsService = require('../utils/smsService');
const { isTestOtpEnabled, getTestOtpCode } = require('../utils/testOtp'); // TEMPORARY — REMOVE once real MSG91 SMS is confirmed working
const { sendTokenResponse: issueDriverSession } = require('./authController');
const { issueOwnerSession } = require('./ownerController');

const PHONE_RE = /^[6-9]\d{9}$/;
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

async function sendOtpFor(doc, phone, res) {
  const otpExpiry = Date.now() + OTP_EXPIRY_MS;

  if (isTestOtpEnabled()) {
    const testOtp = getTestOtpCode();
    doc.otp       = testOtp;
    doc.otpExpiry = otpExpiry;
    await doc.save({ validateBeforeSave: false });
    return res.json({ success: true, message: `OTP sent to ${phone}.`, role: doc.constructor.modelName === 'Owner' ? 'owner' : 'driver', testOtp });
  }

  const otp = String(Math.floor(1000 + Math.random() * 9000));
  doc.otp       = otp;
  doc.otpExpiry = otpExpiry;
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
    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry');
    if (owner) return sendOtpFor(owner, phone, res);

    const driver = await User.findOne({ phone, isActive: true }).select('+otp +otpExpiry');
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

    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +refreshToken');
    if (owner) {
      if (!owner.isOtpValid(otp)) {
        return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
      }
      owner.otp         = undefined;
      owner.otpExpiry   = undefined;
      owner.otpVerified = true;
      return issueOwnerSession(owner, 200, res);
    }

    // No isActive filter here — matches authController.verifyOtp exactly
    // (it doesn't re-check isActive at verify time either).
    const driver = await User.findOne({ phone }).select('+otp +otpExpiry +refreshToken');
    if (driver) {
      if (!driver.isOtpValid(otp)) {
        return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
      }
      if (driver.role === 'driver') {
        if (!deviceId) {
          return res.status(400).json({ success: false, message: 'deviceId is required.' });
        }
        driver.deviceId = deviceId; // unconditional rebind, same as authController.verifyOtp
      }
      driver.otp       = undefined;
      driver.otpExpiry = undefined;
      return issueDriverSession(driver, 200, res, deviceId);
    }

    return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
  } catch (err) {
    next(err);
  }
};
