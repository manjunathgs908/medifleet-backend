'use strict';
/**
 * tests/callHistory.mongo.test.js
 * ============================================================
 * Release checks for the Call Logs views on a REAL, ISOLATED MongoDB (a
 * throwaway local replica set). Skipped unless MONGO_TEST_URL is set;
 * refuses anything but localhost + a medifleet_test_* database.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_callhistory?replicaSet=rs0 npx jest tests/callHistory.mongo.test.js
 *
 *  1. Telecaller access equals main's: GET /api/calls/history and /customers
 *     are compared with the REAL GET /api/calls/logs (controllers/
 *     callController.js, unchanged from main) on the same data.
 *  2. Name search is complete: > 500 matching enquiries and > 500 matching
 *     bookings, every number found and paged; an over-broad name is refused
 *     with a message, never cut short.
 *  3. Replayed (duplicate) records that DISAGREE: listed as records, counted
 *     once per logical call with the canonical outcome, in the overview, the
 *     totals, every outcome filter and "By customer".
 *
 * All data fictional (numbers 90000 xxxxx). No Plivo (no credentials), no
 * network, no writes outside the throwaway database.
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
for (const k of ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'GOOGLE_MAPS_API_KEY']) delete process.env[k];
jest.mock('axios', () => { const a = jest.requireActual('axios'); a.defaults.adapter = async () => { throw new Error('no network in tests'); }; return a; });
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

jest.setTimeout(180000);

maybe('Call Logs release checks on a real isolated MongoDB', () => {
  let mongoose; let CallLog; let Lead; let Trip; let User;
  let history; let calls; let overview; let runAsViewer; let customerRef;
  let owner; let tele; let tele2;
  const IST = 5.5 * 3600e3;
  const NOW = Date.UTC(2026, 10, 20, 6, 30); // 20 Nov 2026, 12:00 IST
  const ist = (day, hh, mm = 0, ss = 0) => new Date(Date.UTC(2026, 10, day, hh, mm, ss) - IST);
  const RAW = /(?<!\d)9000\d{6}(?!\d)/; // any fictional number in full

  beforeAll(async () => {
    mongoose = require('mongoose');
    // These tests set Date.now to a fixed day; Mongoose judges "still connected" by
    // Date.now() minus the last heartbeat (stale after 2 intervals), so a heartbeat
    // seen under the fixed clock would look days old. Hourly heartbeats keep that
    // check from tripping during a run (test-only; production never fakes the clock).
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    CallLog = require('../models/CallLog');
    ({ Lead, Trip, User } = require('../models'));
    history = require('../controllers/callHistoryController');
    calls = require('../controllers/callController'); // main's, unchanged
    overview = require('../services/customerOverview');
    ({ runAsViewer } = require('../utils/phoneViewer'));
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([CallLog, Lead, Trip, User].map((M) => M.init()));
    owner = await User.create({ name: 'Owner (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true });
    tele = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true });
    tele2 = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000003', password: 'x-test-only', isActive: true });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => { await Promise.all([CallLog, Lead, Trip].map((M) => M.collection.deleteMany({}))); });
  const realNow = Date.now;
  beforeEach(() => { Date.now = () => NOW; });
  afterEach(() => { Date.now = realNow; });

  const call = (o) => ({ provider: 'plivo', context: o.direction === 'inbound' ? 'incoming' : 'lead', agentType: 'staff', ...o });
  const add = (rows) => CallLog.insertMany(rows.map(call));
  async function api(handler, user, query) {
    let body; let status = 200;
    await new Promise((resolve, reject) => runAsViewer(user, () => {
      const res = { status(c) { status = c; return this; }, json(b) { body = JSON.parse(JSON.stringify(b)); resolve(); return this; } };
      Promise.resolve(handler({ query, user }, res, (e) => (e ? reject(e) : resolve()))).catch(reject);
    }));
    return { status, body };
  }
  async function allPages(handler, user, query, key) {
    const out = []; let cursor = null; let first = null;
    do {
      const { status, body } = await api(handler, user, { ...query, ...(cursor ? { cursor } : {}) });
      expect(status).toBe(200);
      first ??= body;
      out.push(...body[key]);
      cursor = body.nextCursor;
    } while (cursor);
    return { first, rows: out };
  }
  const ids = (logs) => logs.map((l) => String(l._id)).sort();

  // ── 1. telecaller permissions = main ───────────────────────
  test('telecaller access equals main\'s GET /api/calls/logs: every call and customer visible, own-calls-only staff filter with the same 403, owner-only data stays owner-only', async () => {
    const C1 = '9000000301'; const C2 = '9000000302'; const C3 = '9000000303';
    await add([
      { customerPhone: C1, direction: 'inbound', status: 'completed', agentUser: tele._id, agentName: 'Asha (test)', startedAt: ist(20, 9) },
      { customerPhone: C1, direction: 'outbound', status: 'completed', agentUser: tele2._id, agentName: 'Ravi (test)', startedAt: ist(20, 9, 30) },
      { customerPhone: C2, direction: 'inbound', status: 'missed', startedAt: ist(19, 18) },
      { customerPhone: C2, direction: 'inbound', status: 'completed', agentUser: tele2._id, agentName: 'Ravi (test)', transfers: [{ outcome: 'answered', answeredBy: tele._id }], startedAt: ist(19, 19) },
      // a customer only the OWNER ever spoke to
      { customerPhone: C3, direction: 'outbound', status: 'completed', agentUser: owner._id, agentName: 'Owner (test)', startedAt: ist(18, 11) },
      { customerPhone: C3, direction: 'inbound', status: 'completed', agentUser: owner._id, agentName: 'Owner (test)', startedAt: ist(18, 12) },
    ]);

    // Unfiltered: the telecaller sees every call (others' too), as on main.
    const mainAll = await api(calls.listLogs, tele, { limit: '200' });
    const newAll = await allPages(history.history, tele, { limit: '100' }, 'logs');
    expect(mainAll.body.logs).toHaveLength(6);
    expect(ids(newAll.rows)).toEqual(ids(mainAll.body.logs));

    // One customer's history (the owner-only customer included), as on main.
    const ref3 = customerRef(C3);
    const main3 = await api(calls.listLogs, tele, { customerRef: ref3 });
    const new3 = await api(history.history, tele, { customerRef: ref3 });
    expect(main3.body.logs).toHaveLength(2);
    expect(ids(new3.body.logs)).toEqual(ids(main3.body.logs));
    const ov3 = await overview.buildOverview(C3, { role: 'telecaller', now: NOW });
    const ov3o = await overview.buildOverview(C3, { role: 'owner', now: NOW });
    expect(ov3.counts).toEqual(ov3o.counts); // same history, nothing hidden
    expect(ov3.payments).toBeUndefined();

    // Own calls: same set as main's ?agent= (placed, answered, or taken as a transfer).
    const mainMine = await api(calls.listLogs, tele, { agent: String(tele._id) });
    const newMine = await api(history.history, tele, { staff: String(tele._id) });
    expect(mainMine.body.logs).toHaveLength(2);
    expect(ids(newMine.body.logs)).toEqual(ids(mainMine.body.logs));

    // Someone else's calls: refused the same way on main and here.
    const mainOther = await api(calls.listLogs, tele, { agent: String(tele2._id) });
    const newOther = await api(history.history, tele, { staff: String(tele2._id) });
    const custOther = await api(history.customers, tele, { staff: String(tele2._id) });
    expect([mainOther.status, newOther.status, custOther.status]).toEqual([403, 403, 403]);
    expect(newOther.body.message).toBe(mainOther.body.message);
    expect(custOther.body.message).toBe(mainOther.body.message);
    // The owner may pick anyone (main and here).
    const ownerMain = await api(calls.listLogs, owner, { agent: String(tele2._id) });
    const ownerNew = await api(history.history, owner, { staff: String(tele2._id) });
    expect(ids(ownerNew.body.logs)).toEqual(ids(ownerMain.body.logs));

    // By customer: every customer, including the owner-only one.
    const cust = await allPages(history.customers, tele, { period: 'all', limit: '2' }, 'customers');
    expect(cust.rows.map((c) => c.customerMasked).sort()).toEqual(['••••••0301', '••••••0302', '••••••0303']);

    // Owner-only data: full numbers. Never in the telecaller's JSON (main or new); in the owner's.
    for (const r of [mainAll, newAll.first, new3, main3]) expect(JSON.stringify(r.body || r)).not.toMatch(RAW);
    expect(JSON.stringify(cust.rows)).not.toMatch(RAW);
    const ownerCust = await api(history.customers, owner, { period: 'all' });
    expect(ownerCust.body.customers.map((c) => c.customerPhone).sort()).toEqual([C1, C2, C3]);
    expect((await api(calls.listLogs, owner, {})).body.logs.every((l) => /^9000\d{6}$/.test(l.customerPhone))).toBe(true);
  });

  // ── 2. complete name search ────────────────────────────────
  test('name search over 620 matching enquiries and 560 matching bookings: every number found, totals exact, every page reachable — no 500-row cut', async () => {
    const leadPhone = (i) => `90001${String(i).padStart(5, '0')}`;
    const tripPhone = (i) => `90002${String(i).padStart(5, '0')}`;
    await Lead.collection.insertMany(Array.from({ length: 620 }, (_, i) => ({ patientName: `Ravi Kumar ${i} (test)`, phone: i % 4 ? leadPhone(i) : `+91${leadPhone(i)}`, status: 'new', source: 'manual' })));
    await Trip.collection.insertMany([
      ...Array.from({ length: 560 }, (_, i) => ({ tripNumber: `TRP-TEST-S${i}`, patientName: `Ravi Shankar ${i} (test)`, patientPhone: tripPhone(i), status: 'completed', baseFare: 1000 })),
      // bookings on numbers an enquiry already has: the same number, not a second customer
      ...Array.from({ length: 40 }, (_, i) => ({ tripNumber: `TRP-TEST-K${i}`, patientName: `Ravi Kumar ${i} (test)`, patientPhone: leadPhone(i), status: 'completed', baseFare: 1000 })),
      { tripNumber: 'TRP-TEST-X', patientName: 'Not a match', patientPhone: '9000300001', status: 'completed', baseFare: 1000 },
    ]);
    const t0 = ist(20, 10).getTime();
    await add([
      ...Array.from({ length: 620 }, (_, i) => ({ customerPhone: leadPhone(i), direction: 'inbound', status: 'completed', startedAt: new Date(t0 - i * 60e3) })),
      ...Array.from({ length: 560 }, (_, i) => ({ customerPhone: tripPhone(i), direction: 'outbound', status: i % 2 ? 'completed' : 'customer_missed', startedAt: new Date(t0 - i * 61e3) })),
      { customerPhone: '9000300001', direction: 'inbound', status: 'completed', startedAt: new Date(t0) },
    ]);
    // Over 500 of each really do match (the old limit).
    expect(await Lead.countDocuments({ patientName: /ravi/i })).toBe(620);
    expect(await Trip.countDocuments({ patientName: /ravi/i })).toBe(600);

    const ev = await allPages(history.history, tele, { q: 'ravi', period: 'all', limit: '100' }, 'logs');
    expect(ev.first.total).toBe(1180);
    expect(ev.first.logicalCalls).toBe(1180);
    expect(ev.first.search).toEqual({ by: 'name', numbers: 1180, complete: true });
    expect(ev.rows).toHaveLength(1180);
    expect(new Set(ev.rows.map((l) => l._id)).size).toBe(1180);

    const cu = await allPages(history.customers, tele, { q: 'ravi', period: 'all', limit: '100' }, 'customers');
    expect(cu.first.total).toBe(1180);
    expect(cu.first.search).toEqual({ by: 'name', numbers: 1180, complete: true });
    expect(new Set(cu.rows.map((c) => c.customerRef)).size).toBe(1180);
    expect(cu.rows.some((c) => c.names.includes('Not a match'))).toBe(false);

    const narrower = await api(history.customers, tele, { q: 'ravi kumar', period: 'all' });
    expect(narrower.body.total).toBe(620);
    const lastOne = await api(history.customers, tele, { q: 'Shankar 559', period: 'all' });
    expect(lastOne.body.customers.map((c) => c.customerMasked)).toEqual(['••••••0559']);
  });

  test('a name matching more numbers than the search can hold is refused with a clear message — never silently cut short', async () => {
    const { NAME_MATCH_MAX } = history._internals;
    await Lead.collection.insertMany(Array.from({ length: NAME_MATCH_MAX + 1 }, (_, i) => ({ patientName: `Zed ${i} (test)`, phone: `9${String(100000000 + i)}`, status: 'new', source: 'manual' })));
    const r = await api(history.history, tele, { q: 'zed', period: 'all' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(`“zed” matches ${NAME_MATCH_MAX + 1} customer numbers — too many to search at once. Type more of the name, or search by the last digits of the number.`);
    const c = await api(history.customers, tele, { q: 'zed', period: 'all' });
    expect(c.status).toBe(400);
  });

  // ── 3. disagreeing duplicate records ───────────────────────
  test('replayed records that disagree: listed as records, counted once with the canonical outcome — overview, totals, every outcome filter and By customer agree', async () => {
    const D = '9000000401';
    await add([
      // Call A: the replay says "missed", the other record "completed" -> ANSWERED (completed wins), in either order
      { customerPhone: D, direction: 'inbound', status: 'missed', providerCallId: 'uuid-A', startedAt: ist(20, 10, 0, 0) },
      { customerPhone: D, direction: 'inbound', status: 'completed', providerCallId: 'uuid-A', startedAt: ist(20, 10, 0, 1), agentUser: tele._id, agentName: 'Asha (test)' },
      // Call A2: same disagreement, completed record first
      { customerPhone: D, direction: 'inbound', status: 'completed', providerCallId: 'uuid-A2', startedAt: ist(20, 9, 0, 0) },
      { customerPhone: D, direction: 'inbound', status: 'no_agents', providerCallId: 'uuid-A2', startedAt: ist(20, 9, 0, 2) },
      // Call B: both records missed -> MISSED once
      { customerPhone: D, direction: 'inbound', status: 'missed', providerCallId: 'uuid-B', startedAt: ist(19, 10) },
      { customerPhone: D, direction: 'inbound', status: 'missed', providerCallId: 'uuid-B', startedAt: ist(19, 10, 0, 1) },
      // Call C: one record still "ringing" (fresh), one ringing with an end time -> UNCONFIRMED (beats in progress)
      { customerPhone: D, direction: 'inbound', status: 'ringing', providerCallId: 'uuid-C', startedAt: new Date(NOW - 60e3) },
      { customerPhone: D, direction: 'inbound', status: 'ringing', providerCallId: 'uuid-C', startedAt: new Date(NOW - 60e3), endedAt: new Date(NOW - 30e3) },
      // Call D: outbound, customer_missed + completed -> CONNECTED
      { customerPhone: D, direction: 'outbound', status: 'customer_missed', providerCallId: 'uuid-D', startedAt: ist(18, 10) },
      { customerPhone: D, direction: 'outbound', status: 'completed', providerCallId: 'uuid-D', startedAt: ist(18, 10, 0, 1) },
      // A record with no CallUUID is a call on its own
      { customerPhone: D, direction: 'inbound', status: 'missed', startedAt: ist(17, 10) },
    ]);
    const ref = customerRef(D);
    const RECORDS = 11; const CALLS = 6;

    // Overview (customer totals): logical calls.
    const o = await overview.buildOverview(D, { role: 'telecaller', now: NOW });
    expect(o.counts.allTime.incoming).toMatchObject({ total: 5, answered: 2, missed: 2, unconfirmed: 1 });
    expect(o.counts.allTime.outgoing).toMatchObject({ attempts: 1, connected: 1 });
    expect(o.countsBasis).toMatchObject({ logicalCalls: CALLS, callRows: RECORDS });

    // All call events: records listed, both numbers stated, duplicates marked.
    const all = await api(history.history, tele, { customerRef: ref });
    expect(all.body.total).toBe(RECORDS);
    expect(all.body.logicalCalls).toBe(CALLS);
    expect(all.body.counts.incoming).toMatchObject({ total: 5, answered: 2, missed: 2, unconfirmed: 1 });
    const mark = (uuid) => all.body.logs.filter((l) => l.providerCallId === uuid).map((l) => all.body.sameCall[l._id]);
    expect(mark('uuid-A')).toEqual([{ records: 2, kind: 'incoming', outcome: 'answered' }, { records: 2, kind: 'incoming', outcome: 'answered' }]);
    expect(mark('uuid-A2').every((m) => m.outcome === 'answered')).toBe(true);
    expect(mark('uuid-B').every((m) => m.records === 2 && m.outcome === 'missed')).toBe(true);
    expect(mark('uuid-C').every((m) => m.outcome === 'unconfirmed')).toBe(true);
    expect(mark('uuid-D').every((m) => m.outcome === 'connected')).toBe(true);
    const single = all.body.logs.find((l) => !l.providerCallId);
    expect(all.body.sameCall[single._id]).toBeUndefined();

    // Outcome filters select WHOLE calls by their canonical outcome; every
    // record of a selected call is listed (each marked with that outcome).
    const f = async (outcome) => (await api(history.history, tele, { customerRef: ref, outcome })).body;
    const answered = await f('answered');
    expect([answered.total, answered.logicalCalls]).toEqual([4, 2]); // A and A2, both records each
    expect(answered.logs.every((l) => answered.sameCall[l._id]?.outcome === 'answered')).toBe(true);
    const missed = await f('missed');
    expect([missed.total, missed.logicalCalls]).toEqual([3, 2]); // B's two records + the lone one; NOT A's or A2's replay
    expect(missed.logs.map((l) => l.providerCallId || null).sort()).toEqual([null, 'uuid-B', 'uuid-B'].sort());
    expect(missed.counts.incoming).toMatchObject({ total: 2, missed: 2, answered: 0 });
    const unconfirmed = await f('unconfirmed');
    expect([unconfirmed.total, unconfirmed.logicalCalls]).toEqual([2, 1]); // C's two records
    const inProgress = await f('in_progress');
    expect([inProgress.total, inProgress.logicalCalls]).toEqual([0, 0]); // C's live-looking record is outranked
    expect([(await f('connected')).logicalCalls, (await f('not_connected')).logicalCalls]).toEqual([1, 0]);
    // The outcome filters partition the calls: they add up to the totals.
    expect(answered.logicalCalls + missed.logicalCalls + unconfirmed.logicalCalls + inProgress.logicalCalls).toBe(o.counts.allTime.incoming.total);

    // Paging an outcome filter (guarded aggregation) is stable and complete.
    const pagedMissed = await allPages(history.history, tele, { customerRef: ref, outcome: 'missed', limit: '1' }, 'logs');
    expect(ids(pagedMissed.rows)).toEqual(ids(missed.logs));

    // By customer: logical calls, canonical outcome.
    const cAll = await api(history.customers, tele, { period: 'all' });
    expect(cAll.body.customers[0]).toMatchObject({ calls: CALLS, incoming: { total: 5, answered: 2, missed: 2, unconfirmed: 1 }, outgoing: { attempts: 1, connected: 1 } });
    const cMissed = await api(history.customers, tele, { period: 'all', outcome: 'missed' });
    expect(cMissed.body.customers[0]).toMatchObject({ calls: 2, incoming: { total: 2, missed: 2, answered: 0 } });
  });
});
