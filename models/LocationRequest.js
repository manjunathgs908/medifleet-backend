'use strict';
/**
 * models/LocationRequest.js
 * ============================================================
 * A WhatsApp "please share your pickup location" sent to a caller
 * (services/locationRequests.js): on an incoming customer call, or when
 * the AI telecaller asks for it. When the caller shares a location pin it
 * is recorded here and filled into that call's capture draft / AI call.
 * ============================================================
 */
const mongoose = require('mongoose');

const LocationRequestSchema = new mongoose.Schema({
  phone : { type: String, required: true, index: true, select: false }, // 10 digits
  source: { type: String, enum: ['incoming_call', 'ai_caller'], required: true },
  callLog: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog', index: true },
  aiCall : { type: mongoose.Schema.Types.ObjectId, ref: 'AiCall', index: true },

  // sent: waiting for the pin · received: pin shared · failed: WhatsApp
  // refused or not set up (error says why)
  status: { type: String, enum: ['sent', 'received', 'failed'], required: true },
  // 'template': the approved template (outside the 24-hour window);
  // 'interactive': the one-tap "Send location" button (inside it).
  via   : { type: String, enum: ['template', 'interactive'] },
  sentAt: Date,
  error : String,

  receivedAt: Date,
  location  : { lat: Number, lng: Number, address: String },
}, { timestamps: true });

LocationRequestSchema.index({ phone: 1, sentAt: -1 });

module.exports = mongoose.model('LocationRequest', LocationRequestSchema);
