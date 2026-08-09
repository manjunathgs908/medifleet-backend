'use strict';
const mongoose = require('mongoose');

// Permanent funnel-analytics log for the WhatsApp booking flow. WhatsAppSession
// itself TTL-expires 30 minutes after its last update (see WhatsAppSession.js's
// own comment), so it can't be the source of truth for drop-off reporting once
// a stale conversation is reaped -- this collection is the durable record of
// every step transition, written alongside (never instead of) the session
// write, and never deleted or updated once logged.
const WhatsAppFunnelEventSchema = new mongoose.Schema({
  phone : { type: String, required: true, index: true },

  // The WhatsAppSession this event belongs to. Not a ref-populated field in
  // practice (the session itself may already be TTL-gone by the time anyone
  // queries this) -- kept as a plain id for traceability while it lasts.
  sessionId: { type: mongoose.Schema.Types.ObjectId },

  step        : { type: String, required: true },
  language    : { type: String },
  serviceLabel: { type: String },

  enteredAt: { type: Date, default: Date.now },
});

WhatsAppFunnelEventSchema.index({ step: 1, enteredAt: -1 });
WhatsAppFunnelEventSchema.index({ phone: 1, enteredAt: -1 });

module.exports = mongoose.model('WhatsAppFunnelEvent', WhatsAppFunnelEventSchema);
