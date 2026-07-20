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
const { AMBULANCE_SERVICE_TYPES } = require('../utils/ambulanceServiceTypes');

const SERVICE_TYPES = AMBULANCE_SERVICE_TYPES.map(o => o.serviceType);

// documents.pollution is the PUC (Pollution Under Control) certificate —
// key kept as `pollution` for consistency with the existing DOC_TYPES list
// in ambulanceController.js; only the owner-facing label says "PUC".
const documentSchema = new Schema(
  {
    url       : { type: String },
    publicId  : { type: String }, // Cloudinary public_id — for future delete/replace
    number    : { type: String }, // certificate/document number, optional
    expiryDate: { type: Date },
  },
  { _id: false }
);

const photoSchema = new Schema(
  {
    url     : { type: String, required: true },
    publicId: { type: String },
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

    // Vehicle type — see utils/ambulanceServiceTypes.js. serviceTypeLabel/
    // vehicleModel are derived server-side from that fixed lookup (not
    // owner-entered free text) so display strings stay consistent across
    // the fleet; both are null for HEARSE/FREEZER_BOX, which have no
    // single fixed vehicleModel.
    serviceType     : { type: String, enum: SERVICE_TYPES, required: true },
    serviceTypeLabel: { type: String },
    vehicleModel    : { type: String, enum: ['Maruti Eeco', 'Tempo Traveller', null], default: null },
    year            : { type: Number },

    photos: [photoSchema],

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
