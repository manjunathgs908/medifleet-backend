/**
 * tests/calls.test.js
 * ============================================================
 * Plivo masked calling (controllers/callController.js).
 *
 *   - a driver can only reach the customer of a live trip assigned to
 *     them; a fleet owner only on their own ambulances; CRM staff anyone
 *   - Plivo rings the AGENT first, and only the call-log id travels in
 *     Plivo's URLs; the customer's number is in no response
 *   - /answer bridges to the customer from the company number, recorded,
 *     and only for a request carrying Plivo's signature
 *   - incoming calls ring every CRM user on call duty, masked and recorded
 *   - Plivo failures (trial account) come back as a clear message
 *
 * Models and the Plivo SDK are mocked — no database, no calls placed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';

const crypto = require('crypto');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'limit']) q[m] = () => q;
  return q;
};

jest.mock('../models', () => ({
  Trip: { findOne: jest.fn() },
  Lead: { findById: jest.fn(), findOne: jest.fn() },
  User: { find: jest.fn(), updateOne: jest.fn(), findById: jest.fn() },
}));
jest.mock('../models/Ambulance', () => ({ exists: jest.fn() }));
jest.mock('../models/Quote', () => ({ findById: jest.fn() }));
jest.mock('../models/WhatsAppLead', () => ({ findById: jest.fn() }));
jest.mock('../models/CallLog', () => ({
  create: jest.fn(), findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../services/exotelService', () => ({ connectCall: jest.fn() }));
jest.mock('../models/WebrtcDebugEvent', () => ({
  insertMany: jest.fn(async (docs) => docs),
  create    : jest.fn(async (doc) => doc),
  find      : jest.fn(),
}));
jest.mock('../models/WebrtcEndpoint', () => ({
  find          : jest.fn(),
  findOne       : jest.fn(),
  create        : jest.fn(),
  updateOne     : jest.fn(),
  updateMany    : jest.fn(),
  deleteOne     : jest.fn(),
  countDocuments: jest.fn(),
}));
// Only .get is replaced: the real Plivo SDK (kept for its signature check)
// configures axios when it loads.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  actual.get = jest.fn();
  actual.request = jest.fn(); // Plivo REST: endpoints, number lookup, JWT
  return actual;
});

const mockCreateCall = jest.fn();
jest.mock('plivo', () => {
  const actual = jest.requireActual('plivo');
  return {
    ...actual,
    Client: jest.fn(() => ({ calls: { create: mockCreateCall } })),
  };
});

const axios = require('axios');
const { Trip, User } = require('../models');
const Ambulance = require('../models/Ambulance');
const CallLog = require('../models/CallLog');
const ctrl = require('../controllers/callController');
const { customerRef } = require('../utils/customerPhone');

const CUSTOMER = '9986844442';
const DRIVER_PHONE = '9123456789';

function mockRes() {
  const res = { statusCode: 200, body: null, contentType: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
const run = async (handler, req) => {
  const res = mockRes();
  const next = jest.fn();
  await handler({ body: {}, query: {}, params: {}, get: () => undefined, ...req }, res, next);
  if (next.mock.calls.length && next.mock.calls[0][0]) throw next.mock.calls[0][0];
  return { res, next };
};

function logDoc(over = {}) {
  return { _id: '64b000000000000000000001', direction: 'outbound', save: jest.fn(async function () { return this; }), ...over };
}

const driver = { _id: 'drv1', role: 'driver', name: 'Ravi', phone: DRIVER_PHONE };
const staff  = { _id: 'stf1', role: 'owner', name: 'Desk', phone: '9000000001' };

beforeEach(() => {
  jest.clearAllMocks();
  CallLog.create.mockImplementation(async (data) => logDoc(data));
  mockCreateCall.mockResolvedValue({ requestUuid: 'req-1' });
  // No per-device endpoints unless a test sets some up.
  const WebrtcEndpoint = require('../models/WebrtcEndpoint');
  WebrtcEndpoint.find.mockReturnValue(chain([]));
  WebrtcEndpoint.countDocuments.mockResolvedValue(0);
});

// ─────────────────────────────────────────────────────────────
describe('click-to-call', () => {
  const activeTrip = (over = {}) => ({ _id: 't1', patientPhone: CUSTOMER, driver: 'drv1', status: 'en_route', ...over });

  it('rings the DRIVER first, from the company number, with only the log id in the URLs', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip()));

    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });

    expect(res.statusCode).toBe(200);
    const [from, to, answerUrl, params] = mockCreateCall.mock.calls[0];
    expect(from).toBe('918065591088');
    expect(to).toBe(`91${DRIVER_PHONE}`);
    expect(answerUrl).toBe('https://api.savelife.health/api/calls/answer?log=64b000000000000000000001');
    expect(JSON.stringify([answerUrl, params])).not.toContain(CUSTOMER);
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      customerPhone: CUSTOMER, agentType: 'driver', context: 'trip', trip: 't1',
    }));
    expect(JSON.stringify(res.body)).not.toContain(CUSTOMER);
  });

  it('refuses a driver calling the customer of someone else\'s trip', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip({ driver: 'other' })));
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });
    expect(res.statusCode).toBe(403);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('refuses a driver once the trip is over', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip({ status: 'completed' })));
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });
    expect(res.statusCode).toBe(400);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('a driver cannot reach anyone by ref or lead, only through their trip', async () => {
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { customerRef: customerRef(CUSTOMER) } });
    expect(res.statusCode).toBe(400);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('a fleet owner only reaches trips on their own ambulances', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip({ ambulance: 'amb1' })));
    Ambulance.exists.mockResolvedValue(null);
    const { res } = await run(ctrl.clickToCall, {
      user: { _id: 'own1', role: 'owner', name: 'Partner', phone: '9000000002' },
      actorType: 'owner',
      body: { tripId: 't1' },
    });
    expect(res.statusCode).toBe(404);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('CRM staff can call by the opaque customer ref', async () => {
    const { res } = await run(ctrl.clickToCall, { user: staff, body: { customerRef: customerRef('919986844442') } });
    expect(res.statusCode).toBe(200);
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({ customerPhone: CUSTOMER, agentType: 'staff' }));
  });

  it('explains a Plivo trial refusal plainly and logs the failure', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip()));
    mockCreateCall.mockRejectedValue(new Error('This number is not verified for this trial account'));

    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });

    expect(res.statusCode).toBe(502);
    expect(res.body.message).toMatch(/free trial/);
    const log = await CallLog.create.mock.results[0].value;
    expect(log.status).toBe('failed');
    expect(log.save).toHaveBeenCalled();
  });

  it('never falls back to Exotel — that would show the customer the Exotel number', async () => {
    const saved = process.env.PLIVO_AUTH_ID;
    delete process.env.PLIVO_AUTH_ID;
    process.env.EXOTEL_SID = 'sid';
    process.env.EXOTEL_API_KEY = 'key';
    Trip.findOne.mockReturnValue(chain(activeTrip()));
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });
    process.env.PLIVO_AUTH_ID = saved;
    delete process.env.EXOTEL_SID;
    delete process.env.EXOTEL_API_KEY;
    expect(res.statusCode).toBe(503);
    expect(require('../services/exotelService').connectCall).not.toHaveBeenCalled();
    expect(CallLog.create).not.toHaveBeenCalled();
  });

  it('refuses to call with a malformed PLIVO_NUMBER rather than show customers anything else', async () => {
    const saved = process.env.PLIVO_NUMBER;
    process.env.PLIVO_NUMBER = '8065591088'; // missing the 91
    Trip.findOne.mockReturnValue(chain(activeTrip()));
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });
    process.env.PLIVO_NUMBER = saved;
    expect(res.statusCode).toBe(503);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('records which provider and caller ID handled the call', async () => {
    Trip.findOne.mockReturnValue(chain(activeTrip()));
    const { res } = await run(ctrl.clickToCall, { user: driver, body: { tripId: 't1' } });
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({ provider: 'plivo', callerId: '918065591088' }));
    expect(res.body).toEqual(expect.objectContaining({ provider: 'plivo', callerId: '918065591088' }));
  });

  it('rings the user\'s own call ring number, not their login number', async () => {
    const { res } = await run(ctrl.clickToCall, {
      user: { ...staff, phone: '8884092777', callPhone: '9876500000' },
      body: { customerRef: customerRef(CUSTOMER) },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateCall.mock.calls[0][0]).toBe('918065591088');
    expect(mockCreateCall.mock.calls[0][1]).toBe('919876500000');
  });
});

// ─────────────────────────────────────────────────────────────
describe('answer', () => {
  it('bridges to the customer from the company number, recorded', async () => {
    const log = logDoc({ customerPhone: CUSTOMER });
    CallLog.findById.mockReturnValue(chain(log));

    const { res } = await run(ctrl.answer, {
      method: 'POST', query: { log: '64b000000000000000000001' }, body: { CallUUID: 'ca-1' },
    });

    expect(res.contentType).toBe('text/xml');
    expect(res.body).toContain(`<Number>91${CUSTOMER}</Number>`);
    expect(res.body).toContain('callerId="918065591088"');
    expect(res.body).toMatch(/<Record [^>]*startOnDialAnswer="true"/);
    expect(res.body.indexOf('<Record')).toBeLessThan(res.body.indexOf('<Dial'));
    expect(log.status).toBe('agent_answered');
    expect(log.providerCallId).toBe('ca-1');
  });

  it('dials the driver when the customer started it (legacy tracking-page call), still from the company number', async () => {
    const log = logDoc({ firstLeg: 'customer', customerPhone: CUSTOMER, agentPhone: DRIVER_PHONE });
    CallLog.findById.mockReturnValue(chain(log));
    const { res } = await run(ctrl.answer, { method: 'POST', query: { log: '64b000000000000000000001' } });
    expect(res.body).toContain(`<Number>91${DRIVER_PHONE}</Number>`);
    expect(res.body).not.toContain(CUSTOMER);
    expect(res.body).toContain('callerId="918065591088"');
  });

  it('never dials for an unknown call', async () => {
    CallLog.findById.mockReturnValue(chain(null));
    const { res } = await run(ctrl.answer, { method: 'POST', query: { log: '64b000000000000000000009' } });
    expect(res.body).not.toContain('<Dial');
    expect(res.body).toContain('<Hangup/>');
  });
});

// ─────────────────────────────────────────────────────────────
// Plivo's V3 scheme, written out independently of the SDK so the test
// would catch the middleware validating the wrong URL or parameters.
function sign(url, params, nonce, token) {
  const keys = Object.keys(params).sort();
  const body = keys.map((k) => `${k}${params[k]}`).join('');
  const [base, query] = url.split('?');
  const sortedQuery = query ? query.split('&').sort().join('&') : '';
  // A POST with parameters always gets the '?', even with no query string.
  let signed = (sortedQuery || keys.length) ? `${base}?${sortedQuery}` : base;
  if (sortedQuery && keys.length) signed += '.';
  signed += body;
  return crypto.createHmac('sha256', token).update(`${signed}.${nonce}`).digest('base64');
}

describe('Plivo signature', () => {
  const body = { CallUUID: 'ca-1', From: '918065591088' };
  const req = (headers) => ({
    method: 'POST',
    originalUrl: '/api/calls/answer?log=64b000000000000000000001',
    body,
    get: (h) => headers[h],
  });

  it('lets a request Plivo signed through', async () => {
    const url = 'https://api.savelife.health/api/calls/answer?log=64b000000000000000000001';
    const headers = {
      'X-Plivo-Signature-V3'      : sign(url, body, 'n-1', 'plivo-test-token'),
      'X-Plivo-Signature-V3-Nonce': 'n-1',
    };
    const res = mockRes();
    const next = jest.fn();
    ctrl.requirePlivoSignature(req(headers), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('turns away anything else, so nobody can fetch a customer\'s number from /answer', () => {
    const res = mockRes();
    const next = jest.fn();
    ctrl.requirePlivoSignature(req({ 'X-Plivo-Signature-V3': 'forged', 'X-Plivo-Signature-V3-Nonce': 'n-1' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);

    const res2 = mockRes();
    ctrl.requirePlivoSignature(req({}), res2, next);
    expect(res2.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────
describe('incoming', () => {
  beforeEach(() => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
  });

  it('rings everyone on call duty at once, from the company number, recorded', async () => {
    User.find.mockReturnValue(chain([{ phone: '9000000001' }, { phone: '9000000002' }]));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'in-1' } });

    expect(res.body).toContain('<Number>919000000001</Number><Number>919000000002</Number>');
    expect(res.body).toContain('callerId="918065591088"');
    expect(res.body).toContain('<Record ');
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      direction: 'inbound', customerPhone: CUSTOMER, status: 'ringing', callerId: '918065591088',
    }));
  });

  it('rings each on-duty user\'s call ring number when they have one', async () => {
    User.find.mockReturnValue(chain([{ phone: '8884092777', callPhone: '9876500000' }, { phone: '9000000002' }]));
    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442' } });
    expect(res.body).toContain('<Number>919876500000</Number><Number>919000000002</Number>');
    expect(res.body).not.toContain('8884092777');
  });

  it('tells the caller everyone is busy when nobody is on duty', async () => {
    User.find.mockReturnValue(chain([]));
    delete process.env.PLIVO_FALLBACK_AGENTS;

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442' } });

    expect(res.body).toContain('<Speak');
    expect(res.body).not.toContain('<Dial');
    expect(CallLog.create.mock.calls[0][0].status).toBe('no_agents');
  });
});

// ─────────────────────────────────────────────────────────────
describe('events and recording', () => {
  it('records talk time when the customer leg completes', async () => {
    const log = logDoc({ status: 'agent_answered' });
    CallLog.findById.mockResolvedValue(log);

    const { res } = await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial' },
      body: { DialStatus: 'completed', DialBLegDuration: '95' },
    });

    expect(log.status).toBe('completed');
    expect(log.talkSec).toBe(95);
    expect(res.body).toContain('<Hangup/>');
  });

  it('marks an outbound call the agent never answered', async () => {
    const log = logDoc({ status: 'initiated' });
    CallLog.findById.mockResolvedValue(log);

    await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001' },
      body: { CallStatus: 'no-answer', Duration: '0' },
    });

    expect(log.status).toBe('agent_missed');
    expect(log.endedAt).toBeInstanceOf(Date);
  });

  it('stores the recording URL (server-side only)', async () => {
    await run(ctrl.recording, {
      method: 'POST', query: { log: '64b000000000000000000001' },
      body: { RecordUrl: 'https://media.plivo.com/rec.mp3', RecordingID: 'r1', RecordingDuration: '95' },
    });
    expect(CallLog.updateOne).toHaveBeenCalledWith(
      { _id: '64b000000000000000000001' },
      { $set: { recordingUrl: 'https://media.plivo.com/rec.mp3', recordingId: 'r1', recordingSec: 95 } },
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('recording playback', () => {
  const LOG_ID = '64b000000000000000000001';
  const PLIVO_URL = 'https://media.plivo.com/v1/Account/MAXXX/Recording/r1.mp3';

  const streamRes = () => {
    const res = mockRes();
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.on = jest.fn();
    res.destroy = jest.fn();
    return res;
  };
  const upstream = (status, headers = {}) => ({
    status,
    headers,
    data: { pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() },
  });

  it('fetches from Plivo with Basic Auth and streams it, never sending the URL', async () => {
    CallLog.findById.mockReturnValue(chain({ recordingUrl: PLIVO_URL, status: 'completed' }));
    const up = upstream(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-99/1000', 'x-plivo': 'no' });
    axios.get.mockResolvedValue(up);

    const res = streamRes();
    const next = jest.fn();
    await ctrl.streamRecording({ params: { id: LOG_ID }, get: (h) => (h === 'range' ? 'bytes=0-99' : undefined) }, res, next);

    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toBe(PLIVO_URL);
    expect(opts.auth).toEqual({ username: 'MAXXXXXXXXXXXXXXXXXX', password: 'plivo-test-token' });
    expect(opts.headers).toEqual({ Range: 'bytes=0-99' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/1000');
    expect(res.headers['x-plivo']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(up.data.pipe).toHaveBeenCalledWith(res);
    expect(JSON.stringify(res.headers)).not.toContain('plivo.com');
  });

  it('never sends our credentials to a host that is not Plivo', async () => {
    CallLog.findById.mockReturnValue(chain({ recordingUrl: 'https://evil.example.com/r.mp3', status: 'completed' }));
    const res = streamRes();
    await ctrl.streamRecording({ params: { id: LOG_ID }, get: () => undefined }, res, jest.fn());
    expect(res.statusCode).toBe(502);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('404s a call with no recording', async () => {
    CallLog.findById.mockReturnValue(chain({}));
    const res = streamRes();
    await ctrl.streamRecording({ params: { id: LOG_ID }, get: () => undefined }, res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  it('explains a Plivo auth refusal instead of streaming an error page', async () => {
    CallLog.findById.mockReturnValue(chain({ recordingUrl: PLIVO_URL, status: 'completed' }));
    const up = upstream(401);
    axios.get.mockResolvedValue(up);
    const res = streamRes();
    await ctrl.streamRecording({ params: { id: LOG_ID }, get: () => undefined }, res, jest.fn());
    expect(res.statusCode).toBe(502);
    expect(res.body.message).toMatch(/PLIVO_AUTH_ID/);
    expect(up.data.pipe).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('own call settings', () => {
  it('shows what Plivo rings and what customers see', async () => {
    const { res } = await run(ctrl.getMe, { user: { phone: '8884092777', callPhone: '9876500000', callDuty: true } });
    expect(res.body.me).toEqual(expect.objectContaining({
      ringPhone: '9876500000', loginPhone: '8884092777', usingLogin: false, onDuty: true, callerId: '918065591088',
    }));
  });

  it('saves a valid ring number, separately from the login number', async () => {
    User.findByIdAndUpdate = jest.fn(() => chain({ phone: '8884092777', callPhone: '9876500000' }));
    const { res } = await run(ctrl.setMe, { user: { _id: 'u1' }, body: { callPhone: '+91 98765 00000' } });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('u1', { $set: { callPhone: '9876500000' } }, expect.anything());
    expect(res.body.me.ringPhone).toBe('9876500000');
  });

  it('rejects a number that is not an Indian mobile', async () => {
    User.findByIdAndUpdate = jest.fn();
    const { res } = await run(ctrl.setMe, { user: { _id: 'u1' }, body: { callPhone: '12345' } });
    expect(res.statusCode).toBe(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('reports the live provider and caller ID', async () => {
    const { res } = await run(ctrl.getConfig, {});
    expect(res.body).toEqual(expect.objectContaining({ provider: 'plivo', callerId: '918065591088', legacyExotelActive: false }));
  });
});

// ─────────────────────────────────────────────────────────────
describe('incoming calls always reach the CRM log', () => {
  const body = { CallUUID: 'in-9', From: '919986844442', To: '918065591088', Direction: 'inbound' };
  const signedReq = (url, path) => ({
    method: 'POST', originalUrl: path, path: '/incoming', body, query: {},
    get: (h) => ({
      'X-Plivo-Signature-V3'      : sign(url, body, 'n-2', 'plivo-test-token'),
      'X-Plivo-Signature-V3-Nonce': 'n-2',
    })[h],
  });

  it('accepts Plivo\'s signature when the console URL has a trailing slash', () => {
    const next = jest.fn();
    const req = signedReq('https://api.savelife.health/api/calls/incoming/', '/api/calls/incoming');
    ctrl.requirePlivoSignature(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('counts every hit and records WHY one was rejected', () => {
    const before = ctrl.webhookStats.incoming.rejected;
    const res = mockRes();
    ctrl.requirePlivoSignature({
      method: 'POST', originalUrl: '/api/calls/incoming', path: '/incoming', body, query: {},
      get: () => undefined,
    }, res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(ctrl.webhookStats.incoming.rejected).toBe(before + 1);
    expect(ctrl.webhookStats.incoming.lastRejectReason).toMatch(/no X-Plivo-Signature-V3/);
    expect(ctrl.webhookStats.incoming.lastHitAt).toBeInstanceOf(Date);
  });

  it('logs an incoming call from its hangup when /incoming never ran for it', async () => {
    CallLog.findOne.mockResolvedValue(null);
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));

    await run(ctrl.events, {
      method: 'POST', query: {},
      body: { ...body, CallStatus: 'completed', Duration: '42', HangupCause: 'NORMAL_CLEARING' },
    });

    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      direction: 'inbound', status: 'not_routed', customerPhone: CUSTOMER, providerCallId: 'in-9',
      callerId: '918065591088', totalSec: 42,
    }));
  });

  it('reads Plivo\'s fields from the query when the console is set to GET', async () => {
    User.find.mockReturnValue(chain([{ phone: '9000000001' }]));
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));

    await run(ctrl.incoming, { method: 'GET', query: { From: '919986844442', CallUUID: 'in-get' }, body: {} });

    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      customerPhone: CUSTOMER, providerCallId: 'in-get', direction: 'inbound',
    }));
  });
});

// ─────────────────────────────────────────────────────────────
describe('in-app (WebRTC) calling', () => {
  const now = () => new Date();
  const stale = () => new Date(Date.now() - 5 * 60 * 1000);

  it('rings in the app only while it is open; otherwise falls back to the phone', () => {
    const { sipUsers, phones } = ctrl.routeIncoming([
      { callMode: 'app',   plivoEndpointUsername: 'slaaaa1', appOnlineAt: now(),   phone: '9000000001' },
      { callMode: 'app',   plivoEndpointUsername: 'slbbbb2', appOnlineAt: stale(), phone: '9000000002' },
      { callMode: 'app',   plivoEndpointUsername: null,      appOnlineAt: now(),   phone: '9000000003' },
      { callMode: 'phone', plivoEndpointUsername: 'slcccc4', appOnlineAt: now(),   phone: '9000000004', callPhone: '9876500000' },
    ]);
    expect(sipUsers).toEqual(['slaaaa1']);
    expect(phones).toEqual(['9000000002', '9000000003', '9876500000']);
  });

  const mixedDuty = () => [
    { callMode: 'app', plivoEndpointUsername: 'slaaaa1', appOnlineAt: now(), phone: '9000000001' },
    { callMode: 'phone', phone: '9000000002' },
  ];

  it('stage 1: rings only the in-app endpoints, for 15 seconds, with the call id as a SIP header', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain(mixedDuty()));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'in-app' } });

    expect(res.body).toContain('<User>sip:slaaaa1@phone.plivo.com</User>');
    expect(res.body).not.toContain('<Number>');
    expect(res.body).toContain('timeout="15"');
    expect(res.body).toContain('stage=app');
    expect(res.body).toContain('sipHeaders="logId=64b000000000000000000001"');
    expect(res.body).toContain('callerId="918065591088"');
    expect(res.body).toContain('<Record ');
  });

  // The guarantee: whatever the in-app leg reports — or nothing at all —
  // the next thing is every on-duty phone ringing, never a dropped caller.
  it.each([['no-answer'], ['busy'], ['failed'], ['timeout'], ['cancel'], ['']])(
    'stage 2: an in-app leg ending "%s" rings every on-duty phone, recorded, from the company number',
    async (dialStatus) => {
      const log = logDoc({ direction: 'inbound', status: 'ringing' });
      CallLog.findById.mockResolvedValue(log);
      User.find.mockReturnValue(chain(mixedDuty()));

      const { res } = await run(ctrl.events, {
        method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'app' },
        body: { DialStatus: dialStatus, DialBLegHangupCause: 'USER_NOT_REGISTERED' },
      });

      expect(res.body).toContain('<Number>919000000001</Number><Number>919000000002</Number>');
      expect(res.body).not.toContain('<User>');
      expect(res.body).toContain('callerId="918065591088"');
      expect(res.body).toMatch(/<Record [^>]*startOnDialAnswer="true"/);
      expect(res.body).toContain('stage=phone');
      expect(res.body).not.toContain('<Speak');
      expect(log.status).toBe('ringing');
    },
  );

  it('an answered in-app leg ends the call normally, no phones rung', async () => {
    const log = logDoc({ direction: 'inbound', status: 'ringing' });
    CallLog.findById.mockResolvedValue(log);
    const { res } = await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'app' },
      body: { DialStatus: 'completed', DialBLegDuration: '30' },
    });
    expect(res.body).toContain('<Hangup/>');
    expect(log.status).toBe('completed');
    expect(User.find).not.toHaveBeenCalled();
  });

  it('with nobody online in the app, phones ring straight away', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([
      { callMode: 'app', plivoEndpointUsername: 'slaaaa1', appOnlineAt: stale(), phone: '9000000001' },
      { callMode: 'phone', phone: '9000000002' },
    ]));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'in-off' } });

    expect(res.body).toContain('<Number>919000000001</Number><Number>919000000002</Number>');
    expect(res.body).not.toContain('<User>');
    expect(res.body).toContain('stage=phone');
  });

  // A fake Plivo REST API: answers by method + path, records every call.
  const USER_ID = '64b0000000000000000000aa';
  const APP_URI = '/v1/Account/MAXXXXXXXXXXXXXXXXXX/Application/29986316244302815/';
  const fakePlivo = ({ endpoints = [], application = APP_URI, jwt = 'plivo.issued.jwt', endpointRecord } = {}) => {
    // Plivo's record of each endpoint id, as created or listed.
    const known = Object.fromEntries(endpoints.map((e) => [e.endpoint_id, e.username]));
    axios.request.mockImplementation(async ({ method, url, data }) => {
      const path = url.replace('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX', '');
      const one = path.match(/^\/Endpoint\/([^/?]+)\/$/);
      if (method === 'get' && one) {
        return { data: endpointRecord || { endpoint_id: one[1], username: known[one[1]] || 'slexisting123', application: APP_URI, sip_registered: 'true', sip_user_agent: 'plivo-browser-sdk' } };
      }
      if (method === 'post' && one) return { data: { message: 'changed' } };
      if (method === 'get' && path.startsWith('/Endpoint/')) return { data: { meta: { next: null }, objects: endpoints } };
      if (method === 'post' && path === '/Endpoint/') {
        known.ep1 = `${data.username}123`;
        return { data: { endpoint_id: 'ep1', username: known.ep1, alias: data.alias } };
      }
      if (method === 'get' && path === '/Number/918065591088/') return { data: { number: '918065591088', application } };
      if (method === 'post' && path === '/JWT/Token/') return { data: { api_id: 'x', token: jwt } };
      throw new Error(`unexpected Plivo call ${method} ${path}`);
    });
  };
  const restCalls = (method, path) => axios.request.mock.calls
    .map(([c]) => c).filter((c) => c.method === method && c.url.endsWith(path));

  it('creates the endpoint with a Plivo-safe alias and username, whatever the user is called', async () => {
    fakePlivo();
    const userDoc = { _id: USER_ID, name: 'Manjunath gs', save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));

    const { res } = await run(ctrl.webrtcToken, { user: { _id: USER_ID } });

    expect(res.statusCode).toBe(200);
    const created = restCalls('post', '/Endpoint/')[0].data;
    expect(created.alias).toBe(`savelife-${USER_ID}`);
    expect(created.alias).toMatch(/^[A-Za-z0-9.+@_-]+$/);
    expect(created.username).toMatch(/^[a-z0-9]+$/);
    expect(created.alias).not.toContain('Manjunath');
    expect(created.app_id).toBe('29986316244302815');
    expect(userDoc.plivoEndpointUsername).toBe(`${created.username}123`);
    expect(userDoc.plivoEndpointPassword).toBe(created.password);
    expect(userDoc.save).toHaveBeenCalled();
  });

  it('gets the token from Plivo\'s JWT API, receive-only, for the endpoint, with the app id', async () => {
    fakePlivo({ jwt: 'issued-by-plivo' });
    User.findById.mockReturnValue(chain({ _id: USER_ID, plivoEndpointUsername: 'slexisting123', save: jest.fn() }));

    const { res } = await run(ctrl.webrtcToken, { user: { _id: USER_ID } });

    expect(res.body).toEqual(expect.objectContaining({ success: true, token: 'issued-by-plivo' }));
    const [jwtCall] = restCalls('post', '/JWT/Token/');
    expect(jwtCall.auth).toEqual({ username: 'MAXXXXXXXXXXXXXXXXXX', password: 'plivo-test-token' });
    expect(jwtCall.data).toEqual(expect.objectContaining({
      iss: 'MAXXXXXXXXXXXXXXXXXX',
      sub: 'slexisting123',
      per: { voice: { incoming_allow: true, outgoing_allow: false } },
      app: '29986316244302815',
    }));
    expect(jwtCall.data.exp - jwtCall.data.nbf).toBe(3600);
    expect(restCalls('post', '/Endpoint/')).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('checks the endpoint against Plivo: corrects the username to Plivo\'s, re-links the app, reports lengths only', async () => {
    fakePlivo({ endpointRecord: { endpoint_id: 'ep1', username: 'slexisting123456', application: null, sip_registered: 'false' } });
    const userDoc = { _id: USER_ID, plivoEndpointId: 'ep1', plivoEndpointUsername: 'slexisting123', save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));

    const { res } = await run(ctrl.webrtcToken, { user: { _id: USER_ID } });

    expect(res.body.endpointCheck).toEqual(expect.objectContaining({
      storedLength: 13, plivoLength: 16, match: false, usernameCorrected: true,
      appRelinked: true, appMatches: true, sipRegistered: false,
    }));
    expect(userDoc.plivoEndpointUsername).toBe('slexisting123456');
    expect(restCalls('post', '/Endpoint/ep1/')[0].data).toEqual({ app_id: '29986316244302815' });
    // The token is signed for Plivo's exact username.
    expect(restCalls('post', '/JWT/Token/')[0].data.sub).toBe('slexisting123456');
    expect(JSON.stringify(res.body.endpointCheck)).not.toContain('slexisting');
  });

  it('records the routing decision and Plivo\'s verdict on the in-app leg on the call log', async () => {
    const log = logDoc({
      direction: 'inbound', status: 'ringing',
      routing: { appUsers: [{ sipUri: 'sip:slaaaa1@phone.plivo.com', dialled: true, appOnline: true }] },
    });
    CallLog.findById.mockResolvedValue(log);
    User.find.mockReturnValue(chain(mixedDuty()));

    await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'app' },
      body: { DialStatus: 'failed', DialHangupCause: 'USER_NOT_REGISTERED', DialBLegTo: '919000000001', DialALegUUID: 'a1' },
    });

    expect(log.appLeg).toEqual(expect.objectContaining({
      sipUris: ['sip:slaaaa1@phone.plivo.com'],
      DialStatus: 'failed', DialHangupCause: 'USER_NOT_REGISTERED', DialALegUUID: 'a1',
      fellBackToPhones: 2,
    }));
    expect(log.appLeg.DialBLegTo).toBe('••••••0001'); // numbers masked
  });

  it('stores the routing decision when a call comes in', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([
      { _id: 'u1', name: 'A', callMode: 'app', plivoEndpointUsername: 'slaaaa1', appOnlineAt: now(), phone: '9000000001' },
      { _id: 'u2', name: 'B', callMode: 'app', plivoEndpointUsername: 'slbbbb2', appOnlineAt: stale(), phone: '9000000002' },
    ]));

    await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'diag' } });

    const { routing } = CallLog.create.mock.calls[0][0];
    expect(routing.decision).toBe('app_then_phone');
    expect(routing.appUsers).toEqual([
      expect.objectContaining({ name: 'A', appOnline: true, dialled: true, sipUri: 'sip:slaaaa1@phone.plivo.com' }),
      expect.objectContaining({ name: 'B', appOnline: false, dialled: false }),
    ]);
    expect(JSON.stringify(routing)).not.toMatch(/900000000/);
  });

  it('login mode defaults to password (the only login Plivo registers for us)', async () => {
    delete process.env.PLIVO_WEBRTC_LOGIN;
    fakePlivo();
    User.findById.mockReturnValue(chain({ _id: USER_ID, plivoEndpointId: 'ep1', plivoEndpointUsername: 'slexisting123', plivoEndpointPassword: 'stored-pw', save: jest.fn() }));
    const { res } = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: {} });
    expect(res.body).toEqual(expect.objectContaining({ mode: 'password', username: 'slexisting123', password: 'stored-pw' }));
  });

  it('token mode, by flag or by request, hands out no credentials', async () => {
    process.env.PLIVO_WEBRTC_LOGIN = 'token';
    const byEnv = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: {} });
    delete process.env.PLIVO_WEBRTC_LOGIN;
    const byRequest = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: { mode: 'token' } });
    expect(byEnv.res.body).toEqual({ success: true, mode: 'token' });
    expect(byRequest.res.body).toEqual({ success: true, mode: 'token' });
  });

  it('reset=1 sets a new password on Plivo even when one is stored, and never logs it', async () => {
    fakePlivo();
    const userDoc = { _id: USER_ID, plivoEndpointId: 'ep1', plivoEndpointUsername: 'slexisting123', plivoEndpointPassword: 'old-pw', save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));
    const logged = [];
    const spies = ['info', 'warn', 'error', 'log'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logged.push(a.join(' '))));

    const { res } = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: { reset: '1' } });
    spies.forEach((s) => s.mockRestore());

    const reset = restCalls('post', '/Endpoint/ep1/').find((c) => c.data.password);
    expect(reset.data.password).not.toBe('old-pw');
    expect(userDoc.plivoEndpointPassword).toBe(reset.data.password);
    expect(res.body.password).toBe(reset.data.password);
    expect(logged.join('\n')).not.toContain(reset.data.password);
  });

  it('password mode gives the user their OWN endpoint username and password', async () => {
    fakePlivo();
    const userDoc = { _id: USER_ID, plivoEndpointId: 'ep1', plivoEndpointUsername: 'slexisting123', plivoEndpointPassword: 'stored-pw', save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));

    const { res } = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: { mode: 'password' } });

    expect(res.body).toEqual(expect.objectContaining({ mode: 'password', username: 'slexisting123', password: 'stored-pw' }));
    expect(User.findById).toHaveBeenCalledWith(USER_ID);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('password mode resets and stores a password Plivo never gave us', async () => {
    fakePlivo();
    const userDoc = { _id: USER_ID, plivoEndpointId: 'ep1', plivoEndpointUsername: 'slexisting123', save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));
    process.env.PLIVO_WEBRTC_LOGIN = 'password';

    const { res } = await run(ctrl.webrtcLogin, { user: { _id: USER_ID }, query: {} });
    delete process.env.PLIVO_WEBRTC_LOGIN;

    const reset = restCalls('post', '/Endpoint/ep1/').find((c) => c.data.password);
    expect(reset).toBeTruthy();
    expect(userDoc.plivoEndpointPassword).toBe(reset.data.password);
    expect(res.body.password).toBe(reset.data.password);
  });

  it('reuses an endpoint Plivo already has for this user instead of making another', async () => {
    fakePlivo({ endpoints: [{ alias: `savelife-${USER_ID}`, username: 'slfound999', endpoint_id: 'ep9' }] });
    const userDoc = { _id: USER_ID, save: jest.fn() };
    User.findById.mockReturnValue(chain(userDoc));

    await run(ctrl.webrtcToken, { user: { _id: USER_ID } });

    expect(restCalls('post', '/Endpoint/')).toHaveLength(0);
    expect(userDoc.plivoEndpointUsername).toBe('slfound999');
  });

  it('records who answered in the app; a second claim changes nothing', async () => {
    CallLog.findOneAndUpdate = jest.fn().mockResolvedValueOnce({ _id: 'l1' }).mockResolvedValueOnce(null);
    const first  = await run(ctrl.markAnswered, { params: { id: '64b000000000000000000001' }, user: { _id: 'u1', name: 'A' } });
    const second = await run(ctrl.markAnswered, { params: { id: '64b000000000000000000001' }, user: { _id: 'u2', name: 'B' } });
    expect(CallLog.findOneAndUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({ agentUser: { $exists: false } }));
    expect(first.res.body.claimed).toBe(true);
    expect(second.res.body.claimed).toBe(false);
  });

  it('presence check-ins mark the app open; leaving clears it', async () => {
    await run(ctrl.webrtcPresence, { user: { _id: 'u1' }, body: { online: true } });
    expect(User.updateOne.mock.calls[0][1]).toEqual({ $set: { appOnlineAt: expect.any(Date) } });
    await run(ctrl.webrtcPresence, { user: { _id: 'u1' }, body: { online: false } });
    expect(User.updateOne.mock.calls[1][1]).toEqual({ $unset: { appOnlineAt: 1 } });
  });

  it('lets a user choose to ring in the app', async () => {
    User.findByIdAndUpdate = jest.fn(() => chain({ phone: '9000000001', callMode: 'app' }));
    const { res } = await run(ctrl.setMe, { user: { _id: 'u1' }, body: { callMode: 'app' } });
    expect(User.findByIdAndUpdate.mock.calls[0][1]).toEqual({ $set: { callMode: 'app' } });
    expect(res.body.me.callMode).toBe('app');
    const bad = await run(ctrl.setMe, { user: { _id: 'u1' }, body: { callMode: 'carrier-pigeon' } });
    expect(bad.res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────
describe('in-app token errors', () => {
  it('logs Plivo\'s full error but sends the browser only the stage and status', async () => {
    User.findById.mockReturnValue(chain({ _id: '64b0000000000000000000aa', name: 'Desk', save: jest.fn() }));
    const plivoBody = { alias: ['Invalid Endpoint Alias name. Allowed characters: Letters, Numbers, . , + , @ , - , _'] };
    axios.request.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: plivoBody },
    }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { res } = await run(ctrl.webrtcToken, { user: { _id: '64b0000000000000000000aa' } });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ stage: 'endpoint', plivoStatus: 400 }));
    expect(res.body.message).not.toContain('Invalid Endpoint Alias');
    expect(res.body.message).not.toContain('[object Object]');
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Invalid Endpoint Alias'))).toBe(true);
    errSpy.mockRestore();
  });

  it('reads an axios-style response body and status', () => {
    const { status, text } = ctrl.plivoErrorDetail({ response: { status: 401, data: { error: 'authentication failed' } } });
    expect(status).toBe(401);
    expect(text).toBe('{"error":"authentication failed"}');
  });
});

// ─────────────────────────────────────────────────────────────
describe('in-app debug capture (temporary)', () => {
  const WebrtcDebugEvent = require('../models/WebrtcDebugEvent');

  it('stores SDK events with session and device, redacting anything token-like', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig';
    const { res } = await run(ctrl.postWebrtcDebug, {
      user: { _id: 'u1', name: 'Desk' },
      body: { events: [
        { event: 'onLoginFailed', reason: 'INVALID_ACCESS_TOKEN', sessionId: 's1', device: 'Chrome desktop', at: Date.now() },
        { event: 'onConnectionChange', detail: { state: 'disconnected', token: 'abc', raw: jwt }, sessionId: 's1' },
      ] },
    });
    expect(res.body.saved).toBe(2);
    const docs = WebrtcDebugEvent.insertMany.mock.calls[0][0];
    expect(docs[0]).toEqual(expect.objectContaining({ event: 'onLoginFailed', reason: 'INVALID_ACCESS_TOKEN', sessionId: 's1', device: 'Chrome desktop' }));
    expect(docs[1].detail.token).toBe('[redacted]');
    expect(JSON.stringify(docs)).not.toContain(jwt);
  });

  it('summarises one line per browser session, so two devices on one endpoint stand out', async () => {
    const t = (s) => new Date(Date.UTC(2026, 9, 26, 10, 45, s));
    WebrtcDebugEvent.find.mockReturnValue(chain([
      { sessionId: 'phone', userName: 'Desk', device: 'Android PWA', event: 'onLogin', at: t(30) },
      { sessionId: 'desk',  userName: 'Desk', device: 'Chrome',      event: 'onLogout', reason: 'Logout', at: t(20) },
      { sessionId: 'desk',  userName: 'Desk', device: 'Chrome',      event: 'onLogin', at: t(10) },
    ]));
    const { res } = await run(ctrl.getWebrtcDebug, { user: { _id: 'u1' }, query: {} });
    expect(res.body.sessions).toHaveLength(2);
    const desk = res.body.sessions.find((s) => s.sessionId === 'desk');
    expect(desk.lastLogout).toEqual({ at: t(20), reason: 'Logout' });
    expect(desk.lastLogin).toEqual(t(10));
  });
});

// ─────────────────────────────────────────────────────────────
describe('busy / leg-release investigation', () => {
  const fresh = () => new Date();

  it('"My phone" mode goes straight to the phone, even with an endpoint and a fresh app check-in', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([
      { _id: 'u1', name: 'Me', callMode: 'phone', plivoEndpointUsername: 'slme1', plivoEndpointId: 'ep1', appOnlineAt: fresh(), phone: '9000000001', callPhone: '9986844442' },
    ]));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919123456780', CallUUID: 'mine' } });

    expect(res.body).toContain('<Number>919986844442</Number>');
    expect(res.body).not.toContain('<User>');
    expect(res.body).toContain('stage=phone');
    expect(res.body).toContain('timeout="40"');
    const { routing } = CallLog.create.mock.calls[0][0];
    expect(routing.decision).toBe('phone');
    // What was dialled, so "phone busy" can be told from "never dialled".
    expect(routing.phoneTargets).toEqual(['••••••4442']);
    expect(routing.dutyUsers).toEqual([expect.objectContaining({ name: 'Me', callMode: 'phone', ringPhone: '••••••4442', ringPhoneValid: true })]);
    expect(JSON.stringify(routing)).not.toMatch(/9986844442|9000000001/);
  });

  it('records Plivo\'s verdict on the phone <Dial> (e.g. the phone was busy)', async () => {
    const log = logDoc({ direction: 'inbound', status: 'ringing', routing: { decision: 'phone' } });
    CallLog.findById.mockResolvedValue(log);
    await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'phone' },
      body: { DialStatus: 'busy', DialHangupCause: 'USER_BUSY', DialBLegTo: '919986844442' },
    });
    expect(log.phoneLeg).toEqual(expect.objectContaining({ DialStatus: 'busy', DialHangupCause: 'USER_BUSY', DialBLegTo: '••••••4442' }));
    expect(log.status).toBe('missed');
  });

  it('a call placed FROM a browser endpoint is hung up, not routed to staff', async () => {
    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: 'sip:slme1@phone.plivo.com', CallUUID: 'browser-out' } });
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Dial');
    expect(CallLog.create).not.toHaveBeenCalled();
  });

  it('keeps Plivo\'s full hang-up report on the call log', async () => {
    const log = logDoc({ direction: 'outbound', status: 'initiated' });
    CallLog.findById.mockResolvedValue(log);
    await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001' },
      body: { CallStatus: 'busy', HangupCause: 'USER_BUSY', HangupCauseCode: '3010', HangupCauseName: 'Busy Line', HangupSource: 'Callee', Duration: '0' },
    });
    expect(log.status).toBe('agent_busy');
    expect(log.hangup).toEqual(expect.objectContaining({ CallStatus: 'busy', HangupCauseCode: '3010', HangupCauseName: 'Busy Line', HangupSource: 'Callee' }));
  });

  it('a Plivo concurrency refusal on click-to-call says so plainly', async () => {
    mockCreateCall.mockRejectedValue(new Error('Concurrency Limit Breached'));
    const { res } = await run(ctrl.clickToCall, { user: staff, body: { customerRef: customerRef(CUSTOMER) } });
    expect(res.statusCode).toBe(502);
    expect(res.body.message).toMatch(/simultaneous calls/);
  });

  it('lists Plivo\'s live calls, matched to our logs, numbers masked', async () => {
    const started = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    axios.request.mockImplementation(async ({ method, url }) => {
      if (method === 'get' && url.endsWith('/Call/?status=live')) return { data: { calls: ['leg-1', 'leg-2'] } };
      if (method === 'get' && url.includes('/Call/leg-1/')) return { data: { direction: 'inbound', from: '919986844442', to: '918065591088', call_status: 'in-progress', session_start: started } };
      if (method === 'get' && url.includes('/Call/leg-2/')) return { data: { direction: 'outbound', from: '918065591088', to: 'sip:slme1@phone.plivo.com', call_status: 'ringing' } };
      throw new Error(`unexpected ${method} ${url}`);
    });
    CallLog.find.mockReturnValue(chain([{ _id: 'l1', providerCallId: 'leg-1', direction: 'inbound', status: 'ringing', context: 'incoming' }]));

    const { res } = await run(ctrl.liveCalls, { user: staff });

    expect(res.body.total).toBe(2);
    const [a, b] = res.body.calls;
    expect(a).toEqual(expect.objectContaining({ callUuid: 'leg-1', from: '••••••4442', status: 'in-progress', callLog: expect.objectContaining({ _id: 'l1' }) }));
    expect(a.ageSec).toBeGreaterThan(3 * 3600 - 120);
    expect(b).toEqual(expect.objectContaining({ callUuid: 'leg-2', to: 'sip:slme1@phone.plivo.com', callLog: null }));
    expect(JSON.stringify(res.body)).not.toContain('9986844442');
  });

  it('hangs up one live call by id', async () => {
    axios.request.mockResolvedValue({ data: {} });
    const { res } = await run(ctrl.hangupLiveCall, { user: staff, params: { uuid: 'leg-1-abcdef' } });
    expect(res.body.success).toBe(true);
    expect(axios.request.mock.calls[0][0]).toEqual(expect.objectContaining({ method: 'delete' }));
    expect(axios.request.mock.calls[0][0].url).toMatch(/\/Call\/leg-1-abcdef\/$/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('phone leg: ring verdict, overlap, one leg per number, stuck legs', () => {
  const { phoneLegVerdict } = require('../utils/phoneLegVerdict');
  const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
  const flush = () => new Promise((r) => setImmediate(r));
  const liveLegs = (legs) => axios.request.mockImplementation(async ({ method, url }) => {
    if (method === 'get' && url.endsWith('/Call/?status=live')) return { data: { calls: Object.keys(legs) } };
    const id = Object.keys(legs).find((k) => url.includes(`/Call/${k}/`));
    if (method === 'get' && id) return { data: legs[id] };
    if (method === 'delete') return { data: {} };
    throw new Error(`unexpected ${method} ${url}`);
  });
  const deleted = () => axios.request.mock.calls.filter(([a]) => a.method === 'delete').map(([a]) => a.url);

  it('tells "rang then busy" from "busy with no ring", and blames the carrier only with no overlap', () => {
    expect(phoneLegVerdict({ DialStatus: 'busy', DialRingStatus: 'true', DialHangupCause: 'USER_BUSY' }).code).toBe('rang_then_busy');
    const noRing = phoneLegVerdict({ DialStatus: 'busy', DialRingStatus: 'false', DialHangupCause: 'USER_BUSY' }, { ourCalls: [], liveLegs: [] });
    expect(noRing.code).toBe('busy_no_ring');
    expect(noRing.text).toMatch(/carrier or the handset/);
    expect(noRing.advice).toMatch(/forwarding/);
    expect(phoneLegVerdict({ DialStatus: 'busy', DialRingStatus: 'false', DialHangupCause: 'USER_BUSY' }, { ourCalls: [{}], liveLegs: [] }).code).toBe('busy_overlap');
    expect(phoneLegVerdict({ DialStatus: 'completed', DialRingStatus: 'true' }).code).toBe('answered');
    expect(phoneLegVerdict({ DialStatus: 'no-answer', DialRingStatus: 'true', DialHangupCause: 'NO_ANSWER' }).code).toBe('rang_no_answer');
    expect(phoneLegVerdict({ DialStatus: 'busy', DialRingStatus: 'false', DialHangupCause: 'USER_BUSY' }).code).toBe('busy_no_ring_unchecked');
    expect(phoneLegVerdict(undefined)).toBeNull();
  });

  it('dials one number once, however it is written, and never the caller\'s own number', () => {
    const users = [
      { _id: 'a', phone: '9000000001', callPhone: '9986844442' },
      { _id: 'b', phone: '+91 99868 44442' },
      { _id: 'c', phone: '9123456780' },
    ];
    expect(ctrl.fallbackPhones(users)).toEqual(['9986844442', '9123456780']);
    expect(ctrl.fallbackPhones(users, '919986844442')).toEqual(['9123456780']);
  });

  it('a call from the ring phone itself does not dial that phone, and says so', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([
      { _id: 'u1', name: 'Me', callMode: 'phone', phone: '9000000001', callPhone: '9986844442' },
      { _id: 'u2', name: 'Desk', callMode: 'phone', phone: '9123456780' },
    ]));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'self' } });

    expect(res.body).not.toContain('<Number>919986844442</Number>');
    expect(res.body).toContain('<Number>919123456780</Number>');
    expect(CallLog.create.mock.calls[0][0].routing.callerIsRingPhone).toBe(true);
    expect(CallLog.create.mock.calls[0][0].dialledPhones).toEqual(['9123456780']);
  });

  it('records an overlapping live leg to the same number, and hangs up legs stuck ringing', async () => {
    liveLegs({
      'old-ring': { to: '919986844442', call_status: 'ringing', session_start: ago(300) },
      'other':    { to: '919123456780', call_status: 'in-progress', session_start: ago(400) },
      'mine-new': { to: '919986844442', call_status: 'ringing', session_start: ago(0) },
    });
    CallLog.find.mockReturnValue(chain([]));
    CallLog.updateOne.mockResolvedValue({});

    const overlap = await ctrl.recordPhoneDial('64b000000000000000000001', ['9986844442']);

    expect(overlap.liveLegs).toEqual([expect.objectContaining({ callUuid: 'old-ring', to: '••••••4442', status: 'ringing' })]);
    expect(overlap.autoHungUp).toEqual(['old-ring']);
    expect(deleted()).toEqual([expect.stringMatching(/\/Call\/old-ring\/$/)]);
    expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: '64b000000000000000000001' }, { $set: { overlap } });
    expect(JSON.stringify(overlap)).not.toContain('9986844442');
  });

  it('records another of our calls still ringing the same number', async () => {
    liveLegs({});
    CallLog.find.mockReturnValue(chain([{ _id: 'other-log', direction: 'inbound', status: 'ringing', startedAt: new Date(Date.now() - 20000) }]));
    CallLog.updateOne.mockResolvedValue({});
    const overlap = await ctrl.recordPhoneDial('64b000000000000000000001', ['9986844442']);
    expect(overlap.ourCalls).toEqual([expect.objectContaining({ logId: 'other-log', status: 'ringing' })]);
    expect(CallLog.find.mock.calls[0][0].$or[0].dialledPhones).toEqual({ $in: ['9986844442'] });
  });

  it('the phone stage records what it dialled and checks overlap without delaying the XML', async () => {
    liveLegs({});
    CallLog.find.mockReturnValue(chain([]));
    CallLog.updateOne.mockResolvedValue({});
    const log = logDoc({ direction: 'inbound', status: 'ringing', flow: ['app:15s'], routing: { appUsers: [] } });
    CallLog.findById.mockResolvedValue(log);
    User.find.mockReturnValue(chain([{ _id: 'u1', callMode: 'app', phone: '9000000001', callPhone: '9986844442' }]));

    const { res } = await run(ctrl.events, {
      method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'app' },
      body: { DialStatus: 'no-answer', From: '919123456780' },
    });
    await flush(); await flush();

    expect(res.body.match(/<Number>/g)).toHaveLength(1);
    expect(log.dialledPhones).toEqual(['9986844442']);
    expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: '64b000000000000000000001' }, { $set: { overlap: expect.objectContaining({ callerIsRingPhone: false }) } });
  });

  it('when an incoming call ends, its legs still up are hung up — never a leg another call is ringing', async () => {
    const dialAt = new Date(Date.now() - 30000);
    liveLegs({
      'b-leg':     { to: '919986844442', call_status: 'in-progress', session_start: ago(25) },
      'ring-mine': { to: '919123456780', call_status: 'ringing', session_start: ago(25) },
      'ring-shared': { to: '919000000009', call_status: 'ringing', session_start: ago(10) },
      'before':    { to: '919123456780', call_status: 'ringing', session_start: ago(50) },
    });
    CallLog.findById.mockReturnValue(chain({ _id: 'L', customerLegId: 'b-leg', dialledPhones: ['9986844442', '9123456780', '9000000009'], overlap: { dialAt } }));
    CallLog.find.mockReturnValue(chain([{ _id: 'other', dialledPhones: ['9000000009'] }]));
    CallLog.updateOne.mockResolvedValue({});

    const done = await ctrl.releaseLegs('L');

    expect(done.sort()).toEqual(['b-leg', 'ring-mine']);
    expect(CallLog.updateOne).toHaveBeenCalledWith({ _id: 'L' }, { $set: { 'overlap.releasedAtHangup': expect.any(Array) } });
  });

  it('the live-calls panel hangs up legs stuck ringing and leaves connected calls alone', async () => {
    liveLegs({
      stuck: { direction: 'outbound', to: '919986844442', call_status: 'ringing', session_start: ago(600) },
      talk : { direction: 'inbound', to: '918065591088', call_status: 'in-progress', session_start: ago(600) },
    });
    CallLog.find.mockReturnValue(chain([]));
    const { res } = await run(ctrl.liveCalls, { user: staff });
    expect(res.body.autoHungUp).toBe(1);
    expect(res.body.calls.map((c) => c.callUuid)).toEqual(['talk']);
    expect(deleted()).toEqual([expect.stringMatching(/\/Call\/stuck\/$/)]);
  });

  it('a call log\'s JSON carries the verdict, never the dialled numbers', () => {
    const CallLogModel = jest.requireActual('../models/CallLog');
    const doc = new CallLogModel({
      provider: 'plivo', direction: 'inbound', context: 'incoming', dialledPhones: ['9986844442'],
      phoneLeg: { DialStatus: 'busy', DialRingStatus: 'false', DialHangupCause: 'USER_BUSY' },
      overlap: { ourCalls: [], liveLegs: [] },
    });
    const json = doc.toJSON();
    expect(json.phoneVerdict.code).toBe('busy_no_ring');
    expect(json.dialledPhones).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('9986844442');
  });
});

// ─────────────────────────────────────────────────────────────
describe('recordings only for answered calls; call flow trail', () => {
  const PLIVO_URL = 'https://media.plivo.com/v1/Account/MAXXX/Recording/r9.mp3';
  const streamRes = () => {
    const res = mockRes();
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.on = jest.fn();
    res.destroy = jest.fn();
    return res;
  };

  it('a missed call offers no recording, even if Plivo posted a URL', () => {
    const CallLogReal = jest.requireActual('../models/CallLog');
    const missed = JSON.parse(JSON.stringify(new CallLogReal({ provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'missed', recordingUrl: PLIVO_URL })));
    const answered = JSON.parse(JSON.stringify(new CallLogReal({ provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'completed', talkSec: 42, recordingUrl: PLIVO_URL })));
    expect(missed).toEqual(expect.objectContaining({ hasRecording: false, recordingState: 'not_answered' }));
    expect(answered).toEqual(expect.objectContaining({ hasRecording: true, recordingState: 'available' }));
  });

  it('asked for a missed call\'s recording, it says so without asking Plivo', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: 'l1', recordingUrl: PLIVO_URL, status: 'missed' }));
    const res = streamRes();
    await ctrl.streamRecording({ params: { id: '64b000000000000000000001' }, get: () => undefined }, res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'not_answered' }));
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('a 403 with Basic Auth is retried once without it, and streams if that works', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: 'l1', recordingUrl: PLIVO_URL, status: 'completed', talkSec: 30 }));
    const refused = { status: 403, headers: {}, data: { destroy: jest.fn() } };
    const ok = { status: 200, headers: { 'content-type': 'audio/mpeg' }, data: { pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() } };
    axios.get.mockResolvedValueOnce(refused).mockResolvedValueOnce(ok);
    const res = streamRes();

    await ctrl.streamRecording({ params: { id: '64b000000000000000000001' }, get: () => undefined }, res, jest.fn());

    expect(axios.get.mock.calls[0][1].auth).toBeDefined();
    expect(axios.get.mock.calls[1][1].auth).toBeUndefined();
    expect(ok.data.pipe).toHaveBeenCalledWith(res);
  });

  it('records the flow: app 15s, no answer → phones, phones busy → sorry message', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    const duty = [{ callMode: 'app', plivoEndpointUsername: 'slaaaa1', appOnlineAt: new Date(), phone: '9000000001' }];
    User.find.mockReturnValue(chain(duty));
    await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'f1' } });
    expect(CallLog.create.mock.calls[0][0].flow).toEqual(['app:15s']);

    const log = logDoc({ direction: 'inbound', status: 'ringing', flow: ['app:15s'], routing: { appUsers: [] } });
    CallLog.findById.mockResolvedValue(log);
    await run(ctrl.events, { method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'app' }, body: { DialStatus: 'no-answer' } });
    expect(log.flow).toEqual(['app:15s', 'app:no-answer→phones:1:40s']);

    await run(ctrl.events, { method: 'POST', query: { log: '64b000000000000000000001', leg: 'dial', stage: 'phone' }, body: { DialStatus: 'busy' } });
    expect(log.flow).toEqual(['app:15s', 'app:no-answer→phones:1:40s', 'phone:busy→sorry_message']);
  });
});

// ─────────────────────────────────────────────────────────────
describe('per-device endpoints (one registration per device)', () => {
  const WebrtcEndpoint = require('../models/WebrtcEndpoint');
  const WebrtcDebugEvent = require('../models/WebrtcDebugEvent');
  const USER = { _id: '64b0000000000000000000aa', name: 'Desk', phone: '9000000001' };
  const headers = (h) => (k) => h[k];

  it('rings ALL of an in-app user\'s online devices at once, then phones', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([{ ...USER, callMode: 'app' }]));
    WebrtcEndpoint.find.mockReturnValue(chain([
      { user: USER._id, username: 'sldesktop1', device: 'browser-tab · Chrome', onlineAt: new Date(), deviceKey: 'd1' },
      { user: USER._id, username: 'slphone2', device: 'installed-app · Android', onlineAt: new Date(), deviceKey: 'd2' },
    ]));

    const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'multi' } });

    expect(res.body).toContain('<User>sip:sldesktop1@phone.plivo.com</User><User>sip:slphone2@phone.plivo.com</User>');
    expect(res.body).toContain('timeout="15"');
    const { routing } = CallLog.create.mock.calls[0][0];
    expect(routing.appUsers[0].devices).toEqual([
      expect.objectContaining({ device: 'browser-tab · Chrome', dialled: true }),
      expect.objectContaining({ device: 'installed-app · Android', dialled: true }),
    ]);
    expect(WebrtcDebugEvent.create).toHaveBeenCalledWith(expect.objectContaining({ event: 'server:incoming_routed' }));
  });

  it('a device that stopped checking in is not rung; the user falls to their phone', () => {
    const { sipUsers, phones } = ctrl.routeIncoming(
      [{ ...USER, callMode: 'app' }],
      [{ user: USER._id, username: 'slold', onlineAt: new Date(Date.now() - 10 * 60 * 1000) }],
    );
    expect(sipUsers).toEqual([]);
    expect(phones).toEqual(['9000000001']);
  });

  it('login with a device key gets that device\'s own endpoint and credentials', async () => {
    fakePlivoDevice();
    WebrtcEndpoint.findOne.mockReturnValue(chain(null));
    WebrtcEndpoint.find.mockReturnValue(chain([]));
    const saved = { save: jest.fn() };
    WebrtcEndpoint.create.mockImplementation(async (d) => Object.assign(saved, d));

    const { res } = await run(ctrl.webrtcLogin, {
      user: USER, query: {}, get: headers({ 'X-Device-Key': 'aaaabbbb-cccc-dddd', 'X-Device-Label': 'browser-tab · Chrome' }),
    });

    const created = axios.request.mock.calls.map(([c]) => c).find((c) => c.method === 'post' && c.url.endsWith('/Endpoint/'));
    expect(created.data.alias).toBe(`savelife-${USER._id}-aaaabbbbcccc`);
    expect(created.data.alias).toMatch(/^[A-Za-z0-9.+@_-]+$/);
    expect(created.data.username).toMatch(/^sl[a-z0-9]+$/);
    expect(created.data.username.length).toBeLessThanOrEqual(25);
    expect(res.body).toEqual(expect.objectContaining({ mode: 'password', perDevice: true, username: saved.username, password: saved.password }));
    expect(saved.device).toBe('browser-tab · Chrome');
  });

  it('the same device logging in again reuses its endpoint', async () => {
    fakePlivoDevice();
    const doc = { user: USER._id, deviceKey: 'aaaabbbb-cccc-dddd', endpointId: 'epd', username: 'sldev123', password: 'pw', save: jest.fn() };
    WebrtcEndpoint.findOne.mockReturnValue(chain(doc));
    const { res } = await run(ctrl.webrtcLogin, { user: USER, query: {}, get: headers({ 'X-Device-Key': 'aaaabbbb-cccc-dddd' }) });
    expect(axios.request.mock.calls.some(([c]) => c.method === 'post' && c.url.endsWith('/Endpoint/'))).toBe(false);
    expect(res.body.username).toBe('sldev123');
  });

  it('a sixth device retires the least recently used endpoint', async () => {
    fakePlivoDevice();
    WebrtcEndpoint.findOne.mockReturnValue(chain(null));
    WebrtcEndpoint.find.mockReturnValue(chain([1, 2, 3, 4, 5].map((i) => ({ _id: `e${i}`, endpointId: `ep${i}` }))));
    WebrtcEndpoint.create.mockImplementation(async (d) => ({ ...d, save: jest.fn() }));
    await run(ctrl.webrtcLogin, { user: USER, query: {}, get: headers({ 'X-Device-Key': 'newdevice-0001' }) });
    expect(axios.request.mock.calls.some(([c]) => c.method === 'delete' && c.url.endsWith('/Endpoint/ep1/'))).toBe(true);
    expect(WebrtcEndpoint.deleteOne).toHaveBeenCalledWith({ _id: 'e1' });
  });

  it('presence with a device key marks only that device', async () => {
    await run(ctrl.webrtcPresence, { user: USER, body: { online: true }, get: headers({ 'X-Device-Key': 'aaaabbbb-cccc-dddd' }) });
    expect(WebrtcEndpoint.updateOne).toHaveBeenCalledWith({ user: USER._id, deviceKey: 'aaaabbbb-cccc-dddd' }, { $set: { onlineAt: expect.any(Date) } });
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('the call trail says, per device, whether the call arrived and the Answer screen showed', async () => {
    const logId = '64b000000000000000000001';
    CallLog.findById.mockReturnValue(chain({ _id: logId, startedAt: new Date(), status: 'missed', routing: { decision: 'app_then_phone' } }));
    WebrtcDebugEvent.find.mockReturnValue(chain([
      { event: 'server:incoming_routed', detail: { logId }, at: new Date() },
      { event: 'onIncomingCall', sessionId: 'phone-s', device: 'installed-app · Android', detail: [{ 'X-PH-logId': logId }], at: new Date() },
      { event: 'ui:incoming_shown', sessionId: 'phone-s', device: 'installed-app · Android', detail: [{ logId }], at: new Date() },
      { event: 'state', sessionId: 'desk-s', device: 'browser-tab · Chrome', at: new Date() },
      { event: 'onLogin', sessionId: 'desk-s', device: 'browser-tab · Chrome', at: new Date() },
    ]));

    const { res } = await run(ctrl.getCallTrail, { params: { id: logId } });

    const phone = res.body.sessions.find((s) => s.sessionId === 'phone-s');
    const desk = res.body.sessions.find((s) => s.sessionId === 'desk-s');
    expect(phone).toEqual(expect.objectContaining({ gotIncoming: true, gotThisCall: true, answerScreenShown: true }));
    expect(desk).toEqual(expect.objectContaining({ gotIncoming: false, answerScreenShown: false }));
    expect(res.body.events.map((e) => e.event)).not.toContain('state');
  });

  // Plivo REST for device endpoints: list (none), create, get (matches), link, password, delete.
  function fakePlivoDevice() {
    axios.request.mockImplementation(async ({ method, url, data }) => {
      const path = url.replace('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX', '');
      if (method === 'get' && path === '/Number/918065591088/') return { data: { application: '/v1/Account/MAXXXXXXXXXXXXXXXXXX/Application/29986316244302815/' } };
      if (method === 'get' && path.startsWith('/Endpoint/?')) return { data: { meta: { next: null }, objects: [] } };
      if (method === 'post' && path === '/Endpoint/') return { data: { endpoint_id: 'epnew', username: `${data.username}777` } };
      const one = path.match(/^\/Endpoint\/([^/?]+)\/$/);
      if (method === 'get' && one) return { data: { username: one[1] === 'epd' ? 'sldev123' : `${'x'}`, application: '/v1/Account/MAXXXXXXXXXXXXXXXXXX/Application/29986316244302815/' } };
      if ((method === 'post' || method === 'delete') && one) return { data: {} };
      throw new Error(`unexpected Plivo call ${method} ${path}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
describe('"Ring my phone now (test)" and the caller-is-ring-phone note', () => {
  const me = { _id: 'u1', role: 'owner', name: 'Manju', phone: '9000000001', callPhone: '9986844442' };

  it('rings my ring number from the company number, to the test answer URL — no customer, no recording', async () => {
    CallLog.findOne.mockReturnValue(chain(null));
    const { res } = await run(ctrl.testRing, { user: me });

    expect(res.body.success).toBe(true);
    expect(res.body.ringPhone).toBe('••••••4442');
    const [from, to, answerUrl, params] = mockCreateCall.mock.calls[0];
    expect(from).toBe('918065591088');
    expect(to).toBe('919986844442');
    expect(answerUrl).toBe('https://api.savelife.health/api/calls/test-answer?log=64b000000000000000000001');
    expect(params.hangupUrl).toContain('/api/calls/events?log=');
    expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({ context: 'test_ring', direction: 'outbound', agentUser: 'u1' }));
    expect(CallLog.create.mock.calls[0][0].customerPhone).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('9986844442');
  });

  it('one test at a time per user', async () => {
    CallLog.findOne.mockReturnValue(chain({ _id: 'recent' }));
    const { res } = await run(ctrl.testRing, { user: me });
    expect(res.statusCode).toBe(429);
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it('needs a valid ring number', async () => {
    const { res } = await run(ctrl.testRing, { user: { ...me, phone: '', callPhone: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('answered: marks it connected, speaks the test message and hangs up — no Dial, no Record', async () => {
    const log = logDoc({ context: 'test_ring', status: 'initiated', flow: ['test_ring:40s'] });
    CallLog.findById.mockResolvedValue(log);
    const { res } = await run(ctrl.testAnswer, { method: 'POST', query: { log: '64b000000000000000000001' }, body: { CallUUID: 't1' } });
    expect(res.body).toContain('SaveLife test call');
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Dial');
    expect(res.body).not.toContain('<Record');
    expect(log.status).toBe('completed');
  });

  it('busy: the hang-up report marks the test busy with Plivo\'s cause', async () => {
    const log = logDoc({ context: 'test_ring', status: 'initiated', flow: ['test_ring:40s'] });
    CallLog.findById.mockResolvedValue(log);
    await run(ctrl.events, { method: 'POST', query: { log: '64b000000000000000000001' }, body: { CallStatus: 'busy', HangupCause: 'USER_BUSY', HangupCauseName: 'Busy Line' } });
    expect(log.status).toBe('agent_busy');
    expect(log.hangup).toEqual(expect.objectContaining({ CallStatus: 'busy', HangupCauseName: 'Busy Line' }));
    expect(log.flow).toEqual(['test_ring:40s', 'test_ring:busy']);
  });

  it('calling in FROM the only ring phone: nothing rings, and the log and the caller are told why', async () => {
    Trip.findOne.mockReturnValue(chain(null));
    require('../models').Lead.findOne.mockReturnValue(chain(null));
    User.find.mockReturnValue(chain([{ _id: 'u1', name: 'Manju', callMode: 'phone', phone: '9000000001', callPhone: '9986844442' }]));
    const saved = process.env.PLIVO_FALLBACK_AGENTS;
    delete process.env.PLIVO_FALLBACK_AGENTS;
    try {
      const { res } = await run(ctrl.incoming, { method: 'POST', body: { From: '919986844442', CallUUID: 'self' } });
      expect(res.body).not.toContain('<Dial');
      expect(res.body).toContain('calling from a SaveLife ring number');
      const created = CallLog.create.mock.calls[0][0];
      expect(created.flow).toEqual(['skipped_caller_ring_phone→busy_message']);
      expect(created.routing.skippedCaller).toEqual(expect.objectContaining({ ringPhone: '••••••4442', leftNobody: true }));
      expect(created.routing.skippedCaller.message).toMatch(/Did not ring ••••••4442 \(Manju's ring number\) — it was the number that called in.*Ring my phone now/);
      expect(JSON.stringify(created.routing)).not.toContain('9986844442');
    } finally {
      if (saved !== undefined) process.env.PLIVO_FALLBACK_AGENTS = saved;
    }
  });
});
