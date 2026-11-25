'use strict';
/**
 * tests/customerOverview.test.js — services/customerOverview.js and the
 * customer history endpoint (GET /api/whatsapp/customer/:ref).
 * All people and numbers here are fictional.
 *
 *   A. the reported inconsistency, reproduced through the real route:
 *      summary "Calls made: 0" (it counts WhatsApp-logged outcomes only)
 *      while the customer has 3 outgoing + 1 incoming recorded calls —
 *      the overview counts the recorded calls, by direction and period
 *   B. an end-to-end story: repeat incoming calls -> callback -> connected
 *      -> note -> follow-up -> booking -> cancellation; counts, last
 *      attempt vs last connected, latest note, enquiry / task / booking
 *      statuses kept apart, next action, one timeline
 *   C. a shared number is flagged, never merged; payments only for the owner;
 *      nothing in the overview carries the number
 * ============================================================
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-customer-overview-secret';

const { computeOverview } = require('../services/customerOverview');

const PHONE = '9000000101';
const D = (s) => new Date(`2026-11-20T${s}:00+05:30`); // a fictional day, India time
const D2 = (s) => new Date(`2026-11-21T${s}:00+05:30`);
const NOW = +D2('15:00');

// ── B. the story ───────────────────────────────────────────────
function story() {
  const asha = { agentName: 'Asha (fictional)' };
  const calls = [
    { _id: 'c1', direction: 'inbound', status: 'missed', context: 'incoming', startedAt: D('10:00'), endedAt: D('10:01') },
    { _id: 'c2', direction: 'inbound', status: 'no_agents', context: 'incoming', startedAt: D('10:05'), endedAt: D('10:05') },
    { _id: 'c3', direction: 'outbound', status: 'customer_missed', context: 'call_back', callbackTask: 'cb1', startedAt: D('10:20'), endedAt: D('10:21'), ...asha },
    { _id: 'c4', direction: 'outbound', status: 'completed', context: 'call_back', callbackTask: 'cb1', startedAt: D('10:40'), endedAt: D('10:42'), talkSec: 95, recordingUrl: 'x', recordingSec: 90, ...asha },
    { _id: 'c5', direction: 'inbound', status: 'completed', context: 'incoming', startedAt: D('11:00'), endedAt: D('11:03'), talkSec: 160, ...asha },
    { _id: 'c6', direction: 'outbound', status: 'completed', context: 'lead', startedAt: D2('09:05'), endedAt: D2('09:08'), talkSec: 140, ...asha },
  ];
  const callbacks = [{
    _id: 'cb1', state: 'resolved', firstMissedAt: D('10:00'), lastMissedAt: D('10:05'), missedCount: 2,
    assignedToName: 'Asha (fictional)', resolution: { outcome: 'reached', note: 'Needs an ICU ambulance tomorrow; call at 9 am', at: D('10:42'), byName: 'Asha (fictional)' },
  }];
  const leads = [{
    _id: 'l1', patientName: 'Meena (fictional)', status: 'converted', source: 'manual', convertedTrip: 't1',
    assignedToName: 'Asha (fictional)', createdByName: 'Asha (fictional)', receivedAt: D('10:43'),
    followUpNotes: [{ text: 'Family will confirm the hospital by 9 am', at: D('11:04'), byName: 'Asha (fictional)' }],
    history: [
      { type: 'created', at: D('10:43'), byName: 'Asha (fictional)', detail: { source: 'manual' } },
      { type: 'follow_up_set', at: D('11:05'), byName: 'Asha (fictional)', detail: { at: D2('09:00') } },
      { type: 'status', at: D2('09:10'), byName: 'Asha (fictional)', detail: { from: 'contacted', to: 'converted', trip: 'TRP-1' } },
    ],
  }];
  const trips = [{ _id: 't1', tripNumber: 'TRP-1', patientName: 'Meena (fictional)', status: 'cancelled', selectedType: 'icu', createdAt: D2('09:10'), cancelledAt: D2('12:00'), cancellationReason: 'Family arranged transport' }];
  return { calls, callbacks, leads, trips, waCalls: [], conversations: [], payments: [{ receiptNumber: 'RCT/26-27/000001', kind: 'advance', amountPaise: 50000, method: 'upi', receivedAt: D2('09:20'), trip: 't1' }] };
}

describe('B. end-to-end story: counts and current status agree', () => {
  const o = computeOverview(story(), { role: 'telecaller', now: NOW });

  test('counts by direction and period: 3 incoming (2 missed, 1 answered); 3 outgoing (2 connected), 2 of them callbacks (1 connected)', () => {
    expect(o.counts.allTime).toEqual({
      incoming: { total: 3, answered: 1, missed: 2, unconfirmed: 0, inProgress: 0 },
      outgoing: { attempts: 3, connected: 2, callbackAttempts: 2, callbackConnected: 1 },
      driverCalls: 0,
    });
    expect(o.counts.last30Days).toEqual(o.counts.allTime);
    expect(o.period.firstContactAt).toEqual(D('10:00'));
  });

  test('the customer-wise call list has the same 6 calls the counts are made from', () => {
    expect(o.calls).toHaveLength(6);
    expect(o.calls.filter((c) => c.kind === 'incoming')).toHaveLength(o.counts.allTime.incoming.total);
    expect(o.calls.filter((c) => c.kind === 'outgoing')).toHaveLength(o.counts.allTime.outgoing.attempts);
  });

  test('last attempt is separate from the last connected conversation, with who spoke', () => {
    expect(o.lastAttempt).toMatchObject({ at: D2('09:05'), direction: 'outbound', outcomeLabel: 'Connected', staff: 'Asha (fictional)' });
    expect(o.lastConnected).toMatchObject({ at: D2('09:05'), staff: 'Asha (fictional)', talkSec: 140 });
  });

  test('latest staff note, with who and when and where it was written', () => {
    expect(o.latestNote).toEqual({ text: 'Family will confirm the hospital by 9 am', at: D('11:04'), by: 'Asha (fictional)', source: 'Lead note' });
  });

  test('statuses kept apart: enquiry Booked (closed), no open callback task, no current booking, last booking Cancelled with reason', () => {
    expect(o.enquiry).toMatchObject({ status: 'converted', statusLabel: 'Booked', active: false, assignee: 'Asha (fictional)', nextFollowUpAt: null });
    expect(o.callbackTask).toBeNull();
    expect(o.booking.current).toBeNull();
    expect(o.booking.last).toMatchObject({ tripNumber: 'TRP-1', status: 'cancelled', statusLabel: 'Cancelled', cancellationReason: 'Family arranged transport' });
    expect(o.booking).toMatchObject({ total: 1, cancelled: 1, completed: 0 });
    expect(o.nextAction).toBeNull();
  });

  test('one chronological timeline, newest first, telling the whole story', () => {
    const titles = o.timeline.map((e) => e.title);
    expect(titles[0]).toBe('TRP-1: booking cancelled');
    expect(titles).toEqual(expect.arrayContaining([
      'Incoming call — missed', 'Callback — not connected', 'Callback — connected', 'Callback task closed: Reached the customer',
      'Enquiry received (manual)', 'Follow-up scheduled', 'Note', 'Incoming call — answered', 'Outgoing call — connected',
      'Booked TRP-1 for Meena (fictional)', 'Enquiry status: Contacted → Booked (booking TRP-1)',
    ]));
    const ts = o.timeline.map((e) => +new Date(e.at));
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  test('mid-story (before the booking): open enquiry with its follow-up is the next action, assignee shown', () => {
    const s = story();
    s.trips = []; s.leads[0].status = 'contacted'; delete s.leads[0].convertedTrip; s.leads[0].nextFollowUpAt = D2('09:00');
    s.leads[0].history = s.leads[0].history.slice(0, 2);
    const mid = computeOverview(s, { role: 'telecaller', now: +D('18:00') });
    expect(mid.nextAction).toMatchObject({ label: 'Follow up on the enquiry', dueAt: D2('09:00'), overdue: false, assignee: 'Asha (fictional)' });
    expect(mid.enquiry).toMatchObject({ statusLabel: 'Contacted', active: true });
  });

  test('right after the missed calls: an open callback task is the next action (overdue), counts 2 missed', () => {
    const s = story();
    s.calls = s.calls.slice(0, 2); s.leads = []; s.trips = [];
    s.callbacks = [{ ...s.callbacks[0], state: 'open', resolution: undefined, assignedToName: null }];
    const early = computeOverview(s, { role: 'telecaller', now: +D('10:30') });
    expect(early.counts.allTime.incoming).toMatchObject({ total: 2, missed: 2, answered: 0 });
    expect(early.lastConnected).toBeNull();
    expect(early.callbackTask).toMatchObject({ status: 'open', overdue: true, assignee: null });
    expect(early.nextAction).toMatchObject({ label: 'Call back (missed call)', overdue: true });
  });

  test('payments only for the owner', () => {
    expect(o.payments).toBeUndefined();
    expect(o.timeline.some((e) => e.kind === 'payment')).toBe(false);
    const own = computeOverview(story(), { role: 'owner', now: NOW });
    expect(own.payments).toEqual([{ receiptNumber: 'RCT/26-27/000001', kind: 'advance', amountPaise: 50000, method: 'upi', receivedAt: D2('09:20'), trip: 't1' }]);
    expect(own.timeline.some((e) => e.kind === 'payment')).toBe(true);
  });
});

describe('C. identity and masking', () => {
  test('a shared number with two names is flagged, never merged', () => {
    const s = story();
    s.trips[0].patientName = 'Ramesh (fictional)';
    const o = computeOverview(s, { role: 'owner', now: NOW });
    expect(o.sharedNumber).toBe(true);
    expect(o.names).toEqual(['Meena (fictional)', 'Ramesh (fictional)']);
  });
  test('the number appears nowhere in the overview', () => {
    const s = story();
    s.calls.forEach((c) => { c.customerPhone = PHONE; });
    expect(JSON.stringify(computeOverview(s, { role: 'owner', now: NOW }))).not.toContain(PHONE);
  });
  test('masked driver<->customer trip calls are counted apart from staff calls', () => {
    const s = story();
    s.calls.push({ _id: 'd1', direction: 'outbound', status: 'completed', tripMasked: true, tripCallFrom: 'driver', startedAt: D2('12:30'), talkSec: 30 });
    const o = computeOverview(s, { role: 'telecaller', now: NOW });
    expect(o.counts.allTime.driverCalls).toBe(1);
    expect(o.counts.allTime.outgoing.attempts).toBe(3);
    expect(o.lastAttempt.at).toEqual(D2('09:05')); // driver calls are not staff attempts
  });
});

// ── A. reproduce the report through the real route ─────────────
describe('A. reported inconsistency: "Calls made: 0" next to 3 outgoing + 1 incoming recorded calls', () => {
  const mockRows = {};
  const q = (rows) => { const c = { sort: () => c, select: () => c, populate: () => c, limit: () => c, lean: async () => rows, then: (r, j) => Promise.resolve(rows).then(r, j) }; return c; };
  let handler;
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../utils/pushService', () => ({ sendPush: jest.fn() }));
    jest.doMock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));
    jest.doMock('../models/WhatsAppFunnelEvent', () => ({ find: () => q([]) }));
    jest.doMock('../models/WhatsAppCallLog', () => ({ find: () => q([]) }));            // nothing logged from WhatsApp Chats
    const newest = () => [...mockRows.calls].sort((a, b) => b.startedAt - a.startedAt);
    jest.doMock('../models/CallLog', () => ({
      find: () => q(newest()),
      findOne: (f) => q(newest().find((r) => !r.tripMasked && (!f.status || r.status === f.status)) || null),
    }));
    // Counts come from MongoDB in production (services/callStats, verified on a
    // real database in tests/callStats.mongo.test.js); here the same numbers
    // from the per-call classification, to test the route's wiring.
    jest.doMock('../services/callStats', () => {
      const realStats = jest.requireActual('../services/callStats');
      return { ...realStats, customerCallStats: async (_p, { now }) => {
        const { computeOverview: co } = jest.requireActual('../services/customerOverview');
        return { counts: co({ calls: mockRows.calls }, { now }).counts, rows: mockRows.calls.length, logicalCalls: mockRows.calls.length, firstCallAt: null };
      } };
    });
    jest.doMock('../models/CallbackTask', () => ({ find: () => q([]) }));
    jest.doMock('../models/Payment', () => ({ find: () => q([]) }));
    const real = jest.requireActual('../models');
    jest.doMock('../models', () => ({ ...real, Trip: { find: () => q([]) }, Lead: { find: () => q([]) } }));
    const router = require('../routes/whatsappRoutes');
    handler = router.stack.find((l) => l.route?.path === '/customer/:phone').route.stack.at(-1).handle;
  });
  test('the overview counts the recorded calls; the old summary field (WhatsApp-logged outcomes) stays 0', async () => {
    mockRows.calls = [
      { _id: 'a', direction: 'outbound', status: 'customer_missed', startedAt: D('10:00'), agentName: 'Asha (fictional)' },
      { _id: 'b', direction: 'outbound', status: 'completed', startedAt: D('11:00'), talkSec: 60, agentName: 'Asha (fictional)' },
      { _id: 'c', direction: 'outbound', status: 'agent_missed', startedAt: D('12:00'), agentName: 'Ravi (fictional)' },
      { _id: 'd', direction: 'inbound', status: 'completed', startedAt: D('13:00'), talkSec: 45, agentName: 'Ravi (fictional)' },
    ];
    const { customerRef } = require('../utils/customerPhone');
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const next = jest.fn();
    await handler({ params: { phone: customerRef(PHONE) }, user: { _id: 'u1', role: 'telecaller' } }, res, next);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
    expect(res.body.summary.totalCallsMade).toBe(0);            // what the old card showed as "Calls made"
    expect(res.body.overview.counts.allTime.outgoing).toMatchObject({ attempts: 3, connected: 1 });
    expect(res.body.overview.counts.allTime.incoming).toMatchObject({ total: 1, answered: 1 });
    expect(res.body.overview.lastConnected).toMatchObject({ staff: 'Ravi (fictional)' });
    expect(res.body.overview.payments).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });
});
