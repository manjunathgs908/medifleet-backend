/**
 * models/Ambulance.js
 * ============================================================
 * An ambulance owned by a fleet Owner, belonging to one of their Fleets.
 * `assignedDriver` references the *existing* `User` model (drivers) —
 * read-only reference, User schema itself is untouched.
 * Phase 1 of the driver-auth redesign — additive only.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const documentSchema = new Schema(
  {
    url       : { type: String },
    expiryDate: { type: Date },
  },
  { _id: false }
);

const ambulanceSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    fleet: { type: Schema.Types.ObjectId, ref: 'Fleet', required: true, index: true },

    registrationNumber: {
      type    : String,
      required: true,
      unique  : true,
      uppercase: true,
      trim    : true,
    },

    // Existing driver User doc — read-only reference, User model untouched.
    assignedDriver: { type: Schema.Types.ObjectId, ref: 'User' },

    deviceId: { type: String, trim: true }, // GPS/telematics hardware ID

    status: {
      type   : String,
      enum   : ['available', 'assigned', 'maintenance'],
      default: 'available',
    },

    documents: {
      rc       : documentSchema,
      insurance: documentSchema,
      fitness  : documentSchema,
      permit   : documentSchema,
      pollution: documentSchema,
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Ambulance', ambulanceSchema);
