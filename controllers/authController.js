/**
 * controllers/authController.js
 * ============================================================
 * Handles all authentication flows:
 *   - Phone OTP login (primary — no password needed for drivers)
 *   - Password login (for Owner admin panel)
 *   - JWT access token + refresh token issuance
 *   - Token refresh endpoint
 *   - Logout
 *   - User registration (Owner only)
 * ============================================================
 */

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { User, Trip } = require('../models');
const Shift = require('../models/Shift');
const smsService = require('../utils/smsService');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { isTestOtpEnabled, getTestOtpCode } = require('../utils/testOtp'); // TEMPORARY — REMOVE once real MSG91 SMS is confirmed working

const DRIVER_DOC_TYPES = ['dl', 'aadhaar', 'photo'];

// ── Logout safety rule — ambulance operations, not a generic nicety.
// Live-checked every call (never a cached/stale flag): a driver on duty
// or mid-trip must not be logged out, voluntarily or by an owner's
// unbind-device. Does NOT apply to the DEVICE_MISMATCH forced kick
// (a new-phone login) — that's a distinct mechanism in protect()/refresh(),
// never routed through this check.
async function getDriverActiveDutyOrTripReason(driverId) {
  const activeShift = await Shift.findOne({ driver: driverId, status: { $in: ['active', 'break'] } });
  if (activeShift) return 'duty';

  const activeTrip = await Trip.findOne({ driver: driverId, status: { $in: ['dispatched', 'en_route'] } });
  if (activeTrip) return 'trip';

  return null;
}

// ── Token factories ───────────────────────────────────────────
// deviceId is embedded in BOTH tokens (undefined for non-driver logins,
// which JWT simply omits from the payload) so `protect`/`refresh` can
// reject a stale token the moment a different device rebinds — see the
// device-mismatch check in middleware/auth.js.
const signAccessToken = (userId, deviceId) =>
  jwt.sign({ id: userId, deviceId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

const signRefreshToken = (userId, deviceId) =>
  jwt.sign({ id: userId, deviceId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' });

// ── Standard success response with tokens ────────────────────
const sendTokenResponse = async (user, statusCode, res, deviceId) => {
  const accessToken  = signAccessToken(user._id, deviceId);
  const refreshToken = signRefreshToken(user._id, deviceId);

  // Persist hashed refresh token in DB for rotation verification
  user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  user.lastLogin    = Date.now();
  await user.save({ validateBeforeSave: false });

  const userPayload = {
    id          : user._id,
    name        : user.name,
    phone       : user.phone,
    role        : user.role,
    vehicleId   : user.vehicleId,
    availability: user.availability,
  };

  // Driver-onboarding fields the app's post-login gate (device check,
  // approval-pending screen, ambulance display) needs — only meaningful
  // for role:'driver', so kept off the response for everyone else.
  if (user.role === 'driver') {
    await user.populate('assignedAmbulanceId', 'registrationNumber status');
    userPayload.approvalStatus      = user.approvalStatus;
    userPayload.rejectionReason     = user.rejectionReason;
    userPayload.assignedAmbulanceId = user.assignedAmbulanceId;
    userPayload.driverDocuments     = user.driverDocuments;
    userPayload.deviceId            = user.deviceId;
    // Owner-acting-as-driver marker (see ownerController.actAsDriver) — lets
    // the app know to restore the owner session on end-duty instead of
    // staying in the normal driver flow.
    userPayload.isOwnerSelf         = !!user.isOwnerSelf;
  }

  return res.status(statusCode).json({
    success : true,
    accessToken,
    refreshToken,
    user: userPayload,
  });
};

// Reused by ownerController.actAsDriver to mint a normal driver token for
// an owner's own shadow driver identity — same token shape, same response
// shape, so every existing driver-flow endpoint needs zero changes.
exports.signAccessToken  = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.sendTokenResponse = sendTokenResponse;


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
// @desc    Generate & send 4-digit OTP via SMS (for driver login)
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

    const user = await User.findOne({ phone, isActive: true }).select('+otp +otpExpiry');
    if (!user) return res.status(404).json({ success: false, message: 'No active account found for this number.' });

    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // TEMPORARY — REMOVE once real MSG91 SMS is confirmed working. See
    // utils/testOtp.js. Every number gets the same fixed OTP, no real SMS
    // attempt — testOtp is echoed back so the app can show/auto-fill it.
    if (isTestOtpEnabled()) {
      const testOtp = getTestOtpCode();
      user.otp       = testOtp;
      user.otpExpiry = otpExpiry;
      await user.save({ validateBeforeSave: false });
      return res.json({ success: true, message: `OTP sent to ${phone}.`, testOtp });
    }

    // Generate 4-digit OTP
    const otp = String(Math.floor(1000 + Math.random() * 9000));

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
    const { phone, otp, deviceId } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });

    const user = await User.findOne({ phone }).select('+otp +otpExpiry +refreshToken');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.isOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
    }

    // Driver-only hardening — device binding is meaningless for
    // Owner password-based staff accounts, so scoped to
    // role:'driver' rather than applied blanket. Deliberately does NOT
    // block login on approvalStatus (Phase 1 did — corrected here): a
    // pending/rejected driver must still be able to log in to complete
    // onboarding (upload documents) or see their rejection reason and
    // re-submit. The actual privileged action — going on duty — is what's
    // gated on approvalStatus now, at POST /assignments/start-duty.
    if (user.role === 'driver') {
      if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required.' });
      }
      // Most recent OTP login always wins — unconditional rebind (unlike
      // the old PIN flow, which only bound once and then locked to it).
      user.deviceId = deviceId;
    }

    // Clear OTP after successful verification
    user.otp       = undefined;
    user.otpExpiry = undefined;

    return sendTokenResponse(user, 200, res, deviceId);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/auth/login
// @desc    Password login for Owner
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

    // A different device has since logged in and rebound deviceId — this
    // refresh token's device claim is now stale. Same check as protect().
    if (decoded.deviceId !== user.deviceId) {
      return res.status(401).json({
        success: false,
        code   : 'DEVICE_MISMATCH',
        message: 'Logged in on another device. Please log in again.',
      });
    }

    const newAccessToken = signAccessToken(user._id, user.deviceId);
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
// @desc    Invalidate refresh token (server-side logout). Blocked for a
//          driver who is on duty or has an active trip — ambulance
//          safety rule, not applicable to Owner sessions.
// @access  Private
// ============================================================
exports.logout = async (req, res, next) => {
  try {
    if (req.user.role === 'driver') {
      const reason = await getDriverActiveDutyOrTripReason(req.user._id);
      if (reason === 'duty') {
        return res.status(403).json({ success: false, message: 'You are on duty. Please end your duty before logging out.' });
      }
      if (reason === 'trip') {
        return res.status(403).json({ success: false, message: 'You have an active trip. Please complete it before logging out.' });
      }
    }

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
// @desc    Change own password (Owner)
// @access  Private [owner]
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

    // deviceId is now embedded in the token payload too (protect() checks
    // it) — kept here so a driver still on a pre-OTP-rollout app build
    // isn't falsely kicked by the new device-mismatch check on their very
    // next request; this endpoint itself is otherwise unchanged/deprecated.
    const accessToken  = signAccessToken(user._id, user.deviceId);
    const refreshToken = signRefreshToken(user._id, user.deviceId);
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
// @route   GET /api/driver-auth?approvalStatus=pending
// @desc    List drivers — Owner app's device-unbind tool and Pending
//          Drivers screen share this endpoint. Unscoped by owner (the
//          User schema has no owner/ownerId link — the driver-auth
//          system predates the multi-owner Ambulance/Fleet model and is
//          effectively single-tenant today), so every protectOwner-
//          authenticated Owner currently sees every driver in the system.
// @access  Private [owner] (protectOwner)
// ============================================================
exports.listDrivers = async (req, res, next) => {
  try {
    const { approvalStatus } = req.query;
    const filter = { role: 'driver', owner: req.user._id };
    if (approvalStatus) filter.approvalStatus = approvalStatus;

    const drivers = await User.find(filter)
      .select('name employeeId phone deviceId approvalStatus rejectionReason driverDocuments')
      .sort({ name: 1 });
    return res.json({ success: true, drivers });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/driver-auth/register
// @desc    Owner adds a new driver by name + phone, linked via owner:
//          req.user._id (the actual point of this endpoint — an owner
//          has no other way to create a driver record tied to their
//          fleet). employeeId is a legacy identifier from the old
//          Employee-ID + PIN login era; driver login is phone+OTP now,
//          so it's no longer meaningful to collect from the owner —
//          auto-generated here (DRV-001, DRV-002, ...) purely so
//          existing driver records that display/reference it keep
//          working. No PIN is set; PIN login isn't used by the app.
// @access  Private [owner] (protectOwner)
// ============================================================
exports.createDriverAccount = async (req, res, next) => {
  try {
    const { name, phone, assignedAmbulanceId } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'name and phone are required.' });
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    const existing = await User.findOne({ phone });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A driver with this phone number already exists.' });
    }

    const existingIds = await User.find({ employeeId: /^DRV-\d+$/ }).select('employeeId').lean();
    const maxNum = existingIds.reduce((max, d) => {
      const n = parseInt(d.employeeId.split('-')[1], 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const employeeId = `DRV-${String(maxNum + 1).padStart(3, '0')}`;

    const user = await User.create({
      employeeId,
      name,
      phone,
      role               : 'driver',
      approvalStatus     : 'pending',
      owner              : req.user._id, // links this driver to the Owner creating them (Phase 4 ambulance-picker scoping)
      assignedAmbulanceId: assignedAmbulanceId || undefined,
    });

    return res.status(201).json({
      success: true,
      message: 'Driver added. They can now log in with their phone number and complete onboarding.',
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
      { _id: req.params.id, role: 'driver', owner: req.user._id },
      { approvalStatus: 'approved', $unset: { rejectionReason: '' } },
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
      { _id: req.params.id, role: 'driver', owner: req.user._id },
      { approvalStatus: 'rejected', rejectionReason: reason || undefined },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    return res.json({
      success: true,
      message: 'Driver rejected.',
      driver : { id: user._id, employeeId: user.employeeId, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason },
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
    const driver = await User.findOne({ _id: req.params.id, role: 'driver', owner: req.user._id });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });

    // Same ambulance-safety rule as voluntary logout — an owner can't
    // force a driver off their device mid-duty/mid-trip either.
    const reason = await getDriverActiveDutyOrTripReason(driver._id);
    if (reason === 'duty') {
      return res.status(403).json({ success: false, message: "This driver is currently on duty and can't be logged out right now." });
    }
    if (reason === 'trip') {
      return res.status(403).json({ success: false, message: "This driver is on an active trip and can't be logged out right now." });
    }

    driver.deviceId = undefined;
    await driver.save({ validateBeforeSave: false });

    return res.json({ success: true, message: 'Device unbound. Driver can log in from a new device.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/driver-auth/documents
// @desc    Driver uploads their OWN onboarding document (dl/aadhaar/
//          photo) — same one-upload-per-call Cloudinary pattern as
//          ambulanceController.updateDocument. Re-submitting while
//          rejected flips approvalStatus back to 'pending' and clears
//          the rejection reason, so it naturally re-enters the owner's
//          Pending Drivers queue without a separate "resubmit" action.
// @access  Private [driver]
// ============================================================
exports.uploadDriverDocument = async (req, res, next) => {
  try {
    const { docType, base64, number, expiryDate } = req.body;

    if (!DRIVER_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ success: false, message: `docType must be one of: ${DRIVER_DOC_TYPES.join(', ')}` });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    // base64 is optional (matches ambulanceController.updateDocument's
    // pattern) — lets the app save just a number/expiry edit without
    // forcing a re-upload of the photo.
    const existing = user.driverDocuments?.[docType] || {};
    let { url, publicId } = existing;
    if (base64) {
      const result = await uploadToCloudinary(base64, `drivers/${user._id}/documents`);
      url      = result.secure_url;
      publicId = result.public_id;
    }

    user.driverDocuments = user.driverDocuments || {};
    user.driverDocuments[docType] = {
      url,
      publicId,
      number    : number !== undefined ? number : existing.number,
      expiryDate: expiryDate ? new Date(expiryDate) : existing.expiryDate,
      uploadedAt: base64 ? new Date() : existing.uploadedAt,
    };

    if (user.approvalStatus === 'rejected') {
      user.approvalStatus  = 'pending';
      user.rejectionReason = undefined;
    }

    await user.save({ validateBeforeSave: false });

    return res.json({
      success       : true,
      driverDocuments: user.driverDocuments,
      approvalStatus : user.approvalStatus,
    });
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
    const { lat, lng, status, pushToken } = req.body;

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

    // Piggybacked rather than a separate registration endpoint — this
    // call already fires every ~10s while on duty, so the token stays
    // fresh with zero extra requests from the driver app.
    if (pushToken) {
      update.pushToken = pushToken;
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