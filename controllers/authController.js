/**
 * controllers/authController.js
 * ============================================================
 * Handles all authentication flows:
 *   - Phone OTP login (primary — no password needed for drivers)
 *   - Password login (for Owner / Telecaller admin panel)
 *   - JWT access token + refresh token issuance
 *   - Token refresh endpoint
 *   - Logout
 *   - User registration (Owner only)
 * ============================================================
 */

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { User } = require('../models');
const smsService = require('../utils/smsService');

// ── Token factories ───────────────────────────────────────────
const signAccessToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

const signRefreshToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' });

// ── Standard success response with tokens ────────────────────
const sendTokenResponse = async (user, statusCode, res) => {
  const accessToken  = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);

  // Persist hashed refresh token in DB for rotation verification
  user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  user.lastLogin    = Date.now();
  await user.save({ validateBeforeSave: false });

  return res.status(statusCode).json({
    success : true,
    accessToken,
    refreshToken,
    user: {
      id          : user._id,
      name        : user.name,
      phone       : user.phone,
      role        : user.role,
      vehicleId   : user.vehicleId,
      availability: user.availability,
    },
  });
};


// ============================================================
// @route   POST /api/auth/register
// @desc    Create a new user (Owner role only)
// @access  Private [owner]
// ============================================================
exports.register = async (req, res, next) => {
  try {
    const { name, phone, email, role, password, baseSalary, perTripBonus, vehicleId, shiftType } = req.body;

    const existing = await User.findOne({ phone });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Phone number already registered.' });
    }

    const user = await User.create({
      name, phone, email, role, password,
      baseSalary   : baseSalary   || 15000,
      perTripBonus : perTripBonus || 100,
      vehicleId, shiftType,
    });

    return res.status(201).json({
      success: true,
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} registered successfully.`,
      user   : { id: user._id, name: user.name, phone: user.phone, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/auth/send-otp
// @desc    Generate & send 6-digit OTP via SMS (for driver login)
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

    const user = await User.findOne({ phone, isActive: true }).select('+otp +otpExpiry');
    if (!user) return res.status(404).json({ success: false, message: 'No active account found for this number.' });

    // Generate 6-digit OTP
    const otp       = String(Math.floor(100000 + Math.random() * 900000));
    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    user.otp       = otp;
    user.otpExpiry = otpExpiry;
    await user.save({ validateBeforeSave: false });

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
// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and issue JWT tokens
// @access  Public
// ============================================================
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });

    const user = await User.findOne({ phone }).select('+otp +otpExpiry +refreshToken');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.isOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
    }

    // Clear OTP after successful verification
    user.otp       = undefined;
    user.otpExpiry = undefined;

    return sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/auth/login
// @desc    Password login for Owner / Telecaller
// @access  Public
// ============================================================
exports.loginPassword = async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password are required.' });
    }

    const user = await User.findOne({ phone }).select('+password +refreshToken');
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    return sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/auth/refresh
// @desc    Exchange a valid refresh token for a new access token
// @access  Public
// ============================================================
exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token required.' });
    }

    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const hashedToken = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const user = await User.findOne({ _id: decoded.id, refreshToken: hashedToken }).select('+refreshToken');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Refresh token is invalid or has been revoked.' });
    }

    const newAccessToken = signAccessToken(user._id);
    return res.json({ success: true, accessToken: newAccessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Refresh token expired. Please log in again.' });
    }
    next(err);
  }
};


// ============================================================
// @route   POST /api/auth/logout
// @desc    Invalidate refresh token (server-side logout)
// @access  Private
// ============================================================
exports.logout = async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $unset: { refreshToken: '' } });
    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/auth/me
// @desc    Return current authenticated user profile
// @access  Private
// ============================================================
exports.getMe = async (req, res) => {
  return res.json({ success: true, user: req.user });
};


// ============================================================
// @route   PUT /api/auth/update-password
// @desc    Change own password (Owner / Telecaller)
// @access  Private [owner, telecaller]
// ============================================================
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    next(err);
  }
};
