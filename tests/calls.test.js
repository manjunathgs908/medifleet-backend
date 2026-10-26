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
  User: { find: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../models/Ambulance', () => ({ exists: jest.fn() }));
jest.mock('../models/Quote', () => ({ findById: jest.fn() }));
jest.mock('../models/WhatsAppLead', () => ({ findById: jest.fn() }));
jest.mock('../models/CallLog', () => ({
  create: jest.fn(), findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../services/exotelService', () => ({ connectCall: jest.fn() }));
// Only .get is replaced: the real Plivo SDK (kept for its signature check)
// configures axios when it loads.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  actual.get = jest.fn();
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
  const res = { statusCode: 200, body: null, contentType: null };
  res.status = (c) => { res.statusCode = c; return res; };
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
    CallLog.findById.mockReturnValue(chain({ recordingUrl: PLIVO_URL }));
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
    CallLog.findById.mockReturnValue(chain({ recordingUrl: 'https://evil.example.com/r.mp3' }));
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
    CallLog.findById.mockReturnValue(chain({ recordingUrl: PLIVO_URL }));
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
