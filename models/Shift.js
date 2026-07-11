/**
 * models/Shift.js
 * ============================================================
 * A driver's duty period — tracks active/break/ended state and break
 * intervals so total working time can be computed on end.
 * Phase 3 of the driver-auth redesign — additive only.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const locationSchema = new Schema({ lat: Number, lng: Number }, { _id: false });

const breakSchema = new Schema(
  {
    startedAt: { type: Date },
    endedAt  : { type: Date },
  },
  { _id: false }
);

const shiftSchema = new Schema(
  {
    driver   : { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ambulance: { type: Schema.Types.ObjectId, ref: 'Ambulance' },

    status: {
      type   : String,
      enum   : ['active', 'break', 'ended'],
      default: 'active',
      index  : true,
    },

    shiftStart: { type: Date, default: Date.now },
    shiftEnd  : { type: Date },

    breaks: [breakSchema],

    totalWorkingMinutes: { type: Number }, // computed on end: shift duration minus total break time

    deviceId: { type: String, trim: true },

    loginLocation : locationSchema,
    logoutLocation: locationSchema,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Shift', shiftSchema);
