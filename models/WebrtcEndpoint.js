'use strict';
const mongoose = require('mongoose');

// One Plivo endpoint per CRM user PER DEVICE (browser profile / installed
// app). With one shared endpoint, every device a user had open registered
// the same SIP identity, and Plivo delivered an incoming call to only one
// of those registrations — often not the screen in front of them. Now each
// device registers its own endpoint and an incoming call rings all of the
// user's online devices at once (controllers/callController.js).
//
// deviceKey is a random id the CRM keeps in localStorage, so a device keeps
// its endpoint across reloads. The password is select:false: it goes only
// to that user, on that device, over HTTPS, and is never logged.
const WebrtcEndpointSchema = new mongoose.Schema(
  {
    user      : { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceKey : { type: String, required: true },
    device    : { type: String },               // label: installed-app / browser-tab + user agent
    endpointId: { type: String },
    username  : { type: String, required: true },
    password  : { type: String, select: false },
    onlineAt  : { type: Date },                 // last check-in from that device while registered
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

WebrtcEndpointSchema.index({ user: 1, deviceKey: 1 }, { unique: true });

module.exports = mongoose.model('WebrtcEndpoint', WebrtcEndpointSchema);
