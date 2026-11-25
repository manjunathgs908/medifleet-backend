'use strict';
/**
 * controllers/callHistoryController.js
 * ============================================================
 * READ-ONLY views over CallLog for the CRM Call Logs page. Nothing here
 * places, changes or records a call (calling/recording logic lives in
 * callController.js and is untouched).
 *
 *   GET /api/calls/history    "All call events": call RECORDS (CallLog
 *                             rows), newest first, as the existing call
 *                             cards (same JSON as GET /api/calls/logs —
 *                             numbers masked except for the owner;
 *                             recordings via the existing streaming route).
 *                             Totals state both records and logical calls;
 *                             `sameCall` marks rows that are one of several
 *                             records of ONE call, with that call's outcome.
 *   GET /api/calls/customers  "By customer": one row per customer number,
 *                             counted per logical call.
 *
 * ONE RULE for both views and the customer overview (services/callStats.js):
 * every logical call is first rebuilt from ALL its reliably linked records
 * (same Plivo CallUUID) — its time is the earliest record's, its staff is
 * everyone who handled any record, its number is the earliest record's, its
 * outcome the strongest any record shows — and only then do the filters
 * include or exclude WHOLE calls. Changing a filter never changes a call's
 * outcome. "All call events" lists the records inside the chosen dates (and
 * on the searched number) of the calls that are included.
 *
 * Filters (all server-side):
 *   q          name (from enquiries / bookings) or at least 3 digits of the
 *              number (matched at the end; digits only). A name is matched
 *              against EVERY enquiry and booking (no row limit); the first
 *              page reports `search: { by, numbers, complete: true }`. If a
 *              name matches more than NAME_MATCH_MAX numbers the request is
 *              refused with a clear message — never silently cut short.
 *   period     today | 7d | 30d | all   (IST boundaries, on the call's time), or
 *   from, to   YYYY-MM-DD India dates (inclusive)
 *   staff      a user id — calls they handled (on any linked record: placed,
 *              answered, or took as a transfer). Owner: anyone; telecaller:
 *              themselves only — the same rule and message as
 *              GET /api/calls/logs?agent= on main. Without `staff` a
 *              telecaller sees every call, exactly as on GET /api/calls/logs.
 *   direction  incoming | outgoing | driver   (the call's kind)
 *   outcome    answered | missed | unconfirmed | in_progress  (incoming)
 *              connected | not_connected                        (outgoing)
 *              (the call's canonical outcome)
 *   customerRef  (history only) one customer
 *   cursor, limit  stable keyset pagination (opaque cursor; never a number)
 * ============================================================
 */
const mongoose = require('mongoose');
const CallLog = require('../models/CallLog');
const { Lead, Trip } = require('../models');
const { maskPhone, customerRef, phoneFromRef } = require('../utils/customerPhone');
const { fullPhone } = require('../utils/phoneViewer');
const { normalisePhone } = require('../utils/phone');
const stats = require('../services/callStats');

const DAY_MS = 24 * 3600 * 1000;
// Distinct customer numbers a name search may expand to. Far above any real
// name; beyond it the search is refused with a message, never truncated.
const NAME_MATCH_MAX = 20000;
const isObjectId = (v) => mongoose.isValidObjectId(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Opaque, tamper-evident-enough cursor (base64url JSON). Never carries a
// phone number: the customers cursor carries the customerRef instead.
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function dec(s) {
  if (!s) return null;
  try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return undefined; }
}

function istDate(s, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return undefined;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Refuse dates that roll over (2026-13-01, 2026-02-30) instead of guessing.
  if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return undefined;
  return new Date(day.getTime() - stats.IST_OFFSET_MS + (endOfDay ? DAY_MS : 0));
}

const KIND = { incoming: 'incoming', outgoing: 'outgoing', driver: 'driver' };

// Builds the shared filter.
// Returns { candidate, post, recordMatch, search } or { error, status }:
//   candidate  records that can belong to a wanted call (dates, number)
//   post       the filters on the canonical call (services/callStats postMatch)
async function buildFilter(req, { now = Date.now() } = {}) {
  const q = req.query;
  const and = [];
  const post = {};
  let search = null;
  const phoneConds = [];

  // Period: preset or explicit India dates — on the CALL's time (its earliest
  // record). That record is inside the range, so records in range are the
  // candidates.
  if (q.from || q.to) {
    const from = q.from ? istDate(q.from, false) : null;
    const to = q.to ? istDate(q.to, true) : null;
    if (from === undefined || to === undefined || (from && to && from >= to)) return { error: 'Give dates as YYYY-MM-DD, from on or before to.' };
    if (from) post.from = from;
    if (to) post.to = to;
  } else if (q.period && q.period !== 'all') {
    const starts = stats.periodStarts(now);
    const since = { today: starts.today, '7d': starts.last7Days, '30d': starts.last30Days }[q.period];
    if (since == null) return { error: 'Unknown period.' };
    post.from = new Date(since);
  }
  if (post.from || post.to) and.push({ startedAt: { ...(post.from ? { $gte: post.from } : {}), ...(post.to ? { $lt: post.to } : {}) } });

  if (q.customerRef) {
    const phone = normalisePhone(phoneFromRef(String(q.customerRef)) || '');
    if (phone.length !== 10) return { error: 'Unknown customer reference.' };
    phoneConds.push(phone);
  }

  if (q.staff) {
    const staff = String(q.staff);
    if (!isObjectId(staff)) return { error: 'Unknown staff member.' };
    // Same rule and wording as GET /api/calls/logs?agent= (main): someone
    // else's call list is their performance, which only the owner sees.
    if (req.user.role !== 'owner' && staff !== String(req.user._id)) return { error: 'You can filter by your own calls only.', status: 403 };
    post.staff = staff;
  }

  if (q.direction) {
    if (!KIND[q.direction]) return { error: 'Unknown direction.' };
    post.kind = KIND[q.direction];
  }

  if (q.outcome) {
    if (!['answered', 'missed', 'unconfirmed', 'in_progress', 'connected', 'not_connected'].includes(q.outcome)) return { error: 'Unknown outcome.' };
    post.outcome = q.outcome;
  }

  // Search: digits -> end of the number; words -> names on enquiries/bookings.
  const text = String(q.q || '').trim();
  if (text) {
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 3 && digits.length === text.replace(/[\s+-]/g, '').length) {
      phoneConds.push({ $regex: `${escapeRe(digits.slice(-10))}$` });
      search = { by: 'digits', complete: true };
    } else if (text.length >= 2) {
      // Every matching enquiry and booking, not the first N: distinct
      // numbers are few even when the rows are many.
      const re = new RegExp(escapeRe(text), 'i');
      const [leadPhones, tripPhones] = await Promise.all([
        Lead.distinct('phone', { patientName: re }),
        Trip.distinct('patientPhone', { patientName: re }),
      ]);
      const phones = [...new Set([...leadPhones, ...tripPhones].map((p) => normalisePhone(String(p || ''))).filter((p) => p.length === 10))];
      if (phones.length > NAME_MATCH_MAX) {
        return { error: `“${text}” matches ${phones.length} customer numbers — too many to search at once. Type more of the name, or search by the last digits of the number.` };
      }
      phoneConds.push({ $in: phones });
      search = { by: 'name', numbers: phones.length, complete: true };
    } else {
      return { error: 'Type at least 2 letters or 3 digits.' };
    }
  }
  // The number: the call's number (its earliest record's) must match; the
  // records on that number are the candidates.
  // (customerRef + a search: both must hold for the same number.)
  and.push(...phoneConds.map((c) => ({ customerPhone: c })));
  if (phoneConds.length === 1) [post.phone] = phoneConds;
  else if (phoneConds.length > 1) post.phoneAll = phoneConds;
  // Which of an included call's records are listed: those inside the dates
  // and on the number (the same conditions as the candidates).
  const recordMatch = {};
  if (post.from || post.to) recordMatch.at = { ...(post.from ? { $gte: post.from } : {}), ...(post.to ? { $lt: post.to } : {}) };
  if (phoneConds.length) recordMatch.$and = phoneConds.map((c) => ({ phone: c }));
  return { candidate: and.length ? { $and: and } : {}, post, recordMatch, search };
}

// Canonical calls for the filter (services/callStats callPipeline);
// postMatch takes one phone condition, two (customerRef + search) are ANDed.
async function callsFor(built, now, { withRecords = false } = {}) {
  const { phoneAll, ...post } = built.post;
  const stages = await stats.callPipeline({ candidate: built.candidate, post, now, withRecords, CallLog });
  return phoneAll ? [...stages, { $match: { $and: phoneAll.map((c) => ({ phone: c })) } }] : stages;
}
// No filter at all: every call is included and every record listed.
const unfiltered = (built) => !Object.keys(built.candidate).length && !Object.keys(built.post).length;
const NOT_TEST = { context: { $ne: 'test_ring' } };

const pageLimit = (v, def = 50) => Math.min(Math.max(parseInt(v, 10) || def, 1), 100);
const SORT = { startedAt: -1, _id: -1 };
const withCards = (q) => q
  .select('+customerPhone') // for toJSON: masked, or in full for a CRM owner
  .populate('trip', 'tripNumber patientName')
  .populate('lead', 'patientName');

// Rows on this page that are one of several records of the same call
// (a replayed Plivo webhook): { [rowId]: { records, kind, outcome } } with
// the call's canonical outcome. Rows that are a call on their own are absent.
async function sameCallOf(rows, now) {
  const keys = [...new Set(rows.map((l) => l.providerCallId).filter(Boolean))];
  if (!keys.length) return {};
  const g = await CallLog.aggregate([
    ...(await stats.callPipeline({ candidate: { providerCallId: { $in: keys } }, now, CallLog })),
    { $match: { rows: { $gt: 1 } } },
    { $project: { rows: 1, kind: 1, outcome: 1 } },
  ]);
  const byKey = new Map(g.map((x) => [x._id, x]));
  const out = {};
  for (const l of rows) {
    const x = l.providerCallId && byKey.get(l.providerCallId);
    if (x) out[String(l._id)] = { records: x.rows, kind: x.kind, outcome: x.outcome };
  }
  return out;
}

// ------------------------------------------------------------
// GET /api/calls/history — "All call events" (call RECORDS)
// ------------------------------------------------------------
exports.history = async (req, res, next) => {
  try {
    const now = Date.now();
    const built = await buildFilter(req, { now });
    if (built.error) return bad(res, built.error, built.status);
    const limit = pageLimit(req.query.limit);
    const cur = dec(req.query.cursor);
    if (cur === undefined || (cur && (!Number.isFinite(cur.t) || !isObjectId(cur.id)))) return bad(res, 'Invalid cursor.');

    // Keyset on (time desc, _id desc): rows added later never shift a page.
    let ids; let totals = null;
    if (unfiltered(built)) {
      // Every record of every call: straight from the collection.
      const page = cur ? { $and: [NOT_TEST, { $or: [{ startedAt: { $lt: new Date(cur.t) } }, { startedAt: new Date(cur.t), _id: { $lt: new mongoose.Types.ObjectId(cur.id) } }] }] } : NOT_TEST;
      ids = await CallLog.find(page).select('_id').sort(SORT).limit(limit + 1).lean();
      if (!cur) {
        const [n, g] = await Promise.all([
          CallLog.countDocuments(NOT_TEST),
          CallLog.aggregate([...(await callsFor(built, now)), { $group: { _id: null, logicalCalls: { $sum: 1 }, ...stats.periodAccumulators(now) } }]).allowDiskUse(true),
        ]);
        totals = { records: n, calls: g[0] };
      }
    } else {
      // The included calls (each decided on all its records), then their
      // records inside the dates / on the number, newest first.
      const calls = await callsFor(built, now, { withRecords: true });
      const keyset = cur ? { at: new Date(cur.t), id: new mongoose.Types.ObjectId(cur.id) } : null;
      const [r] = await CallLog.aggregate([
        ...calls,
        { $facet: {
          page: [...stats.recordListStages({ recordMatch: built.recordMatch, keyset }), { $limit: limit + 1 }, { $project: { _id: 1 } }],
          ...(cur ? {} : {
            records: [...stats.recordListStages({ recordMatch: built.recordMatch }), { $count: 'n' }],
            calls: [{ $group: { _id: null, logicalCalls: { $sum: 1 }, ...stats.periodAccumulators(now) } }],
          }),
        } },
      ]).allowDiskUse(true);
      ids = r?.page || [];
      if (!cur) totals = { records: r?.records?.[0]?.n || 0, calls: r?.calls?.[0] };
    }
    const order = new Map(ids.map((x, i) => [String(x._id), i]));
    const logs = ids.length
      ? (await withCards(CallLog.find({ _id: { $in: ids.map((x) => x._id) } }))).sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)))
      : [];
    const more = logs.length > limit;
    const shown = more ? logs.slice(0, limit) : logs;
    const last = shown[shown.length - 1];
    // Same "Status unconfirmed" check as GET /api/calls/logs (read only).
    try { await require('./callController').markNotLiveOnPlivo(shown); } catch { /* display only */ } // eslint-disable-line global-require
    const sameCall = await sameCallOf(shown, now);

    return res.json({
      success: true,
      logs: shown,
      sameCall,
      nextCursor: more && last ? enc({ t: new Date(last.startedAt || last.createdAt).getTime(), id: String(last._id) }) : null,
      ...(totals ? {
        total: totals.records, logicalCalls: totals.calls?.logicalCalls || 0, counts: stats.countsFromGroup(totals.calls).allTime, period: stats.periodInfo(now),
        ...(built.search ? { search: built.search } : {}),
      } : {}),
    });
  } catch (err) { next(err); }
};

// ------------------------------------------------------------
// GET /api/calls/customers — "By customer"
// ------------------------------------------------------------
exports.customers = async (req, res, next) => {
  try {
    if (req.query.customerRef) return bad(res, 'Open the customer instead.');
    const now = Date.now();
    const built = await buildFilter(req, { now });
    if (built.error) return bad(res, built.error, built.status);
    const limit = pageLimit(req.query.limit, 30);
    const cur = dec(req.query.cursor);
    let curPhone = null;
    if (cur) {
      curPhone = normalisePhone(phoneFromRef(String(cur.r || '')) || '');
      if (!Number.isFinite(cur.t) || curPhone.length !== 10) return bad(res, 'Invalid cursor.');
    } else if (cur === undefined) return bad(res, 'Invalid cursor.');

    const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
    const grouped = [
      ...(await callsFor(built, now)),
      { $match: { phone: { $exists: true, $nin: [null, ''] } } },
      { $group: {
        _id: '$phone',
        lastAt: { $max: '$at' },
        firstAt: { $min: '$at' },
        calls: { $sum: 1 },
        incoming: sum({ $eq: ['$kind', 'incoming'] }),
        answered: sum({ $eq: ['$outcome', 'answered'] }),
        missed: sum({ $eq: ['$outcome', 'missed'] }),
        unconfirmed: sum({ $eq: ['$outcome', 'unconfirmed'] }),
        outgoing: sum({ $eq: ['$kind', 'outgoing'] }),
        connected: sum({ $and: [{ $eq: ['$kind', 'outgoing'] }, { $eq: ['$outcome', 'connected'] }] }),
        driverCalls: sum({ $eq: ['$kind', 'driver'] }),
        lastConnectedAt: { $max: { $cond: ['$connected', '$at', null] } },
      } },
    ];
    const pageMatch = cur ? [{ $match: { $or: [{ lastAt: { $lt: new Date(cur.t) } }, { lastAt: new Date(cur.t), _id: { $lt: curPhone } }] } }] : [];
    const [r] = await CallLog.aggregate([
      ...grouped,
      { $facet: {
        total: [{ $count: 'n' }],
        rows: [...pageMatch, { $sort: { lastAt: -1, _id: -1 } }, { $limit: limit + 1 }],
      } },
    ]).allowDiskUse(true);
    const rows = r?.rows || [];
    const more = rows.length > limit;
    const shown = more ? rows.slice(0, limit) : rows;

    // Names on this page's numbers (enquiries + bookings), never merged.
    const phones = shown.map((x) => x._id);
    const variants = phones.flatMap((p) => [p, `91${p}`, `+91${p}`, `0${p}`]);
    const [leads, trips] = phones.length ? await Promise.all([
      Lead.find({ phone: { $in: variants } }).select('phone patientName').lean(),
      Trip.find({ patientPhone: { $in: variants } }).select('patientPhone patientName').lean(),
    ]) : [[], []];
    const names = new Map();
    for (const [p, n] of [...leads.map((l) => [l.phone, l.patientName]), ...trips.map((t) => [t.patientPhone, t.patientName])]) {
      const k = normalisePhone(p); const v = String(n || '').trim();
      if (!v) continue;
      if (!names.has(k)) names.set(k, new Map());
      names.get(k).set(v.toLowerCase(), v);
    }
    const last = shown[shown.length - 1];
    return res.json({
      success: true,
      customers: shown.map((x) => {
        const nm = [...(names.get(x._id)?.values() || [])];
        const full = fullPhone(x._id); // CRM owner only
        return {
          customerRef: customerRef(x._id),
          customerMasked: maskPhone(x._id),
          ...(full ? { customerPhone: full } : {}),
          names: nm, sharedNumber: nm.length > 1,
          calls: x.calls, incoming: { total: x.incoming, answered: x.answered, missed: x.missed, unconfirmed: x.unconfirmed },
          outgoing: { attempts: x.outgoing, connected: x.connected }, driverCalls: x.driverCalls,
          lastCallAt: x.lastAt, firstCallAt: x.firstAt, lastConnectedAt: x.lastConnectedAt || null,
        };
      }),
      nextCursor: more && last ? enc({ t: new Date(last.lastAt).getTime(), r: customerRef(last._id) }) : null,
      total: r?.total?.[0]?.n || 0,
      period: stats.periodInfo(now),
      ...(built.search && !cur ? { search: built.search } : {}),
    });
  } catch (err) { next(err); }
};

exports._internals = { buildFilter, istDate, enc, dec, NAME_MATCH_MAX };
