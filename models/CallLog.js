'use strict';
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');
const { phoneLegVerdict } = require('../utils/phoneLegVerdict');
const { fullPhone } = require('../utils/phoneViewer');
const { maskNumbersInText } = require('../utils/maskNumbersInText');

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

    // Driver<->customer masked trip call (POST /api/trips/:id/call,
    // services/tripCalls.js): bridged on PLIVO_MASKING_NUMBER, and only while
    // the trip is still active -- re-checked when the first party answers.
    // Context stays 'trip', so the CRM lists these exactly like before.
    tripMasked  : { type: Boolean },
    tripCallFrom: { type: String, enum: ['driver', 'customer'] },

    // What the call was about.
    context     : { type: String, enum: ['trip', 'lead', 'quote', 'whatsapp', 'whatsapp_lead', 'call_back', 'incoming', 'test_ring'], required: true },
    trip        : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', index: true },
    lead        : { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    quote       : { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    whatsappLead: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppLead' },

    // LIVE CALL CAPTURE (services/callCapture): the draft booking the
    // listen-only transcriber filled while this call was going, and — once
    // the call ended — its full transcript and a short summary. 10-digit
    // numbers in them go out masked except to the CRM owner.
    callCapture: { type: mongoose.Schema.Types.ObjectId, ref: 'CallCapture' },
    transcript : [{ _id: false, role: { type: String, enum: ['customer', 'operator'] }, text: String, at: Date }],
    summary    : { type: String },

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

    // An incoming call answered on a ring PHONE, as Plivo reported it live
    // (the phone Dial's callbackUrl, callController.js dialEvent), so the
    // CRM can show it and offer Transfer while it lasts. answeredIn:
    // 'phone' only (an in-app answer is claimed by the CRM itself).
    // answeredLegId: Plivo's UUID of that phone leg; answeredLegEndedAt:
    // when that phone hung up (the call itself may go on — a transfer).
    answeredIn        : { type: String, enum: ['phone'] },
    answeredLegId     : { type: String },
    answeredLegEndedAt: { type: Date },

    // Live transfers of an incoming call from the CRM (callController.js
    // transferCall), oldest first. Each: {by, byName, at, targets (user ids
    // rung), steps (e.g. ["english","all","back_app"]), outcome, answeredBy,
    // answeredByName, answeredAt, error}. outcome: 'ringing' while it rings,
    // then 'answered', 'rang_back' (answered by the ring-back group),
    // 'not_answered', 'caller_hung_up' or 'failed'. At most one is ringing.
    transfers : { type: [mongoose.Schema.Types.Mixed], default: undefined },
    // The recording of each part after a transfer: {part (the transfer's
    // index), url, id, sec}. The part before any transfer stays in
    // recordingUrl/recordingSec. url and id stay server-side.
    recordings: { type: [mongoose.Schema.Types.Mixed], default: undefined },

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
    // A transfer of this call ended with nobody taking it — nobody answered,
    // ring-back included, or the caller hung up while on hold. The call is
    // "completed" (someone spoke to the caller first), but the caller still
    // needs help: it is queued for a callback like a missed call, and never
    // retracted as "answered after all". Cleared if Plivo then reports the
    // transfer answered after all.
    transferUnanswered: { type: Date },
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
    if (Array.isArray(ret.transcript)) ret.transcript = ret.transcript.map((t) => ({ ...t, text: maskNumbersInText(t.text) }));
    if (ret.summary) ret.summary = maskNumbersInText(ret.summary);
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
    // A transfer's part was answered by someone if Plivo gave it a length,
    // or (length not reported yet) its transfer was answered.
    if (Array.isArray(ret.recordings)) {
      const answeredParts = new Set((ret.transfers || [])
        .map((t, i) => (['answered', 'rang_back'].includes(t?.outcome) ? i : null)).filter((i) => i != null));
      ret.recordings = ret.recordings
        .filter((r) => r?.url && (Number(r.sec) > 0 || (r.sec == null && answeredParts.has(Number(r.part)))))
        .map((r) => ({ part: Number(r.part), sec: r.sec ?? null }));
    }
    if (Array.isArray(ret.transfers)) ret.transfers = ret.transfers.map(({ targets, englishRung, ...t }) => ({ ...t, targetCount: (targets || []).length }));
    return ret;
  },
});

module.exports = mongoose.model('CallLog', CallLogSchema);
