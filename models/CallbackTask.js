'use strict';
const mongoose = require('mongoose');
const { maskPhone } = require('../utils/customerPhone');
const { fullPhone } = require('../utils/phoneViewer');

// One customer to call back: every missed incoming call from one number
// while its task is open is grouped here (services/callbackQueue.js), each
// call kept as a link to its CallLog. At most ONE open task per number —
// enforced by the partial unique index below, so two Plivo reports
// processed at the same moment can never open two.
//
// A task only ever leaves "open" by a person resolving it with an outcome
// (POST /api/callbacks/:id/resolve). Placing a callback, or a later
// connected call, never resolves it — those are shown as attempts and
// evidence. Every change by a person is appended to `events` with who and
// when; `rev` makes concurrent edits by two operators fail loudly instead
// of overwriting each other.
//
// The number is select:false and stripped from JSON like CallLog's: masked
// for everyone, in full only for a CRM owner (utils/phoneViewer).

const OUTCOMES = {
  reached          : 'Spoke to the customer',
  booked           : 'Booked a trip',
  not_needed       : 'Customer no longer needs help',
  wrong_number     : 'Wrong number',
  unreachable      : 'Could not reach after trying',
  handled_elsewhere: 'Already handled elsewhere',
  other            : 'Other',
};
// These need a short reason, so the closed task explains itself.
const NOTE_REQUIRED = ['unreachable', 'handled_elsewhere', 'other'];

const actor = {
  by    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String },
};

const CallbackTaskSchema = new mongoose.Schema(
  {
    customerPhone: { type: String, required: true, select: false }, // normalised, 10 digits
    // withdrawn: every call on it was later reported answered — there was
    // nothing to call back (services/callbackQueue.js retractAnswered).
    state : { type: String, enum: ['open', 'resolved', 'withdrawn'], default: 'open', index: true },
    // missed_call: queued automatically. not_routed: added by a person from
    // the "Not routed by CRM" list.
    source: { type: String, enum: ['missed_call', 'not_routed'], default: 'missed_call' },

    calls: [{
      _id   : false,
      call  : { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
      at    : { type: Date },   // when the customer called
      status: { type: String }, // the call's status when it was queued
      // Plivo later reported this call answered: kept for the record, no
      // longer counted as missed.
      answeredLater  : { type: Boolean },
      answeredLaterAt: { type: Date },
    }],
    missedCount  : { type: Number, default: 0 },
    firstMissedAt: { type: Date },
    lastMissedAt : { type: Date, index: true },
    lastQueuedAt : { type: Date }, // when the latest missed call joined this task

    // What we know about the caller (from the latest call that had it).
    trip: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },

    assignedTo    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String },
    nextCallbackAt: { type: Date },
    scheduledAt   : { type: Date }, // when nextCallbackAt was set

    withdrawn: {
      at    : { type: Date },
      reason: { type: String },
    },

    resolution: {
      outcome: { type: String, enum: Object.keys(OUTCOMES) },
      note   : { type: String },
      at     : { type: Date },
      ...actor,
    },

    // Append-only history. System entries (missed_again, ...) have no `by`.
    events: [{
      _id   : false,
      type  : { type: String, required: true },
      at    : { type: Date, default: Date.now },
      ...actor,
      detail: { type: mongoose.Schema.Types.Mixed },
    }],

    rev: { type: Number, default: 0 },
  },
  { timestamps: true },
);

CallbackTaskSchema.index({ customerPhone: 1 }, { unique: true, partialFilterExpression: { state: 'open' }, name: 'one_open_task_per_number' });
CallbackTaskSchema.index({ 'calls.call': 1 });
CallbackTaskSchema.index({ customerPhone: 1, state: 1, 'resolution.at': -1 });

CallbackTaskSchema.set('toJSON', {
  transform(doc, ret) {
    if ('customerPhone' in ret) {
      ret.customerMasked = maskPhone(ret.customerPhone);
      const full = fullPhone(ret.customerPhone); // CRM owner only
      delete ret.customerPhone;
      if (full) ret.customerPhone = full;
    }
    if (ret.resolution?.outcome) ret.resolution.outcomeLabel = OUTCOMES[ret.resolution.outcome];
    return ret;
  },
});

const CallbackTask = mongoose.model('CallbackTask', CallbackTaskSchema);
module.exports = CallbackTask;
module.exports.OUTCOMES = OUTCOMES;
module.exports.NOTE_REQUIRED = NOTE_REQUIRED;
