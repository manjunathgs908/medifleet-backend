/**
 * tests/dispatchUrgency.test.js
 * ============================================================
 * Stale bookings on the Active Trips board, and the operator actions on them.
 *
 *   - every active booking carries its age and urgency: an immediate
 *     booking with no crew is overdue after the threshold; a scheduled one
 *     is judged by its pickup time (an absolute instant — no timezone drift)
 *   - "crew assigned" = a driver AND their ambulance (or legacy vehicle),
 *     not just status 'dispatched'
 *   - overdue bookings stay on the board and in the count — nothing is
 *     auto-completed, auto-cancelled or written
 *   - cancel needs a reason; complete needs a crew
 *   - assign / cancel / complete at the same moment can't overwrite each
 *     other or bill twice
 *
 * Models mocked — no database, nothing sent.
 * ============================================================
 */
'use strict';

jest.mock('../models', () => {
  const m = () => ({
    find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
    findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
    updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
  });
  return { User: m(), Trip: m(), Attendance: m(), SalaryRecord: m(), Expense: m(), Notification: m(), Advance: m(), Bill: m(), Income: m(), Hospital: m(), Vehicle: m(), Pricing: m() };
});
const stub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
});
jest.mock('../models/Ambulance',     () => stub());
jest.mock('../models/Assignment',    () => stub());
jest.mock('../models/Shift',         () => stub());
jest.mock('../models/Fleet',         () => stub());
jest.mock('../models/Owner',         () => stub());
jest.mock('../models/GeofenceEvent', () => stub());
jest.mock('../models/BookingOtp',    () => stub());
jest.mock('../models/TripCallEvent', () => ({ create: jest.fn(async () => ({})) }));
// Completion counts advances into the new bill; these trips have none.
jest.mock('../models/Payment', () => ({ find: () => ({ session: () => ({ sort: async () => [] }) }), updateMany: jest.fn() }));
jest.mock('../utils/cloudinary',    () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/smsService',    () => ({ sendOtp: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({ isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn() }));
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({
  compute: jest.fn(async () => ({ baseFare: 1000, additionalCharges: 0, subTotal: 1000, gstAmount: 50, grandTotal: 1050 })),
  findPricingDoc: jest.fn(async () => ({})),
}));
jest.mock('../services/whatsappNotifications', () => ({
  notifyDriverAssigned: jest.fn(async () => {}), notifyTripStarted: jest.fn(async () => {}), notifyTripCompleted: jest.fn(async () => {}),
}));
jest.mock('../services/trackingNotifications', () => ({ notifyTrackingLink: jest.fn(async () => {}) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
// The in-app call hook (services/tripVoip.js) — checked below, never run.
jest.mock('../services/tripVoip', () => ({ closeTripVoip: jest.fn(async () => ({})) }));

const { Trip, User, Bill, Income, Notification } = require('../models');
const Ambulance = require('../models/Ambulance');
const ctrl = require('../controllers/tripController');
const { dispatchStateOf, countDispatchStates, thresholds } = require('../utils/dispatchUrgency');
const whatsappNotifications = require('../services/whatsappNotifications');

const NOW = new Date('2026-11-01T10:00:00Z').getTime();
const min = (m) => new Date(NOW - m * 60e3);
const inMin = (m) => new Date(NOW + m * 60e3);
const trip = (over) => ({ _id: over._id || 'T', status: 'booked', scheduleType: 'now', createdAt: min(5), ...over });
const CREW = { driver: 'd1', ambulance: 'amb1' };

const run = async (handler, req) => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  await handler({ body: {}, params: {}, query: {}, user: { _id: 'op1', role: 'owner' }, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

afterEach(() => {
  delete process.env.DISPATCH_UNASSIGNED_OVERDUE_MINUTES;
  delete process.env.DISPATCH_SCHEDULED_DUE_SOON_MINUTES;
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('urgency of each active booking', () => {
  it('a recent immediate booking without a crew is awaiting assignment, with its age', () => {
    expect(dispatchStateOf(trip({ createdAt: min(5) }), NOW)).toEqual(expect.objectContaining({ state: 'awaiting_assignment', ageMinutes: 5, scheduled: false }));
  });

  it('an immediate booking still without a crew after 15 min is overdue — e.g. 28 Oct seen on 1 Nov', () => {
    const s = dispatchStateOf(trip({ createdAt: new Date('2026-10-28T09:00:00Z') }), NOW);
    expect(s.state).toBe('overdue_unassigned');
    expect(s.ageMinutes).toBe(4 * 24 * 60 + 60);
    expect(s.overdueMinutes).toBe(s.ageMinutes);
  });

  it('exactly at the threshold it becomes overdue; one minute before, not yet', () => {
    expect(dispatchStateOf(trip({ createdAt: min(14) }), NOW).state).toBe('awaiting_assignment');
    expect(dispatchStateOf(trip({ createdAt: min(15) }), NOW).state).toBe('overdue_unassigned');
  });

  it('scheduled bookings are judged by their pickup time, not by when they were made', () => {
    const made3DaysAgo = { scheduleType: 'later', createdAt: min(3 * 24 * 60) };
    expect(dispatchStateOf(trip({ ...made3DaysAgo, scheduleDate: inMin(5 * 60) }), NOW).state).toBe('scheduled_upcoming');
    expect(dispatchStateOf(trip({ ...made3DaysAgo, scheduleDate: inMin(30) }), NOW).state).toBe('scheduled_due_soon');
    expect(dispatchStateOf(trip({ ...made3DaysAgo, scheduleDate: min(5) }), NOW).state).toBe('scheduled_due_soon');
    const late = dispatchStateOf(trip({ ...made3DaysAgo, scheduleDate: min(120) }), NOW);
    expect(late).toEqual(expect.objectContaining({ state: 'overdue_unassigned', overdueMinutes: 120, scheduled: true }));
  });

  it('a pickup time is an absolute instant: 15:30 IST and 10:00 UTC are the same moment', () => {
    const ist = dispatchStateOf(trip({ scheduleType: 'later', scheduleDate: '2026-11-01T15:30:00+05:30' }), NOW);
    const utc = dispatchStateOf(trip({ scheduleType: 'later', scheduleDate: new Date('2026-11-01T10:00:00Z') }), NOW);
    expect(ist.minutesToPickup).toBe(0);
    expect(utc.minutesToPickup).toBe(0);
    expect(new Date(ist.pickupAt).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  it('a "later" booking with no (or an invalid) pickup time is treated as immediate', () => {
    expect(dispatchStateOf(trip({ scheduleType: 'later', createdAt: min(60) }), NOW).state).toBe('overdue_unassigned');
    expect(dispatchStateOf(trip({ scheduleType: 'later', scheduleDate: 'not a date', createdAt: min(60) }), NOW).state).toBe('overdue_unassigned');
  });

  it('"assigned" means a driver AND their ambulance (or legacy vehicle) — own fleet or partner, however old', () => {
    expect(dispatchStateOf(trip({ status: 'dispatched', ...CREW, createdAt: min(3 * 24 * 60) }), NOW).state).toBe('assigned');
    expect(dispatchStateOf(trip({ status: 'en_route', ...CREW }), NOW).state).toBe('assigned');
    expect(dispatchStateOf(trip({ status: 'dispatched', driver: 'd1', vehicle: 'v1' }), NOW).state).toBe('assigned'); // pre-Ambulance trip
  });

  it('"dispatched" to an ambulance with no driver is NOT a crew — it is still waiting/overdue', () => {
    expect(dispatchStateOf(trip({ status: 'dispatched', ambulance: 'amb1', createdAt: min(60) }), NOW).state).toBe('overdue_unassigned');
    expect(dispatchStateOf(trip({ status: 'dispatched', driver: 'd1', createdAt: min(5) }), NOW).state).toBe('awaiting_assignment');
  });

  it('completed and cancelled trips are not active', () => {
    expect(dispatchStateOf(trip({ status: 'completed' }), NOW)).toBeNull();
    expect(dispatchStateOf(trip({ status: 'cancelled' }), NOW)).toBeNull();
  });
});

describe('scheduled pickup time from the booking forms (timezone)', () => {
  const { parseScheduleDate } = require('../utils/dispatchUrgency');
  it('a form value with no timezone (website / CRM datetime-local) is India time', () => {
    expect(parseScheduleDate('2026-11-01T15:30').toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(parseScheduleDate(' 2026-11-01T15:30:45 ').toISOString()).toBe('2026-11-01T10:00:45.000Z');
  });
  it('a value that states its timezone (the app sends ...Z) is kept exactly', () => {
    expect(parseScheduleDate('2026-11-01T10:00:00.000Z').toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(parseScheduleDate('2026-11-01T15:30+05:30').toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(parseScheduleDate(new Date('2026-11-01T10:00:00Z')).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });
  it('nothing usable gives no pickup time', () => {
    for (const v of [undefined, null, '', 'tomorrow', '2026-13-45T99:99']) expect(parseScheduleDate(v)).toBeUndefined();
  });
  it('createTrip uses it for scheduled bookings', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'controllers', 'tripController.js'), 'utf8');
    expect(src).toMatch(/scheduleDate\s*:\s*scheduleType === 'later' && scheduleDate \? parseScheduleDate\(scheduleDate\)/);
  });
});

describe('threshold configuration', () => {
  it('defaults: 15 min overdue, 60 min due soon', () => {
    expect(thresholds()).toEqual({ overdueMinutes: 15, dueSoonMinutes: 60 });
  });

  it('valid values are used', () => {
    process.env.DISPATCH_UNASSIGNED_OVERDUE_MINUTES = '45';
    process.env.DISPATCH_SCHEDULED_DUE_SOON_MINUTES = '180';
    expect(thresholds()).toEqual({ overdueMinutes: 45, dueSoonMinutes: 180 });
    expect(dispatchStateOf(trip({ createdAt: min(30) }), NOW).state).toBe('awaiting_assignment');
  });

  it.each(['0', '-5', 'fifteen', '1e9', 'NaN', 'Infinity'])('an invalid value (%s) falls back to the default, with a warning', (bad) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DISPATCH_UNASSIGNED_OVERDUE_MINUTES = bad;
    expect(thresholds().overdueMinutes).toBe(15);
    expect(dispatchStateOf(trip({ createdAt: min(20) }), NOW).state).toBe('overdue_unassigned');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DISPATCH_UNASSIGNED_OVERDUE_MINUTES'));
  });
});

describe('GET /api/trips/live — what Dispatch and the Dashboard both read', () => {
  const doc = (t) => ({ ...t, toJSON() { const { toJSON, save, ...rest } = this; return rest; }, save: jest.fn() });
  const board = [
    doc(trip({ _id: 'recent',   createdAt: min(5) })),
    doc(trip({ _id: 'overdue1', createdAt: new Date('2026-10-28T09:00:00Z') })),
    doc(trip({ _id: 'overdue2', createdAt: new Date('2026-10-31T18:00:00Z') })),
    doc(trip({ _id: 'sched',    scheduleType: 'later', scheduleDate: inMin(6 * 60), createdAt: min(2 * 24 * 60) })),
    doc(trip({ _id: 'soon',     scheduleType: 'later', scheduleDate: inMin(20) })),
    doc(trip({ _id: 'assigned', status: 'dispatched', driver: { name: 'Ravi' }, ambulance: { registrationNumber: 'KA01' }, createdAt: min(40) })),
  ];

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    const chain = { select: () => chain, populate: () => chain, sort: async () => board };
    Trip.find.mockReturnValue(chain);
    const amb = { populate: () => amb, then: (ok) => Promise.resolve([]).then(ok) };
    Ambulance.find.mockReturnValue(amb);
  });
  afterEach(() => jest.useRealTimers());

  it('every active booking stays on the board, with its urgency; counts break it down', async () => {
    const res = await run(ctrl.getLiveBoard, {});
    expect(Trip.find).toHaveBeenCalledWith({ status: { $in: ['booked', 'dispatched', 'en_route'] } });
    const byId = Object.fromEntries(res.body.liveTrips.map((t) => [t._id, t.dispatch.state]));
    expect(byId).toEqual({
      recent: 'awaiting_assignment', overdue1: 'overdue_unassigned', overdue2: 'overdue_unassigned',
      sched: 'scheduled_upcoming', soon: 'scheduled_due_soon', assigned: 'assigned',
    });
    expect(res.body.counts).toEqual({
      active: 6, overdue: 2, awaitingAssignment: 1, scheduledDueSoon: 1, scheduledUpcoming: 1, assigned: 1, available: 0,
    });
  });

  it('ages move on with each refresh (computed at request time)', async () => {
    const first = (await run(ctrl.getLiveBoard, {})).body.liveTrips.find((t) => t._id === 'recent').dispatch;
    jest.setSystemTime(NOW + 11 * 60e3);
    const later = (await run(ctrl.getLiveBoard, {})).body.liveTrips.find((t) => t._id === 'recent').dispatch;
    expect(first).toEqual(expect.objectContaining({ ageMinutes: 5, state: 'awaiting_assignment' }));
    expect(later).toEqual(expect.objectContaining({ ageMinutes: 16, state: 'overdue_unassigned' }));
  });

  it('nothing is written, cancelled, completed or sent while classifying', async () => {
    await run(ctrl.getLiveBoard, {});
    expect(board.every((d) => d.save.mock.calls.length === 0)).toBe(true);
    expect(Trip.updateOne).not.toHaveBeenCalled();
    expect(Trip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(whatsappNotifications.notifyDriverAssigned).not.toHaveBeenCalled();
  });

  it('the counts helper keeps "active" = every active booking', () => {
    const c = countDispatchStates([{ state: 'overdue_unassigned' }, { state: 'assigned' }]);
    expect(c.active).toBe(2);
    expect(c.overdue).toBe(1);
  });
});

// ── A small trip store with the semantics that matter: each request loads
// its own copy; save() writes only what that request changed; the claim's
// findOneAndUpdate applies only if its conditions hold at that moment. ──
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x) ? new Date(x) : x)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function matches(raw, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(raw, f));
    if (k === '_id') return String(raw._id) === String(cond);
    const v = raw[k];
    if (cond === null) return v === undefined || v === null;
    if (cond instanceof Date) return v instanceof Date && +v === +cond;
    if (cond && typeof cond === 'object') {
      if ('$in' in cond) return cond.$in.includes(v);
      if ('$lt' in cond) return v instanceof Date && v < cond.$lt;
      if ('$ne' in cond) return v !== cond.$ne;
    }
    return String(v) === String(cond);
  });
}
function loadCopy(id) {
  const raw = store.get(String(id));
  if (!raw) return null;
  const loaded = clone(raw);
  const d = clone(raw);
  Object.assign(d, {
    populate: async function populate() { return this; },
    closeAllOpenWaitSegments: () => {},
    events: d.events || [],
    save: jest.fn(async function save() {
      const cur = store.get(String(id));
      for (const k of Object.keys(this)) {
        if (typeof this[k] === 'function' || k === 'events') continue;
        if (!same(this[k], loaded[k])) cur[k] = clone(this[k]);
      }
      return this;
    }),
  });
  return d;
}
let gate = null; // when set, every load waits here until two loads happened
// The commit step runs in a transaction; here a stand-in that runs it once
// (no rollback — the real rollback is checked against MongoDB itself).
const fakeSession = () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} });
function useStore() {
  Trip.startSession = jest.fn(async () => fakeSession());
  Trip.findById.mockImplementation((id) => {
    const p = (async () => { const d = loadCopy(id); if (gate) await gate(); return d; })();
    return { then: (ok, bad) => p.then(ok, bad), populate: () => p, session: () => p };
  });
  Trip.findOneAndUpdate.mockImplementation(async (filter, update) => {
    const raw = [...store.values()].find((r) => matches(r, filter));
    if (!raw) return null;
    Object.assign(raw, clone(update.$set || {}));
    return { _id: raw._id };
  });
  Trip.updateOne.mockImplementation(async (filter, update) => {
    const raw = [...store.values()].find((r) => matches(r, filter));
    if (!raw) return { matchedCount: 0 };
    for (const k of Object.keys(update.$unset || {})) delete raw[k];
    Object.assign(raw, clone(update.$set || {}));
    return { matchedCount: 1 };
  });
  Bill.create.mockImplementation(async (docs) => docs.map((b) => ({ _id: `bill-${Bill.create.mock.calls.length}`, ...b, populate: async () => {} })));
  Bill.findOne.mockReturnValue({ session: async () => null });
  Income.exists.mockReturnValue({ session: async () => null });
  Income.create.mockResolvedValue([{}]);
  Notification.create.mockResolvedValue([{}]);
  User.findByIdAndUpdate.mockResolvedValue({});
  User.findById.mockReturnValue({ select: async () => ({ _id: 'd2', pushToken: null, fcmToken: null }) });
}
function put(over) {
  store.clear();
  store.set('T1', { _id: 'T1', tripNumber: 'TRP-1', patientName: 'P', status: 'booked', createdAt: min(4000), pickup: { address: 'x' }, selectedType: 'bls', ...over });
  return () => store.get('T1');
}
// Both requests load the trip before either goes further.
async function together(a, b) {
  let release; const opened = new Promise((r) => { release = r; }); let loads = 0;
  gate = async () => { loads += 1; if (loads === 2) release(); await opened; };
  try { return await Promise.all([a(), b()]); } finally { gate = null; }
}
const complete = () => run(ctrl.completeTrip, { params: { id: 'T1' }, body: {} });
const cancel = () => run(ctrl.cancelTrip, { params: { id: 'T1' }, body: { reason: 'Duplicate booking' } });
const assign = () => run(ctrl.assignVehicle, { params: { id: 'T1' }, body: { ambulanceId: 'amb2' } });

describe('completion eligibility (the existing lifecycle)', () => {
  beforeEach(useStore);

  it.each([
    ['own fleet, dispatched (CRM closes it)', { status: 'dispatched', ...CREW }],
    ['partner ambulance with its own driver, en route', { status: 'en_route', driver: 'pd1', ambulance: 'partnerAmb' }],
    ['pre-Ambulance trip with a vehicle', { status: 'en_route', driver: 'd1', vehicle: 'v1' }],
  ])('allowed: %s — one bill', async (_l, over) => {
    const t = put(over);
    const res = await complete();
    expect(res.statusCode).toBe(200);
    expect(t().status).toBe('completed');
    expect(Bill.create).toHaveBeenCalledTimes(1);
    expect(t().transitionClaimedAt).toBeUndefined(); // claim released
  });

  it.each([
    ['never assigned (booked)', { status: 'booked' }],
    ['"dispatched" to an ambulance with no driver', { status: 'dispatched', ambulance: 'amb1' }],
    ['a driver but no ambulance or vehicle', { status: 'dispatched', driver: 'd1' }],
    ['booked but somehow carrying a crew', { status: 'booked', ...CREW }],
  ])('refused: %s — nothing billed or changed', async (_l, over) => {
    const t = put(over);
    const before = { ...t() };
    const res = await complete();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no crew assigned/);
    expect(Bill.create).not.toHaveBeenCalled();
    expect(t()).toEqual(before);
  });

  it('a driver can only complete their own trip', async () => {
    put({ status: 'en_route', ...CREW });
    const res = await run(ctrl.completeTrip, { params: { id: 'T1' }, body: {}, user: { _id: 'someone-else', role: 'driver' } });
    expect(res.statusCode).toBe(403);
    expect(Bill.create).not.toHaveBeenCalled();
  });
});

describe('cancel and complete — explicit, with a reason / a crew', () => {
  beforeEach(useStore);

  it('cancel without a real reason is refused, and nothing changes', async () => {
    const t = put({});
    for (const body of [{}, { reason: '' }, { reason: '  ' }, { reason: 'x' }, { reason: 'y'.repeat(301) }, { reason: { $ne: 1 } }]) {
      const res = await run(ctrl.cancelTrip, { params: { id: 'T1' }, body });
      expect(res.statusCode).toBe(400);
    }
    expect(t().status).toBe('booked');
    expect(Trip.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cancel with a reason: cancelled, reason and operator recorded, claim released', async () => {
    const t = put({});
    const res = await run(ctrl.cancelTrip, { params: { id: 'T1' }, body: { reason: '  Duplicate booking  ' } });
    expect(res.statusCode).toBe(200);
    expect(t()).toEqual(expect.objectContaining({ status: 'cancelled', cancellationReason: 'Duplicate booking', cancelledBy: 'op1' }));
    expect(t().cancelledAt).toBeInstanceOf(Date);
    expect(t().transitionClaimedAt).toBeUndefined();
  });

  it('a completed or already-cancelled trip cannot be cancelled', async () => {
    for (const status of ['completed', 'cancelled']) {
      const t = put({ status });
      const res = await cancel();
      expect(res.statusCode).toBe(400);
      expect(t().status).toBe(status);
    }
  });
});

describe('assign / cancel / complete at the same moment', () => {
  beforeEach(() => {
    useStore();
    Ambulance.findById.mockReturnValue({ populate: async () => ({ _id: 'amb2', status: 'assigned', assignedDriver: { _id: 'd2', availability: { status: 'available' } } }) });
  });

  it('two Completes (double click / app + CRM): ONE completion, ONE bill, one income entry', async () => {
    const t = put({ status: 'en_route', ...CREW });
    const [a, b] = await together(complete, complete);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(Bill.create).toHaveBeenCalledTimes(1);
    expect(Income.create).toHaveBeenCalledTimes(1);
    expect(t().status).toBe('completed');
  });

  it('Complete vs Cancel: exactly one wins; never a cancelled trip with a bill', async () => {
    for (const order of [[complete, cancel], [cancel, complete]]) {
      Bill.create.mockClear();
      const t = put({ status: 'dispatched', ...CREW });
      const out = await together(...order);
      expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      if (t().status === 'cancelled') expect(Bill.create).not.toHaveBeenCalled();
      else { expect(t().status).toBe('completed'); expect(Bill.create).toHaveBeenCalledTimes(1); }
    }
  });

  it('Assign vs Cancel: a cancelled booking is never brought back', async () => {
    for (const order of [[assign, cancel], [cancel, assign]]) {
      const t = put({});
      const out = await together(...order);
      expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      if (t().status === 'cancelled') expect(t().driver).toBeUndefined();
      else expect(t()).toEqual(expect.objectContaining({ status: 'dispatched', driver: 'd2', ambulance: 'amb2' }));
    }
  });

  it('two Assigns from the same view: one assignment, the other told to reload', async () => {
    const t = put({});
    const out = await together(assign, assign);
    expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(out.find((r) => r.statusCode === 409).body.code).toBe('TRIP_CHANGED');
    expect(t().status).toBe('dispatched');
  });

  it('a claim left by a request that died does not block for ever (2 min)', async () => {
    const t = put({ status: 'en_route', ...CREW, transitionClaimedAt: new Date(Date.now() - 3 * 60e3) });
    expect((await complete()).statusCode).toBe(200);
    expect(t().status).toBe('completed');
    const fresh = put({ status: 'en_route', ...CREW, transitionClaimedAt: new Date() });
    expect((await complete()).statusCode).toBe(409);
    expect(fresh().status).toBe('en_route');
  });

  it('a failed completion (fare error) releases the claim, so it can be retried', async () => {
    const fareCalculator = require('../utils/fareCalculator');
    fareCalculator.compute.mockRejectedValueOnce(new Error('No active pricing'));
    const t = put({ status: 'en_route', ...CREW });
    expect((await complete()).statusCode).toBe(400);
    expect(t().transitionClaimedAt).toBeUndefined();
    expect((await complete()).statusCode).toBe(200);
  });
});

describe('driver routes follow the same rules', () => {
  beforeEach(() => {
    useStore();
    Ambulance.findById.mockReturnValue({ populate: async () => ({ _id: 'amb2', status: 'assigned', assignedDriver: { _id: 'd2', availability: { status: 'available' } } }) });
  });
  const start = (user = { _id: 'd1', role: 'driver' }) => run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'en_route' }, user });
  const decline = () => run(ctrl.declineTrip, { params: { id: 'T1' }, user: { _id: 'd1', role: 'driver' } });

  it('driver "start trip" still works: dispatched → en route, claim released', async () => {
    const t = put({ status: 'dispatched', ...CREW });
    const res = await start();
    expect(res.statusCode).toBe(200);
    expect(t().status).toBe('en_route');
    expect(t().enRouteAt).toBeInstanceOf(Date);
    expect(t().transitionClaimedAt).toBeUndefined();
  });

  it('another driver cannot start it', async () => {
    const t = put({ status: 'dispatched', ...CREW });
    expect((await start({ _id: 'd9', role: 'driver' })).statusCode).toBe(403);
    expect(t().status).toBe('dispatched');
  });

  it('the old route can no longer complete a trip without a bill', async () => {
    const t = put({ status: 'en_route', ...CREW });
    const res = await run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'completed' }, user: { _id: 'd1', role: 'driver' } });
    expect([res.statusCode, res.body.code]).toEqual([400, 'USE_COMPLETE']);
    expect(t().status).toBe('en_route');
    expect(Bill.create).not.toHaveBeenCalled();
  });

  it('cancelling through the old route needs a reason, like the CRM', async () => {
    const t = put({ status: 'en_route', ...CREW });
    expect((await run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'cancelled' }, user: { _id: 'd1', role: 'driver' } })).statusCode).toBe(400);
    expect(t().status).toBe('en_route');
    const ok = await run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'cancelled', reason: 'Patient refused transport' }, user: { _id: 'd1', role: 'driver' } });
    expect(ok.statusCode).toBe(200);
    expect(t()).toEqual(expect.objectContaining({ status: 'cancelled', cancellationReason: 'Patient refused transport' }));
  });

  it('driver start vs CRM cancel at once: exactly one wins', async () => {
    for (const order of [[() => start(), cancel], [cancel, () => start()]]) {
      const t = put({ status: 'dispatched', ...CREW });
      const out = await together(...order);
      expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(['en_route', 'cancelled']).toContain(t().status);
      if (t().status === 'en_route') expect(t().cancelledAt).toBeUndefined();
    }
  });

  it('driver decline vs CRM reassign at once: never "booked" with the new crew, or dispatched with no driver', async () => {
    for (const order of [[decline, assign], [assign, decline]]) {
      const t = put({ status: 'dispatched', ...CREW });
      const out = await together(...order);
      expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const ok = (t().status === 'booked' && !t().driver) || (t().status === 'dispatched' && t().driver === 'd2');
      expect([t().status, t().driver, ok]).toEqual([t().status, t().driver, true]);
    }
  });

  it('CRM Complete and driver Complete at once (two routes): one bill', async () => {
    const t = put({ status: 'en_route', ...CREW });
    const driverComplete = () => run(ctrl.completeTrip, { params: { id: 'T1' }, body: {}, user: { _id: 'd1', role: 'driver' } });
    const out = await together(complete, driverComplete);
    expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(Bill.create).toHaveBeenCalledTimes(1);
    expect(t().status).toBe('completed');
    // …and the old route can't complete it again afterwards.
    expect((await run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'completed' }, user: { _id: 'd1', role: 'driver' } })).statusCode).toBe(400);
    expect(Bill.create).toHaveBeenCalledTimes(1);
  });
});

describe('an expired claim can never commit', () => {
  beforeEach(useStore);

  it('a request that stalled past its claim cannot overwrite the newer action', async () => {
    const t = put({ status: 'en_route', ...CREW });
    const stale = await ctrl._claimTrip('T1', { status: { $in: ['dispatched', 'en_route'] } });
    t().transitionClaimedAt = new Date(+stale - 3 * 60e3);           // it stalls; its claim expires
    const staleAt = t().transitionClaimedAt;
    const newer = await ctrl._claimTrip('T1', { status: { $in: ['booked', 'dispatched', 'en_route'] } }); // someone else takes over
    expect(newer).toBeInstanceOf(Date);
    const cancelled = await ctrl._commitClaimed('T1', newer, { status: { $in: ['booked', 'dispatched', 'en_route'] } }, async (trip) => {
      trip.status = 'cancelled'; await trip.save(); return trip;
    });
    expect(cancelled.ok).toBe(true);
    const apply = jest.fn();
    const resumed = await ctrl._commitClaimed('T1', staleAt, { status: { $in: ['dispatched', 'en_route'] } }, apply);
    expect(resumed.ok).toBe(false);                                   // ownership check fails …
    expect(apply).not.toHaveBeenCalled();                             // … before anything is written
    expect(t().status).toBe('cancelled');
  });

  it('releasing only ever clears the releaser\'s own claim', async () => {
    const t = put({ status: 'booked' });
    const mine = await ctrl._claimTrip('T1', { status: { $in: ['booked'] } });
    await ctrl._releaseTrip('T1', new Date(+mine - 1000));           // someone else's (older) claim
    expect(+t().transitionClaimedAt).toBe(+mine);
    await ctrl._releaseTrip('T1', mine);
    expect(t().transitionClaimedAt).toBeUndefined();
  });
});

describe('in-app (VoIP) call hook: runs once the trip has really ended', () => {
  const tripVoip = require('../services/tripVoip');
  beforeEach(() => {
    useStore();
    tripVoip.closeTripVoip.mockClear();
    tripVoip.closeTripVoip.mockImplementation(async () => ({}));
  });
  const customerCancel = () => run(ctrl.customerCancelTrip, { params: { id: 'T1' }, body: { reason: 'Not needed' } });
  const driverCancel = () => run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'cancelled', reason: 'Patient refused transport' }, user: { _id: 'd1', role: 'driver' } });

  it.each([
    ['completeTrip', 'completed', complete],
    ['cancelTrip (CRM)', 'cancelled', cancel],
    ['customerCancelTrip', 'cancelled', customerCancel],
    ['updateStatus cancelled (driver)', 'cancelled', driverCancel],
  ])('%s -> closeTripVoip(trip, "%s") after the commit', async (_l, reason, act) => {
    const t = put({ status: 'en_route', ...CREW });
    const res = await act();
    expect(res.statusCode).toBe(200);
    expect(t().status).toBe(reason);
    expect(tripVoip.closeTripVoip).toHaveBeenCalledTimes(1);
    expect(tripVoip.closeTripVoip).toHaveBeenCalledWith('T1', reason);
  });

  it('not on a refused or failed change, nor on start-trip', async () => {
    put({ status: 'en_route', ...CREW });
    await run(ctrl.cancelTrip, { params: { id: 'T1' }, body: { reason: 'x' } });          // no reason
    const fareCalculator = require('../utils/fareCalculator');
    fareCalculator.compute.mockRejectedValueOnce(new Error('No active pricing'));
    expect((await complete()).statusCode).toBe(400);                                      // completion failed
    put({ status: 'dispatched', ...CREW });
    expect((await run(ctrl.updateStatus, { params: { id: 'T1' }, body: { status: 'en_route' }, user: { _id: 'd1', role: 'driver' } })).statusCode).toBe(200);
    put({ status: 'completed', ...CREW });
    expect((await cancel()).statusCode).toBe(400);                                        // already ended
    expect(tripVoip.closeTripVoip).not.toHaveBeenCalled();
  });

  it('a failing hook never fails the request that ended the trip', async () => {
    tripVoip.closeTripVoip.mockImplementation(() => { throw new Error('boom'); });
    const t = put({ status: 'en_route', ...CREW });
    expect((await complete()).statusCode).toBe(200);
    expect(t().status).toBe('completed');
    tripVoip.closeTripVoip.mockImplementation(async () => { throw new Error('async boom'); });
    put({ status: 'en_route', ...CREW });
    expect((await cancel()).statusCode).toBe(200);
  });
});
