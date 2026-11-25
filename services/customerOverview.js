'use strict';
/**
 * services/customerOverview.js
 * ============================================================
 * One customer at a glance, for GET /api/whatsapp/customer/:ref (its
 * `overview`). Grouped by the customer's NUMBER — the identifier every
 * record already shares — never merged by name: when one number carries
 * more than one name, the overview says so (sharedNumber) and keeps them
 * apart.
 *
 * Sources (all existing, read-only):
 *   CallLog       every recorded call with this number (the same set the
 *                 Call Logs / "Recorded calls" list shows: customerPhone =
 *                 the number, test rings excluded)
 *   CallbackTask  missed-call callback tasks (open and resolved)
 *   Lead          enquiries on this number
 *   WhatsApp      bot conversations + call outcomes staff logged by hand
 *   Trip          bookings on this number
 *   Payment       receipts for those bookings — OWNER ONLY
 *
 * Kept separate, never mixed: call outcomes (per call), enquiry status
 * (lead), task status (callback), booking status (trip).
 *
 * Every call is the CANONICAL call of services/callStats: rebuilt from all
 * its linked records (same Plivo CallUUID) before anything is counted or
 * shown — so the counts, the call list, "Last attempt" and "Last spoke"
 * agree with "By customer" and "All call events".
 * Call outcomes use the SAME classification as GET /api/calls/performance
 * (controllers/callController.js) and the existing liveness helper — not a
 * new one:
 *   incoming  answered = status completed; missed = missed / no_agents /
 *             not_routed; unconfirmed = utils/callLiveness; else in progress
 *   outgoing  an attempt; connected = status completed
 * Masked driver<->customer trip calls are counted apart (not staff work).
 * No phone number appears anywhere in the result.
 * ============================================================
 */
const { liveStateOf } = require('../utils/callLiveness');
const { dueStateOf } = require('../utils/callbackDue');
const { maskNumbersInText } = require('../utils/maskNumbersInText');
const callStats = require('./callStats');

// Calls listed in the overview itself; the rest page through
// GET /api/calls/history?customerRef= (all of them, never capped).
const CALLS_SHOWN = 50;
// Calls loaded for the timeline: its newest TIMELINE_MAX entries can hold at
// most TIMELINE_MAX calls, and those are the newest ones — so this is exact.
const TIMELINE_MAX = 300;

const MISSED_STATUSES = ['missed', 'no_agents', 'not_routed']; // as callController.performance
const ACTIVE_TRIP = ['booked', 'dispatched', 'en_route'];
const DAY_MS = 24 * 3600 * 1000;
const TRIP_STATUS = { booked: 'Booked', dispatched: 'Ambulance assigned', en_route: 'On the way', completed: 'Completed', cancelled: 'Cancelled' };
const LEAD_STATUS = { new: 'New', contacted: 'Contacted', converted: 'Booked', lost: 'Lost', spam: 'Spam' };
const CB_OUTCOME = { reached: 'Reached the customer', booked: 'Booked', not_needed: 'Not needed', wrong_number: 'Wrong number', unreachable: 'Unreachable', handled_elsewhere: 'Handled elsewhere', other: 'Other' };
const WA_OUTCOME = { booked: 'Booked', followup: 'Follow up', not_interested: 'Not interested', no_answer: 'No answer' };

const t = (d) => (d ? new Date(d).getTime() : NaN);
const ok = (n) => Number.isFinite(n);
const latest = (rows, at) => rows.filter((r) => ok(t(at(r)))).sort((a, b) => t(at(b)) - t(at(a)))[0] || null;
const dur = (s) => (Number(s) > 0 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : null);

// One call -> { kind, outcome } using the performance classification.
function classify(c, now) {
  if (c.tripMasked) return { kind: 'driver', outcome: c.status === 'completed' ? 'connected' : 'not_connected' };
  if (c.direction === 'inbound') {
    if (c.status === 'completed') return { kind: 'incoming', outcome: 'answered' };
    if (MISSED_STATUSES.includes(c.status)) return { kind: 'incoming', outcome: 'missed' };
    if (liveStateOf(c, { now })?.state === 'unconfirmed') return { kind: 'incoming', outcome: 'unconfirmed' };
    return { kind: 'incoming', outcome: 'in_progress' };
  }
  return { kind: 'outgoing', outcome: c.status === 'completed' ? 'connected' : 'not_connected' };
}
const OUTCOME_LABEL = { answered: 'Answered', missed: 'Missed', unconfirmed: 'Status unconfirmed', in_progress: 'In progress', connected: 'Connected', not_connected: 'Not connected' };
const isCallback = (c) => c.direction === 'outbound' && !c.tripMasked && (c.context === 'call_back' || !!c.callbackTask);

// Rows sharing a Plivo CallUUID are one logical call — the same canonical
// call as services/callStats (give it ALL linked rows): the strongest
// outcome any row shows (completed > missed > unconfirmed > other), the
// EARLIEST row's time and direction, driver if any row is a masked trip
// call, the agent on a connected row (else the latest named one), the
// longest talk time.
function logicalCalls(rows, now = Date.now()) {
  const groups = new Map();
  for (const c of rows || []) {
    const key = c.providerCallId || String(c._id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const rank = (x) => (x.status === 'completed' ? 3 : MISSED_STATUSES.includes(x.status) ? 2 : (liveStateOf(x, { now })?.state === 'unconfirmed' ? 1 : 0));
  const at = (x) => t(x.startedAt || x.createdAt);
  const earlier = (a, b) => at(a) < at(b) || (at(a) === at(b) && String(a._id) < String(b._id));
  return [...groups.values()].map((rs) => {
    if (rs.length === 1) return rs[0];
    const first = rs.reduce((a, b) => (earlier(b, a) ? b : a));
    const best = rs.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    // latest (time, then id) named record — a connected one first
    const latestOf = (xs) => xs.reduce((a, b) => (!a || earlier(a, b) ? b : a), null);
    const named = rs.filter((x) => x.agentName);
    const agent = latestOf(named.filter((x) => x.status === 'completed')) || latestOf(named);
    return {
      ...best,
      _id: first._id, startedAt: first.startedAt, createdAt: first.createdAt, direction: first.direction,
      tripMasked: rs.some((x) => x.tripMasked), callbackTask: rs.find((x) => x.callbackTask)?.callbackTask,
      context: rs.some((x) => x.context === 'call_back') ? 'call_back' : (best.context || first.context),
      agentName: agent?.agentName || null,
      talkSec: Math.max(0, ...rs.map((x) => Number(x.talkSec) || 0)),
      recordingUrl: rs.find((x) => x.recordingUrl)?.recordingUrl, recordingSec: Math.max(0, ...rs.map((x) => Number(x.recordingSec) || 0)),
      records: rs.length,
    };
  });
}

function countCalls(calls, since) {
  const k = { incoming: { total: 0, answered: 0, missed: 0, unconfirmed: 0, inProgress: 0 }, outgoing: { attempts: 0, connected: 0, callbackAttempts: 0, callbackConnected: 0 }, driverCalls: 0 };
  for (const c of calls) {
    if (since && !(t(c.at) >= since)) continue;
    if (c.kind === 'driver') { k.driverCalls += 1; continue; }
    if (c.kind === 'incoming') {
      k.incoming.total += 1;
      if (c.outcome === 'answered') k.incoming.answered += 1;
      else if (c.outcome === 'missed') k.incoming.missed += 1;
      else if (c.outcome === 'unconfirmed') k.incoming.unconfirmed += 1;
      else k.incoming.inProgress += 1;
    } else {
      k.outgoing.attempts += 1;
      if (c.outcome === 'connected') k.outgoing.connected += 1;
      if (c.callback) { k.outgoing.callbackAttempts += 1; if (c.outcome === 'connected') k.outgoing.callbackConnected += 1; }
    }
  }
  return k;
}

function leadHistoryTitle(h) {
  const d = h.detail || {};
  switch (h.type) {
    case 'created': return `Lead added by hand${d.source ? ` (${String(d.source).replace('_', ' ')})` : ''}`;
    case 'assigned': return `Lead assigned to ${d.to}`;
    case 'unassigned': return 'Lead unassigned';
    case 'follow_up_set': return 'Follow-up scheduled';
    case 'follow_up_cleared': return 'Follow-up cleared';
    case 'status': return `Enquiry status: ${LEAD_STATUS[d.from] || d.from || 'New'} → ${LEAD_STATUS[d.to] || d.to}${d.trip ? ` (booking ${d.trip})` : ''}${d.reason ? ` — “${d.reason}”` : ''}`;
    case 'whatsapp_outcome': return `WhatsApp call outcome: ${WA_OUTCOME[d.outcome] || d.outcome}`;
    default: return h.type || 'Lead updated';
  }
}

/**
 * @param d { calls, callbacks, leads, waCalls, conversations, trips, payments? }
 * @param o { role, now }
 */
function computeOverview(d, { role, now = Date.now() } = {}) {
  const owner = role === 'owner';
  // Free text staff or customers typed (notes, enquiry messages, reasons) can
  // hold phone numbers: masked for everyone but the owner.
  const safe = (s) => (s == null || owner ? s : maskNumbersInText(s, { always: true }));
  const shape = (c) => {
    const at = c.startedAt || c.createdAt;
    const { kind, outcome } = classify(c, now);
    return {
      id: String(c._id), at, direction: c.direction, kind, outcome, outcomeLabel: OUTCOME_LABEL[outcome],
      staff: c.agentName || null, talkSec: Number(c.talkSec) > 0 ? Number(c.talkSec) : 0, context: c.context || null,
      callback: isCallback(c),
      // Display only — a recording URL never decides "connected".
      hasRecording: !!c.recordingUrl && (Number(c.recordingSec) > 0 || outcome === 'answered' || outcome === 'connected'),
      driverFrom: c.tripMasked ? (c.tripCallFrom || null) : undefined,
    };
  };
  const calls = logicalCalls(d.calls, now).map(shape).sort((a, b) => t(b.at) - t(a.at));
  const staffCalls = calls.filter((c) => c.kind !== 'driver');
  const connectedCalls = staffCalls.filter((c) => c.outcome === 'answered' || c.outcome === 'connected');
  // Last attempt / last connected: the canonical calls from MongoDB over ALL
  // the number's calls when given (services/callStats — they may be older
  // than the loaded calls, and a replayed record never decides them), else
  // from the loaded (complete) list.
  const lastAttemptCall = d.stats && 'lastAttempt' in d.stats ? d.stats.lastAttempt
    : d.lastAttemptCall !== undefined ? (d.lastAttemptCall && shape(d.lastAttemptCall)) : staffCalls[0];
  const lastConnectedCall = d.stats && 'lastConnected' in d.stats ? d.stats.lastConnected
    : d.lastConnectedCall !== undefined ? (d.lastConnectedCall && shape(d.lastConnectedCall)) : connectedCalls[0];

  const firstContactAt = [
    d.stats?.firstCallAt, ...calls.map((c) => c.at), ...(d.leads || []).map((l) => l.receivedAt || l.createdAt),
    ...(d.conversations || []).map((c) => c.startedAt), ...(d.trips || []).map((tr) => tr.createdAt),
  ].filter((x) => ok(t(x))).sort((a, b) => t(a) - t(b))[0] || null;

  // Counts: over EVERY matching call (services/callStats, in MongoDB) when
  // given; computed here only from a complete list (tests, preview).
  const starts = callStats.periodStarts(now);
  const counts = d.stats?.counts || Object.fromEntries(callStats.PERIODS.map((p) => [p, countCalls(calls, starts[p])]));
  const totalRows = d.stats ? d.stats.rows : (d.calls || []).length;
  const totalLogical = d.stats ? d.stats.logicalCalls : calls.length;

  // Latest staff note, from wherever staff write notes.
  const notes = [
    ...(d.leads || []).flatMap((l) => (l.followUpNotes || []).map((n) => ({ text: safe(n.text), at: n.at, by: n.byName || null, source: 'Lead note' }))),
    ...(d.callbacks || []).filter((c) => c.resolution?.note).map((c) => ({ text: safe(c.resolution.note), at: c.resolution.at, by: c.resolution.byName || null, source: 'Callback outcome' })),
    ...(d.waCalls || []).filter((w) => w.note).map((w) => ({ text: safe(w.note), at: w.createdAt, by: w.calledBy?.name || null, source: 'WhatsApp call note' })),
  ];
  const latestNote = latest(notes, (n) => n.at);

  // Bookings: the CURRENT one (active) apart from the history.
  const trips = [...(d.trips || [])].sort((a, b) => t(b.createdAt) - t(a.createdAt));
  const active = trips.find((tr) => ACTIVE_TRIP.includes(tr.status)) || null;
  const lastTrip = trips[0] || null;
  const bookingOut = (tr) => (tr ? { _id: String(tr._id), tripNumber: tr.tripNumber, patientName: tr.patientName || null, status: tr.status, statusLabel: TRIP_STATUS[tr.status] || tr.status, bookedAt: tr.createdAt, cancelledAt: tr.cancelledAt || null, completedAt: tr.completedAt || null, cancellationReason: tr.status === 'cancelled' ? safe(tr.cancellationReason || null) : null } : null);

  // Enquiry (lead) and callback task: their own statuses, assignees, due times.
  const leads = [...(d.leads || [])].sort((a, b) => t(b.receivedAt || b.createdAt) - t(a.receivedAt || a.createdAt));
  const activeLead = leads.find((l) => ['new', 'contacted'].includes(l.status || 'new') && !l.convertedTrip) || null;
  const openTask = [...(d.callbacks || [])].filter((c) => c.state === 'open').sort((a, b) => t(b.lastMissedAt) - t(a.lastMissedAt))[0] || null;
  const taskDue = openTask ? dueStateOf(openTask, { now }) : null;

  const actions = [];
  if (openTask && taskDue) actions.push({ label: 'Call back (missed call)', dueAt: taskDue.dueAt, overdue: taskDue.overdue, assignee: openTask.assignedToName || null, ref: { type: 'callback', id: String(openTask._id) } });
  if (activeLead?.nextFollowUpAt) actions.push({ label: 'Follow up on the enquiry', dueAt: activeLead.nextFollowUpAt, overdue: t(activeLead.nextFollowUpAt) < now, assignee: activeLead.assignedToName || null, ref: { type: 'lead', id: String(activeLead._id) } });
  actions.sort((a, b) => t(a.dueAt) - t(b.dueAt));
  const nextAction = actions[0]
    || (active ? { label: `Booking ${active.tripNumber}: ${TRIP_STATUS[active.status] || active.status}`, dueAt: null, overdue: false, assignee: null, ref: { type: 'trip', id: String(active._id) } } : null);

  // Names this number carries — never merged; flagged when more than one.
  const names = [...new Map([...leads.map((l) => l.patientName), ...trips.map((tr) => tr.patientName)]
    .filter((n) => n && String(n).trim()).map((n) => [String(n).trim().toLowerCase(), String(n).trim()])).values()];

  // One chronological timeline (newest first).
  const ev = [];
  for (const c of calls) {
    const who = c.staff ? ` · ${c.staff}` : '';
    const title = c.kind === 'driver'
      ? `Driver ↔ customer call (masked) — ${c.outcomeLabel.toLowerCase()}`
      : c.kind === 'incoming' ? `Incoming call — ${c.outcomeLabel.toLowerCase()}` : `${c.callback ? 'Callback' : 'Outgoing call'} — ${c.outcomeLabel.toLowerCase()}`;
    ev.push({ at: c.at, kind: 'call', title, detail: [dur(c.talkSec) && `talked ${dur(c.talkSec)}`, c.hasRecording && 'recorded'].filter(Boolean).join(' · ') || null, by: c.staff, ref: { type: 'call', id: c.id }, text: `${title}${who}` });
  }
  for (const cb of d.callbacks || []) {
    if (cb.scheduledAt && cb.nextCallbackAt) ev.push({ at: cb.scheduledAt, kind: 'callback', title: 'Callback scheduled', detail: null, by: null, dueAt: cb.nextCallbackAt, ref: { type: 'callback', id: String(cb._id) } });
    if (cb.resolution?.at) ev.push({ at: cb.resolution.at, kind: 'callback', title: `Callback task closed: ${CB_OUTCOME[cb.resolution.outcome] || cb.resolution.outcome}`, detail: safe(cb.resolution.note || null), by: cb.resolution.byName || null, ref: { type: 'callback', id: String(cb._id) } });
    if (cb.state === 'withdrawn' && cb.withdrawn?.at) ev.push({ at: cb.withdrawn.at, kind: 'callback', title: 'Callback task closed: the customer got through', detail: null, by: null, ref: { type: 'callback', id: String(cb._id) } });
  }
  for (const l of d.leads || []) {
    ev.push({ at: l.receivedAt || l.createdAt, kind: 'lead', title: `Enquiry received (${String(l.source || 'lead').replace('_', ' ')})`, detail: safe(l.message || null), by: l.createdByName || null, ref: { type: 'lead', id: String(l._id) } });
    for (const h of l.history || []) if (h.type !== 'created') ev.push({ at: h.at, kind: 'lead', title: safe(leadHistoryTitle(h)), detail: null, by: h.byName || null, dueAt: h.type === 'follow_up_set' ? h.detail?.at : undefined, ref: { type: 'lead', id: String(l._id) } });
    for (const n of l.followUpNotes || []) ev.push({ at: n.at, kind: 'note', title: 'Note', detail: safe(n.text), by: n.byName || null, ref: { type: 'lead', id: String(l._id) } });
  }
  for (const c of d.conversations || []) ev.push({ at: c.startedAt, kind: 'whatsapp', title: `WhatsApp chat${c.serviceLabel ? ` about ${c.serviceLabel}` : ''}`, detail: c.completed ? 'finished the booking flow' : `stopped at: ${c.lastStepLabel || c.lastStep}`, by: null });
  // A hand-logged outcome DESCRIBES a call; it is never counted as one.
  for (const w of d.waCalls || []) ev.push({ at: w.createdAt, kind: 'whatsapp', title: `Follow-up logged from WhatsApp chats: ${WA_OUTCOME[w.outcome] || w.outcome}`, detail: safe(w.note || null), by: w.calledBy?.name || null });
  for (const tr of trips) {
    ev.push({ at: tr.createdAt, kind: 'booking', title: `Booked ${tr.tripNumber}${tr.patientName ? ` for ${tr.patientName}` : ''}`, detail: tr.selectedType || null, by: null, ref: { type: 'trip', id: String(tr._id) } });
    if (tr.dispatchedAt) ev.push({ at: tr.dispatchedAt, kind: 'booking', title: `${tr.tripNumber}: ambulance assigned`, detail: null, by: null, ref: { type: 'trip', id: String(tr._id) } });
    if (tr.completedAt) ev.push({ at: tr.completedAt, kind: 'booking', title: `${tr.tripNumber}: trip completed`, detail: null, by: null, ref: { type: 'trip', id: String(tr._id) } });
    if (tr.cancelledAt) ev.push({ at: tr.cancelledAt, kind: 'booking', title: `${tr.tripNumber}: booking cancelled`, detail: safe(tr.cancellationReason || null), by: null, ref: { type: 'trip', id: String(tr._id) } });
  }
  if (owner) for (const p of d.payments || []) ev.push({ at: p.receivedAt, kind: 'payment', title: `${p.kind === 'refund' ? 'Refund' : p.kind === 'reversal' ? 'Receipt reversed' : 'Payment received'} ${p.receiptNumber || ''}`.trim(), detail: `₹${(Number(p.amountPaise) / 100).toLocaleString('en-IN')} · ${p.method}`, by: null });
  const dated = ev.filter((e) => ok(t(e.at))).sort((a, b) => t(b.at) - t(a.at));
  const timeline = dated.slice(0, TIMELINE_MAX);
  const loadedRows = (d.calls || []).length;

  const pi = callStats.periodInfo(now);
  return {
    period: { firstContactAt, ...pi, last30DaysFrom: pi.from.last30Days },
    counts,
    countsBasis: { logicalCalls: totalLogical, callRows: totalRows, computedIn: d.stats ? 'database' : 'list' },
    lastAttempt: lastAttemptCall ? { at: lastAttemptCall.at, direction: lastAttemptCall.direction, outcomeLabel: lastAttemptCall.outcomeLabel, staff: lastAttemptCall.staff, callback: lastAttemptCall.callback } : null,
    lastConnected: lastConnectedCall ? { at: lastConnectedCall.at, direction: lastConnectedCall.direction, staff: lastConnectedCall.staff, talkSec: lastConnectedCall.talkSec } : null,
    latestNote,
    enquiry: activeLead || leads[0] ? (() => { const l = activeLead || leads[0]; return { _id: String(l._id), status: l.status || 'new', statusLabel: LEAD_STATUS[l.status || 'new'], assignee: l.assignedToName || null, nextFollowUpAt: activeLead ? activeLead.nextFollowUpAt || null : null, active: !!activeLead }; })() : null,
    callbackTask: openTask ? { _id: String(openTask._id), status: 'open', assignee: openTask.assignedToName || null, dueAt: taskDue?.dueAt || null, overdue: !!taskDue?.overdue, missedCount: openTask.missedCount || null } : null,
    booking: { current: bookingOut(active), last: active ? null : bookingOut(lastTrip), total: trips.length, cancelled: trips.filter((tr) => tr.status === 'cancelled').length, completed: trips.filter((tr) => tr.status === 'completed').length },
    nextAction,
    names,
    sharedNumber: names.length > 1,
    // The newest calls only; every call pages through GET /api/calls/history?customerRef=.
    calls: calls.slice(0, CALLS_SHOWN),
    callsPage: { shown: Math.min(calls.length, CALLS_SHOWN), callRows: totalRows, logicalCalls: totalLogical, more: totalRows > Math.min(loadedRows, CALLS_SHOWN) },
    timeline,
    timelineTruncated: dated.length > TIMELINE_MAX,
    ...(owner ? { payments: (d.payments || []).map((p) => ({ receiptNumber: p.receiptNumber, kind: p.kind, amountPaise: p.amountPaise, method: p.method, receivedAt: p.receivedAt, trip: String(p.trip) })) } : {}),
  };
}

// Loads the records for one 10-digit number and computes the overview.
// Counts and the last attempt / last connection come from MongoDB over ALL
// the number's calls; only the newest TIMELINE_MAX are loaded as rows.
async function buildOverview(phone10, { role, now = Date.now(), waCalls, conversations, trips } = {}) {
  /* eslint-disable global-require */
  const CallLog = require('../models/CallLog');
  const CallbackTask = require('../models/CallbackTask');
  const Payment = require('../models/Payment');
  const { Lead } = require('../models');
  const { phoneSuffixQuery } = require('../utils/phone');
  /* eslint-enable global-require */
  const FIELDS = 'direction status context tripMasked tripCallFrom agentName startedAt answeredAt endedAt createdAt talkSec callbackTask recordingUrl recordingSec providerCallId';
  const base = { customerPhone: phone10, context: { $ne: 'test_ring' } };
  const [rows, stats, callbacks, leads] = await Promise.all([
    CallLog.find(base).select(FIELDS).sort({ startedAt: -1, _id: -1 }).limit(TIMELINE_MAX).lean(),
    // counts + last attempt / last connected, canonical, over ALL calls
    callStats.customerCallStats(phone10, { now, CallLog }),
    CallbackTask.find({ customerPhone: phone10 })
      .select('state firstMissedAt lastMissedAt lastQueuedAt nextCallbackAt scheduledAt assignedTo assignedToName missedCount resolution withdrawn createdAt').lean(),
    Lead.find({ phone: phoneSuffixQuery(phone10) })
      .select('patientName status source message assignedTo assignedToName nextFollowUpAt convertedTrip followUpNotes history receivedAt createdAt createdByName').lean(),
  ]);
  // Every record linked to the loaded calls (same CallUUID), even one that
  // carries no number or falls outside the newest TIMELINE_MAX, so each call
  // is judged on all its records — as in the counts.
  const keys = [...new Set((rows || []).map((c) => c.providerCallId).filter(Boolean))];
  const linked = keys.length
    ? await CallLog.find({ providerCallId: { $in: keys }, _id: { $nin: rows.map((c) => c._id) }, context: { $ne: 'test_ring' } }).select(FIELDS).lean()
    : [];
  const calls = [...(rows || []), ...(linked || [])];
  const payments = role === 'owner' && trips?.length
    ? await Payment.find({ trip: { $in: trips.map((tr) => tr._id) } }).select('receiptNumber kind amountPaise method receivedAt trip').lean()
    : [];
  return computeOverview({ calls, stats, callbacks, leads, waCalls, conversations, trips, payments }, { role, now });
}

module.exports = { computeOverview, buildOverview, classify, logicalCalls, CALLS_SHOWN, TIMELINE_MAX };
