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
  // req.user (set by `protect`) doesn't populate refs — Driver Profile
  // Check / pre-go-online gate need assignedAmbulanceId's registrationNumber,
  // not just its raw id.
  const user = await req.user.populate('assignedAmbulanceId', 'registrationNumber status');
  return res.json({ success: true, user });
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


// ============================================================
// Phase 2 — Employee ID + PIN driver login (additive, alongside the
// existing phone+password loginPassword and OTP flows above, which
// are untouched). Mounted at /api/driver-auth (routes/driverAuth.js).
// ============================================================

// ============================================================
// @route   POST /api/driver-auth/login
// @desc    Employee ID + PIN login with device binding:
//            - blocked until approvalStatus === 'approved'
//            - first successful login binds req.body.deviceId
//            - subsequent logins must come from the bound device
// @access  Public
// ============================================================
exports.loginWithPin = async (req, res, next) => {
  try {
    const { employeeId, pin, deviceId } = req.body;
    if (!employeeId || !pin || !deviceId) {
      return res.status(400).json({ success: false, message: 'employeeId, pin and deviceId are required.' });
    }

    const user = await User.findOne({ employeeId }).select('+pin +refreshToken');
    if (!user || !user.pin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (user.approvalStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'Your account is pending approval.' });
    }

    if (user.deviceId && user.deviceId !== deviceId) {
      return res.status(403).json({
        success: false,
        message: 'This device is not registered for this ambulance. Contact Owner/Admin.',
      });
    }

    const isMatch = await user.comparePin(pin);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    // First successful login binds this device to the account.
    if (!user.deviceId) {
      user.deviceId = deviceId;
    }

    const accessToken  = signAccessToken(user._id);
    const refreshToken = signRefreshToken(user._id);
    user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
    user.lastLogin    = Date.now();
    await user.save({ validateBeforeSave: false });

    // Driver-onboarding flow (Device Verification / Driver Profile Check /
    // pre-go-online gate) needs approvalStatus, driverDocuments, and the
    // assigned Ambulance's registrationNumber — none of these were returned
    // by this endpoint before. assignedAmbulanceId is populated here (not
    // vehicleId) because it's the same field POST /assignments/start-duty
    // requires as ambulanceId; the Ambulance model has no `type`, only
    // `registrationNumber`.
    await user.populate('assignedAmbulanceId', 'registrationNumber status');

    return res.json({
      success: true,
      accessToken,
      refreshToken,
      pinChangeRequired: user.pinChangeRequired,
      user: {
        id                 : user._id,
        name               : user.name,
        phone              : user.phone,
        role               : user.role,
        employeeId         : user.employeeId,
        deviceId           : user.deviceId,
        vehicleId          : user.vehicleId,
        approvalStatus     : user.approvalStatus,
        assignedAmbulanceId: user.assignedAmbulanceId,
        driverDocuments    : user.driverDocuments,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/driver-auth/change-pin
// @desc    Change own PIN. Clears pinChangeRequired.
// @access  Private (protect)
// ============================================================
exports.changePin = async (req, res, next) => {
  try {
    const { oldPin, newPin } = req.body;
    if (!oldPin || !newPin) {
      return res.status(400).json({ success: false, message: 'oldPin and newPin are required.' });
    }

    const user = await User.findById(req.user._id).select('+pin');
    if (!user || !user.pin) {
      return res.status(400).json({ success: false, message: 'PIN login is not set up for this account.' });
    }

    const isMatch = await user.comparePin(oldPin);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current PIN is incorrect.' });
    }

    user.pin               = newPin; // re-hashed by the pin pre('save') hook
    user.pinChangeRequired = false;
    await user.save();

    return res.json({ success: true, message: 'PIN changed successfully.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/driver-auth
// @desc    List all Employee ID/PIN drivers — for the Owner app's
//          device-unbind tool. Unscoped by owner (the User schema has no
//          owner/ownerId link — the driver-auth system predates the
//          multi-owner Ambulance/Fleet model and is effectively
//          single-tenant today), so every protectOwner-authenticated
//          Owner currently sees every driver in the system.
// @access  Private [owner] (protectOwner)
// ============================================================
exports.listDrivers = async (req, res, next) => {
  try {
    const drivers = await User.find({ role: 'driver' })
      .select('name employeeId phone deviceId approvalStatus')
      .sort({ name: 1 });
    return res.json({ success: true, drivers });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/driver-auth/register
// @desc    Owner creates a new driver account for Employee ID + PIN
//          login. Starts as approvalStatus:'pending', pinChangeRequired:true.
// @access  Private [owner] (protectOwner)
// ============================================================
exports.createDriverAccount = async (req, res, next) => {
  try {
    const { employeeId, name, phone, tempPin, assignedAmbulanceId } = req.body;
    if (!employeeId || !name || !phone || !tempPin) {
      return res.status(400).json({ success: false, message: 'employeeId, name, phone and tempPin are required.' });
    }

    const existing = await User.findOne({ $or: [{ employeeId }, { phone }] });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A user with this employeeId or phone already exists.' });
    }

    const user = await User.create({
      employeeId,
      name,
      phone,
      role               : 'driver',
      pin                : tempPin,
      pinChangeRequired  : true,
      approvalStatus     : 'pending',
      assignedAmbulanceId: assignedAmbulanceId || undefined,
    });

    return res.status(201).json({
      success: true,
      message: 'Driver account created. Pending approval.',
      driver : {
        id            : user._id,
        employeeId    : user.employeeId,
        name          : user.name,
        phone         : user.phone,
        approvalStatus: user.approvalStatus,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/driver-auth/:id/approve
// @access  Private [owner] (protectOwner)
// ============================================================
exports.approveDriver = async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      { approvalStatus: 'approved' },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    return res.json({
      success: true,
      message: 'Driver approved.',
      driver : { id: user._id, employeeId: user.employeeId, approvalStatus: user.approvalStatus },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/driver-auth/:id/reject
// @access  Private [owner] (protectOwner)
// ============================================================
exports.rejectDriver = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      { approvalStatus: 'rejected' },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    return res.json({
      success: true,
      message: 'Driver rejected.',
      reason : reason || null,
      driver : { id: user._id, employeeId: user.employeeId, approvalStatus: user.approvalStatus },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/driver-auth/:id/unbind-device
// @desc    Clears deviceId so the driver can log in from a new device.
// @access  Private [owner] (protectOwner)
// ============================================================
exports.unbindDevice = async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'driver' },
      { $unset: { deviceId: '' } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    return res.json({ success: true, message: 'Device unbound. Driver can log in from a new device.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/driver-auth/location
// @desc    Driver updates their own current lat/lng + availability
//          status. Called periodically (every few seconds) from the
//          driver app while the app is in the foreground.
// @access  Private [driver] (protect)
// ============================================================
exports.updateLocation = async (req, res, next) => {
  try {
    const { lat, lng, status } = req.body;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ success: false, message: 'lat and lng (numbers) are required.' });
    }

    const update = {
      'availability.lat': lat,
      'availability.lng': lng,
      'availability.updatedAt': new Date(),
    };

    // status is optional — only update it if the driver app sent one
    if (status && ['available', 'on_trip', 'offline'].includes(status)) {
      update['availability.status'] = status;
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }

    return res.json({ success: true, availability: user.availability });
  } catch (err) {
    next(err);
  }
};