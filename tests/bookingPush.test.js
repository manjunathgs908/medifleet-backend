/**
 * tests/bookingPush.test.js
 * ============================================================
 * Background Web Push for new incoming bookings (Phase 2).
 *
 *   - subscribe / unsubscribe / public-key: operations staff only; only a
 *     real browser push endpoint is accepted; a browser re-subscribing
 *     moves to the new operator; you can only unsubscribe your own.
 *   - a qualifying booking (public website/app, customer-confirmed quote
 *     link) pushes ONCE to every active owner/telecaller subscription;
 *     a booking an operator typed in pushes nothing.
 *   - 404/410 from the push service deletes that subscription.
 *   - no VAPID env: nothing is sent, the booking still succeeds.
 *
 * Real HTTP through the real routers, protect/authorize/optionalStaff, the
 * real controllers, services/incomingBookings and services/bookingPush.
 * Only the database (in-memory stores) and web-push's network call are
 * stubbed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = 'test-only-push-secret';
const VAPID = {
  VAPID_PUBLIC_KEY : 'BKf_test_public_key',
  VAPID_PRIVATE_KEY: 'test_private_key',
  VAPID_SUBJECT    : 'mailto:test@example.com',
};

const modelStub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(), deleteMany: jest.fn(),
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
jest.mock('../models/Ambulance',        () => modelStub());
jest.mock('../models/Assignment',       () => modelStub());
jest.mock('../models/Shift',            () => modelStub());
jest.mock('../models/Owner',            () => modelStub());
jest.mock('../models/BookingOtp',       () => modelStub());
jest.mock('../models/Quote',            () => modelStub());
jest.mock('../models/PushSubscription', () => modelStub());
jest.mock('../models/TripCallEvent', () => ({
  create: jest.fn(() => Promise.resolve({})), find: jest.fn(), findOne: jest.fn(),
}));
jest.mock('../models/GeofenceEvent', () => modelStub());
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
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { Trip, User } = require('../models');
const Quote = require('../models/Quote');
const PushSubscription = require('../models/PushSubscription');
const bookingPush = require('../services/bookingPush');
const { createBookedTrip } = require('../controllers/tripController');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) q[m] = () => q;
  return q;
};

const USERS = {
  owner1: { _id: 'owner1', name: 'Asha',   role: 'owner',      isActive: true },
  tc1   : { _id: 'tc1',    name: 'Ravi',   role: 'telecaller', isActive: true },
  tc2   : { _id: 'tc2',    name: 'Meena',  role: 'telecaller', isActive: true },
  drv1  : { _id: 'drv1',   name: 'Driver', role: 'driver',     isActive: true },
  gone  : { _id: 'gone',   name: 'Ex',     role: 'telecaller', isActive: false },
};
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ── In-memory stores ────────────────────────────────────────
let trips; let quotes; let subs; let seq;
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((sub) => matches(doc, sub));
  if (v === null) return doc[k] == null;
  if (v && typeof v === 'object' && '$gte' in v) return doc[k] >= v.$gte;
  if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
  return String(doc[k]) === String(v);
});
const plain = ({ populate, ...rest }) => rest;

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, VAPID);
  trips = []; quotes = []; subs = []; seq = 0;

  User.findById = jest.fn((id) => chain(USERS[id] || null));
  Trip.countDocuments = jest.fn().mockResolvedValue(0);
  Trip.create = jest.fn(async (data) => {
    const doc = { _id: `t${++seq}`, status: 'booked', createdAt: new Date(), ...data };
    trips.push(doc);
    return { ...doc, populate: jest.fn().mockResolvedValue(undefined) };
  });
  Trip.findOne = jest.fn((filter) => chain(trips.find((d) => matches(d, filter)) || null));
  Trip.findOneAndUpdate = jest.fn(async (cond, update) => {
    await new Promise((r) => setImmediate(r));
    const doc = trips.find((d) => matches(d, cond));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return { _id: doc._id };
  });
  Quote.find = jest.fn((filter) => chain(quotes.filter((q) => matches(q, filter))));

  PushSubscription.findOneAndUpdate = jest.fn(async (cond, update) => {
    let doc = subs.find((s) => s.endpoint === cond.endpoint);
    if (!doc) { doc = { _id: `s${++seq}`, endpoint: cond.endpoint }; subs.push(doc); }
    Object.assign(doc, update.$set);
    return doc;
  });
  PushSubscription.deleteOne = jest.fn(async (cond) => {
    const i = subs.findIndex((s) => matches(s, cond));
    if (i < 0) return { deletedCount: 0 };
    subs.splice(i, 1);
    return { deletedCount: 1 };
  });
  PushSubscription.deleteMany = jest.fn(async (cond) => {
    const before = subs.length;
    subs = subs.filter((s) => !matches(s, cond));
    return { deletedCount: before - subs.length };
  });
  // populate('user') → the user document, as the real query would.
  PushSubscription.find = jest.fn(() => chain(subs.map((s) => ({ ...s, user: USERS[s.user] || null }))));

  webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
});

// ── HTTP harness ────────────────────────────────────────────
let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/trips', require('../routes/trips'));
  app.use('/api/push', require('../routes/push'));
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

const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const subscription = (endpoint = FCM) => ({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
const subscribeAs = (id, endpoint) => http('POST', '/api/push/subscribe', { token: tokenFor(id), body: { subscription: subscription(endpoint) } });

const BOOKING = {
  patientName: 'Lakshmi', patientPhone: '9876543210', emergencyType: 'general',
  pickupLabel: 'Jayanagar', pickupLat: 12.93, pickupLng: 77.58,
  dropLabel: 'Victoria Hospital', selectedType: 'BLS', tripType: 'one_way',
};
// POST /api/trips, then wait for the fire-and-forget push it started.
const spy = () => jest.spyOn(bookingPush, 'notifyIncomingBooking');
const bookAndSettle = async (token) => {
  const s = spy();
  const res = await http('POST', '/api/trips', { token, body: BOOKING });
  expect(res.status).toBe(201);
  expect(s).toHaveBeenCalledTimes(1);
  const outcome = await s.mock.results[0].value;
  s.mockRestore();
  return { res, outcome };
};

// ============================================================
describe('A. subscribe / unsubscribe / public key', () => {
  test('public key: the VAPID public key, never the private one', async () => {
    const res = await http('GET', '/api/push/public-key', { token: tokenFor('tc1') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabled: true, publicKey: VAPID.VAPID_PUBLIC_KEY });
    expect(JSON.stringify(res.body)).not.toContain(VAPID.VAPID_PRIVATE_KEY);
  });

  test('public key with no VAPID env: enabled false, no key', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const res = await http('GET', '/api/push/public-key', { token: tokenFor('tc1') });
    expect(res.body).toEqual({ success: true, enabled: false, publicKey: null });
  });

  test('subscribe stores endpoint + keys for the operator', async () => {
    const res = await subscribeAs('tc1');
    expect(res.status).toBe(200);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ endpoint: FCM, user: 'tc1', keys: subscription().keys });
  });

  test('the same browser subscribing again after another login moves to that operator — no duplicate', async () => {
    await subscribeAs('tc1');
    await subscribeAs('tc2');
    expect(subs).toHaveLength(1);
    expect(subs[0].user).toBe('tc2');
  });

  test.each([
    ['not https', 'http://fcm.googleapis.com/fcm/send/x'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['a look-alike host', 'https://fcm.googleapis.com.evil.example/x'],
    ['not a URL', 'nope'],
  ])('refuses an endpoint that is %s', async (_label, endpoint) => {
    const res = await subscribeAs('tc1', endpoint);
    expect(res.status).toBe(400);
    expect(subs).toHaveLength(0);
  });

  test.each([
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QABC',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('accepts a real push service: %s', async (endpoint) => {
    expect((await subscribeAs('owner1', endpoint)).status).toBe(200);
  });

  test('refuses a subscription with missing keys', async () => {
    const res = await http('POST', '/api/push/subscribe', { token: tokenFor('tc1'), body: { subscription: { endpoint: FCM, keys: {} } } });
    expect(res.status).toBe(400);
  });

  test('unsubscribe removes it — but only your own', async () => {
    await subscribeAs('tc1');
    const other = await http('POST', '/api/push/unsubscribe', { token: tokenFor('tc2'), body: { endpoint: FCM } });
    expect(other.body.removed).toBe(0);
    expect(subs).toHaveLength(1);
    const mine = await http('POST', '/api/push/unsubscribe', { token: tokenFor('tc1'), body: { endpoint: FCM } });
    expect(mine.body).toEqual({ success: true, removed: 1 });
    expect(subs).toHaveLength(0);
  });

  test('operations only: no token → 401, driver → 403', async () => {
    expect((await http('GET', '/api/push/public-key')).status).toBe(401);
    expect((await http('GET', '/api/push/public-key', { token: tokenFor('drv1') })).status).toBe(403);
    expect((await subscribeAs('drv1')).status).toBe(403);
    expect(subs).toHaveLength(0);
  });
});

// ============================================================
describe('B. a qualifying booking pushes once', () => {
  const setupSubs = async () => {
    await subscribeAs('tc1', 'https://fcm.googleapis.com/fcm/send/tc1');
    await subscribeAs('owner1', 'https://web.push.apple.com/owner1');
    // These two must never be pushed to.
    subs.push({ _id: 'sd', endpoint: 'https://fcm.googleapis.com/fcm/send/drv', keys: subscription().keys, user: 'drv1' });
    subs.push({ _id: 'sg', endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: subscription().keys, user: 'gone' });
  };
  const endpointsSent = () => webpush.sendNotification.mock.calls.map(([s]) => s.endpoint).sort();

  test('a public website/app booking pushes one notification to each active owner/telecaller', async () => {
    await setupSubs();
    const { res, outcome } = await bookAndSettle();
    expect(outcome).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(endpointsSent()).toEqual(['https://fcm.googleapis.com/fcm/send/tc1', 'https://web.push.apple.com/owner1']);

    const [sub, payload, options] = webpush.sendNotification.mock.calls[0];
    expect(sub.keys).toEqual(subscription().keys);
    const p = JSON.parse(payload);
    const id = res.body.trip._id;
    expect(p).toEqual({
      title: 'New booking',
      body : 'Lakshmi · Jayanagar · BLS',
      tripId: id,
      url  : `/dispatch?trip=${id}`,
      tag  : `booking-${id}`,
    });
    expect(payload).not.toContain('9876543210'); // no phone on a lock screen
    expect(options).toMatchObject({ TTL: 1800, urgency: 'high' });
    expect(trips[0].incomingPushAt).toBeInstanceOf(Date);
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(VAPID.VAPID_SUBJECT, VAPID.VAPID_PUBLIC_KEY, VAPID.VAPID_PRIVATE_KEY);
  });

  test('never twice for the same booking — a repeat or concurrent notify sends nothing more', async () => {
    await setupSubs();
    const { res } = await bookAndSettle();
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const id = res.body.trip._id;
    const [a, b] = await Promise.all([bookingPush.sendIncomingBooking(id), bookingPush.sendIncomingBooking(id)]);
    expect(a).toEqual({ sent: 0, skipped: 'already_pushed' });
    expect(b).toEqual({ sent: 0, skipped: 'already_pushed' });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  test('a booking an operator typed in the CRM pushes nothing', async () => {
    await setupSubs();
    const { outcome } = await bookAndSettle(tokenFor('tc1'));
    expect(outcome).toEqual({ sent: 0, skipped: 'not_incoming' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('a customer-confirmed quote link pushes, marked as a quote link', async () => {
    await setupSubs();
    const trip = await createBookedTrip({ ...BOOKING, patientName: 'Quote customer' }, { bookedBy: 'tc2', bookingSource: 'crm' });
    // Before the Quote is confirmed it is not incoming yet…
    expect(await bookingPush.sendIncomingBooking(trip._id)).toEqual({ sent: 0, skipped: 'not_incoming' });
    // …the confirm step marks it, then notifies.
    quotes.push({ _id: 'q1', status: 'confirmed', trip: trip._id });
    expect(await bookingPush.sendIncomingBooking(trip._id)).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).body).toBe('Quote customer · Jayanagar · BLS · quote link');
  });

  test('already acknowledged in the CRM, or assigned: no push', async () => {
    await setupSubs();
    trips.push({ _id: 'ta', status: 'booked', createdAt: new Date(), crmAckAt: new Date(), patientName: 'a' });
    trips.push({ _id: 'tb', status: 'dispatched', createdAt: new Date(), driver: 'drv1', ambulance: 'amb1', patientName: 'b' });
    expect((await bookingPush.sendIncomingBooking('ta')).skipped).toBe('not_incoming');
    expect((await bookingPush.sendIncomingBooking('tb')).skipped).toBe('not_incoming');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('404 / 410 from the push service deletes that subscription; other errors keep it', async () => {
    await subscribeAs('tc1',    'https://fcm.googleapis.com/fcm/send/expired');
    await subscribeAs('tc2',    'https://fcm.googleapis.com/fcm/send/unsub');
    await subscribeAs('owner1', 'https://fcm.googleapis.com/fcm/send/flaky');
    webpush.sendNotification.mockImplementation(async (s) => {
      if (s.endpoint.endsWith('expired')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (s.endpoint.endsWith('unsub'))   throw Object.assign(new Error('Not found'), { statusCode: 404 });
      throw Object.assign(new Error('Server error'), { statusCode: 500 });
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { outcome } = await bookAndSettle();
    errors.mockRestore();
    expect(outcome).toEqual({ sent: 0, failed: 3, removed: 2 });
    expect(subs.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/flaky']);
  });

  test('no VAPID env: nothing is sent, the booking still succeeds', async () => {
    await setupSubs();
    delete process.env.VAPID_PUBLIC_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { outcome } = await bookAndSettle();
    warn.mockRestore();
    expect(outcome).toEqual({ sent: 0, skipped: 'not_configured' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(trips).toHaveLength(1);
  });

  test('a push-side crash never fails the booking', async () => {
    await setupSubs();
    PushSubscription.find = jest.fn(() => { throw new Error('db down'); });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { outcome } = await bookAndSettle();
    errors.mockRestore();
    expect(outcome).toMatchObject({ sent: 0, error: 'db down' });
  });
});
