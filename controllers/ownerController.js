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
const PartnerRegistrationOtp = require('../models/PartnerRegistrationOtp');
const { User } = require('../models');
const { sendTokenResponse: sendDriverTokenResponse } = require('./authController');
const smsService = require('../utils/smsService');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { generateOtp, otpExpiryFromNow } = require('../utils/otp');

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

// Exported so controllers/unifiedAuthController.js can issue a real owner
// session without reimplementing owner token-signing — same function,
// just also reachable from outside this file (mirrors how this file
// already imports authController's own sendTokenResponse for actAsDriver).
exports.issueOwnerSession = sendTokenResponse;


// ============================================================
// @route   POST /api/owners/send-otp
// @desc    Send a login OTP to an Owner that already exists. Creates
//          nothing — registration is POST /api/owners/register.
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +otpAttempts');

    // An unknown number gets the SAME answer a known one does, and nothing
    // is created. Two separate reasons, both load-bearing:
    //
    //  1. Directory. A distinguishable response here turns this endpoint
    //     into a lookup: feed it numbers, keep the ones that come back
    //     different. authController.sendOtp already refuses to do that and
    //     this must match it.
    //  2. This used to `new Owner({ phone, name })` and save it below,
    //     BEFORE any code was verified — so anyone who could reach this
    //     route could mint a real Owner row for a number they do not own.
    //     Registration is now an explicit, OTP-verified act:
    //     POST /api/owners/register.
    //
    // The app never learns "not registered" from here. It shows Register as
    // Partner unconditionally, which needs no server signal at all.
    if (!owner) {
      return res.json({ success: true, message: `OTP sent to ${phone}.` });
    }

    const otpExpiry = otpExpiryFromNow();
    const otp = generateOtp();

    owner.otp         = otp;
    owner.otpExpiry   = otpExpiry;
    owner.otpAttempts = 0;   // a resend is a fresh start
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

    const owner = await Owner.findOne({ phone }).select('+otp +otpExpiry +otpAttempts +refreshToken');
    if (!owner) {
      return res.status(400).json({ success: false, code: 'OTP_INVALID', message: 'Incorrect code. Please request a new one.' });
    }

    // Distinct answers, because the action each calls for is different:
    // expired means ask for another, locked means asking again is the only
    // way forward, invalid means check the SMS and retype.
    const verdict = owner.checkOtp(otp);
    if (!verdict.ok) {
      await owner.save({ validateBeforeSave: false });   // spend the attempt
      if (verdict.reason === 'expired') {
        return res.status(410).json({ success: false, code: 'OTP_EXPIRED', message: 'This code has expired. Please request a new one.' });
      }
      if (verdict.reason === 'locked') {
        return res.status(429).json({ success: false, code: 'OTP_LOCKED', message: 'Too many incorrect attempts. Please request a new code.' });
      }
      const left = verdict.attemptsRemaining;
      return res.status(400).json({
        success: false, code: 'OTP_INVALID', attemptsRemaining: left,
        message: left > 0
          ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. Please request a new one.',
      });
    }

    // Spent on success, so replaying the same value finds nothing and is
    // answered as expired rather than issuing a second session.
    owner.clearOtp();
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
  // Same contract as the driver's /me: the server says what this session
  // may see. For an owner the flags describe their whole fleet — a partner
  // owner has no SaveLife payroll to show for any of their drivers, and
  // SaveLife's own owner does.
  const ours = Boolean(req.user.isPlatformOwner);

  return res.json({
    success : true,
    owner   : req.user,
    features: { attendance: ours, salary: ours },
  });
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

    // pending (no docs yet) -> submitted (awaiting review) on first upload;
    // rejected -> submitted (same "awaiting review" state) on any re-upload
    // after a rejection, same auto-resubmit pattern as
    // authController.uploadDriverDocument's approvalStatus flip.
    if (owner.kycStatus === 'pending' || owner.kycStatus === 'rejected') {
      owner.kycStatus = 'submitted';
      owner.kycRejectionReason = undefined;
    }
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

    // Look up by phone, not just owner+isOwnerSelf: `phone` is the actual
    // real-world link between this Owner and any pre-existing driver User
    // sharing that number — whether that's the shadow we minted last time,
    // a regular employee record the owner happens to share a phone with,
    // or a driver User that was self-registered before this Owner account
    // ever existed (phone comes first, Owner second — the reverse order).
    // Only a driver already claimed by a genuinely different Owner is a
    // real conflict; phone uniqueness means every other case is provably
    // the same real person.
    let shadowDriver = await User.findOne({ phone: req.user.phone, role: 'driver' });

    if (shadowDriver && shadowDriver.owner && shadowDriver.owner.toString() !== req.user._id.toString()) {
      return res.status(409).json({
        success: false,
        message: 'This phone number is linked to a driver account under a different fleet owner. Contact support to resolve.',
      });
    }

    if (!shadowDriver) {
      shadowDriver = await User.create({
        name          : req.user.name,
        phone         : req.user.phone,
        role          : 'driver',
        approvalStatus: 'approved', // implicitly approved to drive their own fleet — never pending
        owner         : req.user._id,
        isOwnerSelf   : true,
      });
    } else {
      // Link it as this owner's shadow identity instead of erroring —
      // backfills `owner` for the no-owner-yet case, and force-approves
      // it the same way a freshly created shadow would be, since it's
      // now provably the owner driving themselves.
      shadowDriver.name           = req.user.name;
      shadowDriver.owner          = req.user._id;
      shadowDriver.isOwnerSelf    = true;
      shadowDriver.approvalStatus = 'approved';
    }

    // Most recent "drive as myself" tap always wins — same unconditional
    // rebind rule real driver OTP login uses.
    shadowDriver.deviceId = deviceId;

    return sendDriverTokenResponse(shadowDriver, 200, res, deviceId);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// PARTNER REGISTRATION — the only place an Owner is ever created.
//
// Two steps on purpose. There is no Owner document yet, so the code cannot
// be stored on the account the way a returning owner's is; it lives in
// PartnerRegistrationOtp until it is spent. The Owner is written only after
// the code is proven, which is what stops an unverified row being created
// for a number the caller does not control — the bug this replaces.
// ============================================================

const PHONE_RE = /^[6-9]\d{9}$/;

// ============================================================
// @route   POST /api/owners/register/send-otp
// @desc    Send a verification code to a phone that wants to register.
// @access  Public (rate limited — sendOtpLimiter)
// ============================================================
exports.sendRegistrationOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone || !PHONE_RE.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    // An already-registered number is answered exactly like a new one, and
    // no code is sent to it. Saying "already registered" here would hand
    // back the directory lookup /send-otp was just cleaned of — this
    // endpoint is reachable by anyone. A partner who already has an account
    // gets where they are going by logging in.
    const existing = await Owner.findOne({ phone }).select('_id');
    if (existing) {
      return res.json({ success: true, message: `OTP sent to ${phone}.` });
    }

    const otp = generateOtp();

    // One live code per number: a resend replaces the previous record
    // rather than leaving several valid codes outstanding, and resets
    // attempts so a mistyped first code cannot lock a fresh one.
    await PartnerRegistrationOtp.findOneAndUpdate(
      { phone },
      { phone, otp, otpExpiry: otpExpiryFromNow(), attempts: 0 },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await smsService.sendOtp(phone, otp);

    const devPayload = process.env.NODE_ENV === 'development' ? { otp } : {};
    return res.json({ success: true, message: `OTP sent to ${phone}.`, ...devPayload });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/owners/register
// @desc    Verify the code and create the Owner at kycStatus 'pending'.
// @access  Public (rate limited — verifyLimiter)
// ============================================================
exports.register = async (req, res, next) => {
  try {
    const { phone, otp, name, businessName, gstin, pan, bankDetails } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({ success: false, message: 'Business name is required.' });
    }

    const record = await PartnerRegistrationOtp.findOne({ phone }).select('+otp');
    if (!record) {
      return res.status(400).json({ success: false, code: 'OTP_INVALID', message: 'Incorrect code. Please request a new one.' });
    }
    if (record.isExpired()) {
      return res.status(410).json({ success: false, code: 'OTP_EXPIRED', message: 'This code has expired. Please request a new one.' });
    }
    if (record.isLocked()) {
      return res.status(429).json({ success: false, code: 'OTP_LOCKED', message: 'Too many incorrect attempts. Please request a new code.' });
    }
    if (!record.matches(otp)) {
      record.attempts += 1;
      await record.save();
      const left = Math.max(0, PartnerRegistrationOtp.MAX_ATTEMPTS - record.attempts);
      return res.status(400).json({
        success: false,
        code   : 'OTP_INVALID',
        attemptsRemaining: left,
        message: left > 0
          ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. Please request a new one.',
      });
    }

    // Code proven. Note what is NOT read out of req.body: kycStatus and
    // isPlatformOwner. Both are a CRM admin's decision, never the
    // registrant's — spreading req.body here would let anyone register
    // themselves pre-approved and onto SaveLife's payroll.
    let owner;
    try {
      owner = await Owner.create({
        phone,
        name        : name.trim(),
        businessName: businessName.trim(),
        gstin       : gstin || undefined,
        pan         : pan || undefined,
        bankDetails : bankDetails ? {
          accountName  : bankDetails.accountName,
          accountNumber: bankDetails.accountNumber,
          ifsc         : bankDetails.ifsc,
          bankName     : bankDetails.bankName,
        } : undefined,
        kycStatus: 'pending',
      });
    } catch (err) {
      // phone carries a unique index, so two registrations racing the same
      // number end up here rather than creating a duplicate.
      if (err.code === 11000) {
        return res.status(409).json({ success: false, message: 'This number is already registered. Please log in instead.' });
      }
      // A bad GSTIN/PAN/IFSC shape arrives as a ValidationError. Report it
      // as a 400 naming the field rather than a 500.
      if (err.name === 'ValidationError') {
        const first = Object.values(err.errors)[0];
        return res.status(400).json({ success: false, message: first ? first.message : 'Invalid registration details.' });
      }
      throw err;
    }

    // Spend the code only once the Owner exists, so a failed create leaves
    // the partner able to retry with the same SMS.
    await PartnerRegistrationOtp.deleteOne({ _id: record._id });

    // No session is issued here. kycStatus is 'pending' and every owner
    // route worth reaching sits behind requireKycApproved anyway — the
    // partner logs in normally once an admin approves them, and sees their
    // own status through /api/owners/me until then.
    return res.status(201).json({
      success: true,
      message: 'Registration submitted. SaveLife will review and approve your account.',
      owner  : {
        id          : owner._id,
        name        : owner.name,
        businessName: owner.businessName,
        phone       : owner.phone,
        kycStatus   : owner.kycStatus,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// CRM ADMIN — Owner KYC review (medifleet-frontend, the platform admin's
// CRM, NOT the owner's own app). Distinct actor/session from everything
// above: these are gated by `protect, authorize('owner')` against the
// CRM's own User-model 'owner' role, not `protectOwner` — a completely
// separate login from the fleet-Owner OTP session used everywhere else
// in this file. One level up from authController's listDrivers/
// approveDriver/rejectDriver, which this deliberately mirrors.
// ============================================================

// ============================================================
// @route   GET /api/owners
// @desc    Every fleet Owner, for the CRM's Owners review page.
// @access  Private [CRM owner/admin]
// ============================================================
exports.listOwners = async (req, res, next) => {
  try {
    const owners = await Owner.find({})
      .select('name phone businessName gstin pan kycStatus kycDocuments kycRejectionReason isPlatformOwner createdAt')
      .sort({ createdAt: -1 });
    return res.json({ success: true, owners });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/owners/:id/approve
// @access  Private [CRM owner/admin]
// ============================================================
exports.approveOwner = async (req, res, next) => {
  try {
    const owner = await Owner.findByIdAndUpdate(
      req.params.id,
      { kycStatus: 'approved', $unset: { kycRejectionReason: '' } },
      { new: true }
    );
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });

    return res.json({
      success: true,
      message: 'Owner approved.',
      owner  : { id: owner._id, name: owner.name, phone: owner.phone, kycStatus: owner.kycStatus },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/owners/:id/reject
// @access  Private [CRM owner/admin]
// ============================================================
exports.rejectOwner = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const owner = await Owner.findByIdAndUpdate(
      req.params.id,
      { kycStatus: 'rejected', kycRejectionReason: reason || undefined },
      { new: true }
    );
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });

    return res.json({
      success: true,
      message: 'Owner rejected.',
      owner  : { id: owner._id, name: owner.name, phone: owner.phone, kycStatus: owner.kycStatus, kycRejectionReason: owner.kycRejectionReason },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/owners/:id/platform-owner
// @desc    Mark an Owner as SaveLife's own (or unmark it).
// @access  Private [CRM owner/admin]
//
// This decides whether the Owner's drivers are OUR employees. Attendance
// rows and payroll are written only for drivers under a platform Owner, so
// this flag is the difference between a driver we pay and a driver a
// partner pays.
//
// It lives here, behind `protect` (the CRM User session), and is reachable
// from nowhere else: it is not in the register handler's input list, and no
// protectOwner route writes it. An owner who could set it on themselves
// could move their own drivers onto SaveLife's payroll, which is why the
// check is structural — the field simply has no owner-session write path —
// rather than a validation somewhere that could be forgotten.
// ============================================================
exports.setPlatformOwner = async (req, res, next) => {
  try {
    const { isPlatformOwner } = req.body;
    if (typeof isPlatformOwner !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isPlatformOwner must be true or false.' });
    }

    const owner = await Owner.findByIdAndUpdate(
      req.params.id,
      { isPlatformOwner },
      { new: true },
    );
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });

    return res.json({
      success: true,
      message: isPlatformOwner
        ? 'Marked as a SaveLife-owned fleet. Its drivers now get attendance and payroll.'
        : 'Unmarked. Its drivers no longer get attendance or payroll.',
      owner: {
        id: owner._id, name: owner.name, phone: owner.phone, isPlatformOwner: owner.isPlatformOwner,
      },
    });
  } catch (err) {
    next(err);
  }
};
