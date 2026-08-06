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
  },

  tripId: { type: String, default: null },

  updatedAt: { type: Date, default: Date.now },
});

WhatsAppSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 1800 });

module.exports = mongoose.model('WhatsAppSession', WhatsAppSessionSchema);
