'use strict';
const mongoose = require('mongoose');

// Server-authoritative record of what happened to a dispatched trip's
// notification, independent of Trip.events (which is the trip lifecycle's
// own business audit trail — dispatch/pickup/drop — and never client- or
// diagnostics-scoped). Every event here is written by backend code that
// already knows it happened (a push was actually sent, confirmTrip/
// declineTrip actually ran) — no app-reported events (PUSH_RECEIVED,
// INCOMING_SCREEN_SHOWN, APP_ERROR) yet; those need a POST route and a
// trust-model decision that hasn't been made.
const TripCallEventSchema = new mongoose.Schema({
  tripId  : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['PUSH_SENT', 'PUSH_RECEIVED', 'INCOMING_SCREEN_SHOWN', 'ACCEPTED', 'REJECTED', 'TIMED_OUT', 'APP_ERROR'],
    required: true,
  },
  // Every row in this pass is 'backend' — kept in the schema now (rather
  // than added later) so app-reported events slot in later without a
  // migration.
  source: { type: String, enum: ['backend', 'app'], required: true },
  at      : { type: Date, default: Date.now }, // server receipt time, always
  clientAt: { type: Date }, // reserved for future app-reported events
  meta    : { type: mongoose.Schema.Types.Mixed },
});

TripCallEventSchema.index({ tripId: 1, at: 1 });
TripCallEventSchema.index({ driverId: 1, at: -1 });

module.exports = mongoose.model('TripCallEvent', TripCallEventSchema);
