'use strict';
/**
 * tests/canonicalCalls.mongo.test.js
 * ============================================================
 * ONE classification rule for the Customer Overview, "By customer" and
 * "All call events", on a REAL, ISOLATED MongoDB (throwaway local replica
 * set). Skipped unless MONGO_TEST_URL is set; refuses anything but localhost
 * + a medifleet_test_* database.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_canon?replicaSet=rs0 npx jest tests/canonicalCalls.mongo.test.js
 *
 * Each logical call is decided from ALL its linked records (same Plivo
 * CallUUID) BEFORE any filter: time = earliest record, staff = anyone on any
 * record, number = earliest record's, outcome = strongest. Filters then keep
 * or drop whole calls. Covered:
 *   - duplicate records across midnight IST (23:59:58 / 00:00:03)
 *   - custom date ranges and the Today / 7 / 30-day boundaries
 *   - different staff on the records of one call
 *   - a sweep of filter combinations: no filter ever turns an answered
 *     call into a missed one, and the three views agree
 *   - "answered"/"connected" need the existing evidence (status completed),
 *     never an agent/driver answering, an app claim, talk time or a recording
 *   - a linked record without a number still decides the call
 * All data fictional (numbers 90000 xxxxx). No network, no Plivo.
 * ============================================================
 */
const URL = process.env.MONGO_TEST_URL || '';
const safe = (() => {
  try {
    const u = new (require('url').URL)(URL);
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && /^\/medifleet_test_[a-z0-9_]+$/.test(u.pathname);
  } catch { return false; }
})();
const maybe = URL && safe ? describe : describe.skip;
if (URL && !safe) throw new Error('MONGO_TEST_URL must be localhost and a medifleet_test_* database — refusing to run.');
process.env.CUSTOMER_REF_SECRET = process.env.CUSTOMER_REF_SECRET || 'test-only-customer-ref-secret';
for (const k of ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN']) delete process.env[k];
jest.mock('axios', () => { const a = jest.requireActual('axios'); a.defaults.adapter = async () => { throw new Error('no network in tests'); }; return a; });

jest.setTimeout(180000);

maybe('one canonical call rule across the three views (real isolated MongoDB)', () => {
  let mongoose; let CallLog; let User; let history; let overview; let runAsViewer; let customerRef;
  let owner; let tele; let tele2;
  const IST = 5.5 * 3600e3;
  const NOW = Date.UTC(2026, 10, 20, 6, 30); // 20 Nov 2026, 12:00 IST
  const ist = (mo, day, hh, mm = 0, ss = 0) => new Date(Date.UTC(2026, mo - 1, day, hh, mm, ss) - IST);
  const P = '9000000501'; // the customer
  const Q = '9000000502'; // another customer

  beforeAll(async () => {
    mongoose = require('mongoose');
    // These tests set Date.now to a fixed day; Mongoose judges "still connected" by
    // Date.now() minus the last heartbeat (stale after 2 intervals), so a heartbeat
    // seen under the fixed clock would look days old. Hourly heartbeats keep that
    // check from tripping during a run (test-only; production never fakes the clock).
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    CallLog = require('../models/CallLog');
    ({ User } = require('../models'));
    history = require('../controllers/callHistoryController');
    overview = require('../services/customerOverview');
    ({ runAsViewer } = require('../utils/phoneViewer'));
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([CallLog, User].map((M) => M.init()));
    owner = await User.create({ name: 'Owner (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true });
    tele = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true });
    tele2 = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000003', password: 'x-test-only', isActive: true });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => { await CallLog.collection.deleteMany({}); });
  const realNow = Date.now;
  beforeEach(() => { Date.now = () => NOW; });
  afterEach(() => { Date.now = realNow; });

  const call = (o) => ({ provider: 'plivo', context: o.direction === 'inbound' ? 'incoming' : 'lead', agentType: 'staff', customerPhone: P, ...o });
  const add = (rows) => CallLog.collection.insertMany(rows.map(call)); // raw: a record may lack a number
  async function api(handler, user, query) {
    let body; let status = 200;
    await new Promise((resolve, reject) => runAsViewer(user, () => {
      const res = { status(c) { status = c; return this; }, json(b) { body = JSON.parse(JSON.stringify(b)); resolve(); return this; } };
      Promise.resolve(handler({ query, user }, res, (e) => (e ? reject(e) : resolve()))).catch(reject);
    }));
    if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`);
    return body;
  }
  const events = (q) => api(history.history, owner, { customerRef: customerRef(P), limit: '100', ...q });
  const byCustomer = async (q) => (await api(history.customers, owner, { limit: '100', ...q })).customers.find((c) => c.customerPhone === P) || null;
  const pcids = (b) => b.logs.map((l) => l.providerCallId || null);

  // The midnight call: Plivo's replay ("missed", 23:59:58 on the 18th) and the
  // real report ("completed" by Asha, 00:00:03 on the 19th) of ONE call.
  const MIDNIGHT = [
    { providerCallId: 'uuid-M', direction: 'inbound', status: 'missed', startedAt: ist(11, 18, 23, 59, 58), endedAt: ist(11, 18, 23, 59, 59) },
    { providerCallId: 'uuid-M', direction: 'inbound', status: 'completed', startedAt: ist(11, 19, 0, 0, 3), endedAt: ist(11, 19, 0, 4), talkSec: 230, agentUser: null, agentName: null },
  ];

  test('across midnight IST: the call belongs to the 18th (its earliest record), is answered on every view, and never shows as missed', async () => {
    await add([
      { ...MIDNIGHT[0] }, { ...MIDNIGHT[1], agentUser: tele._id, agentName: 'Asha (test)' },
      { direction: 'inbound', status: 'missed', startedAt: ist(11, 19, 9, 0) }, // a genuinely missed call (no CallUUID)
    ]);
    // 18th only: the call is there, answered; its record inside the dates is listed and marked.
    let e = await events({ from: '2026-11-18', to: '2026-11-18' });
    expect([e.total, e.logicalCalls]).toEqual([1, 1]);
    expect(e.counts.incoming).toMatchObject({ total: 1, answered: 1, missed: 0 });
    expect(e.sameCall[e.logs[0]._id]).toEqual({ records: 2, kind: 'incoming', outcome: 'answered' });
    // 19th only: the call is NOT there (it started on the 18th) — the 00:00:03
    // record is not a second call, and the replay never makes a "missed" one.
    e = await events({ from: '2026-11-19', to: '2026-11-19' });
    expect(pcids(e)).toEqual([null]);
    expect(e.counts.incoming).toMatchObject({ total: 1, answered: 0, missed: 1 });
    // 18th–19th: once, both records listed.
    e = await events({ from: '2026-11-18', to: '2026-11-19' });
    expect([e.total, e.logicalCalls]).toEqual([3, 2]);
    expect(e.counts.incoming).toMatchObject({ total: 2, answered: 1, missed: 1 });
    // Missed, any dates: never the midnight call.
    for (const q of [{}, { from: '2026-11-18', to: '2026-11-18' }, { from: '2026-11-19', to: '2026-11-19' }, { period: 'today' }, { period: '7d' }]) {
      expect(pcids(await events({ ...q, outcome: 'missed' }))).not.toContain('uuid-M');
    }
    // By customer and the overview say the same.
    expect(await byCustomer({ from: '2026-11-18', to: '2026-11-18' })).toMatchObject({ calls: 1, incoming: { answered: 1, missed: 0 } });
    expect(await byCustomer({ from: '2026-11-19', to: '2026-11-19' })).toMatchObject({ calls: 1, incoming: { answered: 0, missed: 1 } });
    const o = await overview.buildOverview(P, { role: 'telecaller', now: NOW });
    expect(o.counts.allTime.incoming).toMatchObject({ total: 2, answered: 1, missed: 1 });
    const m = o.calls.find((c) => c.outcome === 'answered');
    expect(new Date(m.at).getTime()).toBe(ist(11, 18, 23, 59, 58).getTime()); // the call's time = earliest record
    expect(m.staff).toBe('Asha (test)');
  });

  test('date boundaries: exactly 00:00:00.000 IST starts the day; the 30-day window uses the call\'s earliest record', async () => {
    const starts = require('../services/callStats').periodStarts(NOW);
    expect(new Date(starts.last30Days).getTime()).toBe(ist(10, 22, 0, 0).getTime()); // 22 Oct 00:00 IST
    await add([
      // exactly at 19 Nov 00:00:00.000 IST (answered)
      { providerCallId: 'uuid-B0', direction: 'inbound', status: 'completed', startedAt: ist(11, 19, 0, 0, 0), agentUser: tele._id },
      // 30-day edge: replay at 21 Oct 23:59:59 (missed), real report 22 Oct 00:00:05 (answered)
      { providerCallId: 'uuid-30', direction: 'inbound', status: 'missed', startedAt: ist(10, 21, 23, 59, 59) },
      { providerCallId: 'uuid-30', direction: 'inbound', status: 'completed', startedAt: ist(10, 22, 0, 0, 5), agentUser: tele2._id },
    ]);
    expect(pcids(await events({ from: '2026-11-19', to: '2026-11-19' }))).toEqual(['uuid-B0']);
    expect(pcids(await events({ from: '2026-11-18', to: '2026-11-18' }))).toEqual([]);
    // The 30-day call started before the window: not in "30 days" at all (not as answered, not as missed)…
    const in30 = await events({ period: '30d' });
    expect(pcids(in30)).toEqual(['uuid-B0']);
    expect(in30.counts.incoming).toMatchObject({ total: 1, answered: 1, missed: 0 });
    // …and answered in "All time".
    const all = await events({ period: 'all' });
    expect(all.counts.incoming).toMatchObject({ total: 2, answered: 2, missed: 0 });
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    expect(o.counts.last30Days.incoming).toMatchObject({ total: 1, answered: 1, missed: 0 });
    expect(o.counts.allTime.incoming).toMatchObject({ total: 2, answered: 2, missed: 0 });
    expect(await byCustomer({ period: '30d' })).toMatchObject({ calls: 1, incoming: { answered: 1, missed: 0 } });
  });

  test('different staff on the records of one call: the call belongs to everyone who handled any record, and keeps its outcome', async () => {
    await add([
      // Ravi answered; a replayed record names Asha and says "missed".
      { providerCallId: 'uuid-S', direction: 'inbound', status: 'completed', startedAt: ist(11, 19, 10, 0), agentUser: tele2._id, agentName: 'Ravi (test)', talkSec: 90 },
      { providerCallId: 'uuid-S', direction: 'inbound', status: 'missed', startedAt: ist(11, 19, 10, 0, 4), agentUser: tele._id, agentName: 'Asha (test)' },
      // A call Ravi transferred to Asha (Asha only in transfers.answeredBy).
      { providerCallId: 'uuid-X', direction: 'inbound', status: 'completed', startedAt: ist(11, 19, 11, 0), agentUser: tele2._id, agentName: 'Ravi (test)', transfers: [{ outcome: 'answered', answeredBy: tele._id }] },
    ]);
    for (const [who, user] of [['Asha', tele], ['Ravi', tele2]]) {
      const e = await api(history.history, user, { customerRef: customerRef(P), staff: String(user._id) });
      expect(e.logicalCalls).toBe(2);
      expect(e.counts.incoming).toMatchObject({ total: 2, answered: 2, missed: 0 });
      expect(e.total).toBe(3); // every record of both calls
      const missed = await api(history.history, user, { customerRef: customerRef(P), staff: String(user._id), outcome: 'missed' });
      expect([missed.total, missed.logicalCalls]).toEqual([0, 0]);
      const c = (await api(history.customers, owner, { staff: String(user._id), period: 'all' })).customers[0];
      expect(c).toMatchObject({ calls: 2, incoming: { answered: 2, missed: 0 } });
      expect(who).toBeTruthy();
    }
    const nobody = await api(history.history, owner, { staff: String(owner._id) });
    expect(nobody.total).toBe(0);
    // The overview names who connected (Ravi), not the replay's name.
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    expect(o.lastConnected).toMatchObject({ staff: 'Ravi (test)' });
    expect(o.calls.find((c) => c.outcome === 'answered' && c.talkSec === 90)?.staff).toBe('Ravi (test)');
  });

  test('a sweep of filter combinations: an answered call is never missed, and Overview / By customer / All call events agree on every period', async () => {
    await add([
      ...MIDNIGHT.map((r, i) => ({ ...r, ...(i ? { agentUser: tele._id, agentName: 'Asha (test)' } : {}) })),
      { providerCallId: 'uuid-S', direction: 'inbound', status: 'completed', startedAt: ist(11, 20, 10, 0), agentUser: tele2._id, agentName: 'Ravi (test)' },
      { providerCallId: 'uuid-S', direction: 'inbound', status: 'no_agents', startedAt: ist(11, 20, 10, 0, 2), agentUser: tele._id },
      { providerCallId: 'uuid-O', direction: 'outbound', status: 'customer_missed', startedAt: ist(11, 15, 23, 59, 59), agentUser: tele._id },
      { providerCallId: 'uuid-O', direction: 'outbound', status: 'completed', startedAt: ist(11, 16, 0, 0, 1), agentUser: tele._id },
      { direction: 'inbound', status: 'missed', startedAt: ist(11, 17, 8, 0) },
      { direction: 'inbound', status: 'missed', startedAt: ist(11, 1, 8, 0), customerPhone: Q },
    ]);
    const ANSWERED = new Set(['uuid-M', 'uuid-S']);
    const dates = [{}, { period: 'today' }, { period: '7d' }, { period: '30d' }, { period: 'all' },
      { from: '2026-11-15', to: '2026-11-15' }, { from: '2026-11-16', to: '2026-11-16' }, { from: '2026-11-18', to: '2026-11-18' },
      { from: '2026-11-19', to: '2026-11-19' }, { from: '2026-11-19', to: '2026-11-20' }, { from: '2026-11-01', to: '2026-11-30' }];
    const staffs = [{}, { staff: String(tele._id) }, { staff: String(tele2._id) }];
    const dirs = [{}, { direction: 'incoming' }, { direction: 'outgoing' }];
    let combos = 0;
    for (const d of dates) {
      for (const s of staffs) {
        for (const dir of dirs) {
          const q = { ...d, ...s, ...dir };
          const all = await events(q);
          const missed = await events({ ...q, outcome: 'missed' });
          const answered = await events({ ...q, outcome: 'answered' });
          // never an answered call under Missed; Missed + Answered + … add up
          expect(pcids(missed).filter((k) => ANSWERED.has(k))).toEqual([]);
          expect(missed.counts.incoming.missed).toBe(all.counts.incoming.missed);
          expect(answered.counts.incoming.answered).toBe(all.counts.incoming.answered);
          // By customer = All call events for this customer
          const c = await byCustomer(q);
          expect(c ? c.calls : 0).toBe(all.logicalCalls);
          if (c) expect([c.incoming.answered, c.incoming.missed, c.outgoing.connected]).toEqual([all.counts.incoming.answered, all.counts.incoming.missed, all.counts.outgoing.connected]);
          combos += 1;
        }
      }
    }
    expect(combos).toBe(dates.length * staffs.length * dirs.length);
    // Overview periods = All call events with that period, for this customer.
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    for (const [key, period] of [['today', 'today'], ['last7Days', '7d'], ['last30Days', '30d'], ['allTime', 'all']]) {
      const e = await events({ period });
      expect(o.counts[key]).toEqual(e.counts);
    }
    expect(o.counts.allTime.incoming).toMatchObject({ total: 3, answered: 2, missed: 1 });
    expect(o.counts.allTime.outgoing).toMatchObject({ attempts: 1, connected: 1 });
  });

  test('"answered" / "connected" need status completed — an agent or driver answering, an app claim, talk time or a recording alone never count', async () => {
    const stale = new Date(NOW - 3 * 3600e3);
    await add([
      // incoming: agent picked up in the app (agent_answered + answeredAt + agentUser) but no Plivo connection report; ended
      { providerCallId: 'ev-1', direction: 'inbound', status: 'agent_answered', answeredAt: stale, endedAt: new Date(stale.getTime() + 60e3), agentUser: tele._id, agentName: 'Asha (test)', talkSec: 40, recordingUrl: 'https://example.invalid/r1', recordingSec: 30, startedAt: stale },
      // incoming: the app's "answered" claim only (agentUser/answeredAt), still ringing, fresh
      { providerCallId: 'ev-2', direction: 'inbound', status: 'ringing', answeredAt: new Date(NOW - 60e3), agentUser: tele._id, startedAt: new Date(NOW - 90e3) },
      // outgoing: our agent answered (agent_answered), the customer never did; recording present
      { providerCallId: 'ev-3', direction: 'outbound', status: 'agent_answered', answeredAt: stale, endedAt: new Date(stale.getTime() + 30e3), recordingUrl: 'https://example.invalid/r2', agentUser: tele._id, startedAt: stale },
      { providerCallId: 'ev-4', direction: 'outbound', status: 'customer_missed', recordingUrl: 'https://example.invalid/r3', recordingSec: 12, talkSec: 12, agentUser: tele._id, startedAt: stale },
      // masked trip call: the driver picked up (agent_answered = in call), ended without the completion report
      { providerCallId: 'ev-5', direction: 'outbound', tripMasked: true, tripCallFrom: 'customer', status: 'agent_answered', endedAt: new Date(stale.getTime() + 20e3), startedAt: stale },
      // masked trip call that did connect (completed): a DRIVER call, never staff "answered"
      { providerCallId: 'ev-6', direction: 'inbound', tripMasked: true, tripCallFrom: 'customer', status: 'completed', talkSec: 50, startedAt: stale },
    ]);
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    expect(o.counts.allTime.incoming).toMatchObject({ total: 2, answered: 0, unconfirmed: 1, inProgress: 1 });
    expect(o.counts.allTime.outgoing).toMatchObject({ attempts: 2, connected: 0 });
    expect(o.counts.allTime.driverCalls).toBe(2);
    expect(o.lastConnected).toBeNull();
    const e = await events({ period: 'all' });
    expect(e.counts).toEqual(o.counts.allTime);
    expect((await events({ outcome: 'answered' })).total).toBe(0);
    expect((await events({ outcome: 'connected' })).total).toBe(0);
    expect(await byCustomer({ period: 'all' })).toMatchObject({ incoming: { answered: 0 }, outgoing: { connected: 0 }, driverCalls: 2, lastConnectedAt: null });
    // the list says the same, call by call
    const label = Object.fromEntries(o.calls.map((c) => [c.kind + c.outcome, true]));
    expect(label.incominganswered || label.outgoingconnected).toBeFalsy();
  });

  test('a linked record with NO number still decides the call (a replay that lost the number)', async () => {
    await add([
      { providerCallId: 'uuid-N', direction: 'inbound', status: 'missed', startedAt: ist(11, 19, 15, 0) },
      { providerCallId: 'uuid-N', direction: 'inbound', status: 'completed', startedAt: ist(11, 19, 15, 0, 2), customerPhone: null, agentUser: tele._id, agentName: 'Asha (test)' },
    ]);
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    expect(o.counts.allTime.incoming).toMatchObject({ total: 1, answered: 1, missed: 0 });
    expect(o.lastConnected).toMatchObject({ staff: 'Asha (test)' });
    expect(o.calls).toHaveLength(1);
    expect(o.calls[0].outcome).toBe('answered');
    const e = await events({ period: 'all' });
    expect([e.total, e.logicalCalls]).toEqual([1, 1]); // the numbered record is listed…
    expect(e.counts.incoming).toMatchObject({ answered: 1, missed: 0 }); // …the call is answered
    expect(await byCustomer({ period: 'all' })).toMatchObject({ calls: 1, incoming: { answered: 1, missed: 0 } });
  });

  test('Last attempt / Last spoke are canonical: a newer replay record never makes the last attempt "Missed"', async () => {
    await add([
      { providerCallId: 'uuid-L', direction: 'inbound', status: 'completed', startedAt: ist(11, 20, 9, 0), agentUser: tele._id, agentName: 'Asha (test)', talkSec: 75 },
      { providerCallId: 'uuid-L', direction: 'inbound', status: 'missed', startedAt: ist(11, 20, 9, 1) }, // newest record of all
      { direction: 'outbound', status: 'customer_missed', startedAt: ist(11, 19, 18, 0), agentUser: tele2._id, agentName: 'Ravi (test)' },
    ]);
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    expect(o.lastAttempt).toMatchObject({ outcomeLabel: 'Answered', staff: 'Asha (test)', direction: 'inbound' });
    expect(new Date(o.lastAttempt.at).getTime()).toBe(ist(11, 20, 9, 0).getTime());
    expect(o.lastConnected).toMatchObject({ staff: 'Asha (test)', talkSec: 75 });
  });
});
