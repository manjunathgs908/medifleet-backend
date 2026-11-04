'use strict';
/**
 * models/LeadClaim.js
 * ============================================================
 * One document per channel + phone ("whatsapp:9886512345"), written in the
 * same transaction that creates a lead for that number. Two creators at the
 * same instant both write this one document, so MongoDB lets only one of
 * them commit; the other is retried, finds the lead the first one created,
 * and updates it instead — never a second lead. Not a lead itself, holds no
 * customer data beyond the key; leads that already exist are untouched.
 * ============================================================
 */
const mongoose = require('mongoose');

const leadClaimSchema = new mongoose.Schema(
  {
    _id : { type: String },                  // `${source}:${normalisedPhone}`
    hits: { type: Number, default: 0 },      // touched by each creator (forces the conflict)
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.model('LeadClaim', leadClaimSchema);
