'use strict';
const mongoose = require('mongoose');

// One in-progress WhatsApp booking conversation per phone number -- tracks
// which step of the flow the sender is on and whatever booking details
// have been collected so far. TTL-expires 30 minutes after updatedAt, so
// an abandoned conversation doesn't linger forever; a customer who comes
// back after that just starts a fresh flow rather than resuming a stale
// one. Not enforced unique on phone here -- the flow handler (built next)
// owns the "one active session per phone" invariant via how it
// queries/upserts, not a schema-level constraint.
//
// updatedAt has no auto-refresh wired up yet (no {timestamps:true}, no
// pre-save hook) -- whatever writes to this session on each step of the
// flow must explicitly set updatedAt itself, or the TTL ends up measuring
// time-since-creation instead of time-since-last-activity.
const WhatsAppSessionSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  step : { type: String, required: true },

  // Picked once, first step of the flow, then every reply for the rest of
  // this session is composed in this language. Defaults to 'en' only for
  // schema-level safety (a session should never actually reach the
  // language field unset in practice) -- not a "assume English" fallback
  // for an unanswered prompt.
  language: { type: String, enum: ['en', 'hi', 'kn', 'te'], default: 'en' },

  // Human-readable, already-language-resolved label for whatever
  // service/sub-type the customer picked (e.g. "ALS (Tempo)") -- set once
  // in whatsappFlow.js right after service/sub-type selection, then read
  // back for the AWAITING_CONFIRM booking summary. MUST be a declared
  // schema path: this schema has no {strict:false}, so Mongoose's default
  // strict mode silently drops any session.set() write to a path that
  // isn't declared here -- not even held in memory after .save(), let
  // alone persisted. That silent drop is exactly what left the summary's
  // {service} placeholder un-interpolated before this field existed.
  serviceLabel: { type: String },

  draftBooking: {
    serviceType: { type: String },
    pickup: {
      address: { type: String },
      lat    : { type: Number },
      lng    : { type: Number },
    },
    drop: {
      address: { type: String },
      lat    : { type: Number },
      lng    : { type: Number },
    },
    fareEstimate: { type: Number },
    distanceKm  : { type: Number },

    // Transient Google Places Text Search results awaiting a customer's
    // disambiguation pick (AWAITING_PICKUP_CHOICE / AWAITING_DROP_CHOICE)
    // -- cleared as soon as a choice resolves. Declared here for the same
    // strict-mode reason as serviceLabel above: an undeclared path is
    // silently dropped by session.set(), never persisted.
    placeOptions: [{
      name   : { type: String },
      address: { type: String },
      lat    : { type: Number },
      lng    : { type: Number },
    }],
  },

  tripId: { type: String, default: null },

  updatedAt: { type: Date, default: Date.now },
});

WhatsAppSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 1800 });

module.exports = mongoose.model('WhatsAppSession', WhatsAppSessionSchema);
