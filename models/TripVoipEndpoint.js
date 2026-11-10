'use strict';
const mongoose = require('mongoose');

// Plivo endpoints for IN-APP trip calls (services/tripVoip.js) — separate
// from the CRM's WebrtcEndpoint on purpose: the CRM's incoming-call routing
// reads that collection, and a driver or customer must never be rung for a
// CRM call.
//
//   kind 'driver'   one per driver PER DEVICE (the app's own device key),
//                   kept across trips. onlineAt: the last check-in from that
//                   app (login / presence); the driver is rung in the app
//                   only while it is fresh.
//   kind 'customer' one per TRIP, created on the customer's first in-app
//                   call and deleted from Plivo when the trip completes or
//                   is cancelled, so its login dies with the trip.
//
// Both are linked to the "SaveLife Trip VoIP" application
// (PLIVO_TRIP_VOIP_APP_ID), whose answer URL decides every call they place.
// The password is select:false: it goes only to that driver / that trip's
// customer, over HTTPS, and is never logged. No phone numbers live here.
const TripVoipEndpointSchema = new mongoose.Schema(
  {
    kind      : { type: String, enum: ['driver', 'customer'], required: true },
    user      : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // driver
    deviceKey : { type: String },                                         // driver
    device    : { type: String },                                         // driver: label
    trip      : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },   // customer
    endpointId: { type: String, required: true },
    username  : { type: String, required: true, index: true },
    password  : { type: String, select: false },
    appId     : { type: String },
    onlineAt  : { type: Date },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

TripVoipEndpointSchema.index(
  { user: 1, deviceKey: 1 },
  { unique: true, partialFilterExpression: { kind: 'driver' } },
);
TripVoipEndpointSchema.index(
  { trip: 1 },
  { unique: true, partialFilterExpression: { kind: 'customer' } },
);

module.exports = mongoose.model('TripVoipEndpoint', TripVoipEndpointSchema);
