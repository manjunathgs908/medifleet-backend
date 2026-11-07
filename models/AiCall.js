'use strict';
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');
const { fullPhone } = require('../utils/phoneViewer');

// One outbound AI-telecaller call (PILOT — services/aiCaller). Created when
// the CRM starts a call to an allowlisted test number; filled in as Plivo
// and the OpenAI Realtime session report. The number is select:false and
// stripped from JSON like CallLog's: masked for everyone, full for a CRM
// owner only.
//
// Money: estCostPaise is a ROUGH estimate in integer paise from the
// AI_COST_* env rates (never hardcoded); null when they aren't set. The
// raw usage it came from is kept so it can be recomputed.
const AiCallSchema = new mongoose.Schema(
  {
    phone    : { type: String, required: true, select: false }, // normalised, 10 digits
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    status : {
      type: String,
      enum: ['dialing', 'in_progress', 'handing_off', 'completed', 'no_answer', 'failed'],
      default: 'dialing',
      index: true,
    },
    // What the call achieved. booked: a Trip was created; follow_up: a
    // callback task was queued for a person; handed_off: transferred to
    // on-duty staff; ended: finished with nothing to do.
    outcome: { type: String, enum: ['booked', 'follow_up', 'handed_off', 'ended', 'no_answer', 'failed'] },
    summary: { type: String, maxlength: 1000 },

    handoff      : { type: Boolean, default: false },
    handoffReason: { type: String, maxlength: 300 },
    handoffAt    : { type: Date },

    trip        : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
    callbackTask: { type: mongoose.Schema.Types.ObjectId, ref: 'CallbackTask' },

    plivoRequestUuid: { type: String },
    plivoCallUuid   : { type: String, index: true },
    recordingUrl    : { type: String, select: false },

    // What the caller told the assistant about the patient (create_booking),
    // shown to the team with the booking — the Trip has no place for it.
    needs: {
      condition: { type: String, maxlength: 300 },
      oxygen   : { type: Boolean },
      helper   : { type: Boolean },
      patientAt: { type: String, enum: ['home', 'hospital', 'other'] },
      // Round trip: the ambulance waits (about waitHours) and brings them back.
      roundTrip: { type: Boolean },
      waitHours: { type: Number },
      nurse      : { type: Boolean },          // asked for a nurse (charge confirmed by the team)
      specialCare: { type: String, maxlength: 300 },
      twoDrivers : { type: Boolean },          // over 1000 km one way
      pickupDetails: { type: String, maxlength: 200 }, // home pickup: house / street / landmark
      appointmentAt: { type: Date },           // hospital appointment — NOT the pickup time (Trip.scheduleDate)
      freezerBox   : { type: Boolean },        // body transport: a freezer box too (team confirms the charge)
    },
    // A request the team prices and calls back about (not bookable here).
    request: {
      type: { type: String, enum: ['freezer_box'] },
      area: { type: String, maxlength: 200 },
      address: { type: String, maxlength: 300 }, // delivery address for a box kept at home
      startAt: { type: Date },                   // from when
      days: { type: Number },
      hours: { type: Number },                   // instead of days, if less than a day
      at  : { type: Date },
    },
    // The pickup the caller shared on WhatsApp during the call
    // (services/locationRequests.js); get_quote can use it.
    sharedLocation: {
      lat    : Number,
      lng    : Number,
      address: String,
      at     : Date,
    },

    // The call language. Set only when the caller explicitly asks for one
    // (languageSource 'requested'); transcriptScript is just which letters
    // the first transcript used — Kannada has come back in Telugu letters.
    language  : { type: String },
    languageSource  : { type: String, enum: ['requested'] },
    transcriptScript: { type: String },
    transcript: [{
      _id : false,
      role: { type: String, enum: ['assistant', 'caller', 'system'] },
      text: { type: String, maxlength: 2000 },
      at  : { type: Date, default: Date.now },
    }],

    dialedAt   : { type: Date },
    answeredAt : { type: Date },
    endedAt    : { type: Date },
    durationSec: { type: Number }, // Plivo's billed duration
    hangupCause: { type: String },

    usage: {
      audioIn : { type: Number, default: 0 }, // OpenAI Realtime tokens
      audioOut: { type: Number, default: 0 },
      textIn  : { type: Number, default: 0 },
      textOut : { type: Number, default: 0 },
      cachedIn: { type: Number, default: 0 },
    },
    estCostPaise: { type: Number, default: null },
    // GPT-Live's own final usage report (session.closed), kept verbatim —
    // its shape is newer than the fields above, which are filled from it
    // where they match.
    usageRaw: { type: mongoose.Schema.Types.Mixed },

    // The assistant ended the call (end_call): when the stream closes,
    // /plivo/next hangs up instead of handing off.
    endRequested: { type: Boolean, default: false },
    // GPT-Live dropped mid-call and was reconnected this many times (session.js).
    aiReconnects: { type: Number, default: 0 },
    // Times the assistant began saying a price before get_quote and was cut off (session.js).
    priceGuardStops: { type: Number, default: 0 },
    // Times "link sent" / "booked" was said before it was true and cut off (session.js).
    claimGuardStops: { type: Number, default: 0 },
    // Times the caller spoke over the assistant and her audio was stopped (session.js).
    bargeIns: { type: Number, default: 0 },

    error: { type: String, maxlength: 500 },
    // Why the OpenAI side ended, as OpenAI said it — handshake HTTP status,
    // websocket close code/reason, error events. For diagnosing a pilot call.
    openaiClose : { code: Number, reason: String, at: Date },
    openaiErrors: [{ _id: false, at: Date, code: String, message: String }],
  },
  { timestamps: true },
);

AiCallSchema.set('toJSON', {
  transform(doc, ret) {
    if ('phone' in ret) {
      ret.phoneMasked = maskPhone(ret.phone);
      const full = fullPhone(ret.phone);
      delete ret.phone;
      if (full) ret.phone = full;
    }
    delete ret.recordingUrl;
    return ret;
  },
});

module.exports = mongoose.model('AiCall', AiCallSchema);
