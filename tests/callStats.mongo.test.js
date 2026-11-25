'use strict';
/**
 * tests/callStats.mongo.test.js
 * ============================================================
 * Customer call metrics, the customer overview and the Call Logs
 * "All call events" / "By customer" views against a REAL, ISOLATED MongoDB
 * (throwaway local replica set). Skipped unless MONGO_TEST_URL is set;
 * refuses anything but localhost + a medifleet_test_* database.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_callstats?replicaSet=rs0 npx jest tests/callStats.mongo.test.js
 *
 * All data fictional (numbers 90000 0xxxx).
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

jest.setTimeout(120000);

maybe('customer call metrics on a real isolated MongoDB', () => {
  let mongoose; let CallLog; let CallbackTask; let Payment; let Lead; let Trip; let User;
  let stats; let overview; let history; let runAsViewer; let customerRef;
  let owner; let tele; let tele2;
  const P = '9000000201'; // the customer under test (fictional)
  const OTHER = '9000000202';
  const IST = 5.5 * 3600e3;
  const NOW = Date.UTC(2026, 10, 20, 6, 30); // 20 Nov 2026, 12:00 IST
  const ist = (day, hh, mm = 0) => new Date(Date.UTC(2026, 10, day, hh, mm) - IST); // a time in India on that Nov date

  beforeAll(async () => {
    mongoose = require('mongoose');
    // These tests set Date.now to a fixed day; Mongoose judges "still connected" by
    // Date.now() minus the last heartbeat (stale after 2 intervals), so a heartbeat
    // seen under the fixed clock would look days old. Hourly heartbeats keep that
    // check from tripping during a run (test-only; production never fakes the clock).
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    CallLog = require('../models/CallLog');
    CallbackTask = require('../models/CallbackTask');
    Payment = require('../models/Payment');
    ({ Lead, Trip, User } = require('../models'));
    stats = require('../services/callStats');
    overview = require('../services/customerOverview');
    history = require('../controllers/callHistoryController');
    jest.mock('../controllers/callController', () => ({ markNotLiveOnPlivo: async () => {} })); // no Plivo
    ({ runAsViewer } = require('../utils/phoneViewer'));
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([CallLog, CallbackTask, Lead, Trip, User].map((M) => M.init()));
    owner = await User.create({ name: 'Owner (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true });
    tele = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true });
    tele2 = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000003', password: 'x-test-only', isActive: true });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => { await Promise.all([CallLog, CallbackTask, Lead, Trip].map((M) => M.deleteMany({}))); await Payment.collection.deleteMany({}); });

  const call = (o) => ({ provider: 'plivo', context: o.direction === 'inbound' ? 'incoming' : 'lead', customerPhone: P, agentType: 'staff', ...o });
  const add = (rows) => CallLog.insertMany(rows.map(call));
  const ov = (role, extra = {}) => overview.buildOverview(P, { role, now: NOW, ...extra });
  // Calls an Express handler as `user`, serialising inside the viewer context
  // (that is when CallLog's toJSON decides masked vs full).
  async function api(handler, user, query) {
    let body; let status = 200;
    await new Promise((resolve, reject) => runAsViewer(user, () => {
      const res = { status(c) { status = c; return this; }, json(b) { body = JSON.parse(JSON.stringify(b)); resolve(); return this; } };
      Promise.resolve(handler({ query, user }, res, (e) => (e ? reject(e) : resolve()))).catch(reject);
    }));
    return { status, body };
  }
  const realNow = Date.now;
  beforeEach(() => { Date.now = () => NOW; });
  afterEach(() => { Date.now = realNow; });

  // ── definitions ────────────────────────────────────────────
  test('one logical call is counted once: legs, transfers and recordings live on one row; a replayed webhook row with the same CallUUID is not a second call', async () => {
    await add([
      { direction: 'inbound', status: 'completed', providerCallId: 'uuid-1', customerLegId: 'b-leg', appLeg: { DialStatus: 'no-answer' }, phoneLeg: { DialStatus: 'completed' },
        transfers: [{ outcome: 'answered', answeredBy: tele2._id }], recordings: [{ part: 0, url: 'x', sec: 20 }], startedAt: ist(20, 10), endedAt: ist(20, 10, 5), agentUser: tele._id, agentName: 'Asha (test)' },
      // the hang-up webhook replayed and logged the same call again
      { direction: 'inbound', status: 'not_routed', providerCallId: 'uuid-1', startedAt: ist(20, 10), endedAt: ist(20, 10, 6) },
    ]);
    const s = await stats.customerCallStats(P, { now: NOW });
    expect(s.rows).toBe(2);
    expect(s.logicalCalls).toBe(1);
    expect(s.counts.allTime.incoming).toEqual({ total: 1, answered: 1, missed: 0, unconfirmed: 0, inProgress: 0 });
    expect(s.counts.today.incoming.total).toBe(1);
  });

  test('a manual outcome (WhatsApp chats "No answer", a callback resolution, a lead note) is never another call', async () => {
    const [missed, back] = await add([
      { direction: 'inbound', status: 'missed', startedAt: ist(20, 9), endedAt: ist(20, 9, 1) },
      { direction: 'outbound', context: 'call_back', status: 'completed', startedAt: ist(20, 9, 10), talkSec: 40, agentName: 'Asha (test)' },
    ]);
    await CallbackTask.collection.insertOne({ customerPhone: P, state: 'resolved', firstMissedAt: ist(20, 9), lastMissedAt: ist(20, 9), resolution: { outcome: 'reached', note: 'Spoke to her', at: ist(20, 9, 12), byName: 'Asha (test)' }, missedCalls: [missed._id] });
    await Lead.create({ patientName: 'Meena (test)', phone: P, status: 'contacted', source: 'manual', followUpNotes: [{ text: 'Call again', at: ist(20, 9, 13), byName: 'Asha (test)' }] });
    const waCalls = [{ outcome: 'no_answer', createdAt: ist(20, 9, 20), note: 'tried', calledBy: { name: 'Asha (test)' } }];
    const o = await ov('telecaller', { waCalls });
    expect(o.countsBasis).toMatchObject({ logicalCalls: 2, callRows: 2, computedIn: 'database' });
    expect(o.counts.allTime.incoming.total).toBe(1);
    expect(o.counts.allTime.outgoing).toMatchObject({ attempts: 1, connected: 1, callbackAttempts: 1, callbackConnected: 1 });
    expect(o.timeline.map((e) => e.title)).toEqual(expect.arrayContaining(['Follow-up logged from WhatsApp chats: No answer', 'Callback task closed: Reached the customer', 'Note']));
    expect(back).toBeTruthy();
  });

  test('an agent answering, or a recording URL, alone never proves the customer was connected', async () => {
    await add([
      { direction: 'outbound', status: 'agent_answered', answeredAt: ist(20, 11), endedAt: ist(20, 11, 1), recordingUrl: 'https://example.invalid/rec.mp3', recordingSec: 0, startedAt: ist(20, 11), agentName: 'Asha (test)' },
      { direction: 'outbound', status: 'customer_missed', recordingUrl: 'https://example.invalid/rec2.mp3', startedAt: ist(20, 11, 5), agentName: 'Asha (test)' },
    ]);
    const o = await ov('owner');
    expect(o.counts.allTime.outgoing).toMatchObject({ attempts: 2, connected: 0 });
    expect(o.lastConnected).toBeNull();
    expect(o.lastAttempt).toMatchObject({ outcomeLabel: 'Not connected' });
  });

  test('last attempt and last connected conversation stay separate — even when the connection is older than every loaded call', async () => {
    await add([{ direction: 'inbound', status: 'completed', startedAt: ist(1, 10), talkSec: 90, agentName: 'Ravi (test)' }]);
    await add(Array.from({ length: 320 }, (_, i) => ({ direction: 'outbound', status: 'customer_missed', startedAt: new Date(ist(19, 8).getTime() + i * 60e3), agentName: 'Asha (test)' })));
    const o = await ov('telecaller');
    expect(o.lastAttempt).toMatchObject({ staff: 'Asha (test)', outcomeLabel: 'Not connected' });
    expect(o.lastConnected).toMatchObject({ staff: 'Ravi (test)', talkSec: 90 });
    expect(new Date(o.lastConnected.at)).toEqual(ist(1, 10));
    expect(o.counts.allTime.incoming.answered).toBe(1); // counted although not among the loaded 300
  });

  test('a booking confirmed earlier and cancelled now: current booking empty, last booking cancelled, both events on the timeline', async () => {
    const lead = await Lead.create({ patientName: 'Meena (test)', phone: P, status: 'contacted', source: 'manual', receivedAt: ist(20, 8) });
    const trip = await Trip.create({ patientName: 'Meena (test)', patientPhone: P, baseFare: 1000, pickup: { address: 'Test' }, status: 'booked', leadId: lead._id });
    await Lead.updateOne({ _id: lead._id }, { $set: { status: 'converted', convertedTrip: trip._id }, $push: { history: { type: 'status', at: ist(20, 9), byName: 'Asha (test)', detail: { from: 'contacted', to: 'converted', trip: trip.tripNumber } } } });
    await Trip.collection.updateOne({ _id: trip._id }, { $set: { createdAt: ist(20, 9), status: 'cancelled', cancelledAt: ist(20, 11), cancellationReason: 'Patient recovered' } });
    const trips = await Trip.find({ patientPhone: P }).lean();
    const o = await ov('telecaller', { trips });
    expect(o.booking.current).toBeNull();
    expect(o.booking.last).toMatchObject({ status: 'cancelled', statusLabel: 'Cancelled', cancellationReason: 'Patient recovered' });
    expect(o.booking).toMatchObject({ total: 1, cancelled: 1 });
    const titles = o.timeline.map((e) => e.title);
    expect(titles[0]).toBe(`${trip.tripNumber}: booking cancelled`);
    expect(titles).toEqual(expect.arrayContaining([`Booked ${trip.tripNumber} for Meena (test)`, expect.stringContaining('Contacted → Booked')]));
    expect(o.enquiry).toMatchObject({ status: 'converted', active: false }); // enquiry status untouched by the cancellation
  });

  test('a shared number with several legitimate trips: names listed apart, flagged, never merged; one person\'s calls are not split', async () => {
    await Trip.create([
      { patientName: 'Meena (test)', patientPhone: P, baseFare: 1000, pickup: { address: 'A' }, status: 'completed', completedAt: ist(10, 12) },
      { patientName: 'Gopal (test)', patientPhone: P, baseFare: 1000, pickup: { address: 'B' }, status: 'booked' },
    ]);
    await add([{ direction: 'inbound', status: 'completed', startedAt: ist(20, 9) }]);
    const trips = await Trip.find({ patientPhone: P }).lean();
    const o = await ov('telecaller', { trips });
    expect(o.names.sort()).toEqual(['Gopal (test)', 'Meena (test)']);
    expect(o.sharedNumber).toBe(true);
    expect(o.booking).toMatchObject({ total: 2, completed: 1 });
    expect(o.booking.current).toMatchObject({ patientName: 'Gopal (test)', status: 'booked' });
    const { body } = await api(history.customers, owner, {});
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]).toMatchObject({ sharedNumber: true, calls: 1 });
  });

  // ── IST periods ────────────────────────────────────────────
  test('Today / 7 days / 30 days / All time use India-time day boundaries', async () => {
    await add([
      { direction: 'inbound', status: 'completed', startedAt: ist(20, 0, 1) },   // today 00:01 IST
      { direction: 'inbound', status: 'missed', startedAt: ist(19, 23, 59) },    // yesterday 23:59 IST
      { direction: 'inbound', status: 'missed', startedAt: ist(14, 0, 0) },      // first instant of the 7-day window
      { direction: 'inbound', status: 'missed', startedAt: ist(13, 23, 59) },    // just outside it
      { direction: 'inbound', status: 'missed', startedAt: ist(22 - 31, 12) },   // 22 Oct: inside 30 days (window from 22 Oct 00:00 IST)
      { direction: 'inbound', status: 'missed', startedAt: new Date(ist(1, 0).getTime() - 20 * 86400e3) }, // 12 Oct: outside 30 days
    ]);
    const s = await stats.customerCallStats(P, { now: NOW });
    expect(s.counts.today.incoming.total).toBe(1);
    expect(s.counts.last7Days.incoming.total).toBe(3);
    expect(s.counts.last30Days.incoming.total).toBe(5);
    expect(s.counts.allTime.incoming.total).toBe(6);
    expect(s.period.from.today).toBe('2026-11-19T18:30:00.000Z');
    expect(s.period.from.last7Days).toBe('2026-11-13T18:30:00.000Z');
    expect(s.period.from.last30Days).toBe('2026-10-21T18:30:00.000Z');
  });

  // ── the same classification in MongoDB and in JS ────────────
  test('database counts equal the per-call classification row for row (mixed statuses, stale and live rings, driver calls, callbacks)', async () => {
    const statuses = { inbound: ['completed', 'missed', 'no_agents', 'not_routed', 'ringing', 'initiated', 'agent_answered', 'failed'], outbound: ['completed', 'customer_missed', 'agent_missed', 'agent_answered', 'initiated', 'failed'] };
    const rows = [];
    let seed = 7; const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    for (let i = 0; i < 600; i += 1) {
      const direction = rnd(2) ? 'inbound' : 'outbound';
      const st = statuses[direction][rnd(statuses[direction].length)];
      rows.push({ direction, status: st, startedAt: new Date(NOW - rnd(60 * 86400) * 1000), ...(rnd(3) === 0 ? { endedAt: new Date(NOW - 1000) } : {}),
        ...(rnd(10) === 0 ? { tripMasked: true, context: 'trip' } : {}), ...(direction === 'outbound' && rnd(4) === 0 ? { context: 'call_back' } : {}) });
    }
    await add(rows);
    const s = await stats.customerCallStats(P, { now: NOW });
    const js = overview.computeOverview({ calls: await CallLog.find({ customerPhone: P }).lean() }, { now: NOW }).counts;
    expect(s.counts).toEqual(js);
  });

  // ── more than 2,000 calls; pagination ───────────────────────
  test('2,450 calls: overview counts every one (no 2,000 cap); "All call events" pages through all of them once, in a stable order', async () => {
    const N = 2450;
    const base = ist(20, 11).getTime();
    await add(Array.from({ length: N }, (_, i) => ({
      direction: i % 5 === 0 ? 'inbound' : 'outbound',
      status: i % 5 === 0 ? (i % 2 ? 'completed' : 'missed') : (i % 3 ? 'customer_missed' : 'completed'),
      // groups of identical timestamps exercise the _id tie-break
      startedAt: new Date(base - Math.floor(i / 7) * 3600e3),
      agentUser: i % 2 ? tele._id : tele2._id, agentName: i % 2 ? 'Asha (test)' : 'Ravi (test)',
    })));
    await add([{ direction: 'inbound', status: 'completed', customerPhone: OTHER, startedAt: ist(20, 8) }]);
    const expected = { incoming: 490, answered: 245, outgoing: 1960 };
    const o = await ov('telecaller');
    expect(o.counts.allTime.incoming).toMatchObject({ total: expected.incoming, answered: expected.answered, missed: expected.incoming - expected.answered });
    expect(o.counts.allTime.outgoing.attempts).toBe(expected.outgoing);
    expect(o.countsBasis).toMatchObject({ logicalCalls: N, callRows: N });
    expect(o.calls).toHaveLength(overview.CALLS_SHOWN);
    expect(o.callsPage).toMatchObject({ callRows: N, more: true });

    const ref = customerRef(P);
    const seen = []; let cursor = null; let first = null; let pages = 0;
    do {
      const { body } = await api(history.history, tele, { customerRef: ref, limit: '100', ...(cursor ? { cursor } : {}) });
      if (!first) first = body;
      seen.push(...body.logs.map((l) => l._id));
      cursor = body.nextCursor; pages += 1;
      // a call arriving mid-paging never shifts later pages
      if (pages === 3) await add([{ direction: 'inbound', status: 'missed', startedAt: new Date(NOW) }]);
    } while (cursor);
    expect(first.total).toBe(N);
    expect(first.counts.incoming.total).toBe(expected.incoming);
    expect(pages).toBe(Math.ceil(N / 100));
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
    const order = await CallLog.find({ customerPhone: P, startedAt: { $lt: new Date(NOW) } }).sort({ startedAt: -1, _id: -1 }).select('_id').lean();
    expect(seen).toEqual(order.map((x) => String(x._id)));

    // filters, server-side
    const asha = await api(history.history, tele, { customerRef: ref, staff: String(tele._id), direction: 'incoming', outcome: 'answered', limit: '5' });
    expect(asha.body.total).toBe(await CallLog.countDocuments({ customerPhone: P, agentUser: tele._id, direction: 'inbound', status: 'completed' }));
    expect(asha.body.logs.every((l) => l.direction === 'inbound' && l.status === 'completed')).toBe(true);
    const forbidden = await api(history.history, tele, { staff: String(tele2._id) });
    expect(forbidden.status).toBe(403);
  });

  test('"By customer": one row per number, counted per logical call, searchable, stable keyset pages', async () => {
    const numbers = Array.from({ length: 45 }, (_, i) => `90000${String(100000 + i).slice(1)}`);
    await add(numbers.flatMap((p, i) => [
      { customerPhone: p, direction: 'inbound', status: 'missed', startedAt: new Date(ist(20, 10).getTime() - (i % 9) * 60e3), providerCallId: `u-${p}` },
      { customerPhone: p, direction: 'inbound', status: 'completed', startedAt: new Date(ist(20, 10).getTime() - (i % 9) * 60e3), providerCallId: `u-${p}` }, // replay of the same call
      { customerPhone: p, direction: 'outbound', status: i % 2 ? 'completed' : 'customer_missed', startedAt: new Date(ist(18, 10).getTime()) },
    ]));
    await Lead.create({ patientName: 'Kavya (test)', phone: numbers[3], status: 'new', source: 'manual' });
    const seen = []; let cursor = null; let total = null;
    do {
      const { body } = await api(history.customers, tele, { limit: '10', ...(cursor ? { cursor } : {}) });
      total ??= body.total;
      seen.push(...body.customers);
      cursor = body.nextCursor;
      if (cursor) expect(cursor).not.toMatch(/9000\d{6}/);
    } while (cursor);
    expect(total).toBe(45);
    expect(new Set(seen.map((c) => c.customerRef)).size).toBe(45);
    expect(seen.every((c) => c.calls === 2 && c.incoming.total === 1 && c.incoming.answered === 1)).toBe(true);
    expect(seen.every((c) => !('customerPhone' in c) && /^••••••\d{4}$/.test(c.customerMasked))).toBe(true); // telecaller: masked
    const byName = await api(history.customers, tele, { q: 'kavya' });
    expect(byName.body.customers).toHaveLength(1);
    expect(byName.body.customers[0]).toMatchObject({ names: ['Kavya (test)'] });
    const byDigits = await api(history.customers, owner, { q: numbers[7].slice(-4) });
    expect(byDigits.body.customers.map((c) => c.customerPhone)).toContain(numbers[7]); // owner: full number
    const today = await api(history.customers, owner, { period: 'today', direction: 'outgoing' });
    expect(today.body.total).toBe(0); // outgoing calls were on the 18th
  });

  // ── privacy ────────────────────────────────────────────────
  test('owner vs telecaller: payments (list, timeline entries, counts) owner-only; numbers in notes masked for the telecaller; the number never in their JSON', async () => {
    const trip = await Trip.create({ patientName: 'Meena (test)', patientPhone: P, baseFare: 1000, pickup: { address: 'Test' }, status: 'completed', completedAt: ist(19, 12) });
    await Payment.collection.insertMany([
      { receiptNumber: 'RCT/TEST/1', trip: trip._id, kind: 'payment', amountPaise: 150000, method: 'cash', receivedAt: ist(19, 13), verification: 'staff_recorded' },
      { receiptNumber: 'RCT/TEST/2', trip: trip._id, kind: 'refund', amountPaise: 20000, method: 'upi', receivedAt: ist(19, 14), verification: 'staff_recorded' },
    ]);
    await Lead.create({ patientName: 'Meena (test)', phone: P, status: 'contacted', source: 'manual', message: `Call my son on ${OTHER}`, followUpNotes: [{ text: `Alt number 98450 12345`, at: ist(20, 9), byName: 'Asha (test)' }] });
    await add([{ direction: 'inbound', status: 'completed', startedAt: ist(20, 8) }]);
    const trips = await Trip.find({ patientPhone: P }).lean();
    const asOwner = await ov('owner', { trips });
    const asTele = await ov('telecaller', { trips });
    expect(asOwner.payments).toHaveLength(2);
    expect(asOwner.timeline.filter((e) => e.kind === 'payment')).toHaveLength(2);
    expect(asTele.payments).toBeUndefined();
    expect(asTele.timeline.some((e) => e.kind === 'payment')).toBe(false);
    const teleText = JSON.stringify(asTele);
    expect(teleText).not.toMatch(/RCT\/TEST|1,500|refund/i);
    expect(teleText).not.toContain(P);
    expect(teleText).not.toContain(OTHER);
    expect(teleText).not.toContain('98450 12345');
    expect(asTele.latestNote.text).toBe('Alt number ••••••2345');
    expect(JSON.stringify(asOwner)).toContain('98450 12345');
    // the call cards: masked for the telecaller, full for the owner
    const t1 = await api(history.history, tele, { customerRef: customerRef(P) });
    expect(JSON.stringify(t1.body)).not.toContain(P);
    expect(t1.body.logs[0].customerMasked).toBe('••••••0201');
    const o1 = await api(history.history, owner, { customerRef: customerRef(P) });
    expect(o1.body.logs[0].customerPhone).toBe(P);
  });
});
