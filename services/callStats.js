'use strict';
/**
 * services/callStats.js
 * ============================================================
 * Call counts and call classification computed IN MONGODB over every
 * matching CallLog — never over a loaded, capped page — for the customer
 * overview and the Call Logs "By customer" / "All call events" views.
 * Read-only. Requires MongoDB 4.2+ (the installed driver's minimum; the
 * stages here need 4.0+); scripts/check-mongo-compat.js checks a server
 * read-only.
 *
 * METRIC DEFINITIONS (docs/CUSTOMER-CALL-METRICS.md has the full text)
 *
 *   Call record    one CallLog document. Its legs (agent leg, customer leg,
 *                  in-app leg, ring-phone leg, transfers, recordings) live
 *                  on that one record.
 *   Logical call   all records RELIABLY LINKED to one call: records with the
 *                  same Plivo CallUUID (providerCallId) — e.g. a replayed
 *                  hang-up webhook that logged the call twice. A record with
 *                  no CallUUID is a call on its own. Test rings excluded.
 *
 *   CANONICAL CALL — decided from ALL its linked records, BEFORE any filter:
 *     at          the EARLIEST record's startedAt (createdAt if missing)
 *     direction   the earliest record's direction
 *     number      the number on the earliest record that has one
 *     staff       everyone who handled ANY of its records: agentUser
 *                 (answered / placed) and transfers.answeredBy
 *     kind        driver if any record is a masked trip call, else
 *                 incoming (inbound) / outgoing (outbound)
 *     outcome     the strongest any record shows —
 *                   incoming: answered > missed > unconfirmed > in progress
 *                   outgoing / driver: connected > not connected
 *   Filters (period, dates, staff, direction, outcome, customer, search)
 *   then INCLUDE OR EXCLUDE WHOLE CALLS by these canonical values, so no
 *   filter can change a call's outcome, time or number.
 *
 *   Evidence (unchanged): answered / connected = status `completed`, which
 *   is written only from Plivo's own report that the call connected — the
 *   Dial result for an incoming call (staff took the caller) or the
 *   customer's leg for an outgoing one, and the other party's leg for a
 *   masked trip call. `agent_answered` (our agent / the driver picked up),
 *   an "answered" claim from the app, talk time or a recording URL alone
 *   is NOT a connection.
 *
 *   Incoming     answered  completed
 *                missed    missed / no_agents / not_routed
 *                unconfirmed  still ringing/initiated/agent_answered but the
 *                          hang-up arrived or it is older than any call can
 *                          last (utils/callLiveness)
 *                in progress  anything else
 *   Outgoing     attempts, connected (completed), callback attempts (context
 *                call_back or linked to a callback task)
 *   driverCalls  masked driver<->customer trip calls (not staff work)
 *   Periods      by the canonical `at`, India time (IST) day boundaries:
 *                today / last 7 days (today + 6) / last 30 days (today + 29)
 *                / all time.
 *   NOT calls    outcomes logged by hand (WhatsApp chats, callback task
 *                resolutions, lead notes).
 *
 * How a filtered query finds its calls without reading every record:
 *   1. CANDIDATE records: inside the date range (the earliest record of any
 *      call in range is in range) and on the searched number(s);
 *   2. their CallUUIDs (one indexed distinct);
 *   3. every record that is a candidate without a CallUUID, or carries one
 *      of those CallUUIDs (indexed $in) — i.e. ALL linked records of every
 *      candidate call, wherever they fall;
 *   4. grouped per call, canonical fields computed, filters applied.
 * With no date or number filter (or more than LINK_MAX CallUUIDs) every
 * record is read and grouped; the filters on the canonical call still
 * decide, so the result is the same.
 * ============================================================
 */
const mongoose = require('mongoose');
const { ACTIVE_STATUSES, MAX_LIVE_MS } = require('../utils/callLiveness');

const MISSED_STATUSES = ['missed', 'no_agents', 'not_routed'];
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const PERIODS = ['today', 'last7Days', 'last30Days', 'allTime'];
const NOT_TEST = { context: { $ne: 'test_ring' } };
// Above this many candidate CallUUIDs, read every record instead of an $in.
const LINK_MAX = 50000;

function istDayStart(now = Date.now()) {
  const t = new Date(now).getTime();
  return Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}
// { today, last7Days, last30Days, allTime } -> lower bound (ms) or null.
function periodStarts(now = Date.now()) {
  const d0 = istDayStart(now);
  return { today: d0, last7Days: d0 - 6 * DAY_MS, last30Days: d0 - 29 * DAY_MS, allTime: null };
}
function periodInfo(now = Date.now()) {
  const p = periodStarts(now);
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  return { timezone: 'Asia/Kolkata', asOf: new Date(now).toISOString(), from: { today: iso(p.today), last7Days: iso(p.last7Days), last30Days: iso(p.last30Days), allTime: null } };
}

const emptyCounts = () => ({
  incoming: { total: 0, answered: 0, missed: 0, unconfirmed: 0, inProgress: 0 },
  outgoing: { attempts: 0, connected: 0, callbackAttempts: 0, callbackConnected: 0 },
  driverCalls: 0,
});
// [path, condition on the canonical call]
const METRICS = [
  ['incoming.total', { $eq: ['$kind', 'incoming'] }],
  ['incoming.answered', { $eq: ['$outcome', 'answered'] }],
  ['incoming.missed', { $eq: ['$outcome', 'missed'] }],
  ['incoming.unconfirmed', { $eq: ['$outcome', 'unconfirmed'] }],
  ['incoming.inProgress', { $eq: ['$outcome', 'in_progress'] }],
  ['outgoing.attempts', { $eq: ['$kind', 'outgoing'] }],
  ['outgoing.connected', { $and: [{ $eq: ['$kind', 'outgoing'] }, { $eq: ['$outcome', 'connected'] }] }],
  ['outgoing.callbackAttempts', { $and: [{ $eq: ['$kind', 'outgoing'] }, '$callback'] }],
  ['outgoing.callbackConnected', { $and: [{ $eq: ['$kind', 'outgoing'] }, '$callback', { $eq: ['$outcome', 'connected'] }] }],
  ['driverCalls', { $eq: ['$kind', 'driver'] }],
];
const fieldName = (period, path) => `${period}__${path.replace('.', '_')}`;

// What each record contributes to its call (computed per record).
function recordProjection(now, withRecords = false) {
  const staleBefore = new Date(now - MAX_LIVE_MS);
  const at = { $ifNull: ['$startedAt', '$createdAt'] };
  return {
    _k: { $ifNull: ['$providerCallId', { $concat: ['row:', { $toString: '$_id' }] }] },
    at,
    direction: 1,
    phone: { $cond: [{ $in: [{ $ifNull: ['$customerPhone', ''] }, ['']] }, null, '$customerPhone'] },
    masked: { $eq: ['$tripMasked', true] },
    completed: { $eq: ['$status', 'completed'] },
    missed: { $in: ['$status', MISSED_STATUSES] },
    // utils/callLiveness: an "active" status that can no longer be true.
    unconfirmed: { $and: [
      { $in: ['$status', ACTIVE_STATUSES] },
      { $or: [{ $gt: ['$endedAt', null] }, { $lt: [at, staleBefore] }] },
    ] },
    cb: { $and: [{ $eq: ['$direction', 'outbound'] }, { $ne: ['$tripMasked', true] }, { $or: [{ $eq: ['$context', 'call_back'] }, { $gt: ['$callbackTask', null] }] }] },
    agentUser: { $ifNull: ['$agentUser', null] },
    transferredTo: { $ifNull: ['$transfers.answeredBy', []] },
    agentName: { $ifNull: ['$agentName', null] },
    talkSec: { $ifNull: ['$talkSec', 0] },
    // per-record staff detail (GET /api/calls/performance credits people)
    ...(withRecords === 'staff' ? {
      answeredAt: { $ifNull: ['$answeredAt', null] },
      xfer: { $map: { input: { $ifNull: ['$transfers', []] }, in: { o: '$$this.outcome', by: '$$this.answeredBy' } } },
    } : {}),
  };
}

// One group per call. "Earliest" / "latest" values come from $min / $max
// over { a: time, i: record id, … } — documents compare field by field, so
// the earliest (time, then id) record wins without sorting.
const tagged = (extra) => ({ a: '$at', i: '$_id', ...extra });
function groupStage(withRecords) {
  return { $group: {
    _id: '$_k',
    first: { $min: tagged({ d: '$direction' }) },
    firstPhone: { $min: { $cond: [{ $gt: ['$phone', null] }, tagged({ p: '$phone' }), null] } }, // $min ignores null
    masked: { $max: '$masked' },
    completed: { $max: '$completed' },
    missed: { $max: '$missed' },
    unconfirmed: { $max: '$unconfirmed' },
    callback: { $max: '$cb' },
    agents: { $addToSet: '$agentUser' },
    transferredTo: { $push: '$transferredTo' },
    lastNamed: { $max: { $cond: [{ $gt: ['$agentName', null] }, tagged({ n: '$agentName' }), null] } },
    connectedNamed: { $max: { $cond: [{ $and: ['$completed', { $gt: ['$agentName', null] }] }, tagged({ n: '$agentName' }), null] } },
    talkSec: { $max: '$talkSec' },
    rows: { $sum: 1 },
    lastRecordAt: { $max: '$at' },
    ...(withRecords ? { recs: { $push: {
      _id: '$_id', at: '$at', phone: '$phone',
      ...(withRecords === 'staff' ? { completed: '$completed', agentUser: '$agentUser', answeredAt: '$answeredAt', xfer: '$xfer' } : {}),
    } } } : {}),
  } };
}

// The canonical call fields from a group.
const canonicalStages = () => [
  { $addFields: {
    at: '$first.a',
    direction: '$first.d',
    phone: '$firstPhone.p', // the number on the earliest record that has one
    handlers: { $setUnion: [
      { $filter: { input: '$agents', cond: { $gt: ['$$this', null] } } },
      { $reduce: { input: '$transferredTo', initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } },
    ] },
    // display: the agent on a connected record, else the latest named one
    staffName: { $ifNull: ['$connectedNamed.n', '$lastNamed.n'] },
    kind: { $cond: ['$masked', 'driver', { $cond: [{ $eq: ['$first.d', 'inbound'] }, 'incoming', 'outgoing'] }] },
  } },
  { $project: { first: 0, firstPhone: 0, agents: 0, transferredTo: 0, lastNamed: 0, connectedNamed: 0 } },
  { $addFields: {
    outcome: { $switch: { branches: [
      { case: { $ne: ['$kind', 'incoming'] }, then: { $cond: ['$completed', 'connected', 'not_connected'] } },
      { case: '$completed', then: 'answered' },
      { case: '$missed', then: 'missed' },
      { case: '$unconfirmed', then: 'unconfirmed' },
    ], default: 'in_progress' } },
    connected: { $and: ['$completed', { $ne: ['$kind', 'driver'] }] },
  } },
];

// The filters, applied to CANONICAL calls (see the header).
//   post: { from, to (Date), staff (ObjectId|string), kind, outcome, phone (a $match condition) }
const OUTCOME_MATCH = {
  answered: { kind: 'incoming', outcome: 'answered' },
  missed: { kind: 'incoming', outcome: 'missed' },
  unconfirmed: { kind: 'incoming', outcome: 'unconfirmed' },
  in_progress: { kind: 'incoming', outcome: 'in_progress' },
  connected: { kind: 'outgoing', outcome: 'connected' },
  not_connected: { kind: 'outgoing', outcome: 'not_connected' },
};
function postMatch(post = {}) {
  const and = [];
  if (post.from || post.to) and.push({ at: { ...(post.from ? { $gte: post.from } : {}), ...(post.to ? { $lt: post.to } : {}) } });
  if (post.staff) and.push({ handlers: new mongoose.Types.ObjectId(String(post.staff)) });
  if (post.kind) and.push({ kind: post.kind });
  if (post.outcome) and.push(OUTCOME_MATCH[post.outcome] || { outcome: '__none__' });
  if (post.phone) and.push({ phone: post.phone });
  return and.length ? [{ $match: { $and: and } }] : [];
}

/**
 * Stages: records -> ONE canonical document per logical call -> the filters.
 *   match        a CallLog $match that contains EVERY linked record of each
 *                wanted call (callPipeline builds it); test rings excluded
 *   post         the filters on the canonical call (postMatch)
 *   withRecords  also keep recs [{ _id, at, phone }] (for listing records);
 *                'staff' adds per record { completed, agentUser, answeredAt,
 *                xfer: [{ o: outcome, by: answeredBy }] } (performance credit)
 * Output fields: _id (call key), at, direction, phone, kind, outcome,
 * completed, missed, unconfirmed, connected, callback, handlers, staffName,
 * talkSec, rows, lastRecordAt[, recs].
 */
function callStages({ match = {}, post = {}, now = Date.now(), withRecords = false } = {}) {
  return [
    { $match: { $and: [match, NOT_TEST] } },
    { $project: recordProjection(now, withRecords) },
    groupStage(withRecords),
    ...canonicalStages(),
    ...postMatch(post),
  ];
}

/**
 * The full pipeline for candidate records (see the header): finds the
 * candidates' CallUUIDs, then reads every linked record.
 *   candidate  a CallLog $match on records (dates, number); {} = everything
 */
async function callPipeline({ candidate = {}, post = {}, now = Date.now(), withRecords = false, CallLog = require('../models/CallLog') } = {}) { // eslint-disable-line global-require
  if (!Object.keys(candidate).length) return callStages({ match: {}, post, now, withRecords });
  const keys = await CallLog.distinct('providerCallId', { $and: [candidate, NOT_TEST, { providerCallId: { $type: 'string' } }] });
  if (keys.length > LINK_MAX) return callStages({ match: {}, post, now, withRecords });
  const match = { $or: [{ $and: [candidate, { providerCallId: null }] }, ...(keys.length ? [{ providerCallId: { $in: keys } }] : [])] };
  return callStages({ match, post, now, withRecords });
}

/**
 * Stages that list the RECORDS of the calls a pipeline produced, newest
 * first: each call's records that themselves match `recordMatch` (on
 * recs.at / recs.phone — the dates and number), after an optional keyset.
 * Output: { _id (record id), at }.
 */
function recordListStages({ recordMatch = {}, keyset = null } = {}) {
  return [
    { $unwind: '$recs' },
    { $project: { _id: '$recs._id', at: '$recs.at', phone: '$recs.phone', call: '$_id' } },
    ...(Object.keys(recordMatch).length ? [{ $match: recordMatch }] : []),
    ...(keyset ? [{ $match: { $or: [{ at: { $lt: keyset.at } }, { at: keyset.at, _id: { $lt: keyset.id } }] } }] : []),
    { $sort: { at: -1, _id: -1 } },
  ];
}

// Accumulators for the 4 periods (counts) — on canonical calls.
function periodAccumulators(now = Date.now()) {
  const starts = periodStarts(now);
  const acc = {};
  for (const period of PERIODS) {
    const since = starts[period];
    for (const [path, cond] of METRICS) {
      const all = since == null ? cond : { $and: [cond, { $gte: ['$at', new Date(since)] }] };
      acc[fieldName(period, path)] = { $sum: { $cond: [all, 1, 0] } };
    }
  }
  return acc;
}
function countsFromGroup(g) {
  const out = {};
  for (const period of PERIODS) {
    const c = emptyCounts();
    for (const [path] of METRICS) {
      const v = Number(g?.[fieldName(period, path)]) || 0;
      const [a, b] = path.split('.');
      if (b) c[a][b] = v; else c[a] = v;
    }
    out[period] = c;
  }
  return out;
}

const OUTCOME_LABEL = { answered: 'Answered', missed: 'Missed', unconfirmed: 'Status unconfirmed', in_progress: 'In progress', connected: 'Connected', not_connected: 'Not connected' };
const callSummary = (c) => (c ? {
  at: c.at, direction: c.direction, kind: c.kind, outcome: c.outcome, outcomeLabel: OUTCOME_LABEL[c.outcome],
  staff: c.staffName || null, talkSec: Number(c.talkSec) > 0 ? Number(c.talkSec) : 0, callback: !!c.callback,
} : null);

/**
 * One customer's number: counts over every call, plus the last attempt and
 * the last connected conversation — all canonical calls (the number is the
 * call's canonical number).
 */
async function customerCallStats(phone10, { now = Date.now(), CallLog = require('../models/CallLog') } = {}) { // eslint-disable-line global-require
  const staffCall = { $ne: ['$kind', 'driver'] };
  const [r] = await CallLog.aggregate([
    ...(await callPipeline({ candidate: { customerPhone: phone10 }, post: { phone: phone10 }, now, CallLog })),
    { $facet: {
      totals: [{ $group: { _id: null, logicalCalls: { $sum: 1 }, rows: { $sum: '$rows' }, firstAt: { $min: '$at' }, ...periodAccumulators(now) } }],
      lastAttempt: [{ $match: { $expr: staffCall } }, { $sort: { at: -1, _id: -1 } }, { $limit: 1 }],
      lastConnected: [{ $match: { $expr: { $and: [staffCall, '$completed'] } } }, { $sort: { at: -1, _id: -1 } }, { $limit: 1 }],
    } },
  ]).allowDiskUse(true);
  const g = r?.totals?.[0];
  return {
    counts: countsFromGroup(g), logicalCalls: g?.logicalCalls || 0, rows: g?.rows || 0, firstCallAt: g?.firstAt || null, period: periodInfo(now),
    lastAttempt: callSummary(r?.lastAttempt?.[0]), lastConnected: callSummary(r?.lastConnected?.[0]),
  };
}


module.exports = {
  MISSED_STATUSES, IST_OFFSET_MS, PERIODS, OUTCOME_LABEL,
  istDayStart, periodStarts, periodInfo, emptyCounts,
  LINK_MAX, callStages, callPipeline, recordListStages, postMatch, periodAccumulators, countsFromGroup, customerCallStats, callSummary,
};
