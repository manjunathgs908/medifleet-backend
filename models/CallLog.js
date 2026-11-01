'use strict';
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');
const { phoneLegVerdict } = require('../utils/phoneLegVerdict');
const { fullPhone } = require('../utils/phoneViewer');

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

    // Who Plivo rang first. 'agent' for click-to-call and incoming;
    // 'customer' only for the legacy /api/call/connect from the customer's
    // tracking page, where the customer starts the call to the driver.
    firstLeg: { type: String, enum: ['agent', 'customer'], default: 'agent' },

    // The number both parties saw. Always PLIVO_NUMBER for a Plivo call --
    // recorded per call so it can be checked, not assumed.
    callerId: { type: String },

    // What the call was about.
    context     : { type: String, enum: ['trip', 'lead', 'quote', 'whatsapp', 'whatsapp_lead', 'call_back', 'incoming', 'test_ring'], required: true },
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

    // TEMPORARY diagnostics for in-app (WebRTC) delivery — readable via
    // GET /api/calls/logs. No phone numbers in any of them (counts and
    // masked values only).
    //   routing:  what /incoming decided and why — per in-app user whether
    //             their app counted as online, the exact SIP URI dialled,
    //             and Plivo's own view of that endpoint at call time.
    //   appLeg:   what Plivo reported for the in-app <Dial> (stage 1).
    //   phoneLeg: what Plivo reported for the phone <Dial> (stage 2).
    routing : { type: mongoose.Schema.Types.Mixed },
    hangup  : { type: mongoose.Schema.Types.Mixed }, // Plivo's hang-up report for the whole call
    // The exact phones this call's phone <Dial> rang — server-side only,
    // for spotting two of our calls ringing one number at once.
    dialledPhones: { type: [String], select: false, index: true },
    // TEMPORARY diagnostic: when the phone <Dial> went out, was anything
    // else of ours (another call, a stuck leg) already on that number? And
    // was the caller themselves one of the ring numbers?
    overlap : { type: mongoose.Schema.Types.Mixed },
    // Each step our XML took, in order — e.g. ["app:15s", "app:no-answer→phones:1",
    // "phones:busy→sorry"]. A call Plivo reports as "ended by Answer XML"
    // ended on our <Hangup/>; this says which one and why.
    flow    : { type: [String], default: undefined },
    appLeg  : { type: mongoose.Schema.Types.Mixed },
    phoneLeg: { type: mongoose.Schema.Types.Mixed },

    recordingUrl: { type: String },
    recordingId : { type: String },
    recordingSec: { type: Number },

    // Missed-call callback queue (services/callbackQueue.js).
    //   callbackEligible: set by /incoming on a real customer's call (a
    //     mobile number that is not one of our ring phones). Only calls
    //     carrying it can be queued — none from before the queue existed.
    //   callbackReview: a 'not_routed' call (created at hang-up) waiting for
    //     a person to add it to the queue or dismiss it — {state, by, byName, at}.
    //   callbackTask: inbound — the task this missed call belongs to;
    //     outbound — the task this call was a callback attempt for.
    callbackEligible: { type: Boolean },
    callbackReview  : { type: mongoose.Schema.Types.Mixed },
    callbackTask    : { type: mongoose.Schema.Types.ObjectId, ref: 'CallbackTask', index: true },
    // A queued missed call later reported answered: taken off its task's
    // missed count at this time.
    callbackRetractedAt: { type: Date },
  },
  { timestamps: true },
);

CallLogSchema.index({ createdAt: -1 });
CallLogSchema.index({ callbackEligible: 1, status: 1, startedAt: 1 }, { partialFilterExpression: { callbackEligible: true } });

// Whether an "active" stored status can still be true (display only).
const { liveStateOf } = require('../utils/callLiveness');

CallLogSchema.set('toJSON', {
  transform(doc, ret) {
    if ('customerPhone' in ret) {
      ret.customerMasked = maskPhone(ret.customerPhone);
      const full = fullPhone(ret.customerPhone); // CRM owner only
      delete ret.customerPhone;
      if (full) ret.customerPhone = full;
    }
    delete ret.agentPhone;
    delete ret.dialledPhones;
    ret.phoneVerdict = phoneLegVerdict(ret.phoneLeg, ret.overlap);
    // Display-only (see liveStateOf); `status` itself is never rewritten.
    const live = liveStateOf(ret, { notLiveOnPlivo: !!doc.$locals?.notLiveOnPlivo });
    if (live) {
      ret.liveState = live.state;
      if (live.state === 'unconfirmed') {
        ret.statusUnconfirmed = true;
        ret.statusUnconfirmedReason = live.reason;
      }
    }
    // The Plivo recording URL stays server-side too: with Plivo's Basic Auth
    // for recordings on, it needs our credentials, and either way the CRM
    // plays it through GET /api/calls/:id/recording, which checks the login.
    // A recording only exists once someone answered: <Record
    // startOnDialAnswer> never starts on an unanswered call, even if Plivo
    // posts a URL for it. So offer playback only for an answered call (or a
    // recording Plivo says has length), never for a missed one.
    const answered = ret.status === 'completed' || Number(ret.talkSec) > 0;
    ret.hasRecording = !!ret.recordingUrl && (Number(ret.recordingSec) > 0 || (ret.recordingSec == null && answered));
    ret.recordingState = ret.hasRecording ? 'available' : answered ? 'none' : 'not_answered';
    delete ret.recordingUrl;
    delete ret.recordingId;
    return ret;
  },
});

module.exports = mongoose.model('CallLog', CallLogSchema);
