'use strict';
/**
 * models/WhatsAppMessage.js
 * ============================================================
 * Every message on the ONE SaveLife WhatsApp number (8884092777), both
 * ways, so the CRM can show a real two-way thread (services/waMessageLog.js,
 * services/waChat.js):
 *
 *   inbound   everything a customer sends (logged by the webhook before
 *             anything else runs)
 *   outbound  everything sent to a customer — bot replies, call/welcome
 *             automation, templates, the introduction, handover messages
 *             and staff replies (logged by whatsappService.postMessage
 *             AFTER the send; the payload itself is never touched)
 *
 * Logging started when this feature went live: older conversations have
 * no stored messages (the CRM says so).
 *
 * `phone` is the 10-digit number — the same key as WhatsAppConversation /
 * WhatsAppContact. It never leaves the server: the API addresses a chat by
 * its customerRef (utils/customerPhone), which is derived from a secret and
 * so is not stored (rotating the secret would orphan stored refs).
 *
 * `at` is SERVER time (receipt, or the moment of sending). WhatsApp's own
 * timestamp on inbound messages is kept separately (waTimestamp) and never
 * used for ordering.
 * ============================================================
 */
const mongoose = require('mongoose');

const TYPES = ['text', 'image', 'location', 'interactive', 'template', 'document', 'audio', 'video', 'sticker', 'contacts', 'reaction', 'other'];
const STATUSES = ['received', 'sending', 'sent', 'delivered', 'read', 'failed'];
const SENDERS = ['customer', 'bot', 'system', 'staff'];

const WhatsAppMessageSchema = new mongoose.Schema({
  phone      : { type: String, required: true },          // 10 digits — never sent to a client
  direction  : { type: String, enum: ['inbound', 'outbound'], required: true },
  type       : { type: String, enum: TYPES, default: 'other' },
  body       : { type: String, maxlength: 4096 },          // text, caption, or button/list prompt
  options    : { type: [String], default: undefined },     // the buttons / list rows offered (outbound)
  template   : { type: String },                           // template name (outbound templates)
  mediaId    : { type: String },                           // WhatsApp's media id (image, audio, …)
  // Our own copy of a staff-sent image, so the CRM can show it (never public).
  media      : {
    kind      : { type: String, enum: ['gallery', 'upload', 'profile'] },
    galleryKey: String,
    upload    : { type: mongoose.Schema.Types.ObjectId, ref: 'WaChatMedia' },
    user      : { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // 'profile': whose intro photo
  },
  location   : { lat: Number, lng: Number, name: String, address: String },
  sender     : { type: String, enum: SENDERS, required: true },
  senderName : { type: String },                           // staff member's name (CRM only)
  senderUser : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  kind       : { type: String, enum: ['reply', 'intro', 'handover'] }, // staff messages
  waMessageId: { type: String },                           // wamid — delivery reports carry it
  status     : { type: String, enum: STATUSES },
  error      : { type: String, maxlength: 500 },
  clientMsgId: { type: String, maxlength: 64 },            // a staff send's idempotency key
  at         : { type: Date, required: true },             // server time
  waTimestamp: { type: Date },                             // WhatsApp's own time (inbound; reference only)
}, { timestamps: true });

WhatsAppMessageSchema.index({ phone: 1, at: -1, _id: -1 });
WhatsAppMessageSchema.index({ waMessageId: 1 }, { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } });
WhatsAppMessageSchema.index({ phone: 1, clientMsgId: 1 }, { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } });

WhatsAppMessageSchema.statics.TYPES = TYPES;

module.exports = mongoose.model('WhatsAppMessage', WhatsAppMessageSchema);
