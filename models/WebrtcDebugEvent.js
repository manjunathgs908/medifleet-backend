'use strict';
const mongoose = require('mongoose');

// TEMPORARY diagnostics for in-app (WebRTC) calling: what the Plivo Browser
// SDK reported in each CRM tab (login, login failure, logout, connection
// changes, registration state), tagged with a per-page-load session id and
// device, so two devices fighting over one endpoint show up as two
// sessions. Written by POST /api/calls/webrtc/debug, read by GET.
// Expires after 24 hours on its own. No tokens or passwords are stored:
// the controller redacts anything token-like before saving.
const WebrtcDebugEventSchema = new mongoose.Schema({
  user     : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  userName : { type: String },
  sessionId: { type: String, index: true },
  device   : { type: String },
  event    : { type: String, required: true },
  reason   : { type: String },
  detail   : { type: mongoose.Schema.Types.Mixed },
  clientAt : { type: Date },
  at       : { type: Date, default: Date.now },
});

WebrtcDebugEventSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('WebrtcDebugEvent', WebrtcDebugEventSchema);
