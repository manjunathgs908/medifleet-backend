'use strict';
/**
 * models/WhatsAppContact.js
 * ============================================================
 * When each number last messaged the WhatsApp bot — WhatsApp's 24-hour
 * customer-service window: inside it a free-form message (like the one-tap
 * "Send location" button) may be sent; outside it only an approved
 * template. Written on every inbound message (routes/whatsappRoutes.js).
 * ============================================================
 */
const mongoose = require('mongoose');

const WhatsAppContactSchema = new mongoose.Schema({
  phone        : { type: String, required: true, unique: true }, // 10 digits
  lastInboundAt: { type: Date, required: true },
}, { timestamps: true });

module.exports = mongoose.model('WhatsAppContact', WhatsAppContactSchema);
