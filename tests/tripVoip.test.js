/**
 * tests/tripVoip.test.js
 * ============================================================
 * In-app (VoIP) customer -> driver calls, Phase 1 (services/tripVoip.js,
 * controllers/tripVoipController.js):
 *
 *   A. POST /api/trips/:id/voip/session — active vs ended trips, the
 *      customer's proof, driver offline -> DRIVER_UNAVAILABLE, limits
 *   B. /api/calls/trip-voip-answer — rings the driver's APP only, and
 *      re-checks trip / caller / driver / session at answer time
 *   C. /api/calls/trip-voip-dial + hangup — not answered -> DRIVER_UNAVAILABLE,
 *      never a phone leg
 *   D. the app's status / End
 *   E. trip completed / cancelled -> live call hung up, endpoint deleted
 *   F. the driver app's login and presence
 *   G. no real number anywhere (responses, XML, log lines); no phone dial
 *   H. wiring and the unchanged shared bridge
 *
 * Plivo's REST calls are replaced (nothing leaves the process); the XML
 * builders are the real ones. CallLog and TripVoipEndpoint are a small
 * in-memory fake so state changes can be followed end to end.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';
process.env.PLIVO_MASKING_NUMBER = '918071234567';
process.env.PLIVO_TRIP_VOIP_APP_ID = 'app-trip-voip-1';
delete process.env.TRIP_VOIP_RING_SECONDS;
delete process.env.TRIP_VOIP_DRIVER_ONLINE_MIN;
delete process.env.TRIP_VOIP_SESSION_TTL_SEC;
delete process.env.TRIP_CALL_MAX_PER_10_MIN;

// ── A tiny in-memory collection (only the query shapes the code uses) ────
function mockCollection() {
  let rows = [];
  let seq = 0;
  const get = (o, k) => k.split('.').reduce((v, p) => (v == null ? v : v[p]), o);
  const eq = (a, b) => String(a) === String(b);
  const matchOne = (v, cond) => {
    if (cond === null) return v == null;
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === '$in') return x.some((y) => eq(v, y));
        if (op === '$ne') return !eq(v, x);
        if (op === '$gte') return v != null && new Date(v) >= new Date(x);
        if (op === '$exists') return x ? v !== undefined : v === undefined;
        throw new Error(`fake: ${op}`);
      });
    }
    return eq(v, cond);
  };
  const matches = (r, q = {}) => Object.entries(q).every(([k, c]) => matchOne(get(r, k), c));
  const apply = (r, u) => {
    for (const [k, v] of Object.entries(u.$set || {})) r[k] = v;
    for (const k of Object.keys(u.$unset || {})) delete r[k];
    for (const [k, v] of Object.entries(u.$push || {})) r[k] = [...(r[k] || []), v];
  };
  const hydrate = (r) => {
    if (!r) return null;
    const d = JSON.parse(JSON.stringify(r));
    for (const k of ['startedAt', 'onlineAt', 'lastUsedAt', 'endedAt']) if (d[k]) d[k] = new Date(d[k]);
    Object.defineProperty(d, 'save', {
      enumerable: false,
      value: async () => { const i = rows.findIndex((x) => eq(x._id, d._id)); rows[i] = { ...JSON.parse(JSON.stringify(d)) }; return d; },
    });
    return d;
  };
  const query = (fn) => {
    let lean = false;
    const q = {
      select: () => q, populate: () => q, sort: () => q, limit: () => q,
      lean: () => { lean = true; return q; },
      then: (res, rej) => Promise.resolve().then(() => {
        const v = fn();
        if (Array.isArray(v)) return v.map((r) => (lean ? JSON.parse(JSON.stringify(r)) : hydrate(r)));
        return lean ? (v ? JSON.parse(JSON.stringify(v)) : null) : hydrate(v);
      }).then(res, rej),
    };
    return q;
  };
  const uniqueClash = (d) => (d.kind === 'customer' && rows.some((r) => r.kind === 'customer' && eq(r.trip, d.trip)))
    || (d.kind === 'driver' && rows.some((r) => r.kind === 'driver' && eq(r.user, d.user) && r.deviceKey === d.deviceKey));
  return {
    rows: () => rows,
    reset: () => { rows = []; },
    seed: (d) => { const r = { _id: (++seq).toString(16).padStart(24, 'a'), ...d }; rows.push(r); return r; },
    create: jest.fn(async (d) => {
      if (uniqueClash(d)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      const r = { _id: (++seq).toString(16).padStart(24, '0'), startedAt: new Date(), flow: [], ...JSON.parse(JSON.stringify(d)) };
      rows.push(r);
      return hydrate(r);
    }),
    findById: jest.fn((id) => query(() => rows.find((r) => eq(r._id, id)) || null)),
    findOne: jest.fn((q) => query(() => rows.find((r) => matches(r, q)) || null)),
    find: jest.fn((q) => query(() => rows.filter((r) => matches(r, q)))),
    countDocuments: jest.fn(async (q) => rows.filter((r) => matches(r, q)).length),
    updateOne: jest.fn(async (q, u) => { const r = rows.find((x) => matches(x, q)); if (r) apply(r, u); return { modifiedCount: r ? 1 : 0 }; }),
    updateMany: jest.fn(async (q, u) => { const rs = rows.filter((x) => matches(x, q)); rs.forEach((r) => apply(r, u)); return { modifiedCount: rs.length }; }),
    findOneAndUpdate: jest.fn((q, u) => query(() => { const r = rows.find((x) => matches(x, q)); if (r) apply(r, u); return r || null; })),
    deleteOne: jest.fn(async (q) => { const i = rows.findIndex((x) => matches(x, q)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }),
  };
}

jest.mock('../models/CallLog', () => mockCollection());
jest.mock('../models/TripVoipEndpoint', () => mockCollection());
jest.mock('../models', () => ({ Trip: { findById: jest.fn(), find: jest.fn() }, User: { findById: jest.fn() } }));
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
const TripVoipEndpoint = require('../models/TripVoipEndpoint');
const plivo = require('../services/plivoService');
const voip = require('../services/tripVoip');
const ctrl = require('../controllers/tripVoipController');
const tripCallCtrl = require('../controllers/tripCallController');

const DRIVER_ID = '64b0000000000000000000d1';
const OTHER_DRIVER = '64b0000000000000000000d2';
const TRIP_ID = '64b0000000000000000000f1';
const OTHER_TRIP = '64b0000000000000000000f2';
const CUSTOMER = '9986844442';
const DRIVER_PHONE = '9876500000';
const TOKEN = 'k3y-0f-the-tracking-link-22';
const DEVICE = 'drv-device-0001';
const REAL_NUMBERS = /9986844442|9876500000/;

// ── Trips (the Trip model is a plain map) ─────────────────────────────────
let trips;
const tripOf = (over = {}) => ({
  _id: TRIP_ID, status: 'en_route', driverConfirmed: true, patientPhone: CUSTOMER, trackingToken: TOKEN, driver: DRIVER_ID, ...over,
});
const tripQuery = (id) => {
  let populated = false;
  const q = {
    select: () => q, lean: () => q,
    populate: () => { populated = true; return q; },
    then: (res, rej) => Promise.resolve().then(() => {
      const t = trips[String(id)];
      if (!t) return null;
      const copy = { ...t };
      if (populated && copy.driver) copy.driver = { _id: copy.driver, name: 'Ravi', phone: DRIVER_PHONE };
      return copy;
    }).then(res, rej),
  };
  return q;
};

// ── Request / response doubles ───────────────────────────────────────────
const mockRes = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.type = (t) => { res.headers['content-type'] = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
};
const reqOf = ({ params = {}, body = {}, query = {}, headers = {}, user, method = 'POST' } = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { params, body, query, headers: h, user, method, get: (k) => h[String(k).toLowerCase()] };
};
const run = async (handler, req) => {
  const res = mockRes();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};
const session = (body = { trackingToken: TOKEN }, headers = {}, tripId = TRIP_ID) =>
  run(ctrl.session, reqOf({ params: { id: tripId }, body, headers }));
const driverLogin = (headers = { 'X-Device-Key': DEVICE }, query = {}, user = { _id: DRIVER_ID, role: 'driver' }) =>
  run(ctrl.driverLogin, reqOf({ method: 'GET', headers, query, user }));
const answer = (params) => run(ctrl.answer, reqOf({ body: params }));
const dial = (logId, params) => run(ctrl.dial, reqOf({ query: { log: logId }, body: params }));
const hangup = (params) => run(ctrl.hangup, reqOf({ body: params }));
const statusOf = (logId, headers = { 'X-Tracking-Token': TOKEN }) =>
  run(ctrl.status, reqOf({ method: 'GET', params: { id: TRIP_ID, logId }, headers }));
const end = (logId) => run(ctrl.end, reqOf({ params: { id: TRIP_ID, logId }, body: { trackingToken: TOKEN } }));
const logRow = (id) => CallLog.rows().find((r) => String(r._id) === String(id));
const customerEp = () => TripVoipEndpoint.rows().find((r) => r.kind === 'customer' && r.trip === TRIP_ID);

// The full happy start: driver app online, customer session, Plivo answer.
async function startRinging() {
  await driverLogin();
  const s = await session();
  const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, To: s.body.dialTo, 'X-PH-logId': s.body.callLogId, CallUUID: 'call-a-1' });
  return { s, a };
}

// Plivo REST stand-ins.
let epSeq = 0;
let logged = [];
beforeEach(() => {
  jest.clearAllMocks();
  CallLog.reset();
  TripVoipEndpoint.reset();
  voip._resetSweep();
  process.env.PLIVO_TRIP_VOIP_APP_ID = 'app-trip-voip-1';
  trips = { [TRIP_ID]: tripOf() };
  Trip.findById.mockImplementation((id) => tripQuery(id));
  Trip.find.mockImplementation((q) => ({
    select: () => ({ lean: async () => Object.values(trips).filter((t) => q._id.$in.map(String).includes(String(t._id))) }),
  }));
  epSeq = 0;
  jest.spyOn(plivo, 'createEndpoint').mockImplementation(async ({ username }) => {
    epSeq += 1;
    return { id: `ep-${epSeq}`, username: `${username}${100 + epSeq}` };
  });
  jest.spyOn(plivo, 'deleteEndpoint').mockResolvedValue({});
  jest.spyOn(plivo, 'resetEndpointPassword').mockResolvedValue('new-pass-xyz');
  jest.spyOn(plivo, 'linkEndpointToApp').mockResolvedValue({});
  jest.spyOn(plivo, 'hangupCall').mockResolvedValue({});
  logged = [];
  for (const m of ['info', 'warn', 'error', 'log']) {
    jest.spyOn(console, m).mockImplementation((...a) => { logged.push(a.map(String).join(' ')); });
  }
});
afterEach(() => {
  // G: no phone leg was ever placed, and no log line carried a real number.
  expect(mockCreateCall).not.toHaveBeenCalled();
  expect(logged.join('\n')).not.toMatch(REAL_NUMBERS);
  jest.restoreAllMocks();
});

// ============================================================
describe('A. POST /api/trips/:id/voip/session', () => {
  test('active trip + driver app online -> this trip\'s login, the log id and what to dial; no numbers', async () => {
    await driverLogin();
    const res = await session();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, ok: true, ringSeconds: 25, expiresInSec: 120 }));
    expect(res.body.username).toMatch(/^slc/);
    expect(res.body.password).toEqual(expect.any(String));
    expect(res.body.dialTo).toBe(`tripvoip${res.body.callLogId}`);
    expect(res.body.sipHeaders).toEqual({ 'X-PH-logId': String(res.body.callLogId) });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(REAL_NUMBERS);
    // The endpoint is linked to the Trip VoIP application, not the CRM's.
    expect(plivo.createEndpoint).toHaveBeenLastCalledWith(expect.objectContaining({ appId: 'app-trip-voip-1', alias: `slvoip-c-${TRIP_ID}` }));
    const log = logRow(res.body.callLogId);
    expect(log).toEqual(expect.objectContaining({ channel: 'voip', status: 'initiated', tripMasked: true, tripCallFrom: 'customer', agentUser: DRIVER_ID }));
    // Neither number is stored on an in-app call.
    expect(log.customerPhone).toBeUndefined();
    expect(log.agentPhone).toBeUndefined();
  });

  test('a second tap reuses the trip\'s endpoint (one endpoint per trip)', async () => {
    await driverLogin();
    const a = await session();
    const b = await session();
    expect(b.body.username).toBe(a.body.username);
    expect(b.body.callLogId).not.toBe(a.body.callLogId);
    expect(plivo.createEndpoint).toHaveBeenCalledTimes(2); // the driver's + the trip's
    expect(TripVoipEndpoint.rows().filter((r) => r.kind === 'customer')).toHaveLength(1);
  });

  test.each([
    ['completed', 'TRIP_COMPLETED'],
    ['cancelled', 'TRIP_CANCELLED'],
  ])('%s trip -> 409 %s, nothing created', async (status, code) => {
    await driverLogin();
    trips[TRIP_ID].status = status;
    const res = await session();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ success: false, ok: false, code }));
    expect(customerEp()).toBeUndefined();
    expect(CallLog.rows()).toHaveLength(0);
  });

  test('before the driver accepts -> 409 DRIVER_NOT_CONFIRMED', async () => {
    await driverLogin();
    trips[TRIP_ID] = tripOf({ status: 'dispatched', driverConfirmed: false });
    expect((await session()).body.code).toBe('DRIVER_NOT_CONFIRMED');
  });

  test('wrong customer: wrong trackingToken -> 403 NOT_THIS_TRIP; no proof -> 401', async () => {
    await driverLogin();
    const wrong = await session({ trackingToken: 'someone-elses-token-0000' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body.code).toBe('NOT_THIS_TRIP');
    const none = await session({});
    expect(none.statusCode).toBe(401);
    expect(none.body.code).toBe('CUSTOMER_PROOF_REQUIRED');
    expect(CallLog.rows()).toHaveLength(0);
  });

  test('a customer-app login works only for the trip\'s own phone', async () => {
    await driverLogin();
    const mine = jwt.sign({ phone: CUSTOMER, role: 'customer' }, process.env.JWT_SECRET);
    const theirs = jwt.sign({ phone: '9000000001', role: 'customer' }, process.env.JWT_SECRET);
    expect((await session({}, { Authorization: `Bearer ${mine}` })).statusCode).toBe(200);
    expect((await session({}, { Authorization: `Bearer ${theirs}` })).body.code).toBe('NOT_THIS_TRIP');
  });

  test('driver app offline -> 409 DRIVER_UNAVAILABLE with the in-app message; no endpoint, no log', async () => {
    const res = await session();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, ok: false, code: 'DRIVER_UNAVAILABLE', message: 'Driver is not reachable right now. Please try again.' });
    expect(customerEp()).toBeUndefined();
    expect(CallLog.rows()).toHaveLength(0);
  });

  test('a stale check-in counts as offline; presence false makes the driver unreachable', async () => {
    await driverLogin();
    TripVoipEndpoint.rows()[0].onlineAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
    expect((await session()).body.code).toBe('DRIVER_UNAVAILABLE');
    await driverLogin();
    expect((await session()).statusCode).toBe(200);
    await run(ctrl.driverPresence, reqOf({ body: { online: false }, user: { _id: DRIVER_ID, role: 'driver' } }));
    expect((await session()).body.code).toBe('DRIVER_UNAVAILABLE');
  });

  test('another driver\'s online app does not count', async () => {
    await driverLogin(undefined, undefined, { _id: OTHER_DRIVER, role: 'driver' });
    expect((await session()).body.code).toBe('DRIVER_UNAVAILABLE');
  });

  test('shares the phone calls\' rate limit (6 per 10 minutes) -> 429', async () => {
    await driverLogin();
    for (let i = 0; i < 6; i += 1) CallLog.seed({ trip: TRIP_ID, tripMasked: true, startedAt: new Date() });
    const res = await session();
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  test('PLIVO_TRIP_VOIP_APP_ID unset -> 503 NOT_CONFIGURED', async () => {
    await driverLogin();
    delete process.env.PLIVO_TRIP_VOIP_APP_ID;
    const res = await session();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  test('Plivo refuses the endpoint -> 502 PLIVO_FAILED, no log', async () => {
    await driverLogin();
    plivo.createEndpoint.mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { status: 500 } }));
    const res = await session();
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('PLIVO_FAILED');
    expect(CallLog.rows()).toHaveLength(0);
  });

  test('unknown trip -> 404', async () => {
    expect((await session(undefined, undefined, OTHER_TRIP)).statusCode).toBe(404);
    expect((await session(undefined, undefined, 'not-an-id')).statusCode).toBe(404);
  });
});

// ============================================================
describe('B. /api/calls/trip-voip-answer', () => {
  test('rings ONLY the driver\'s app endpoint: <User>, no <Number>, 25s, own action URL, same recording', async () => {
    const { s, a } = await startRinging();
    const xml = a.body;
    const driverEp = TripVoipEndpoint.rows().find((r) => r.kind === 'driver');
    expect(xml).toContain(`<User>sip:${driverEp.username}@phone.plivo.com</User>`);
    expect(xml).not.toContain('<Number>');
    expect(xml).toContain('timeout="25"');
    expect(xml).toContain(`/api/calls/trip-voip-dial?log=${s.body.callLogId}`);
    expect(xml).not.toContain('/api/calls/events');
    expect(xml).toContain(`sipHeaders="logId=${s.body.callLogId},tripId=${TRIP_ID}"`);
    expect(xml).toContain('callerName="SaveLife Customer"');
    expect(xml).toMatch(/<Record [^>]*startOnDialAnswer="true"/); // the shared bridge's recording, unchanged
    expect(xml).not.toMatch(REAL_NUMBERS);
    expect(logRow(s.body.callLogId)).toEqual(expect.objectContaining({ status: 'ringing', providerCallId: 'call-a-1' }));
  });

  test('the log id is also read from the dialled destination', async () => {
    await driverLogin();
    const s = await session();
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, To: `sip:${s.body.dialTo}@phone.plivo.com`, CallUUID: 'c' });
    expect(a.body).toContain('<Dial');
  });

  test.each([
    ['completed', 'TRIP_COMPLETED'],
    ['cancelled', 'TRIP_CANCELLED'],
  ])('trip %s after the session was issued -> "trip has ended", no Dial', async (status, code) => {
    await driverLogin();
    const s = await session();
    trips[TRIP_ID].status = status;
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId, CallUUID: 'c' });
    expect(a.body).toContain('This trip has ended, so this call cannot be connected.');
    expect(a.body).not.toContain('<Dial');
    expect(logRow(s.body.callLogId).status).toBe('blocked_trip_inactive');
    expect((await statusOf(s.body.callLogId)).body).toEqual(expect.objectContaining({ ok: false, state: 'failed', code }));
  });

  test('driver swapped after the session -> refused, the new driver is not rung either', async () => {
    await driverLogin();
    await driverLogin(undefined, undefined, { _id: OTHER_DRIVER, role: 'driver' });
    const s = await session();
    trips[TRIP_ID].driver = OTHER_DRIVER;
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId, CallUUID: 'c' });
    expect(a.body).not.toContain('<Dial');
    expect(logRow(s.body.callLogId).status).toBe('blocked_driver_changed');
    expect((await statusOf(s.body.callLogId)).body.code).toBe('DRIVER_CHANGED');
  });

  test.each([
    ['another endpoint', 'sip:sld1234567abcdef101@phone.plivo.com'],
    ['a phone number', '919986844442'],
    ['nobody', undefined],
  ])('a call from %s with a valid log id is refused', async (_l, From) => {
    await driverLogin();
    const s = await session();
    const a = await answer({ From, 'X-PH-logId': s.body.callLogId, CallUUID: 'c' });
    expect(a.body).not.toContain('<Dial');
    expect(logRow(s.body.callLogId).status).toBe('blocked_wrong_caller');
  });

  test('another trip\'s customer endpoint cannot use this trip\'s log', async () => {
    await driverLogin();
    const s = await session();
    TripVoipEndpoint.seed({ kind: 'customer', trip: OTHER_TRIP, endpointId: 'ep-x', username: 'slcother1' });
    const a = await answer({ From: 'sip:slcother1@phone.plivo.com', 'X-PH-logId': s.body.callLogId });
    expect(a.body).not.toContain('<Dial');
  });

  test('one session = one call: a replayed answer does not ring again', async () => {
    const { s } = await startRinging();
    const again = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId, CallUUID: 'call-a-2' });
    expect(again.body).not.toContain('<Dial');
    expect(logRow(s.body.callLogId).status).toBe('ringing'); // the live call is left alone
  });

  test('a session not dialled within its TTL is refused', async () => {
    await driverLogin();
    const s = await session();
    logRow(s.body.callLogId).startedAt = new Date(Date.now() - 5 * 60 * 1000);
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId });
    expect(a.body).not.toContain('<Dial');
    expect((await statusOf(s.body.callLogId)).body.code).toBe('SESSION_EXPIRED');
  });

  test('driver app went offline between session and dial -> DRIVER_UNAVAILABLE, no phone leg', async () => {
    await driverLogin();
    const s = await session();
    await run(ctrl.driverPresence, reqOf({ body: { online: false }, user: { _id: DRIVER_ID, role: 'driver' } }));
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId });
    expect(a.body).toContain('Driver is not reachable right now. Please try again.');
    expect(a.body).not.toContain('<Dial');
    expect(a.body).not.toContain('<Number>');
    expect((await statusOf(s.body.callLogId)).body).toEqual(expect.objectContaining({ ok: false, code: 'DRIVER_UNAVAILABLE' }));
  });

  test('no / unknown / non-VoIP log -> refused, nothing created', async () => {
    expect((await answer({ From: 'sip:x@phone.plivo.com' })).body).not.toContain('<Dial');
    expect((await answer({ 'X-PH-logId': '64b0000000000000000000ee' })).body).not.toContain('<Dial');
    const phoneCall = CallLog.seed({ trip: TRIP_ID, tripMasked: true, direction: 'outbound', status: 'initiated' });
    expect((await answer({ 'X-PH-logId': phoneCall._id })).body).not.toContain('<Dial');
    expect(CallLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('C. the Dial\'s outcome and the hang-up', () => {
  test('driver\'s app not answered -> driver_unavailable, spoken in-app, NO phone leg', async () => {
    const { s } = await startRinging();
    const d = await dial(s.body.callLogId, { DialStatus: 'no-answer', DialHangupCause: 'NO_ANSWER' });
    expect(d.body).toContain('Driver is not reachable right now. Please try again.');
    expect(d.body).not.toContain('<Dial');
    expect(d.body).not.toContain('<Number>');
    expect(logRow(s.body.callLogId).status).toBe('driver_unavailable');
    const st = await statusOf(s.body.callLogId);
    expect(st.body).toEqual({ success: true, callLogId: s.body.callLogId, ok: false, state: 'failed', code: 'DRIVER_UNAVAILABLE', message: 'Driver is not reachable right now. Please try again.' });
  });

  test.each(['busy', 'failed', 'timeout', ''])('DialStatus "%s" is also driver_unavailable', async (DialStatus) => {
    const { s } = await startRinging();
    await dial(s.body.callLogId, { DialStatus });
    expect(logRow(s.body.callLogId).status).toBe('driver_unavailable');
  });

  test('answered -> completed with talk time, then the hang-up only sets the end', async () => {
    const { s } = await startRinging();
    const d = await dial(s.body.callLogId, { DialStatus: 'completed', DialBLegDuration: '42', DialBLegUUID: 'b-1' });
    expect(d.body).toContain('<Hangup/>');
    await hangup({ CallUUID: 'call-a-1', Duration: '50', 'X-PH-logId': s.body.callLogId });
    expect(logRow(s.body.callLogId)).toEqual(expect.objectContaining({ status: 'completed', talkSec: 42, totalSec: 50, customerLegId: 'b-1' }));
    expect(logRow(s.body.callLogId).endedAt).toBeTruthy();
    expect((await statusOf(s.body.callLogId)).body).toEqual(expect.objectContaining({ ok: true, state: 'ended', code: 'COMPLETED' }));
  });

  test('the customer hung up while it rang -> customer_cancelled (either report first)', async () => {
    const { s } = await startRinging();
    await hangup({ CallUUID: 'call-a-1', 'X-PH-logId': s.body.callLogId });
    expect(logRow(s.body.callLogId).status).toBe('customer_cancelled');
    await dial(s.body.callLogId, { DialStatus: 'cancel' });
    expect(logRow(s.body.callLogId).status).toBe('customer_cancelled');
  });

  test('a hang-up of the driver\'s leg does not end the call; an unknown hang-up creates nothing', async () => {
    const { s } = await startRinging();
    await hangup({ CallUUID: 'driver-leg-9' });
    expect(logRow(s.body.callLogId).status).toBe('ringing');
    expect(await voip.callEnded({ CallUUID: 'nobody' })).toBe('NO_LOG');
    expect(CallLog.create).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
describe('D. the app\'s status and End', () => {
  test('End during the call hangs it up on Plivo', async () => {
    const { s } = await startRinging();
    const r = await end(s.body.callLogId);
    expect(r.body).toEqual(expect.objectContaining({ success: true, hungUp: true }));
    expect(plivo.hangupCall).toHaveBeenCalledWith('call-a-1');
  });

  test('End before dialling closes the session; it can no longer be dialled', async () => {
    await driverLogin();
    const s = await session();
    await end(s.body.callLogId);
    expect(logRow(s.body.callLogId).status).toBe('customer_cancelled');
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId });
    expect(a.body).not.toContain('<Dial');
  });

  test('status/End need the customer\'s proof and this trip\'s log', async () => {
    await driverLogin();
    const s = await session();
    expect((await statusOf(s.body.callLogId, {})).statusCode).toBe(401);
    expect((await statusOf(s.body.callLogId, { 'X-Tracking-Token': 'wrong-token-000000000000' })).statusCode).toBe(403);
    const other = CallLog.seed({ trip: OTHER_TRIP, channel: 'voip', status: 'initiated' });
    expect((await statusOf(other._id)).statusCode).toBe(404);
    expect((await statusOf(s.body.callLogId)).body).toEqual(expect.objectContaining({ ok: true, state: 'starting' }));
  });
});

// ============================================================
describe('E. trip completed / cancelled -> closeTripVoip', () => {
  test('hangs up the live call, closes pending sessions, deletes the trip\'s endpoint', async () => {
    const { s } = await startRinging();
    const pending = await session();
    trips[TRIP_ID].status = 'completed';
    const r = await voip.closeTripVoip(TRIP_ID, 'completed');
    expect(r).toEqual({ hungUp: 1, endpointDeleted: true });
    expect(plivo.hangupCall).toHaveBeenCalledWith('call-a-1');
    expect(plivo.deleteEndpoint).toHaveBeenCalledTimes(1);
    expect(customerEp()).toBeUndefined();
    expect(logRow(pending.body.callLogId).status).toBe('blocked_trip_inactive');
    // Plivo then reports the hang-up: recorded as ended by the trip, not as a customer cancel.
    await hangup({ CallUUID: 'call-a-1', 'X-PH-logId': s.body.callLogId });
    expect(logRow(s.body.callLogId).status).toBe('blocked_trip_inactive');
  });

  test('after closing, the old login cannot place a call', async () => {
    await driverLogin();
    const s = await session();
    trips[TRIP_ID].status = 'cancelled';
    await voip.closeTripVoip(TRIP_ID, 'cancelled');
    const a = await answer({ From: `sip:${s.body.username}@phone.plivo.com`, 'X-PH-logId': s.body.callLogId });
    expect(a.body).not.toContain('<Dial');
  });

  test('a connected call cut by the trip end keeps its talk time', async () => {
    const { s } = await startRinging();
    await voip.closeTripVoip(TRIP_ID, 'completed');
    await dial(s.body.callLogId, { DialStatus: 'completed', DialBLegDuration: '30' });
    expect(logRow(s.body.callLogId)).toEqual(expect.objectContaining({ status: 'completed', talkSec: 30 }));
  });

  test('never throws; a failed Plivo delete keeps the record for the sweep to retry', async () => {
    await driverLogin();
    await session();
    plivo.deleteEndpoint.mockRejectedValueOnce(Object.assign(new Error('down'), { response: { status: 503 } }));
    await expect(voip.closeTripVoip(TRIP_ID, 'completed')).resolves.toEqual({ hungUp: 0, endpointDeleted: false });
    expect(customerEp()).toBeTruthy();
    plivo.deleteEndpoint.mockRejectedValueOnce(Object.assign(new Error('gone'), { response: { status: 404 } }));
    expect((await voip.closeTripVoip(TRIP_ID, 'completed')).endpointDeleted).toBe(true);
    CallLog.find.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(voip.closeTripVoip(TRIP_ID, 'completed')).resolves.toBeDefined();
  });

  test('the sweep closes endpoints of trips that ended by any path', async () => {
    await driverLogin();
    await session();
    trips[TRIP_ID].status = 'completed';
    expect(await voip.sweepEndedTrips({ force: true })).toBe(1);
    expect(customerEp()).toBeUndefined();
  });
});

// ============================================================
describe('F. the driver app\'s login and presence', () => {
  test('needs the device key', async () => {
    const res = await driverLogin({});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('DEVICE_KEY_REQUIRED');
  });

  test('creates this device\'s endpoint on the Trip VoIP app, returns its login, marks it online', async () => {
    const res = await driverLogin({ 'X-Device-Key': DEVICE, 'X-Device-Label': 'Pixel 7' });
    expect(res.body).toEqual(expect.objectContaining({ success: true, ok: true, sipDomain: 'phone.plivo.com', onlineForSec: 720 * 60 }));
    expect(res.body.username).toMatch(/^sld/);
    expect(res.body.password).toEqual(expect.any(String));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(plivo.createEndpoint).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-trip-voip-1' }));
    const row = TripVoipEndpoint.rows()[0];
    expect(row).toEqual(expect.objectContaining({ kind: 'driver', user: DRIVER_ID, deviceKey: DEVICE, device: 'Pixel 7' }));
    expect(row.onlineAt).toBeTruthy();
  });

  test('a later login reuses it; reset=1 sets a new password; a moved app id is relinked', async () => {
    const a = await driverLogin();
    const b = await driverLogin();
    expect(b.body.username).toBe(a.body.username);
    expect(plivo.createEndpoint).toHaveBeenCalledTimes(1);
    const c = await driverLogin(undefined, { reset: '1' });
    expect(c.body.password).toBe('new-pass-xyz');
    process.env.PLIVO_TRIP_VOIP_APP_ID = 'app-trip-voip-2';
    await driverLogin();
    expect(plivo.linkEndpointToApp).toHaveBeenCalledWith('ep-1', 'app-trip-voip-2');
  });

  test('a driver keeps at most 3 devices (oldest retired, also on Plivo)', async () => {
    for (const k of ['dev-aaaa-0001', 'dev-aaaa-0002', 'dev-aaaa-0003', 'dev-aaaa-0004']) {
      await driverLogin({ 'X-Device-Key': k });
    }
    expect(TripVoipEndpoint.rows().filter((r) => r.kind === 'driver')).toHaveLength(3);
    expect(plivo.deleteEndpoint).toHaveBeenCalledWith('ep-1');
  });

  test('presence needs a boolean', async () => {
    const r = await run(ctrl.driverPresence, reqOf({ body: { online: 'yes' }, user: { _id: DRIVER_ID } }));
    expect(r.statusCode).toBe(400);
  });

  test('not configured -> 503; Plivo failure -> 502 without details', async () => {
    delete process.env.PLIVO_TRIP_VOIP_APP_ID;
    expect((await driverLogin()).statusCode).toBe(503);
    process.env.PLIVO_TRIP_VOIP_APP_ID = 'app-trip-voip-1';
    plivo.createEndpoint.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 401 } }));
    const r = await driverLogin();
    expect(r.statusCode).toBe(502);
    expect(r.body.code).toBe('PLIVO_FAILED');
  });
});

// ============================================================
describe('H. wiring, and the shared bridge unchanged', () => {
  const tripsRouter = require('../routes/trips');
  const callsRouter = require('../routes/calls');
  const callCtrl = require('../controllers/callController');
  const { protect } = require('../middleware/auth');
  const layer = (router, path, method) => router.stack.find((l) => l.route?.path === path && (l.route.methods[method] || l.route.methods._all))?.route.stack;

  test('customer routes', () => {
    expect(layer(tripsRouter, '/:id/voip/session', 'post').map((s) => s.handle)).toEqual([ctrl.session]);
    expect(layer(tripsRouter, '/:id/voip/:logId', 'get').map((s) => s.handle)).toEqual([ctrl.status]);
    expect(layer(tripsRouter, '/:id/voip/:logId/end', 'post').map((s) => s.handle)).toEqual([ctrl.end]);
  });

  test('driver routes: protect + driver role', async () => {
    for (const [p, m, h] of [['/driver-voip/login', 'get', ctrl.driverLogin], ['/driver-voip/presence', 'post', ctrl.driverPresence]]) {
      const stack = layer(callsRouter, p, m);
      expect(stack).toHaveLength(3);
      expect(stack[0].handle).toBe(protect);
      expect(stack[2].handle).toBe(h);
      const r = mockRes();
      const next = jest.fn();
      stack[1].handle({ user: { role: 'customer' } }, r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r.statusCode).toBe(403);
    }
  });

  test('webhooks: Plivo signature first', () => {
    for (const [p, h] of [['/trip-voip-answer', ctrl.answer], ['/trip-voip-dial', ctrl.dial], ['/trip-voip-hangup', ctrl.hangup]]) {
      expect(layer(callsRouter, p, 'post').map((s) => s.handle)).toEqual([callCtrl.requirePlivoSignature, h]);
    }
  });

  test('the phone-bridge webhook never bridges an in-app call\'s log', async () => {
    const row = CallLog.seed({ trip: TRIP_ID, tripMasked: true, direction: 'outbound', channel: 'voip', status: 'initiated' });
    const r = await run(tripCallCtrl.answer, reqOf({ query: { log: row._id } }));
    expect(r.body).not.toContain('<Dial');
  });

  test('bridgeXml without the new options is exactly the old XML', () => {
    const xml = plivo.bridgeXml({ numbers: ['9000000001'], sipUsers: ['crmuser1'], logId: 'L1', stage: 'app', timeout: 15 });
    expect(xml).toContain('action="https://api.savelife.health/api/calls/events?log=L1&amp;leg=dial&amp;stage=app"');
    expect(xml).toContain('sipHeaders="logId=L1"');
    expect(xml).not.toContain('callerName');
    expect(xml).toContain('<Dial callerId="918065591088" action=');
    expect(plivo.hangupXml()).toContain('<Hangup/>');
  });
});
