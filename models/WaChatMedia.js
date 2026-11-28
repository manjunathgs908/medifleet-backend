'use strict';
/**
 * models/WaChatMedia.js
 * ============================================================
 * A photo a staff member uploaded and sent in one customer's WhatsApp chat
 * (services/waChat.js). Kept so the CRM thread can show what was sent;
 * stored privately (never a public URL) and served only to signed-in CRM
 * staff through that chat. Sent to WhatsApp via its media store.
 * ============================================================
 */
const mongoose = require('mongoose');

const WaChatMediaSchema = new mongoose.Schema({
  phone      : { type: String, required: true }, // 10 digits — the chat it belongs to
  data       : { type: Buffer, required: true, select: false },
  contentType: { type: String, enum: ['image/jpeg', 'image/png'], required: true },
  bytes      : { type: Number, required: true },
  by         : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName     : String,
}, { timestamps: true });

WaChatMediaSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('WaChatMedia', WaChatMediaSchema);
