'use strict';
/**
 * models/CallStyleExample.js
 * ============================================================
 * A REAL SaveLife call, kept as a style example for the AI telecaller
 * (services/aiCaller/styleExamples.js): a few active ones go into its
 * instructions so it copies how SaveLife's operators actually talk —
 * phrasing, question order, warmth, brevity.
 *
 * Added by the owner on the AI Telecaller page, from a captured call's
 * transcript (CallLog.transcript, from live call capture) or pasted, and
 * editable there (take out names before saving). Phone numbers are
 * masked whenever an example is sent to the model.
 * ============================================================
 */
const mongoose = require('mongoose');

const CallStyleExampleSchema = new mongoose.Schema({
  title   : { type: String, maxlength: 120 },
  language: { type: String, maxlength: 20 }, // 'kn' | 'en' | 'hi' | 'te' | mixed — a label only
  transcript: [{
    _id : false,
    role: { type: String, enum: ['operator', 'customer'], required: true },
    text: { type: String, required: true, maxlength: 1000 },
  }],
  active: { type: Boolean, default: true },
  // Lower first; ties: most recently updated first.
  order : { type: Number, default: 0 },
  notes : { type: String, maxlength: 500 },
  source: {
    callLog: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('CallStyleExample', CallStyleExampleSchema);
