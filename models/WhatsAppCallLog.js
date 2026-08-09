'use strict';
const mongoose = require('mongoose');

// Permanent record of every ops call-back attempt against a WhatsApp
// conversation -- one row per call, never updated or deleted. Distinct from
// WhatsAppFunnelEvent (the bot's own step transitions) and WhatsAppLead
// (dead-end services with no bookable backendCode): this is purely "did
// someone call this phone back, and what happened."
const WhatsAppCallLogSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },

  outcome: {
    type: String,
    enum: ['booked', 'followup', 'not_interested', 'no_answer'],
    required: true,
  },

  // Only meaningful when outcome === 'followup' -- the required/in-the-
  // future rule is enforced at the route (a request-validation concern),
  // not here, since a schema-level conditional-required wouldn't cover
  // "must be in the future" anyway.
  followUpAt: { type: Date, default: null },

  note: { type: String, trim: true },

  // The logged-in owner who made the call (protect's req.user).
  calledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Set when outcome is 'booked' and a Trip was created for this call.
  // String, not an ObjectId ref -- the caller may pass either a Trip's
  // _id or its human tripNumber, and this isn't validated against Trip.
  tripId: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
});

WhatsAppCallLogSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('WhatsAppCallLog', WhatsAppCallLogSchema);
