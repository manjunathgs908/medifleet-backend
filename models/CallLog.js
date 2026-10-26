'use strict';
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');

// One masked, recorded phone call through Plivo (or the Exotel fallback):
// an agent -- a driver, a fleet owner, or CRM staff -- and a customer.
//
// Separate from Trip.callLogs, which stays as the Exotel driver<->customer
// record it always was, and from WhatsAppCallLog, which is the desk's own
// note of what a call achieved ("booked", "no answer"), not the call
// itself. A call here can belong to a trip, a lead, a quote, a WhatsApp
// lead or nothing at all (an incoming call from an unknown number).
//
// Both numbers are select:false and stripped from JSON: the backend dials
// them, nobody reads them.
const CallLogSchema = new mongoose.Schema(
  {
    provider : { type: String, enum: ['plivo', 'exotel'], required: true },
    direction: { type: String, enum: ['outbound', 'inbound'], required: true, index: true },

    // Who was on our side of the call. agentUser for drivers and CRM staff
    // (User), agentOwner for fleet partners (Owner).
    agentType : { type: String, enum: ['driver', 'staff', 'fleet_owner', null], default: null },
    agentUser : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    agentOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner' },
    agentName : { type: String },
    agentPhone: { type: String, select: false },

    customerPhone: { type: String, select: false, index: true },

    // What the call was about.
    context     : { type: String, enum: ['trip', 'lead', 'quote', 'whatsapp', 'whatsapp_lead', 'call_back', 'incoming'], required: true },
    trip        : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', index: true },
    lead        : { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    quote       : { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    whatsappLead: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppLead' },

    // initiated -> agent_answered -> completed, or one of the failures.
    // Inbound: ringing -> completed / missed / no_agents.
    status: { type: String, default: 'initiated', index: true },

    providerRequestId: { type: String },              // Plivo request_uuid / Exotel Sid
    providerCallId   : { type: String, index: true }, // Plivo CallUUID (A leg)
    customerLegId    : { type: String },              // Plivo DialBLegUUID
    hangupCause      : { type: String },
    error            : { type: String },

    // Server time only.
    startedAt  : { type: Date, default: Date.now },
    answeredAt : { type: Date },
    endedAt    : { type: Date },
    talkSec    : { type: Number }, // customer leg, i.e. the actual conversation
    totalSec   : { type: Number }, // whole call including ringing the agent

    recordingUrl: { type: String },
    recordingId : { type: String },
    recordingSec: { type: Number },
  },
  { timestamps: true },
);

CallLogSchema.index({ createdAt: -1 });

CallLogSchema.set('toJSON', {
  transform(doc, ret) {
    if ('customerPhone' in ret) {
      ret.customerMasked = maskPhone(ret.customerPhone);
      delete ret.customerPhone;
    }
    delete ret.agentPhone;
    // The Plivo recording URL stays server-side too: with Plivo's Basic Auth
    // for recordings on, it needs our credentials, and either way the CRM
    // plays it through GET /api/calls/:id/recording, which checks the login.
    ret.hasRecording = !!ret.recordingUrl;
    delete ret.recordingUrl;
    delete ret.recordingId;
    return ret;
  },
});

module.exports = mongoose.model('CallLog', CallLogSchema);
