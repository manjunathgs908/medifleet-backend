'use strict';
const mongoose = require('mongoose');

// One browser/device's Web Push subscription for a CRM operator (owner or
// telecaller), used to alert them to a new customer booking while the CRM
// is in the background or closed (services/bookingPush.js). Keyed on the
// endpoint: a browser has exactly one per site, and re-subscribing after
// another operator logs in on it moves it to them (last login wins).
// Deleted when the push service says it's gone (404/410), and by the
// browser itself on logout or when the operator turns booking push off.
const PushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth  : { type: String, required: true },
    },
    user     : { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userAgent: { type: String, maxlength: 400 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
