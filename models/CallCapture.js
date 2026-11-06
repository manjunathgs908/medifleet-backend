'use strict';
/**
 * models/CallCapture.js
 * ============================================================
 * LIVE CALL CAPTURE. One per answered customer call (CallLog): what the
 * listen-only transcriber heard and the booking details extracted from
 * it, filling the CRM's booking form while the call is going.
 *
 * It is a DRAFT, never a booking. Nothing here creates a Trip: an operator
 * reviews the form and books it through the normal POST /api/trips, which
 * links the trip back here (trip) with bookingSource 'ai_call_entry'.
 * A separate collection on purpose — a Trip status would reach the driver
 * app, the customer app and the website.
 *
 * Customer numbers: fields.patientPhone and any 10-digit number in the
 * transcript or summary go out masked to everyone but the CRM owner.
 * ============================================================
 */
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');
const { fullPhone } = require('../utils/phoneViewer');
const { maskNumbersInText } = require('../utils/maskNumbersInText');

const placeSchema = new mongoose.Schema({
  label: String,
  lat  : Number,
  lng  : Number,
}, { _id: false });

const CallCaptureSchema = new mongoose.Schema({
  callLog: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog', required: true, unique: true },
  // Who answered (the operator whose form it fills).
  agentUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // starting: Plivo asked to stream · live: audio arriving · ended: call
  // over, final extraction done · failed: the stream never started
  // (whatever was captured is kept either way).
  status: { type: String, enum: ['starting', 'live', 'ended', 'failed'], default: 'starting' },
  plivoStreamId: String,
  startedAt: Date,
  endedAt  : Date,

  // As heard and extracted — blank when not clearly said.
  fields: {
    patientName : { type: String, default: '' },
    patientPhone: { type: String, default: '' }, // 10 digits, masked in JSON
    pickupText  : { type: String, default: '' },
    dropText    : { type: String, default: '' },
    serviceType : { type: String, default: '' }, // a Pricing serviceType code
    scheduleType: { type: String, default: '' }, // '' | 'now' | 'later'
    scheduleAt  : { type: String, default: '' }, // 'YYYY-MM-DDTHH:mm' India time, for later
  },
  // pickupText / dropText resolved through the same Places search as the
  // WhatsApp bot; several matches -> options for the operator, never a guess.
  pickup       : placeSchema,
  drop         : placeSchema,
  pickupOptions: [placeSchema],
  dropOptions  : [placeSchema],
  // The existing fare engine's quote for the resolved route (display only;
  // the booking is priced again when the operator books it).
  estimate: {
    fare       : mongoose.Schema.Types.Mixed,
    distanceKm : Number,
    durationSec: Number,
    fareError  : String,
    at         : Date,
  },

  transcript: [{
    _id : false,
    role: { type: String, enum: ['customer', 'operator'] },
    text: String,
    at  : Date, // server time the turn ended
  }],
  summary: { type: String, default: '' },
  extractions: { type: Number, default: 0 },

  // Anything that went wrong — never stops the call or the capture.
  problems: [{ _id: false, at: Date, where: String, message: String }],

  trip    : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
  bookedAt: Date,
  bookingLock: { type: Boolean, select: false },
}, { timestamps: true });

CallCaptureSchema.index({ createdAt: -1 });

CallCaptureSchema.set('toJSON', {
  transform(doc, ret) {
    if (ret.fields) {
      const phone = ret.fields.patientPhone;
      ret.fields.patientPhoneMasked = phone ? maskPhone(phone) : '';
      ret.fields.patientPhone = (phone && fullPhone(phone)) || ''; // CRM owner only
    }
    if (Array.isArray(ret.transcript)) ret.transcript = ret.transcript.map((t) => ({ ...t, text: maskNumbersInText(t.text) }));
    if (ret.summary) ret.summary = maskNumbersInText(ret.summary);
    delete ret.bookingLock;
    return ret;
  },
});

module.exports = mongoose.model('CallCapture', CallCaptureSchema);
