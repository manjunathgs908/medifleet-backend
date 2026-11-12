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
 *   F. dial-pad flow: /api/calls/trip-inbound (+ -dial, -dial-event,
 *      -hangup) and the trip-end hook; callNumberFor
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
  Trip: { findById: jest.fn(), find: jest.fn(), exists: jest.fn() },
  User: { findById: jest.fn(), find: jest.fn() },
}));
jest.mock('../models/CallLog', () => ({
  create: jest.fn(), countDocuments: jest.fn(), findById: jest.fn(), updateOne: jest.fn(),
  findOne: jest.fn(), find: jest.fn(),
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
  q.lean = () => q;
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
describe('F. dial-pad flow (caller dials the masking number)', () => {
  const plivoSvc = require('../services/plivoService');
  const OTHER_TRIP = '64b0000000000000000000f2';
  let hangupSpy;
  let logLines;
  let consoleSpies;
  beforeEach(() => {
    hangupSpy = jest.spyOn(plivoSvc, 'hangupCall').mockResolvedValue({});
    logLines = [];
    consoleSpies = ['info', 'warn', 'error'].map((m) => jest.spyOn(console, m)
      .mockImplementation((...a) => { logLines.push(a.map(String).join(' ')); }));
  });
  afterEach(() => {
    // No real number ever reaches a log line, and nobody's phone is rung
    // first (no callback): Plivo's "make a call" API is never used here.
    expect(logLines.join('\n')).not.toMatch(REAL_NUMBERS);
    expect(mockCreateCall).not.toHaveBeenCalled();
    hangupSpy.mockRestore();
    consoleSpies.forEach((s) => s.mockRestore());
  });

  // What the database answers for this caller.
  const world = ({ trips = [tripOf()], drivers = [], recentlyEnded = false } = {}) => {
    User.find.mockReturnValue(chain(drivers));
    Trip.find.mockReturnValue(chain(trips));
    Trip.exists.mockResolvedValue(recentlyEnded ? { _id: 'x' } : null);
  };
  const { User } = require('../models');
  const inbound = (From, extra = {}) => run(ctrl.inbound, { method: 'POST', body: { From, To: '918071234567', CallUUID: 'a-leg-1', ...extra }, query: {} });

  describe('bridging: caller -> active trip -> the OTHER party', () => {
    test('customer dials from their registered number: rings the DRIVER from the masking number', async () => {
      world();
      const res = await inbound(`+91${CUSTOMER}`);
      expect(res.headers['content-type']).toBe('text/xml');
      expect(res.body).toContain('<Dial callerId="918071234567"');
      expect(res.body).toContain(`<Number>91${DRIVER_RING}</Number>`);
      expect(res.body).not.toContain(CUSTOMER);                      // caller's own number never sent on
      expect(res.body).toContain(`/api/calls/trip-inbound-dial?log=${LOG_ID}`);
      expect(res.body).toContain(`callbackUrl="https://api.savelife.health/api/calls/trip-inbound-dial-event?log=${LOG_ID}"`);
      expect(res.body).toContain('timeout="30"');
      expect(res.body).toContain('timeLimit="1800"');
      expect(res.body).not.toContain('/api/calls/events');           // never the CRM's incoming pipeline
      expect(CallLog.create).toHaveBeenCalledWith(expect.objectContaining({
        direction: 'outbound', channel: 'dialpad', context: 'trip', trip: TRIP_ID, tripMasked: true,
        tripCallFrom: 'customer', firstLeg: 'customer', status: 'ringing', callerId: '918071234567',
        agentUser: DRIVER_ID, providerCallId: 'a-leg-1',
      }));
    });

    test.each([
      ['login phone', `91${DRIVER_LOGIN}`],
      ['call ring number', `0${DRIVER_RING}`],
    ])('driver dials from their %s: rings the CUSTOMER', async (_l, from) => {
      world({ trips: [tripOf({ patientPhone: CUSTOMER })], drivers: [{ _id: DRIVER_ID }] });
      const res = await inbound(from);
      expect(res.body).toContain(`<Number>91${CUSTOMER}</Number>`);
      expect(res.body).not.toMatch(/9876500000|9123456789/);
      expect(CallLog.create).toHaveBeenCalledWith(expect.objectContaining({ tripCallFrom: 'driver', firstLeg: 'agent' }));
    });

    test('only ACTIVE trips are searched, and drivers by role', async () => {
      world();
      await inbound(`91${CUSTOMER}`);
      expect(Trip.find.mock.calls[0][0].status).toEqual({ $in: ['booked', 'dispatched', 'en_route'] });
      expect(User.find.mock.calls[0][0].role).toBe('driver');
    });

    test('TRIP_DIAL_RING_SECONDS is clamped to 10-60', async () => {
      world();
      process.env.TRIP_DIAL_RING_SECONDS = '500';
      expect((await inbound(`91${CUSTOMER}`)).body).toContain('timeout="60"');
      process.env.TRIP_DIAL_RING_SECONDS = '3';
      expect((await inbound(`91${CUSTOMER}`)).body).toContain('timeout="10"');
      delete process.env.TRIP_DIAL_RING_SECONDS;
    });
  });

  describe('refusals: a spoken message, nobody dialled, no call row', () => {
    const refused = (res, re) => {
      expect(res.body).toMatch(re);
      expect(res.body).toContain('<Hangup/>');
      expect(res.body).not.toContain('<Dial');
      expect(CallLog.create).not.toHaveBeenCalled();
    };

    test('unknown caller (no trip at all)', async () => {
      world({ trips: [] });
      refused(await inbound('919000000001'), /only connects calls for an active SaveLife trip/);
    });

    test.each(['', 'anonymous', 'sip:someone@phone.plivo.com', '0801234567'])('withheld / not a mobile (%p): not even looked up', async (from) => {
      world();
      refused(await inbound(from), /only connects calls for an active SaveLife trip/);
      expect(Trip.find).not.toHaveBeenCalled();
    });

    test('the help line is the CRM number, spoken digit by digit', async () => {
      world({ trips: [] });
      expect((await inbound('919000000001')).body).toContain('8 0 6 5 5 9 1 0 8 8');
    });

    test('completed / cancelled: their trip ended recently -> "your trip has ended"', async () => {
      world({ trips: [], recentlyEnded: true });
      refused(await inbound(`91${CUSTOMER}`), /Your trip has ended/);
      expect(Trip.exists.mock.calls[0][0].status).toEqual({ $in: ['completed', 'cancelled'] });
    });

    test('more than one active trip -> refused, never guessed', async () => {
      world({ trips: [tripOf(), tripOf({ _id: OTHER_TRIP })] });
      refused(await inbound(`91${CUSTOMER}`), /more than one active SaveLife trip/);
    });

    test('driver on one trip and customer on another -> refused', async () => {
      world({
        trips: [
          tripOf(),                                                        // driving this one
          tripOf({ _id: OTHER_TRIP, patientPhone: DRIVER_RING,             // booked this one as a customer
            driver: { _id: '64b0000000000000000000d9', name: 'Other', phone: '9000000003' } }),
        ],
        drivers: [{ _id: DRIVER_ID }],
      });
      refused(await inbound(`91${DRIVER_RING}`), /more than one active SaveLife trip/);
    });

    test('caller is both the driver and the customer of one trip -> refused', async () => {
      world({ trips: [tripOf({ patientPhone: DRIVER_RING })], drivers: [{ _id: DRIVER_ID }] });
      refused(await inbound(`91${DRIVER_RING}`), /more than one active SaveLife trip/);
    });

    test('customer before the driver accepted', async () => {
      world({ trips: [tripOf({ status: 'dispatched', driverConfirmed: false })] });
      refused(await inbound(`91${CUSTOMER}`), /once they accept the trip/);
    });

    test('rate limit is shared with the callback flow', async () => {
      world();
      CallLog.countDocuments.mockResolvedValue(6);
      refused(await inbound(`91${CUSTOMER}`), /Too many calls on this trip/);
    });

    test('driver has no valid phone -> cannot connect', async () => {
      world({ trips: [tripOf({ driver: { _id: DRIVER_ID, name: 'Ravi', phone: '0801234567' } })] });
      refused(await inbound(`91${CUSTOMER}`), /cannot be connected right now/);
    });

    test.each([
      ['unset', undefined],
      ['the CRM line itself', '918065591088'],
    ])('no dedicated masking number (%s): refused before any lookup', async (_l, value) => {
      if (value === undefined) delete process.env.PLIVO_MASKING_NUMBER; else process.env.PLIVO_MASKING_NUMBER = value;
      world();
      refused(await inbound(`91${CUSTOMER}`), /trip calls are not available/);
      expect(Trip.find).not.toHaveBeenCalled();
    });

    test('a database error still answers Plivo with a message, never a 500', async () => {
      User.find.mockImplementation(() => { throw new Error('db down'); });
      const res = await inbound(`91${CUSTOMER}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/could not be connected/);
    });
  });

  // ── the other side picks up / the Dial ends / the caller hangs up ──────
  const dlog = (over = {}) => ({
    _id: LOG_ID, channel: 'dialpad', status: 'ringing', trip: TRIP_ID, agentUser: DRIVER_ID,
    tripCallFrom: 'customer', providerCallId: 'a-leg-1', ...over,
  });
  const matched = (n) => ({ matchedCount: n });

  describe('live report (DialAction=answer): connect only while the trip is active', () => {
    const event = (log, trip, body = { DialAction: 'answer', DialBLegUUID: 'b-leg-1' }) => {
      CallLog.findById.mockReturnValue(chain(log));
      Trip.findById.mockReturnValue(chain(trip));
      return run(ctrl.inboundDialEvent, { method: 'POST', query: { log: LOG_ID }, body });
    };

    test('trip active: ringing -> connected (agent_answered), nothing hung up', async () => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      const res = await event(dlog(), { status: 'en_route', driver: DRIVER_ID, driverConfirmed: true });
      expect(res.body).toContain('<Response');
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: 'ringing' }, expect.objectContaining({
        $set: expect.objectContaining({ status: 'agent_answered', customerLegId: 'b-leg-1' }),
      }));
      expect(hangupSpy).not.toHaveBeenCalled();
    });

    test.each(['completed', 'cancelled'])('trip %s while it rang: does NOT connect — hung up', async (status) => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      await event(dlog(), { status, driver: DRIVER_ID });
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: { $in: ['ringing', 'agent_answered'] } }, expect.objectContaining({
        $set: { status: 'blocked_trip_inactive' },
      }));
      expect(hangupSpy).toHaveBeenCalledWith('a-leg-1');
    });

    test('driver reassigned while it rang: hung up', async () => {
      await event(dlog(), { status: 'en_route', driver: '64b0000000000000000000d9', driverConfirmed: true });
      expect(hangupSpy).toHaveBeenCalledWith('a-leg-1');
    });

    test('lost the race to the trip-end hook (already stopped): hung up, not connected', async () => {
      CallLog.updateOne.mockResolvedValue(matched(0));
      CallLog.findById.mockReturnValueOnce(chain(dlog())).mockReturnValueOnce(chain({ status: 'blocked_trip_inactive' }));
      Trip.findById.mockReturnValue(chain({ status: 'en_route', driver: DRIVER_ID, driverConfirmed: true }));
      await run(ctrl.inboundDialEvent, { method: 'POST', query: { log: LOG_ID }, body: { DialAction: 'answer' } });
      expect(hangupSpy).toHaveBeenCalledWith('a-leg-1');
    });

    test('a repeated answer report on a connected call changes nothing', async () => {
      CallLog.updateOne.mockResolvedValue(matched(0));
      CallLog.findById.mockReturnValueOnce(chain(dlog())).mockReturnValueOnce(chain({ status: 'agent_answered' }));
      Trip.findById.mockReturnValue(chain({ status: 'en_route', driver: DRIVER_ID, driverConfirmed: true }));
      await run(ctrl.inboundDialEvent, { method: 'POST', query: { log: LOG_ID }, body: { DialAction: 'answer' } });
      expect(hangupSpy).not.toHaveBeenCalled();
    });

    test('hangup reports, and logs that are not dial-pad calls, are ignored', async () => {
      await event(dlog(), { status: 'completed' }, { DialAction: 'hangup' });
      await event(dlog({ channel: undefined }), { status: 'completed' });
      await event(dlog({ channel: 'voip' }), { status: 'completed' });
      expect(CallLog.updateOne).not.toHaveBeenCalled();
      expect(hangupSpy).not.toHaveBeenCalled();
    });
  });

  describe('Dial action: the outcome and what the caller hears last', () => {
    const finished = (log, body) => {
      CallLog.findById.mockReturnValue(chain(log));
      return run(ctrl.inboundDial, { method: 'POST', query: { log: LOG_ID }, body });
    };

    test('talked: completed with talk time, quiet hang-up', async () => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      const res = await finished(dlog({ status: 'agent_answered', answeredAt: new Date() }), { DialStatus: 'completed', DialBLegDuration: '95' });
      expect(res.body).toContain('<Hangup');
      expect(res.body).not.toContain('<Speak');
      expect(CallLog.updateOne).toHaveBeenCalledWith(
        { _id: LOG_ID, status: { $in: ['ringing', 'agent_answered', 'completed', 'cancelled'] } },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'completed', talkSec: 95 }) }),
      );
    });

    test('customer called, driver did not answer: driver_unavailable + "the driver could not answer"', async () => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      const res = await finished(dlog(), { DialStatus: 'no-answer' });
      expect(res.body).toMatch(/The driver could not answer right now/);
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: { $in: ['ringing', 'agent_answered'] } }, expect.objectContaining({
        $set: expect.objectContaining({ status: 'driver_unavailable' }),
      }));
    });

    test('driver called, customer busy: customer_busy + "the customer could not answer"', async () => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      const res = await finished(dlog({ tripCallFrom: 'driver' }), { DialStatus: 'busy' });
      expect(res.body).toMatch(/The customer could not answer right now/);
      expect(CallLog.updateOne.mock.calls[0][1].$set.status).toBe('customer_busy');
    });

    test('caller hung up while it rang: cancelled', async () => {
      CallLog.updateOne.mockResolvedValue(matched(1));
      await finished(dlog(), { DialStatus: 'cancel' });
      expect(CallLog.updateOne.mock.calls[0][1].$set.status).toBe('cancelled');
    });

    test('stopped at trip end: no "try again" message, status untouched', async () => {
      const res = await finished(dlog({ status: 'blocked_trip_inactive' }), { DialStatus: 'cancel' });
      expect(res.body).not.toContain('<Speak');
      expect(CallLog.updateOne).not.toHaveBeenCalled();
    });

    test('stopped at trip end between our read and the update: still no message', async () => {
      CallLog.updateOne.mockResolvedValue(matched(0));
      CallLog.findById.mockReturnValueOnce(chain(dlog())).mockReturnValueOnce(chain({ status: 'blocked_trip_inactive' }));
      const res = await run(ctrl.inboundDial, { method: 'POST', query: { log: LOG_ID }, body: { DialStatus: 'no-answer' } });
      expect(res.body).not.toContain('<Speak');
    });

    test('unknown log: hang up', async () => {
      CallLog.findById.mockReturnValue(chain(null));
      const res = await run(ctrl.inboundDial, { method: 'POST', query: { log: 'nope' }, body: {} });
      expect(res.body).toContain('<Hangup');
    });
  });

  describe('hangup URL (the caller\'s leg ended)', () => {
    test('found by CallUUID: end time, and a still-"live" status is settled', async () => {
      CallLog.findOne.mockResolvedValue(dlog({ status: 'agent_answered' }));
      CallLog.updateOne.mockResolvedValue(matched(1));
      const res = await run(ctrl.inboundHangup, { method: 'POST', query: {}, body: { CallUUID: 'a-leg-1', Duration: '120', HangupCause: 'NORMAL_CLEARING' } });
      expect(res.body).toContain('<Response');
      expect(CallLog.findOne).toHaveBeenCalledWith({ providerCallId: 'a-leg-1', channel: 'dialpad' });
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, endedAt: null }, { $set: expect.objectContaining({ totalSec: 120, hangupCause: 'NORMAL_CLEARING' }) });
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: 'agent_answered' }, { $set: { status: 'completed' } });
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: 'ringing' }, expect.objectContaining({ $set: { status: 'cancelled' } }));
    });

    test('a refused call (no row) is ignored', async () => {
      CallLog.findOne.mockResolvedValue(null);
      await run(ctrl.inboundHangup, { method: 'POST', query: {}, body: { CallUUID: 'x' } });
      expect(CallLog.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('trip completed / cancelled (the tripController hook)', () => {
    test('(a) nothing in progress: nothing hung up', async () => {
      CallLog.find.mockReturnValue(chain([]));
      expect(await tripCalls.endRingingDialpadCalls(TRIP_ID, 'completed')).toEqual({ ringingEnded: 0 });
      expect(CallLog.find).toHaveBeenCalledWith({ trip: TRIP_ID, channel: 'dialpad', status: 'ringing', endedAt: null });
      expect(hangupSpy).not.toHaveBeenCalled();
    });

    test('(b) other side still RINGING: stopped and hung up, so it never connects', async () => {
      CallLog.find.mockReturnValue(chain([{ _id: LOG_ID, providerCallId: 'a-leg-1' }]));
      CallLog.updateOne.mockResolvedValue(matched(1));
      expect(await tripCalls.endRingingDialpadCalls(TRIP_ID, 'cancelled')).toEqual({ ringingEnded: 1 });
      expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: LOG_ID, status: 'ringing' }, {
        $set: { status: 'blocked_trip_inactive' }, $push: { flow: 'dialpad:trip_cancelled→ringing_call_ended' },
      });
      expect(hangupSpy).toHaveBeenCalledWith('a-leg-1');
    });

    test('(c) CONNECTED a moment before (update did not apply): left running', async () => {
      CallLog.find.mockReturnValue(chain([{ _id: LOG_ID, providerCallId: 'a-leg-1' }]));
      CallLog.updateOne.mockResolvedValue(matched(0));
      expect(await tripCalls.endRingingDialpadCalls(TRIP_ID, 'completed')).toEqual({ ringingEnded: 0 });
      expect(hangupSpy).not.toHaveBeenCalled();
    });

    test('never throws; a Plivo 404 (already gone) is fine', async () => {
      CallLog.find.mockImplementation(() => { throw new Error('db down'); });
      await expect(tripCalls.endRingingDialpadCalls(TRIP_ID, 'completed')).resolves.toEqual({ ringingEnded: 0, error: true });
      CallLog.find.mockReturnValue(chain([{ _id: LOG_ID, providerCallId: 'a-leg-1' }]));
      CallLog.updateOne.mockResolvedValue(matched(1));
      hangupSpy.mockRejectedValue({ response: { status: 404 } });
      await expect(tripCalls.endRingingDialpadCalls(TRIP_ID, 'completed')).resolves.toEqual({ ringingEnded: 1 });
    });
  });

  describe('callNumberFor (what the app\'s Call button dials)', () => {
    test('masking number in +91 form while this side may call', () => {
      expect(tripCalls.callNumberFor(tripOf(), 'customer')).toBe('+918071234567');
      expect(tripCalls.callNumberFor(tripOf({ status: 'dispatched', driverConfirmed: false }), 'driver')).toBe('+918071234567');
    });

    test('null: ended, no driver, customer before acceptance, no dedicated number', () => {
      expect(tripCalls.callNumberFor(tripOf({ status: 'completed' }), 'driver')).toBeNull();
      expect(tripCalls.callNumberFor(tripOf({ status: 'cancelled' }), 'customer')).toBeNull();
      expect(tripCalls.callNumberFor(tripOf({ driver: null }), 'customer')).toBeNull();
      expect(tripCalls.callNumberFor(tripOf({ status: 'dispatched', driverConfirmed: false }), 'customer')).toBeNull();
      expect(tripCalls.callNumberFor(null, 'customer')).toBeNull();
      process.env.PLIVO_MASKING_NUMBER = '918065591088';
      expect(tripCalls.callNumberFor(tripOf(), 'customer')).toBeNull();
    });
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

  test('every trip webhook sits behind the Plivo signature check, which refuses unsigned requests', () => {
    for (const [p, h] of [
      ['/trip-answer', ctrl.answer],
      ['/trip-inbound', ctrl.inbound],
      ['/trip-inbound-dial', ctrl.inboundDial],
      ['/trip-inbound-dial-event', ctrl.inboundDialEvent],
      ['/trip-inbound-hangup', ctrl.inboundHangup],
    ]) {
      expect(layer(callsRouter, p, 'post').map((s) => s.handle)).toEqual([callCtrl.requirePlivoSignature, h]);
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
