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
      enum   : ['pending', 'submitted', 'verified', 'rejected'],
      default: 'pending',
    },
    kycDocuments: {
      aadhaar     : kycDocSchema,
      pan         : kycDocSchema,
      addressProof: kycDocSchema,
      photo       : kycDocSchema,
    },
    kycRejectionReason: { type: String },

    isActive : { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

// ── Instance method: check if OTP is valid (same contract as User.isOtpValid) ──
ownerSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpiry > Date.now();
};

module.exports = mongoose.model('Owner', ownerSchema);
