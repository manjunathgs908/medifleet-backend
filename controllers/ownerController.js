/**
 * controllers/ownerController.js
 * ============================================================
 * Fleet Owner registration + KYC — Phase 1 of the driver-auth redesign.
 *
 *   - OTP registration/login (reuses utils/smsService.sendOtp — same
 *     MSG91 integration the driver OTP flow uses)
 *   - KYC document upload (reuses utils/cloudinary.uploadToCloudinary)
 *   - actAsDriver: mints a driver token for the owner's own shadow
 *     driver identity, so a small owner-operator can drive their own
 *     fleet through the completely unmodified driver flow (start-duty,
 *     trips, location, logout-safety) — the one deliberate exception to
 *     "self-contained", since it needs the User model + authController's
 *     token-signing to produce a real driver session.
 * ============================================================
 */
'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const Owner  = require('../models/Owner');
const { User } = require('../models');
const { sendTokenResponse: sendDriverTokenResponse } = require('./authController');
const smsService = require('../utils/smsService');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { isTestOtpNumber, getTestOtpCode } = require('../utils/testOtp'); // TEMPORARY — REMOVE AFTER DLT APPROVAL

const ALLOWED_KYC_DOCS = ['aadhaar', 'pan', 'addressProof', 'photo'];

// ── Token factories ───────────────────────────────────────────
const signAccessToken = (ownerId) =>
  jwt.sign({ id: ownerId, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

const signRefreshToken = (ownerId) =>
  jwt.sign({ id: ownerId, role: 'owner' }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' });

const sendTokenResponse = async (owner, statusCode, res) => {
  const accessToken  = signAccessToken(owner._id);
  const refreshToken = signRefreshToken(owner._id);

  owner.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  owner.lastLogin    = Date.now();
  await owner.save({ validateBeforeSave: false });

  return res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    owner: {
      id         : owner._id,
      name       : owner.name,
      phone      : owner.phone,
      role       : 'owner',
      otpVerified: owner.otpVerified,
      kycStatus  : owner.kycStatus,
    },
  });
};


// ============================================================
// @route   POST /api/owners/send-otp
// @desc    Register a new Owner (first call for a phone) or resend an
//          OTP to an existing one. `name` is required only when the
//          phone hasn't been seen before.
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

    let owner = await Owner.findOne({ phone }).select('+otp +otpExpiry');
    if (!owner) {
      if (!name) {
        return res.status(400).json({ success: false, message: 'Name is required to register a new owner.' });
      }
      owner = new Owner({ phone, name });
    }

    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // TEMPORARY — REMOVE AFTER DLT APPROVAL. See utils/testOtp.js.
    // Whitelisted test numbers get a fixed OTP, no real SMS attempt.
    // testOtp is echoed back so the app can show/auto-fill it — safe
    // because this whole branch only runs for numbers already on the
    // whitelist, never a general echo of every OTP sent.
    if (isTestOtpNumber(phone)) {
      const testOtp = getTestOtpCode();
      owner.otp       = testOtp;
      owner.otpExpiry = otpExpiry;
      await owner.save({ validateBeforeSave: false });
      return res.json({ success: true, message: `OTP sent to ${phone}.`, testOtp });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    owner.otp       = otp;
    owner.otpExpiry = otpExpiry;
    await owner.save({ validateBeforeSave: false });

    // Send SMS via MSG91 (see utils/smsService.js)
    await smsService.sendOtp(phone, otp);

    // In development, return OTP in response for testing
    const devPayload = process.env.NODE_ENV === 'development' ? { otp } : {};

    return res.json({ success: true, message: `OTP sent to ${phone}.`, ...devPayload });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/owners/verify-otp
// @desc    Verify OTP and issue JWT tokens for the Owner
// @access  Public
// ============================================================
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });

    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +refreshToken');
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });

    if (!owner.isOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
    }

    owner.otp         = undefined;
    owner.otpExpiry   = undefined;
    owner.otpVerified = true;

    return sendTokenResponse(owner, 200, res);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/owners/me
// @desc    Return the current authenticated Owner's profile
// @access  Private [owner]
// ============================================================
exports.getMe = async (req, res) => {
  return res.json({ success: true, owner: req.user });
};


// ============================================================
// @route   POST /api/owners/kyc/upload
// @desc    Upload one KYC document (aadhaar/pan/addressProof/photo).
//          Auto-advances kycStatus from 'pending' to 'submitted'.
// @access  Private [owner]
// ============================================================
exports.uploadKycDocument = async (req, res, next) => {
  try {
    const { docType, base64 } = req.body;

    if (!ALLOWED_KYC_DOCS.includes(docType)) {
      return res.status(400).json({
        success: false,
        message: `docType must be one of: ${ALLOWED_KYC_DOCS.join(', ')}`,
      });
    }
    if (!base64) {
      return res.status(400).json({ success: false, message: 'base64 file data is required.' });
    }

    const result = await uploadToCloudinary(base64, `owners/${req.user._id}/kyc`);

    const owner = await Owner.findById(req.user._id);
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });

    owner.kycDocuments = owner.kycDocuments || {};
    owner.kycDocuments[docType] = { url: result.secure_url, uploadedAt: new Date() };
    if (owner.kycStatus === 'pending') owner.kycStatus = 'submitted';
    await owner.save();

    return res.json({
      success     : true,
      message     : 'Document uploaded.',
      kycDocuments: owner.kycDocuments,
      kycStatus   : owner.kycStatus,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/owners/act-as-driver
// @desc    Mints a normal driver token for this owner's own shadow
//          driver identity (role:'driver', isOwnerSelf:true,
//          approvalStatus:'approved' from creation — never goes through
//          the pending-approval gate). Find-or-create, then delegates
//          entirely to authController.sendTokenResponse — same token
//          shape a real driver login produces, so every existing
//          driver-flow endpoint (start-duty, trips, location,
//          logout-safety) needs zero changes to work for an owner
//          driving their own fleet.
// @access  Private [owner]
// ============================================================
exports.actAsDriver = async (req, res, next) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'deviceId is required.' });
    }

    let shadowDriver = await User.findOne({ owner: req.user._id, isOwnerSelf: true, role: 'driver' });

    if (!shadowDriver) {
      try {
        shadowDriver = await User.create({
          name          : req.user.name,
          phone         : req.user.phone,
          role          : 'driver',
          approvalStatus: 'approved', // implicitly approved to drive their own fleet — never pending
          owner         : req.user._id,
          isOwnerSelf   : true,
        });
      } catch (createErr) {
        if (createErr.code === 11000) {
          return res.status(409).json({
            success: false,
            message: 'A driver account already exists with your phone number. Contact support to link it.',
          });
        }
        throw createErr;
      }
    } else {
      // Keep the shadow record's name in sync if the owner's profile name changed.
      shadowDriver.name = req.user.name;
    }

    // Most recent "drive as myself" tap always wins — same unconditional
    // rebind rule real driver OTP login uses.
    shadowDriver.deviceId = deviceId;

    return sendDriverTokenResponse(shadowDriver, 200, res, deviceId);
  } catch (err) {
    next(err);
  }
};
