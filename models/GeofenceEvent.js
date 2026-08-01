'use strict';
const mongoose = require('mongoose');

// Server-authoritative record of a driver crossing their fixed-posting
// geofence (see User.postingLat/postingLng, added for SaveLife's own
// employed drivers). Recording/warning only -- no salary deduction, no
// driver notification (see authController.updateLocation). Same
// shape/indexing conventions as TripCallEvent.
const GeofenceEventSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['LEFT_POSTING', 'RETURNED_TO_POSTING'],
    required: true,
  },
  at  : { type: Date, default: Date.now },
  meta: { type: mongoose.Schema.Types.Mixed },
});

GeofenceEventSchema.index({ driverId: 1, at: -1 });

module.exports = mongoose.model('GeofenceEvent', GeofenceEventSchema);
