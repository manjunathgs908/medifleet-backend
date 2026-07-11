/**
 * models/Assignment.js
 * ============================================================
 * Links one driver to one ambulance for the duration of a duty period.
 * Phase 3 of the driver-auth redesign — additive only, sits on top of
 * the Phase 1 Ambulance model and the existing User (driver) model.
 * At most one active Assignment may exist per ambulance and per driver
 * at any time — enforced in controllers/assignmentController.js.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const locationSchema = new Schema({ lat: Number, lng: Number }, { _id: false });

const assignmentSchema = new Schema(
  {
    driver   : { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ambulance: { type: Schema.Types.ObjectId, ref: 'Ambulance', required: true, index: true },

    active: { type: Boolean, default: true, index: true },

    startTime: { type: Date, default: Date.now },
    endTime  : { type: Date },

    startLocation: locationSchema,
    endLocation  : locationSchema,

    deviceId: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Assignment', assignmentSchema);
