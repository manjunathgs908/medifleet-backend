/**
 * tests/incomingBookings.test.js
 * ============================================================
 * The CRM's full-screen "Incoming Booking" ring.
 *
 *   - POST /api/trips is still public: a booking with no token (website,
 *     customer app), a junk token or a customer token is created exactly
 *     as before, with no bookedBy. optionalStaff never blocks.
 *   - only a valid CRM staff login gets bookedBy, and so never rings —
 *     except a quote link the CUSTOMER confirmed (bookingSource 'crm' plus
 *     a confirmed Quote for the trip), which does.
 *   - GET /incoming lists unanswered customer bookings; acknowledging one
 *     (Accept or Dismiss) takes it off the list for everybody.
 *   - two operators acknowledging at the same moment: exactly one wins,
 *     the other is told who did.
 *
 * Real HTTP through the real routes/trips router, the real protect /
 * authorize / optionalStaff and the real controllers. Only the models are
 * stubbed, by an in-memory Trip store whose findOneAndUpdate matches and
 * writes in one step, as MongoDB does.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = 'test-only-incoming-secret';

const modelStub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
  updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
});

jest.mock('../models', () => {
  const m = () => ({
    find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
    findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
    updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
  });
  return {
    Trip: m(), User: m(), Bill: m(), Income: m(), Notification: m(),
    Hospital: m(), Lead: m(), ChatMessage: m(), Vehicle: m(),
    computeSegmentAmount: jest.fn(),
  };
});
jest.mock('../models/Ambulance',     () => modelStub());
jest.mock('../models/Assignment',    () => modelStub());
jest.mock('../models/Shift',         () => modelStub());
jest.mock('../models/Owner',         () => modelStub());
jest.mock('../models/BookingOtp',    () => modelStub());
jest.mock('../models/TripCallEvent', () => ({
  create: jest.fn(() => Promise.resolve({})), find: jest.fn(), findOne: jest.fn(),
}));
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../models/Quote',         () => modelStub());
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn(),
}));
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/smsService',  () => ({ sendOtp: jest.fn(), sendAlert: jest.fn(), sendSms: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({ notifyDriverAssigned: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/trackingNotifications', () => ({ notifyTrackingLink: jest.fn(() => Promise.resolve()) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({
  compute: jest.fn(async () => ({ baseFare: 1000, distanceKm: 5, additionalCharges: 0, grandTotal: 1050 })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const { Trip, User } = require('../models');
const Quote = require('../models/Quote');
const { optionalStaff } = require('../middleware/auth');
const { INCOMING_WINDOW_MS, createBookedTrip } = require('../controllers/tripController');

// A mongoose Query standing in for its own result.
const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) q[m] = () => q;
  return q;
};

// ── Users and their tokens ──────────────────────────────────
const USERS = {
  owner1 : { _id: 'owner1',  name: 'Asha (owner)', role: 'owner',      isActive: true },
  tc1    : { _id: 'tc1',     name: 'Ravi',         role: 'telecaller', isActive: true },
  tc2    : { _id: 'tc2',     name: 'Meena',        role: 'telecaller', isActive: true },
  drv1   : { _id: 'drv1',    name: 'Driver',       role: 'driver',     isActive: true },
  cust1  : { _id: 'cust1',   name: 'Customer',     role: 'customer',   isActive: true },
  gone   : { _id: 'gone',    name: 'Ex-staff',     role: 'telecaller', isActive: false },
  moved  : { _id: 'moved',   name: 'Moved',        role: 'telecaller', isActive: true, deviceId: 'new-phone' },
};
const tokenFor = (id, extra = {}) => jwt.sign({ id, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ── In-memory Trip store ────────────────────────────────────
let store;
let quotes;
let seq;
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((sub) => matches(doc, sub));
  if (v === null) return doc[k] == null;
  if (v && typeof v === 'object' && '$gte' in v) return doc[k] >= v.$gte;
  if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
  return String(doc[k]) === String(v);
});
const addTrip = (fields) => {
  const doc = { _id: `t${++seq}`, status: 'booked', createdAt: new Date(), ...fields };
  store.push(doc);
  return doc;
};
const plain = (doc) => { const { populate, ...rest } = doc; return rest; };

beforeEach(() => {
  jest.clearAllMocks();
  store = [];
  quotes = [];
  seq = 0;
  Quote.find = jest.fn((filter) => chain(quotes.filter((q) => matches(q, filter))));
  User.findById = jest.fn((id) => chain(USERS[id] || null));
  Trip.create = jest.fn(async (data) => {
    const doc = addTrip(data);
    doc.populate = jest.fn().mockResolvedValue(undefined);
    return doc;
  });
  Trip.countDocuments = jest.fn().mockResolvedValue(0);
  Trip.find = jest.fn((filter) => chain(store.filter((d) => matches(d, filter))
    .map((d) => ({ ...plain(d), toJSON: () => plain(d) }))));
  // Match + write in one synchronous step after a tick, so two concurrent
  // requests really interleave but can never both match — the guarantee a
  // single MongoDB findOneAndUpdate gives.
  Trip.findOneAndUpdate = jest.fn(async (cond, update) => {
    await new Promise((r) => setImmediate(r));
    const doc = store.find((d) => matches(d, cond));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return { _id: doc._id };
  });
  Trip.findById = jest.fn((id) => {
    const doc = store.find((d) => d._id === id);
    if (!doc) return chain(null);
    const by = doc.crmAckBy ? { _id: doc.crmAckBy, name: USERS[doc.crmAckBy]?.name } : undefined;
    return chain({ ...plain(doc), crmAckBy: by });
  });
});

// ── HTTP harness ────────────────────────────────────────────
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/trips', require('../routes/trips'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const http = async (method, path, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const BOOKING = {
  patientName: 'Lakshmi', patientPhone: '9876543210', emergencyType: 'general',
  pickupLabel: 'Jayanagar', pickupLat: 12.93, pickupLng: 77.58,
  dropLabel: 'Victoria Hospital', selectedType: 'bls', tripType: 'one_way',
};
const book = (token) => http('POST', '/api/trips', { token, body: BOOKING });
const incoming = (token = tokenFor('tc1')) => http('GET', '/api/trips/incoming', { token });
const ack = (id, action, token = tokenFor('tc1')) => http('PUT', `/api/trips/${id}/acknowledge`, { token, body: { action } });

// ============================================================
describe('A. optionalStaff never blocks', () => {
  const run = async (authorization) => {
    const req = { headers: authorization ? { authorization } : {} };
    const res = { status: jest.fn(), json: jest.fn() };
    const next = jest.fn();
    await optionalStaff(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    return req;
  };

  test.each([
    ['no header', undefined],
    ['not a Bearer header', 'Basic abc'],
    ['junk token', 'Bearer not.a.jwt'],
    ['token signed with another secret', `Bearer ${jwt.sign({ id: 'tc1' }, 'other-secret')}`],
    ['expired staff token', `Bearer ${jwt.sign({ id: 'tc1', exp: Math.floor(Date.now() / 1000) - 60 }, 'test-only-incoming-secret')}`],
    ['customer token', `Bearer ${tokenFor('cust1')}`],
    ['driver token', `Bearer ${tokenFor('drv1')}`],
    ['deactivated staff', `Bearer ${tokenFor('gone')}`],
    ['staff logged in on another device', `Bearer ${tokenFor('moved', { deviceId: 'old-phone' })}`],
    ['user no longer exists', `Bearer ${tokenFor('nobody')}`],
  ])('%s: passes through with no req.user', async (_label, authorization) => {
    const req = await run(authorization);
    expect(req.user).toBeUndefined();
  });

  test('a database error is swallowed, not turned into a failed booking', async () => {
    User.findById = jest.fn(() => { throw new Error('db down'); });
    const req = await run(`Bearer ${tokenFor('tc1')}`);
    expect(req.user).toBeUndefined();
  });

  test.each(['owner1', 'tc1'])('valid CRM staff (%s): req.user is set', async (id) => {
    const req = await run(`Bearer ${tokenFor(id)}`);
    expect(req.user._id).toBe(id);
  });
});

// ============================================================
describe('B. POST /api/trips stays public', () => {
  test('a website/app booking with no token succeeds, unchanged, with no bookedBy', async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Trip.create).toHaveBeenCalledTimes(1);
    const data = Trip.create.mock.calls[0][0];
    expect(data.bookedBy).toBeUndefined();
    expect(data.status).toBe('booked');
    expect(data.patientName).toBe('Lakshmi');
    expect(data.pickup).toEqual({ address: 'Jayanagar', lat: 12.93, lng: 77.58 });
    expect(data.dropAddress).toBe('Victoria Hospital');
    expect(data.baseFare).toBe(1000);
    expect(data.estimatedFare).toBe(1050);
    expect('bookingSource' in data).toBe(false); // schema default, as before
    expect('crmAckAt' in data).toBe(false);
  });

  test('the payload stored for a no-token booking is identical to one with a junk or customer token', async () => {
    await book();
    await book('junk');
    await book(tokenFor('cust1'));
    expect(Trip.create).toHaveBeenCalledTimes(3);
    const [a, b, c] = Trip.create.mock.calls.map(([d]) => d);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test.each(['tc1', 'owner1'])('a CRM operator booking (%s) records bookedBy', async (id) => {
    const res = await book(tokenFor(id));
    expect(res.status).toBe(201);
    expect(String(Trip.create.mock.calls[0][0].bookedBy)).toBe(id);
  });
});

// ============================================================
describe('C. incoming → acknowledge → no longer incoming', () => {
  test('customer booking rings; operator booking does not', async () => {
    await book();                 // website / app
    await book(tokenFor('tc1'));  // CRM form
    const res = await incoming();
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].patientName).toBe('Lakshmi');
    expect(res.body.trips[0].bookedBy).toBeUndefined();
  });

  test('Accept takes it off the list; a second tap is told it was already handled', async () => {
    await book();
    const [{ _id }] = (await incoming()).body.trips;

    const first = await ack(_id, 'accepted', tokenFor('tc1'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, acknowledged: true, ack: { action: 'accepted', by: { _id: 'tc1' } } });
    expect(store[0]).toMatchObject({ crmAckBy: 'tc1', crmAckAction: 'accepted' });
    expect(store[0].crmAckAt).toBeInstanceOf(Date);

    expect((await incoming()).body.trips).toHaveLength(0);
    expect((await incoming(tokenFor('owner1'))).body.trips).toHaveLength(0);

    const again = await ack(_id, 'dismissed', tokenFor('tc2'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ acknowledged: false, ack: { action: 'accepted', by: { name: 'Ravi' } } });
    expect(store[0]).toMatchObject({ crmAckBy: 'tc1', crmAckAction: 'accepted' }); // not overwritten
  });

  test('Dismiss also stops it ringing, and changes no trip status', async () => {
    await book();
    const [{ _id }] = (await incoming()).body.trips;
    await ack(_id, 'dismissed');
    expect((await incoming()).body.trips).toHaveLength(0);
    expect(store[0].status).toBe('booked');
    expect(store[0].driver).toBeUndefined();
  });

  test('assigned, cancelled, old and already-acknowledged bookings never ring', async () => {
    addTrip({ patientName: 'fresh' });
    addTrip({ patientName: 'assigned', driver: 'drv1', ambulance: 'amb1', status: 'dispatched' });
    addTrip({ patientName: 'cancelled', status: 'cancelled' });
    addTrip({ patientName: 'old', createdAt: new Date(Date.now() - INCOMING_WINDOW_MS - 1000) });
    addTrip({ patientName: 'seen', crmAckAt: new Date() });
    addTrip({ patientName: 'crm', bookedBy: 'tc1' });
    expect((await incoming()).body.trips.map((t) => t.patientName)).toEqual(['fresh']);
  });

  test('bad action → 400, unknown trip → 404', async () => {
    await book();
    const [{ _id }] = (await incoming()).body.trips;
    expect((await ack(_id, 'maybe')).status).toBe(400);
    expect((await ack('t999', 'accepted')).status).toBe(404);
    expect((await incoming()).body.trips).toHaveLength(1);
  });

  test('operations only: no token → 401, driver → 403', async () => {
    expect((await http('GET', '/api/trips/incoming')).status).toBe(401);
    expect((await incoming(tokenFor('drv1'))).status).toBe(403);
    expect((await ack('t1', 'accepted', tokenFor('drv1'))).status).toBe(403);
  });
});

// ============================================================
// The quote-link path books through the same createBookedTrip, exactly as
// quoteController.confirmQuote calls it, then marks its Quote confirmed.
describe('E. quote links confirmed by the customer ring; operator bookings do not', () => {
  const QUOTE_BOOKING = {
    patientName: 'Quote customer', patientPhone: '9123456780', emergencyType: 'general',
    pickupLabel: 'Malleshwaram', pickupLat: 13.0, pickupLng: 77.57,
    dropLabel: 'Manipal Hospital', selectedType: 'bls', tripType: 'one_way', scheduleType: 'now',
  };
  // Same call and options as quoteController's confirm step.
  const confirmQuoteLink = async (operatorId = 'tc1', { quoteStatus = 'confirmed' } = {}) => {
    const trip = await createBookedTrip(QUOTE_BOOKING, { bookedBy: operatorId, bookingSource: 'crm' });
    quotes.push({ _id: `q${quotes.length + 1}`, status: quoteStatus, trip: trip._id, createdBy: operatorId });
    return trip;
  };

  test('a quote-link confirmation appears in /incoming, marked as a quote link', async () => {
    const trip = await confirmQuoteLink();
    expect(String(store[0].bookedBy)).toBe('tc1'); // bookedBy set — and it still rings
    const res = await incoming();
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0]).toMatchObject({ _id: trip._id, patientName: 'Quote customer', incomingVia: 'quote_link' });
  });

  test('a booking typed directly in the CRM does not ring — even alongside a quote-link one', async () => {
    await book(tokenFor('tc1'));     // operator, CRM booking form
    await book(tokenFor('owner1'));  // owner, CRM booking form
    await confirmQuoteLink('tc2');
    await book();                    // website / app
    const trips = (await incoming()).body.trips;
    expect(trips.map((t) => t.incomingVia).sort()).toEqual(['customer', 'quote_link']);
    expect(trips.map((t) => t.patientName).sort()).toEqual(['Lakshmi', 'Quote customer']);
  });

  test("bookingSource 'crm' alone is not enough: no confirmed Quote for the trip, no ring", async () => {
    addTrip({ patientName: 'crm-tagged, no quote', bookedBy: 'tc1', bookingSource: 'crm' });
    await confirmQuoteLink('tc1', { quoteStatus: 'confirming' }); // mid-confirm, not yet confirmed
    expect((await incoming()).body.trips).toHaveLength(0);
  });

  test('a confirmed Quote does not make an operator booking without the quote mark ring', async () => {
    await book(tokenFor('tc1'));
    quotes.push({ _id: 'qx', status: 'confirmed', trip: store[0]._id }); // even pointing at it
    expect((await incoming()).body.trips).toHaveLength(0);
  });

  test('acknowledge works for a quote-link booking: Accept, then gone for everyone', async () => {
    const trip = await confirmQuoteLink();
    const first = await ack(trip._id, 'accepted', tokenFor('tc2'));
    expect(first.body).toMatchObject({ acknowledged: true, ack: { action: 'accepted', by: { _id: 'tc2' } } });
    expect(store[0]).toMatchObject({ crmAckBy: 'tc2', crmAckAction: 'accepted', status: 'booked' });
    expect((await incoming()).body.trips).toHaveLength(0);
    expect((await incoming(tokenFor('owner1'))).body.trips).toHaveLength(0);
    const again = await ack(trip._id, 'dismissed', tokenFor('tc1'));
    expect(again.body).toMatchObject({ acknowledged: false, ack: { action: 'accepted', by: { name: 'Meena' } } });
  });

  test('a quote-link booking that is assigned, old or cancelled no longer rings', async () => {
    const t1 = await confirmQuoteLink();
    const t2 = await confirmQuoteLink();
    const t3 = await confirmQuoteLink();
    Object.assign(store.find((d) => d._id === t1._id), { driver: 'drv1', ambulance: 'amb1', status: 'dispatched' });
    Object.assign(store.find((d) => d._id === t2._id), { createdAt: new Date(Date.now() - INCOMING_WINDOW_MS - 1000) });
    Object.assign(store.find((d) => d._id === t3._id), { status: 'cancelled' });
    expect((await incoming()).body.trips).toHaveLength(0);
  });
});

// ============================================================
describe('D. two operators acknowledge at the same moment', () => {
  test('exactly one wins; the other is told who', async () => {
    await book();
    const [{ _id }] = (await incoming()).body.trips;

    const [a, b] = await Promise.all([
      ack(_id, 'accepted',  tokenFor('tc1')),
      ack(_id, 'dismissed', tokenFor('tc2')),
    ]);
    const results = [a.body, b.body];
    const winners = results.filter((r) => r.acknowledged);
    const losers  = results.filter((r) => !r.acknowledged);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winnerId = winners[0].ack.by._id;
    expect(store[0].crmAckBy).toBe(winnerId);
    expect(store[0].crmAckAction).toBe(winners[0].ack.action);
    expect(losers[0].ack.by.name).toBe(USERS[winnerId].name);
    expect((await incoming()).body.trips).toHaveLength(0);
  });
});
