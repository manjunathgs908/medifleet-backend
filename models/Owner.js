/**
 * models/Owner.js
 * ============================================================
 * Fleet Owner — Phase 1 of the driver-auth redesign.
 *
 * Distinct from the existing `User` model's role:'owner' (internal
 * MediFleet CRM staff). This `Owner` represents an external fleet/vendor
 * who self-registers via OTP, completes KYC, and manages their own
 * Fleets and Ambulances. Additive only — does not touch `User`.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const kycDocSchema = new Schema(
  {
    url       : { type: String },
    uploadedAt: { type: Date },
  },
  { _id: false }
);

const ownerSchema = new Schema(
  {
    name : { type: String, required: [true, 'Name is required'], trim: true },
    phone: {
      type    : String,
      required: [true, 'Phone number is required'],
      unique  : true,
      match   : [/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'],
    },

    // ── OTP auth state (mirrors User's OTP pattern) ──────────
    otp         : { type: String, select: false },
    otpExpiry   : { type: Date,   select: false },
    otpVerified : { type: Boolean, default: false },
    refreshToken: { type: String, select: false },

    // ── KYC ────────────────────────────────────────────────────
    kycStatus: {
      type   : String,
      enum   : ['pending', 'submitted', 'approved', 'rejected'],
      default: 'pending',
    },
    kycDocuments: {
      aadhaar     : kycDocSchema,
      pan         : kycDocSchema,
      addressProof: kycDocSchema,
      photo       : kycDocSchema,
    },
    kycRejectionReason: { type: String },

    // ── Business identity, collected at registration ───────────
    // Only businessName is required: a single-ambulance operator often has
    // neither a GST registration nor a registered trade name, and refusing
    // to onboard them would be refusing the common case. GST/PAN are
    // uppercased and shape-checked but never treated as proof of anything —
    // verification is the CRM admin's job during KYC review.
    businessName: { type: String, trim: true },
    gstin: {
      type: String, trim: true, uppercase: true,
      match: [/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN'],
    },
    pan: {
      type: String, trim: true, uppercase: true,
      match: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid 10-character PAN'],
    },

    // ── Payout destination ─────────────────────────────────────
    // Held for the commission/payout phase. `select: false` on the account
    // number because it is the one field here that is worth stealing and
    // nothing in the app or CRM needs it on a list screen — a payout run
    // will select it explicitly.
    bankDetails: {
      accountName  : { type: String, trim: true },
      accountNumber: { type: String, trim: true, select: false },
      ifsc         : { type: String, trim: true, uppercase: true,
                       match: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid 11-character IFSC'] },
      bankName     : { type: String, trim: true },
    },

    // ── Platform ownership ─────────────────────────────────────
    // True for SaveLife's own Owner record and nothing else.
    //
    // This is the switch that decides whether a driver is OUR employee or a
    // partner's. Attendance rows and payroll are only ever written for
    // drivers under a platform Owner: a partner pays their own drivers, and
    // computing a salary for someone we do not employ would be inventing a
    // liability.
    //
    // Settable ONLY by a CRM admin (protect + authorize('owner'), the User
    // session) via PUT /api/owners/:id/platform-owner. It is stripped from
    // registration input and from every Owner-session write path, because an
    // owner who could set it on themselves could put their own drivers on
    // SaveLife's payroll.
    isPlatformOwner: { type: Boolean, default: false },

    isActive : { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

// ── Instance method: check if OTP is valid (same contract as User.isOtpValid) ──
ownerSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpiry > Date.now();
};

// Adds otpAttempts plus checkOtp()/clearOtp(). Same rules as User, from the
// same file, so the two cannot drift — see utils/otp.js.
require('../utils/otp').applyOtpMethods(ownerSchema);

module.exports = mongoose.model('Owner', ownerSchema);
