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
    // No index:true here — the partial unique indexes below already cover
    // both fields for this schema's actual query patterns (always filtered
    // on active:true); declaring both raised a "duplicate schema index" warning.
    driver   : { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ambulance: { type: Schema.Types.ObjectId, ref: 'Ambulance', required: true },

    active: { type: Boolean, default: true, index: true },

    startTime: { type: Date, default: Date.now },
    endTime  : { type: Date },

    startLocation: locationSchema,
    endLocation  : locationSchema,

    deviceId: { type: String, trim: true },
  },
  { timestamps: true }
);

// Partial unique indexes — the actual concurrency guarantee (not just the
// findOne-then-create pre-checks in the controller, which can race: two
// concurrent start-duty calls could both pass a findOne check before
// either write lands). Only one *active* Assignment can exist per
// ambulance, and per driver, at a time; ended (active:false) history
// rows are excluded via partialFilterExpression so they never collide.
assignmentSchema.index({ ambulance: 1 }, { unique: true, partialFilterExpression: { active: true } });
assignmentSchema.index({ driver: 1 }, { unique: true, partialFilterExpression: { active: true } });

module.exports = mongoose.model('Assignment', assignmentSchema);
