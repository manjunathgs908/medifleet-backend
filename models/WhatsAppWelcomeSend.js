'use strict';
/**
 * models/WhatsAppWelcomeSend.js
 * ============================================================
 * The "savelife_welcome" WhatsApp template sent to a caller
 * (services/callWelcome.js): at most ONE per number per IST calendar day.
 * The unique (phone, istDate) index is the lock — two calls at the same
 * moment cannot both send. A failed send is kept with its reason and may
 * be retried the same day (by the next call, or the manual button); a sent
 * one is never repeated that day. The next IST day is a fresh row.
 * ============================================================
 */
const mongoose = require('mongoose');

const WhatsAppWelcomeSendSchema = new mongoose.Schema({
  phone  : { type: String, required: true, select: false }, // 10 digits
  istDate: { type: String, required: true },                 // 'YYYY-MM-DD', India time
  // sending: claimed, the WhatsApp request is in flight · sent · failed
  status : { type: String, enum: ['sending', 'sent', 'failed'], required: true },
  // What triggered the send that holds the row now.
  source : { type: String, enum: ['incoming_call', 'manual'], required: true },
  callLog: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
  sentBy : { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // manual only
  attempts: { type: Number, default: 1 },
  sentAt : Date,
  wamid  : String,                                           // WhatsApp's message id
  error  : { code: Number, reason: String, message: String },
}, { timestamps: true });

WhatsAppWelcomeSendSchema.index({ phone: 1, istDate: 1 }, { unique: true });
// Rows are only needed for today's check (and a little history).
WhatsAppWelcomeSendSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.model('WhatsAppWelcomeSend', WhatsAppWelcomeSendSchema);
