'use strict';
/**
 * models/LeadBookingClaim.js
 * ============================================================
 * One row per lead that staff booked from (services/leadBooking.js). Its _id
 * IS the lead id, so MongoDB's unique _id lets only one booking-from-this-
 * lead be in progress at a time: a double tap, a retry or a second device
 * gets "already being booked" / "already booked" instead of a second trip.
 *
 *   pending  a booking is being created (owner = token, since = at)
 *   done     the booking exists (trip)
 *
 * A pending claim older than the stale window is recovered, never trusted:
 * if a trip from this lead was created since the claim, the claim is
 * completed with it; otherwise a new attempt may take it over.
 * No customer data is stored here.
 * ============================================================
 */
const mongoose = require('mongoose');

const leadBookingClaimSchema = new mongoose.Schema(
  {
    _id   : { type: String },                                   // the lead id
    state : { type: String, enum: ['pending', 'done'], required: true },
    token : { type: String, required: true },                   // which attempt holds it
    at    : { type: Date, required: true },                     // when that attempt began
    by    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    trip  : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
    doneAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.model('LeadBookingClaim', leadBookingClaimSchema);
