/**
 * tests/tripCalls.test.js
 * ============================================================
 * Driver <-> customer masked calling (services/tripCalls.js,
 * controllers/tripCallController.js):
 *
 *   A. when a trip is callable, and whose real numbers are used
 *   B. POST /api/trips/:id/call from the driver
 *   C. ... from the customer (trackingToken / customer-app login)
 *   D. rate limit, masking-number fallback, Plivo failure
 *   E. /api/calls/trip-answer: bridges only while the trip is active
 *   F. /api/calls/trip-inbound: a redial is never bridged
 *   G. wiring: auth on the app route, Plivo signature on the webhooks
 *
 * Plivo's REST client is replaced (no call leaves the process); the XML
 * builders and signature check are the real ones. No database.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';
process.env.PLIVO_MASKING_NUMBER = '918071234567';
delete process.env.TRIP_CALL_MAX_SECONDS;
delete process.env.TRIP_CALL_MAX_PER_10_MIN;

jest.mock('../models', () => ({
  Trip: { findById: jest.fn() },
  User: { findById: jest.fn() },
}));
jest.mock('../models/CallLog', () => ({
  create: jest.fn(), countDocuments: jest.fn(), findById: jest.fn(), updateOne: jest.fn(),
}));
// routes/trips.js is required only to check the new route's wiring; its
// other controllers (and their push SDKs) are stand-ins.
const mockStubController = () => new Proxy({}, { get: (t, k) => (k === '__esModule' ? false : (t[k] ||= jest.fn())) });
jest.mock('../controllers/tripController', () => mockStubController());
jest.mock('../controllers/paymentController', () => mockStubController());
const mockCreateCall = jest.fn();
jest.mock('plivo', () => ({
  ...jest.requireActual('plivo'),
  Client: jest.fn(() => ({ calls: { create: mockCreateCall } })),
}));

const jwt = require('jsonwebtoken');
const { Trip } = require('../models');
const CallLog = require('../models/CallLog');
const tripCalls = require('../services/tripCalls');
const ctrl = require('../controllers/tripCallController');

const DRIVER_ID = '64b0000000000000000000d1';
const TRIP_ID = '64b0000000000000000000f1';
const LOG_ID = '64b0000000000000000000c1';
const CUSTOMER = '9986844442';
const DRIVER_LOGIN = '9123456789';
const DRIVER_RING = '9876500000';
const TOKEN = 'k3y-0f-the-tracking-link-22';
const REAL_NUMBERS = /9986844442|9876500000|9123456789/;

const tripOf = (over = {}) => ({
  _id: TRIP_ID, status: 'en_route', driverConfirmed: true, patientPhone: CUSTOMER, trackingToken: TOKEN,
  driver: { _id: DRIVER_ID, name: 'Ravi', phone: DRIVER_LOGIN, callPhone: DRIVER_RING },
  ...over,
});
const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  q.select = () => q;
  q.populate = () => q;
  return q;
};
const mockRes = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.type = (t) => { res.headers['content-type'] = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
};
const run = async (handler, req) => {
  const res = mockRes();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};
const start = (body, { user, headers = {} } = {}) =>
  run(ctrl.startCall, { params: { id: TRIP_ID }, body, user, headers });
const asDriver = (body = { from: 'driver' }, user = { _id: DRIVER_ID, role: 'driver' }) => start(body, { user });

let savedLog;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLIVO_MASKING_NUMBER = '918071234567';
  Trip.findById.mockReturnValue(chain(tripOf()));
  CallLog.countDocuments.mockResolvedValue(0);
  CallLog.updateOne.mockResolvedValue({});
  CallLog.create.mockImplementation(async (d) => {
    savedLog = { _id: LOG_ID, ...d, save: jest.fn(async () => savedLog) };
    return savedLog;
  });
  mockCreateCall.mockResolvedValue({ requestUuid: 'req-1' });
});

// ============================================================
describe('A. callable trips and number resolution', () => {
  test.each(['booked', 'dispatched', 'en_route'])('%s with a driver is callable', (status) => {
    expect(() => tripCalls.assertCallable(tripOf({ status }), 'driver')).not.toThrow();
  });

  test.each([
    ['completed', 'TRIP_COMPLETED'],
    ['cancelled', 'TRIP_CANCELLED'],
  ])('%s is refused for both sides (409 %s)', (status, code) => {
    for (const from of ['driver', 'customer']) {
      expect(() => tripCalls.assertCallable(tripOf({ status }), from)).toThrow(expect.objectContaining({ status: 409, code }));
    }
  });

  test('no driver yet -> 409 NO_DRIVER', () => {
    expect(() => tripCalls.assertCallable(tripOf({ driver: null }), 'customer')).toThrow(expect.objectContaining({ code: 'NO_DRIVER' }));
  });

  test('the customer cannot call before the driver accepts; the driver can', () => {
    const t = tripOf({ status: 'dispatched', driverConfirmed: false });
    expect(() => tripCalls.assertCallable(t, 'customer')).toThrow(expect.objectContaining({ code: 'DRIVER_NOT_CONFIRMED' }));
    expect(() => tripCalls.assertCallable(t, 'driver')).not.toThrow();
  });

  test('numbers come from the trip: driver ring number (else login), customer = patientPhone', () => {
    expect(tripCalls.resolveParties(tripOf())).toEqual({ driverPhone: DRIVER_RING, customerPhone: CUSTOMER });
    const noRing = tripOf({ driver: { _id: DRIVER_ID, phone: '+91 91234 56789', callPhone: '' } });
    expect(tripCalls.resolveParties(noRing).driverPhone).toBe(DRIVER_LOGIN);
    expect(tripCalls.resolveParties(tripOf({ patientPhone: '+91-99868-44442' })).customerPhone).toBe(CUSTOMER);
  });

  test.each([
    ['customer N/A', { patientPhone: 'N/A' }, 'CUSTOMER_PHONE_INVALID'],
    ['driver landline', { driver: { _id: DRIVER_ID, phone: '0801234567' } }, 'DRIVER_PHONE_INVALID'],
    ['same number', { patientPhone: DRIVER_RING }, 'SAME_NUMBER'],
  ])('%s -> 400 %s', (_l, over, code) => {
    expect(() => tripCalls.resolveParties(tripOf(over))).toThrow(expect.objectContaining({ status: 400, code }));
  });
});

// ============================================================
describe('B. the driver calls the customer', () => {
  test('rings the DRIVER first, from the masking number; on answer goes to trip-answer', async () => {
    const res = await asDriver();
    expect(res.statusCode).toBe(200);

    const [from, to, answerUrl, opts] = mockCreateCall.mock.calls[0];
    expect(from).toBe('918071234567');
    expect(to).toBe(`91${DRIVER_RING}`);
    expect(answerUrl).toBe(`https://api.savelife.health/api/calls/trip-answer?log=${LOG_ID}`);
    expect(opts).toMatchObject({ hangupUrl: `https://api.savelife.health/api/calls/events?log=${LOG_ID}`, timeLimit: 1800 });
    // Only the log id in the URLs -- never a number.
    expect(answerUrl + opts.hangupUrl).not.toMatch(REAL_NUMBERS);

    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      context: 'trip', trip: TRIP_ID, tripMasked: true, tripCallFrom: 'driver', firstLeg: 'agent',
      callerId: '918071234567', agentPhone: DRIVER_RING, customerPhone: CUSTOMER, direction: 'outbound', provider: 'plivo',
    }));
    expect(savedLog.providerRequestId).toBe('req-1');

    expect(res.body).toMatchObject({ success: true, callLogId: LOG_ID, callerId: '918071234567' });
    expect(res.body.message).toMatch(/connect you to the customer/);
    expect(JSON.stringify(res.body)).not.toMatch(REAL_NUMBERS);
  });

  test('another driver\'s trip -> 403, nobody rung', async () => {
    const res = await asDriver({ from: 'driver' }, { _id: '64b0000000000000000000d9', role: 'driver' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_YOUR_TRIP');
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  test.each([
    ['completed', 'TRIP_COMPLETED'],
    ['cancelled', 'TRIP_CANCELLED'],
  ])('a %s trip -> 409 %s with a clear message; no call, no log', async (status, code) => {
    Trip.findById.mockReturnValue(chain(tripOf({ status })));
    const res = await asDriver();
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code });
    expect(res.body.message).toMatch(/calls between the driver and the customer are closed/);
    expect(mockCreateCall).not.toHaveBeenCalled();
    expect(CallLog.create).not.toHaveBeenCalled();
  });

  test('unknown or malformed trip id -> 404', async () => {
    Trip.findById.mockReturnValue(chain(null));
    expect((await asDriver()).statusCode).toBe(404);
    const bad = await run(ctrl.startCall, { params: { id: 'nope' }, body: { from: 'driver' }, user: { _id: DRIVER_ID } });
    expect(bad.statusCode).toBe(404);
  });
});

// ============================================================
describe('C. the customer calls the driver', () => {
  test('with the trip\'s trackingToken: rings the CUSTOMER first, never shows a number', async () => {
    const res = await start({ from: 'customer', trackingToken: TOKEN });
    expect(res.statusCode).toBe(200);
    const [from, to] = mockCreateCall.mock.calls[0];
    expect(from).toBe('918071234567');
    expect(to).toBe(`91${CUSTOMER}`);
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({ firstLeg: 'customer', tripCallFrom: 'customer' }));
    expect(res.body.message).toMatch(/connect you to the driver/);
    expect(JSON.stringify(res.body)).not.toMatch(REAL_NUMBERS);
  });

  test('with a customer-app login for the trip\'s number', async () => {
    const token = jwt.sign({ phone: CUSTOMER, role: 'customer' }, process.env.JWT_SECRET);
    const res = await start({ from: 'customer' }, { headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(mockCreateCall).toHaveBeenCalledTimes(1);
  });

  test('a bare trip id is not enough -> 401', async () => {
    const res = await start({ from: 'customer' });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('CUSTOMER_PROOF_REQUIRED');
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  test('a wrong trackingToken, or a login for another number -> 403', async () => {
    expect((await start({ from: 'customer', trackingToken: 'guess' })).statusCode).toBe(403);
    const other = jwt.sign({ phone: '9000000001', role: 'customer' }, process.env.JWT_SECRET);
    expect((await start({ from: 'customer' }, { headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(403);
    // A driver/staff token is not a customer proof.
    const staff = jwt.sign({ id: DRIVER_ID }, process.env.JWT_SECRET);
    expect((await start({ from: 'customer' }, { headers: { authorization: `Bearer ${staff}` } })).statusCode).toBe(401);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  test('after completion the customer is refused too', async () => {
    Trip.findById.mockReturnValue(chain(tripOf({ status: 'completed' })));
    const res = await start({ from: 'customer', trackingToken: TOKEN });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TRIP_COMPLETED');
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  test('before the driver accepts -> 409 DRIVER_NOT_CONFIRMED', async () => {
    Trip.findById.mockReturnValue(chain(tripOf({ status: 'dispatched', driverConfirmed: false })));
    const res = await start({ from: 'customer', trackingToken: TOKEN });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DRIVER_NOT_CONFIRMED');
  });
});

// ============================================================
describe('D. limits, fallback and failures', () => {
  test('6 calls on a trip in 10 minutes -> the 7th is 429', async () => {
    CallLog.countDocuments.mockResolvedValue(6);
    const res = await asDriver();
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(mockCreateCall).not.toHaveBeenCalled();
    expect(CallLog.countDocuments.mock.calls[0][0]).toMatchObject({ trip: TRIP_ID, tripMasked: true });
  });

  test('no PLIVO_MASKING_NUMBER -> falls back to PLIVO_NUMBER', async () => {
    delete process.env.PLIVO_MASKING_NUMBER;
    const res = await asDriver();
    expect(res.statusCode).toBe(200);
    expect(mockCreateCall.mock.calls[0][0]).toBe('918065591088');
    expect(res.body.callerId).toBe('918065591088');
  });

  test('a malformed PLIVO_MASKING_NUMBER is ignored rather than used as caller ID', () => {
    process.env.PLIVO_MASKING_NUMBER = '8071234567';
    expect(tripCalls.maskingNumber()).toEqual({ number: '918065591088', dedicated: false });
  });

  test('Plivo refuses -> 502 with Plivo\'s reason; the log is marked failed', async () => {
    mockCreateCall.mockRejectedValue(new Error('Concurrency Limit Breached'));
    const res = await asDriver();
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('PLIVO_FAILED');
    expect(res.body.message).toMatch(/simultaneous calls/);
    expect(savedLog.status).toBe('failed');
    expect(savedLog.save).toHaveBeenCalled();
  });

  test('Plivo not configured -> 503', async () => {
    const id = process.env.PLIVO_AUTH_ID;
    delete process.env.PLIVO_AUTH_ID;
    try {
      const res = await asDriver();
      expect(res.statusCode).toBe(503);
      expect(res.body.code).toBe('NOT_CONFIGURED');
    } finally { process.env.PLIVO_AUTH_ID = id; }
  });
});

// ============================================================
describe('E. trip-answer: bridges only while the trip is active', () => {
  const logOf = (over = {}) => ({
    _id: LOG_ID, direction: 'outbound', tripMasked: true, tripCallFrom: 'driver', firstLeg: 'agent',
    trip: TRIP_ID, agentUser: DRIVER_ID, callerId: '918071234567',
    agentPhone: DRIVER_RING, customerPhone: CUSTOMER, ...over,
  });
  const answer = (log, trip, body = { CallUUID: 'uuid-1' }) => {
    CallLog.findById.mockReturnValue(chain(log));
    Trip.findById.mockReturnValue(chain(trip));
    return run(ctrl.answer, { method: 'POST', query: { log: LOG_ID }, body });
  };

  test('driver started it: dials the CUSTOMER, caller ID = masking number, no driver number in the XML', async () => {
    const res = await answer(logOf(), { status: 'en_route', driver: DRIVER_ID, driverConfirmed: true });
    expect(res.headers['content-type']).toBe('text/xml');
    expect(res.body).toContain('<Dial callerId="918071234567"');
    expect(res.body).toContain(`<Number>91${CUSTOMER}</Number>`);
    expect(res.body).not.toMatch(/9876500000|9123456789/);
    expect(res.body).toContain('timeLimit="1800"');
    expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: 'initiated' }, { $set: { status: 'agent_answered' } });
  });

  test('customer started it: dials the DRIVER', async () => {
    const res = await answer(logOf({ firstLeg: 'customer', tripCallFrom: 'customer' }), { status: 'en_route', driver: DRIVER_ID, driverConfirmed: true });
    expect(res.body).toContain(`<Number>91${DRIVER_RING}</Number>`);
    expect(res.body).not.toContain(CUSTOMER);
  });

  test.each(['completed', 'cancelled'])('trip %s while the phone rang -> "trip has ended", no Dial', async (status) => {
    const res = await answer(logOf(), { status, driver: DRIVER_ID });
    expect(res.body).toMatch(/This trip has ended/);
    expect(res.body).not.toContain('<Dial');
    expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID }, { $set: expect.objectContaining({ status: 'blocked_trip_inactive' }) });
  });

  test('driver reassigned meanwhile -> refused', async () => {
    const res = await answer(logOf(), { status: 'en_route', driver: '64b0000000000000000000d9' });
    expect(res.body).toMatch(/driver on this trip has changed/);
    expect(res.body).not.toContain('<Dial');
  });

  test('an ordinary click-to-call log, or no log, is never bridged here', async () => {
    let res = await answer(logOf({ tripMasked: undefined }), { status: 'en_route', driver: DRIVER_ID });
    expect(res.body).toMatch(/could not be connected/);
    expect(res.body).not.toContain('<Dial');
    CallLog.findById.mockReturnValue(chain(null));
    res = await run(ctrl.answer, { method: 'POST', query: { log: 'x' }, body: {} });
    expect(res.body).not.toContain('<Dial');
  });
});

// ============================================================
describe('F. trip-inbound: a redial is never bridged', () => {
  test('plays the message, names the help line, dials nobody', () => {
    const res = mockRes();
    ctrl.inbound({ method: 'POST', body: { From: `91${CUSTOMER}` } }, res);
    expect(res.headers['content-type']).toBe('text/xml');
    expect(res.body).toMatch(/only connects calls for a SaveLife trip/);
    expect(res.body).toContain('8 0 6 5 5 9 1 0 8 8');
    expect(res.body).not.toContain('<Dial');
  });
});

// ============================================================
describe('G. wiring', () => {
  const tripsRouter = require('../routes/trips');
  const callsRouter = require('../routes/calls');
  const callCtrl = require('../controllers/callController');
  // router.all() registers under `_all`.
  const layer = (router, path, method) => router.stack.find((l) => l.route?.path === path && (l.route.methods[method] || l.route.methods._all))?.route.stack;

  test('POST /api/trips/:id/call: authenticate, then startCall', () => {
    const stack = layer(tripsRouter, '/:id/call', 'post');
    expect(stack.map((s) => s.handle)).toEqual([ctrl.authenticate, ctrl.startCall]);
  });

  test('authenticate: bad from -> 400; from:driver without a login -> 401 (protect); customer passes to the trip check', async () => {
    expect((await run(ctrl.authenticate, { body: {}, headers: {} })).statusCode).toBe(400);
    const r = mockRes();
    let passed = false;
    await ctrl.authenticate({ body: { from: 'driver' }, headers: {}, cookies: {} }, r, () => { passed = true; });
    expect(passed).toBe(false);
    expect(r.statusCode).toBe(401);
    let customerPassed = false;
    await ctrl.authenticate({ body: { from: 'customer' }, headers: {} }, mockRes(), () => { customerPassed = true; });
    expect(customerPassed).toBe(true);
  });

  test('a driver-role check follows protect: a CRM login cannot place a "driver" call', async () => {
    const { User } = require('../models');
    const staffToken = jwt.sign({ id: '64b0000000000000000000a1' }, process.env.JWT_SECRET);
    User.findById.mockReturnValue(chain({ _id: '64b0000000000000000000a1', role: 'telecaller', isActive: true }));
    const r = mockRes();
    let passed = false;
    await ctrl.authenticate({ body: { from: 'driver' }, headers: { authorization: `Bearer ${staffToken}` }, cookies: {} }, r, () => { passed = true; });
    expect(passed).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  test('both webhooks sit behind the Plivo signature check, which refuses unsigned requests', () => {
    for (const p of ['/trip-answer', '/trip-inbound']) {
      expect(layer(callsRouter, p, 'post')[0].handle).toBe(callCtrl.requirePlivoSignature);
    }
    const r = mockRes();
    const next = jest.fn();
    callCtrl.requirePlivoSignature({
      method: 'POST', path: '/trip-answer', originalUrl: '/api/calls/trip-answer?log=x', query: {}, body: {}, get: () => undefined,
    }, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(403);
  });
});
