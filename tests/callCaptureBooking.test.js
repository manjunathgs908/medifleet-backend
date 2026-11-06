/**
 * tests/callCaptureBooking.test.js
 * ============================================================
 * LIVE CALL CAPTURE -> booking, only by an operator. POST /api/trips with
 * callCaptureId (the CRM's "Book" on a pre-filled form):
 *   - books through the same createBookedTrip: status 'booked', unassigned,
 *     bookingSource 'ai_call_entry', bookedBy the operator — so it does
 *     not ring as an incoming customer booking, and nothing is dispatched
 *   - the draft is linked to the trip; a second booking from it is 409
 *   - phone left blank (or the masked one a telecaller sees): the number
 *     said on the call, else the caller's own number
 *   - CRM staff only (a public booking carrying callCaptureId is refused);
 *     a booking WITHOUT callCaptureId is exactly as before
 *   - a failed booking releases the draft for another try
 *
 * Real routes/trips router, auth and tripController; models in memory.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = 'test-only-capture-booking-secret';

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
jest.mock('../models/TripCallEvent', () => ({ create: jest.fn(() => Promise.resolve({})), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../models/Quote',         () => modelStub());
jest.mock('../models/WhatsAppLead',    () => ({ ...modelStub(), find: jest.fn(() => ({ sort: () => ({ limit: () => Promise.resolve([]) }) })) }));
jest.mock('../models/WhatsAppSession', () => ({ ...modelStub(), find: jest.fn(() => ({ sort: () => ({ limit: () => Promise.resolve([]) }) })) }));
jest.mock('../models/CallCapture', () => ({ findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/CallLog', () => ({ findById: jest.fn() }));
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({ isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn() }));
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/smsService',  () => ({ sendOtp: jest.fn(), sendAlert: jest.fn(), sendSms: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({ notifyDriverAssigned: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/trackingNotifications', () => ({ notifyTrackingLink: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/bookingPush', () => ({ notifyIncomingBooking: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({
  compute: jest.fn(async () => ({ baseFare: 1000, distanceKm: 5, additionalCharges: 0, grandTotal: 1050 })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const { Trip, User } = require('../models');
const CallCapture = require('../models/CallCapture');
const CallLog = require('../models/CallLog');
const fareCalculator = require('../utils/fareCalculator');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) q[m] = () => q;
  return q;
};

const USERS = {
  tc1 : { _id: 'tc1', name: 'Ravi', role: 'telecaller', isActive: true },
  drv1: { _id: 'drv1', name: 'Driver', role: 'driver', isActive: true },
};
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const CAPTURE_ID = '64e000000000000000000001';
let captures;
const capMatches = (d, f) => String(d._id) === String(f._id)
  && (!('trip' in f) || d.trip == null)
  && (!f.bookingLock || d.bookingLock !== true);

beforeEach(() => {
  jest.clearAllMocks();
  User.findById = jest.fn((id) => chain(USERS[id] || null));
  Trip.create = jest.fn(async (data) => ({ _id: 'trip1', ...data, populate: jest.fn().mockResolvedValue(undefined) }));
  Trip.find = jest.fn(() => chain([]));
  captures = [{ _id: CAPTURE_ID, callLog: 'log1', fields: { patientPhone: '' }, trip: null, bookingLock: false }];
  CallCapture.findOneAndUpdate = jest.fn(async (filter, update) => {
    await new Promise((r) => setImmediate(r));
    const d = captures.find((c) => capMatches(c, filter));
    if (!d) return null;
    Object.assign(d, update.$set);
    return d;
  });
  CallCapture.findById = jest.fn((id) => chain(captures.find((c) => String(c._id) === String(id)) || null));
  CallCapture.updateOne = jest.fn(async (filter, update) => {
    const d = captures.find((c) => String(c._id) === String(filter._id));
    if (d) Object.assign(d, update.$set);
    return { matchedCount: d ? 1 : 0 };
  });
  CallLog.findById = jest.fn(() => chain({ _id: 'log1', customerPhone: '919876543210' }));
});

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

const http = async (body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/trips`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const FORM = {
  patientName: 'Lakshmi', patientPhone: '9845012345', emergencyType: 'general',
  pickupLabel: 'Jayanagar', pickupLat: 12.93, pickupLng: 77.58,
  dropLabel: 'Victoria Hospital', selectedType: 'bls', tripType: 'one_way',
};
const fromCapture = (extra = {}) => ({ ...FORM, callCaptureId: CAPTURE_ID, ...extra });

describe('booking from a live call capture', () => {
  test('a booked, unassigned trip sourced ai_call_entry, by the operator; the draft is linked', async () => {
    const res = await http(fromCapture(), tokenFor('tc1'));
    expect(res.status).toBe(201);
    const data = Trip.create.mock.calls[0][0];
    expect(data).toMatchObject({ status: 'booked', bookingSource: 'ai_call_entry', bookedBy: 'tc1', patientPhone: '9845012345' });
    expect(data.driver).toBeUndefined();
    expect(data.ambulance).toBeUndefined();
    expect(fareCalculator.compute).toHaveBeenCalledTimes(1); // the same fare engine as every booking
    expect(captures[0]).toMatchObject({ trip: 'trip1', bookingLock: false });
    expect(captures[0].bookedAt).toBeTruthy();
  });

  test('a second booking from the same call is refused (409), no second trip', async () => {
    expect((await http(fromCapture(), tokenFor('tc1'))).status).toBe(201);
    const again = await http(fromCapture(), tokenFor('tc1'));
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already been booked/);
    expect(Trip.create).toHaveBeenCalledTimes(1);
  });

  test('two presses at the same moment: exactly one trip', async () => {
    const [a, b] = await Promise.all([http(fromCapture(), tokenFor('tc1')), http(fromCapture(), tokenFor('tc1'))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(Trip.create).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['blank', ''],
    ['the masked number a telecaller sees', '••••••2345'],
  ])('phone %s: the number said on the call', async (_l, typed) => {
    captures[0].fields.patientPhone = '9845012345';
    await http(fromCapture({ patientPhone: typed }), tokenFor('tc1'));
    expect(Trip.create.mock.calls[0][0].patientPhone).toBe('9845012345');
  });

  test('phone blank and none said: the caller’s own number', async () => {
    await http(fromCapture({ patientPhone: '' }), tokenFor('tc1'));
    expect(Trip.create.mock.calls[0][0].patientPhone).toBe('9876543210');
  });

  test('a number the operator typed is kept as typed', async () => {
    captures[0].fields.patientPhone = '9845012345';
    await http(fromCapture({ patientPhone: '9000000001' }), tokenFor('tc1'));
    expect(Trip.create.mock.calls[0][0].patientPhone).toBe('9000000001');
  });

  test.each([
    ['no login (public)', undefined],
    ['a driver', 'drv1'],
  ])('%s cannot book from a capture (403); nothing created', async (_l, user) => {
    const res = await http(fromCapture(), user && tokenFor(user));
    expect(res.status).toBe(403);
    expect(Trip.create).not.toHaveBeenCalled();
    expect(CallCapture.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('unknown capture: 404', async () => {
    expect((await http(fromCapture({ callCaptureId: '64e0000000000000000000ff' }), tokenFor('tc1'))).status).toBe(404);
    expect((await http(fromCapture({ callCaptureId: 'junk' }), tokenFor('tc1'))).status).toBe(404);
  });

  test('a failed booking (fare error) releases the draft for another try', async () => {
    fareCalculator.compute.mockRejectedValueOnce(Object.assign(new Error('No pricing for this service'), { isFareError: true }));
    const res = await http(fromCapture(), tokenFor('tc1'));
    expect(res.status).toBe(400);
    await new Promise((r) => setImmediate(r));
    expect(captures[0]).toMatchObject({ trip: null, bookingLock: false });
    expect((await http(fromCapture(), tokenFor('tc1'))).status).toBe(201);
  });

  test('without callCaptureId nothing changes: no capture lookup, no bookingSource', async () => {
    const res = await http(FORM);
    expect(res.status).toBe(201);
    expect(CallCapture.findOneAndUpdate).not.toHaveBeenCalled();
    expect('bookingSource' in Trip.create.mock.calls[0][0]).toBe(false);
  });
});
