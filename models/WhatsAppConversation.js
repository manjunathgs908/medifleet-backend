'use strict';
/**
 * models/WhatsAppConversation.js
 * ============================================================
 * The team-inbox state of ONE customer's WhatsApp chat with the single
 * SaveLife number (8884092777): who on the team owns it, and whether that
 * person has introduced themselves. One document per customer number,
 * created on first assignment. The bot (services/whatsappFlow.js,
 * AWAITING_* states) neither reads nor writes it.
 *
 *   assignedTo / assignedToName   the telecaller (or owner) on this chat
 *   rev                           guards every change (as Lead.rev): a
 *                                 change made from an out-of-date view is
 *                                 refused (409), never applied over another
 *   history                       who assigned / claimed / unassigned, when
 *   intro                         the ONE introduction card sent on this
 *                                 chat (photo + caption) — set once, never
 *                                 resent (services/waIntro.js)
 *   handovers                     short "my colleague {name} will help you"
 *                                 messages, at most one per new assignee
 *
 * No customer number leaves the server: the API addresses a chat by its
 * opaque customerRef (utils/customerPhone).
 * ============================================================
 */
const mongoose = require('mongoose');

const sent = {
  at    : Date,
  by    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  wamid : String, // WhatsApp's message id (delivery reports carry it)
};

const WhatsAppConversationSchema = new mongoose.Schema({
  phone         : { type: String, required: true, unique: true }, // 10 digits
  assignedTo    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedToName: { type: String },
  assignedAt    : { type: Date },
  rev           : { type: Number, default: 0 },
  // Human takeover (services/waChat.js): 'human' = a staff member is
  // handling this customer, and the webhook only LOGS their messages — no
  // bot, no automated reply — until someone hands the chat back ('bot').
  // Affects this one customer only. A missing field means 'bot'.
  mode          : { type: String, enum: ['bot', 'human'], default: 'bot' },
  modeAt        : { type: Date },
  modeBy        : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  modeByName    : { type: String },
  history       : [{
    _id   : false,
    type  : { type: String, enum: ['assigned', 'claimed', 'unassigned', 'takeover', 'handback'] },
    at    : Date,
    by    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
    from  : String,
    to    : String,
    via   : String, // takeover/handback: 'button' | 'reply' | 'unassigned'
  }],
  intro: {
    ...sent,
    // A send in flight (claimed before calling WhatsApp, so two taps or two
    // devices can never send twice). Cleared on failure; stale after 2 min.
    sendingAt: Date,
    sendingBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  // The previous assignee when the chat was last handed from one person to
  // another (unset on a first assignment / claim) — the new assignee may
  // then send one handover message.
  handoverFrom: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    at  : Date,
  },
  handovers: [{ _id: false, ...sent, sendingAt: Date }],
}, { timestamps: true });

module.exports = mongoose.model('WhatsAppConversation', WhatsAppConversationSchema);
