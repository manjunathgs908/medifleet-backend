/**
 * models/Fleet.js
 * ============================================================
 * A named grouping of Ambulances under one Owner.
 * Phase 1 of the driver-auth redesign — additive only.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const fleetSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    name : { type: String, required: [true, 'Fleet name is required'], trim: true },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Fleet', fleetSchema);
