'use strict';
/**
 * tests/performance.mongo.test.js
 * ============================================================
 * GET /api/calls/performance on a REAL, ISOLATED MongoDB (throwaway local
 * replica set), counted per canonical logical call — the same classification
 * as the customer overview and the Call Logs views. Skipped unless
 * MONGO_TEST_URL is set; refuses anything but localhost + medifleet_test_*.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_perf?replicaSet=rs0 npx jest tests/performance.mongo.test.js
 *
 * Covered: main's own scenario with main's expected figures (staff-credit
 * rules unchanged); replayed / duplicate records; transfers (several staff
 * on one call, the team counts it once); midnight IST; owner vs telecaller
 * scope; agent-answer-only and driver calls; and agreement with "All call
 * events", "By customer" and the customer overview for the same scope and
 * period. All data fictional. No network, no Plivo.
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

maybe('GET /api/calls/performance per canonical call (real isolated MongoDB)', () => {
  let mongoose; let CallLog; let User; let calls; let history; let overview; let runAsViewer; let customerRef;
  let owner; let asha; let ravi;
  const IST = 5.5 * 3600e3;
  const NOW = Date.UTC(2026, 10, 20, 6, 30); // 20 Nov 2026, 12:00 IST
  const ist = (day, hh, mm = 0, ss = 0) => new Date(Date.UTC(2026, 10, day, hh, mm, ss) - IST);
  const dayRange = (day) => ({ from: ist(day, 0).toISOString(), to: ist(day + 1, 0).toISOString() }); // one India day
  const P = '9000000601';

  beforeAll(async () => {
    mongoose = require('mongoose');
    // Fixed test clock vs Mongoose's heartbeat-age check: see tests/canonicalCalls.mongo.test.js.
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    CallLog = require('../models/CallLog');
    ({ User } = require('../models'));
    calls = require('../controllers/callController');
    history = require('../controllers/callHistoryController');
    overview = require('../services/customerOverview');
    ({ runAsViewer } = require('../utils/phoneViewer'));
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([CallLog, User].map((M) => M.init()));
    owner = await User.create({ name: 'Owner (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true });
    asha = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true });
    ravi = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000003', password: 'x-test-only', isActive: true });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => { await CallLog.collection.deleteMany({}); });
  const realNow = Date.now;
  beforeEach(() => { Date.now = () => NOW; });
  afterEach(() => { Date.now = realNow; });

  const call = (o) => ({ provider: 'plivo', context: o.direction === 'inbound' ? 'incoming' : 'lead', agentType: 'staff', customerPhone: P, ...o });
  const add = (rows) => CallLog.collection.insertMany(rows.map(call));
  async function api(handler, user, query) {
    let body; let status = 200;
    await new Promise((resolve, reject) => runAsViewer(user, () => {
      const res = { status(c) { status = c; return this; }, json(b) { body = JSON.parse(JSON.stringify(b)); resolve(); return this; } };
      Promise.resolve(handler({ query, user }, res, (e) => (e ? reject(e) : resolve()))).catch(reject);
    }));
    if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`);
    return body;
  }
  const perf = (user, range) => api(calls.performance, user, range);
  const person = (b, u) => b.people.find((p) => String(p.user) === String(u._id));

  test('main\'s own scenario gives main\'s figures: staff-credit rules unchanged', async () => {
    const t0 = ist(19, 10);
    const at = (s) => new Date(t0.getTime() + s * 1000);
    await add([
      { direction: 'inbound', status: 'completed', agentUser: ravi._id, startedAt: at(0), answeredAt: at(10) },
      { direction: 'inbound', status: 'completed', agentUser: ravi._id, startedAt: at(100), answeredAt: at(120) },
      { direction: 'inbound', status: 'completed', agentUser: owner._id, startedAt: at(200), answeredAt: at(205) },
      { direction: 'inbound', status: 'completed', startedAt: at(300) }, // answered, nobody recorded
      { direction: 'inbound', status: 'missed', startedAt: at(400) },
      { direction: 'inbound', status: 'no_agents', startedAt: at(500) },
      { direction: 'outbound', status: 'completed', agentUser: ravi._id, startedAt: at(600) },
      { direction: 'outbound', status: 'agent_missed', agentUser: ravi._id, startedAt: at(700) },
    ]);
    const b = await perf(owner, dayRange(19));
    expect(b.team).toEqual({ incoming: 6, answered: 4, answeredUnattributed: 1, missed: 2, inProgress: 0, unconfirmed: 0, driverCalls: 0 });
    expect(person(b, ravi)).toMatchObject({ answered: 2, avgAnswerSec: 15, placed: 2, connected: 1 });
    expect(person(b, owner)).toMatchObject({ answered: 1, avgAnswerSec: 5 });
    expect(b.basis).toEqual({ unit: 'logical_call', logicalCalls: 8, callRecords: 8 });
    // telecaller: own row only, the same team totals
    const t = await perf(ravi, dayRange(19));
    expect(t.scope).toBe('self');
    expect(t.people.map((p) => p.name)).toEqual(['Ravi (test)']);
    expect(t.team).toEqual(b.team);
  });

  test('replayed records: one call, never a missed one; only the agent on the connected record is credited', async () => {
    await add([
      { providerCallId: 'r-1', direction: 'inbound', status: 'completed', agentUser: ravi._id, startedAt: ist(19, 11), answeredAt: ist(19, 11, 0, 8) },
      { providerCallId: 'r-1', direction: 'inbound', status: 'missed', agentUser: asha._id, startedAt: ist(19, 11, 0, 3) }, // replay naming Asha
      { providerCallId: 'r-2', direction: 'inbound', status: 'missed', startedAt: ist(19, 12) },
      { providerCallId: 'r-2', direction: 'inbound', status: 'missed', startedAt: ist(19, 12, 0, 1) }, // replayed miss
      { providerCallId: 'r-3', direction: 'outbound', status: 'customer_missed', agentUser: asha._id, startedAt: ist(19, 13) },
      { providerCallId: 'r-3', direction: 'outbound', status: 'completed', agentUser: asha._id, startedAt: ist(19, 13, 0, 2) },
    ]);
    const b = await perf(owner, dayRange(19));
    expect(b.team).toEqual({ incoming: 2, answered: 1, answeredUnattributed: 0, missed: 1, inProgress: 0, unconfirmed: 0, driverCalls: 0 });
    expect(person(b, ravi)).toMatchObject({ answered: 1, avgAnswerSec: 8 });
    expect(person(b, asha)).toMatchObject({ answered: 0, placed: 1, connected: 1 }); // placed once, not twice
    expect(b.basis).toMatchObject({ logicalCalls: 3, callRecords: 6 });
  });

  test('transfers: several staff on one call are each credited once; the team counts the call once', async () => {
    await add([
      // Ravi answered, transferred to Asha (answered), back to Ravi (rang_back); a replay repeats the transfer list
      { providerCallId: 't-1', direction: 'inbound', status: 'completed', agentUser: ravi._id, startedAt: ist(19, 14), answeredAt: ist(19, 14, 0, 5),
        transfers: [{ outcome: 'answered', answeredBy: asha._id }, { outcome: 'rang_back', answeredBy: ravi._id }, { outcome: 'no_answer' }] },
      { providerCallId: 't-1', direction: 'inbound', status: 'completed', startedAt: ist(19, 14, 0, 1), transfers: [{ outcome: 'answered', answeredBy: asha._id }] },
      // transfer offered to the owner, nobody picked up: no credit
      { providerCallId: 't-2', direction: 'inbound', status: 'completed', agentUser: asha._id, startedAt: ist(19, 15), answeredAt: ist(19, 15, 0, 4), transfers: [{ outcome: 'no_answer', answeredBy: null }] },
    ]);
    const b = await perf(owner, dayRange(19));
    expect(b.team).toMatchObject({ incoming: 2, answered: 2, missed: 0 });
    expect(person(b, ravi).answered).toBe(1);
    expect(person(b, asha).answered).toBe(2); // t-1 as a transfer (once), t-2 as the agent
    expect(person(b, owner).answered).toBe(0);
    const sumPeople = b.people.reduce((n, p) => n + p.answered, 0);
    expect(sumPeople).toBeGreaterThan(b.team.answered); // people overlap; the team does not
  });

  test('midnight IST: a call whose records straddle midnight belongs to its first record\'s day, answered', async () => {
    await add([
      { providerCallId: 'm-1', direction: 'inbound', status: 'missed', startedAt: ist(18, 23, 59, 58) },
      { providerCallId: 'm-1', direction: 'inbound', status: 'completed', agentUser: asha._id, startedAt: ist(19, 0, 0, 3), answeredAt: ist(19, 0, 0, 8) },
    ]);
    const d18 = await perf(owner, dayRange(18));
    expect(d18.team).toMatchObject({ incoming: 1, answered: 1, missed: 0 });
    expect(person(d18, asha)).toMatchObject({ answered: 1, avgAnswerSec: 10 }); // from the call's start (23:59:58)
    const d19 = await perf(owner, dayRange(19));
    expect(d19.team).toMatchObject({ incoming: 0, answered: 0, missed: 0 });
    expect(person(d19, asha).answered).toBe(0);
    const both = await perf(owner, { from: ist(18, 0).toISOString(), to: ist(20, 0).toISOString() });
    expect(both.team).toMatchObject({ incoming: 1, answered: 1, missed: 0 });
  });

  test('agent-answer-only, app claims, recordings and driver calls never count as answered or connected', async () => {
    const stale = ist(19, 9);
    await add([
      { providerCallId: 'a-1', direction: 'inbound', status: 'agent_answered', agentUser: asha._id, answeredAt: stale, endedAt: ist(19, 9, 1), talkSec: 40, recordingUrl: 'https://example.invalid/r', startedAt: stale },
      { providerCallId: 'a-2', direction: 'outbound', status: 'agent_answered', agentUser: asha._id, answeredAt: stale, endedAt: ist(19, 9, 2), recordingUrl: 'https://example.invalid/r2', startedAt: ist(19, 9, 1) },
      { providerCallId: 'a-3', direction: 'inbound', tripMasked: true, status: 'completed', talkSec: 50, startedAt: ist(19, 9, 5) },
      { providerCallId: 'a-4', direction: 'outbound', tripMasked: true, status: 'agent_answered', endedAt: ist(19, 9, 7), startedAt: ist(19, 9, 6) },
    ]);
    const b = await perf(owner, dayRange(19));
    expect(b.team).toEqual({ incoming: 1, answered: 0, answeredUnattributed: 0, missed: 0, inProgress: 0, unconfirmed: 1, driverCalls: 2 });
    expect(person(b, asha)).toMatchObject({ answered: 0, placed: 1, connected: 0 });
  });

  test('the performance panel agrees with All call events, By customer and the overview for the same scope and period', async () => {
    const Q = '9000000602';
    await add([
      { providerCallId: 'g-1', direction: 'inbound', status: 'missed', startedAt: ist(18, 23, 59, 58) },
      { providerCallId: 'g-1', direction: 'inbound', status: 'completed', agentUser: asha._id, startedAt: ist(19, 0, 0, 3) },
      { providerCallId: 'g-2', direction: 'inbound', status: 'completed', agentUser: ravi._id, startedAt: ist(19, 10) },
      { providerCallId: 'g-2', direction: 'inbound', status: 'no_agents', startedAt: ist(19, 10, 0, 2) },
      { providerCallId: 'g-3', direction: 'inbound', status: 'missed', startedAt: ist(19, 11), customerPhone: Q },
      { providerCallId: 'g-4', direction: 'inbound', status: 'ringing', endedAt: ist(19, 12, 1), startedAt: ist(19, 12), customerPhone: Q },
      { providerCallId: 'g-5', direction: 'outbound', status: 'completed', agentUser: asha._id, startedAt: ist(19, 13) },
      { providerCallId: 'g-6', direction: 'outbound', status: 'customer_missed', agentUser: ravi._id, startedAt: ist(19, 14), customerPhone: Q },
      { providerCallId: 'g-7', direction: 'inbound', status: 'completed', agentUser: asha._id, startedAt: ist(20, 9) },
    ]);
    for (const day of [18, 19, 20]) {
      const date = `2026-11-${day}`;
      const p = await perf(owner, dayRange(day));
      const e = await api(history.history, owner, { from: date, to: date });
      expect({ total: p.team.incoming, answered: p.team.answered, missed: p.team.missed, unconfirmed: p.team.unconfirmed, inProgress: p.team.inProgress })
        .toEqual(e.counts.incoming);
      const cust = (await api(history.customers, owner, { from: date, to: date })).customers;
      const sum = (k) => cust.reduce((n, c) => n + c.incoming[k], 0);
      expect([sum('total'), sum('answered'), sum('missed'), sum('unconfirmed')]).toEqual([p.team.incoming, p.team.answered, p.team.missed, p.team.unconfirmed]);
      // per person: answered / placed / connected = the same staff's calls in All call events
      for (const u of [asha, ravi]) {
        const me = person(p, u);
        const ans = await api(history.history, owner, { from: date, to: date, staff: String(u._id), outcome: 'answered' });
        const out = await api(history.history, owner, { from: date, to: date, staff: String(u._id), direction: 'outgoing' });
        const con = await api(history.history, owner, { from: date, to: date, staff: String(u._id), outcome: 'connected' });
        expect([me.answered, me.placed, me.connected]).toEqual([ans.logicalCalls, out.logicalCalls, con.logicalCalls]);
      }
    }
    // The overview's "Today" for one customer = performance for today when that customer is the only caller today.
    const o = await overview.buildOverview(P, { role: 'owner', now: NOW });
    const today = await perf(owner, { from: ist(20, 0).toISOString(), to: new Date(NOW + 1000).toISOString() });
    expect(o.counts.today.incoming).toMatchObject({ total: today.team.incoming, answered: today.team.answered, missed: today.team.missed });
    expect(customerRef(P)).toBeTruthy();
  });
});
