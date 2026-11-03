/**
 * tests/phoneTransfer.test.js
 * ============================================================
 * Live transfer of an incoming call answered on a ring PHONE (ring mode
 * "My phone"), from the CRM (controllers/callController.js):
 *
 *   - the phone <Dial> reports live (callbackUrl → /dial-event): who
 *     picked up, and when that phone hung up
 *   - GET /my-live shows that call to the person whose phone answered it,
 *     while they are still on it
 *   - Transfer is the same transfer as in the app; the phone leg is hung
 *     up 5s later if Plivo has not dropped it already
 *   - app and phone disagreeing (phone hung up, call ended) is refused
 *     plainly; the in-app transfer is unchanged
 *
 * Models and Plivo's REST API are mocked — no database, no calls placed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'limit']) q[m] = () => q;
  return q;
};

jest.mock('../models', () => ({
  Trip: { findOne: jest.fn() },
  Lead: { findById: jest.fn(), findOne: jest.fn() },
  User: { find: jest.fn(), updateOne: jest.fn(), findById: jest.fn(), findOne: jest.fn() },
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
  find: jest.fn(), findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn(),
  updateMany: jest.fn(), deleteOne: jest.fn(), countDocuments: jest.fn(),
}));
// Plivo's REST API (transfer, hang-up) goes through axios.request.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  actual.get = jest.fn();
  actual.request = jest.fn();
  return actual;
});

const axios = require('axios');
const { User } = require('../models');
const CallLog = require('../models/CallLog');
const WebrtcEndpoint = require('../models/WebrtcEndpoint');
const plivo = require('../services/plivoService');
const ctrl = require('../controllers/callController');

const LOG_ID = '64b000000000000000000001';
const A_LEG = 'aaaa-customer-leg';
const PHONE_LEG = 'bbbb-owner-phone-leg';

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
  await handler({ method: 'POST', body: {}, query: {}, params: {}, get: () => undefined, ...req }, res, next);
  if (next.mock.calls.length && next.mock.calls[0][0]) throw next.mock.calls[0][0];
  return { res, next };
};

// On call duty, ring mode "My phone".
const owner  = { _id: '64a0000000000000000000a1', role: 'owner', name: 'Owner', phone: '9000000001', callMode: 'phone' };
const tcEn   = { _id: '64a0000000000000000000b1', role: 'telecaller', name: 'Asha', phone: '9000000002', callMode: 'phone', speaksEnglish: true };
const tcKa   = { _id: '64a0000000000000000000b2', role: 'telecaller', name: 'Ravi', phone: '9000000003', callMode: 'phone' };

// An incoming call the owner answered on their phone, still live.
const phoneCall = (over = {}) => ({
  _id: LOG_ID, provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'ringing',
  providerCallId: A_LEG, customerPhone: '9986844442',
  agentUser: owner._id, agentName: owner.name, answeredAt: new Date(),
  answeredIn: 'phone', answeredLegId: PHONE_LEG,
  ...over,
});

const updatesTo = () => CallLog.updateOne.mock.calls.map(([filter, update]) => ({ filter, update }));
const plivoCalls = () => axios.request.mock.calls.map(([c]) => ({ method: c.method, url: c.url, data: c.data }));

beforeEach(() => {
  jest.clearAllMocks();
  CallLog.updateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
  User.find.mockReturnValue(chain([owner, tcEn, tcKa]));
  WebrtcEndpoint.find.mockReturnValue(chain([]));
  axios.request.mockResolvedValue({ data: {} });
});

// ─────────────────────────────────────────────────────────────
describe('phone Dial reports live', () => {
  it('the phone stage asks Plivo for live answer/hang-up reports, with only the log id in the URL', () => {
    const x = plivo.bridgeXml({ numbers: ['9000000001'], logId: LOG_ID, stage: 'phone' });
    expect(x).toContain(`callbackUrl="https://api.savelife.health/api/calls/dial-event?log=${LOG_ID}&amp;stage=phone"`);
    expect(x).toContain('callbackMethod="POST"');
  });

  it('the in-app stage and outbound calls are unchanged (no live reports)', () => {
    const app = plivo.bridgeXml({ sipUsers: ['u1'], logId: LOG_ID, stage: 'app', timeout: 15 });
    const out = plivo.bridgeXml({ numbers: ['9986844442'], logId: LOG_ID });
    expect(app).not.toContain('dial-event');
    expect(out).not.toContain('dial-event');
  });

  it('the webhook is behind Plivo\'s signature; /my-live behind login and the call-staff roles', () => {
    const router = require('../routes/calls');
    const layer = (path, method) => router.stack.find((l) => l.route?.path === path && (method ? l.route.methods[method] : true));
    const dial = layer('/dial-event');
    expect(dial.route.stack.map((s) => s.handle)).toEqual([ctrl.requirePlivoSignature, ctrl.dialEvent]);
    const mine = layer('/my-live', 'get');
    expect(mine.route.stack).toHaveLength(3); // protect, authorize, handler
    expect(mine.route.stack[2].handle).toBe(ctrl.myLiveCall);
    // Before /:id, or "my-live" would be read as a call id.
    const idx = (p) => router.stack.findIndex((l) => l.route?.path === p);
    expect(idx('/my-live')).toBeLessThan(idx('/:id'));
  });
});

describe('POST /dial-event', () => {
  const answer = (over = {}) => ({ query: { log: LOG_ID, stage: 'phone' }, body: { DialAction: 'answer', DialBLegUUID: PHONE_LEG, DialBLegTo: '919000000001', ...over } });

  it('answer: the on-duty person whose ring phone picked up has the call, now', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, direction: 'inbound', context: 'incoming' }));
    const { res } = await run(ctrl.dialEvent, answer());
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('text/xml');
    const [u] = updatesTo();
    // First answer wins: only if nobody has the call yet.
    expect(u.filter).toEqual(expect.objectContaining({ agentUser: { $exists: false }, answeredLegId: { $exists: false } }));
    expect(u.update.$set).toEqual(expect.objectContaining({
      agentUser: owner._id, agentName: 'Owner', agentType: 'staff', answeredIn: 'phone', answeredLegId: PHONE_LEG,
    }));
    expect(u.update.$set.answeredAt).toBeInstanceOf(Date);
  });

  it('a phone that is nobody\'s ring phone: answer time only, shown to nobody', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, direction: 'inbound' }));
    await run(ctrl.dialEvent, answer({ DialBLegTo: '919111111111' }));
    const [u] = updatesTo();
    expect(u.update.$set.agentUser).toBeUndefined();
    expect(u.update.$set.answeredIn).toBe('phone');
  });

  it('a repeated answer report, or one for a call already ended, changes nothing', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, direction: 'inbound', answeredLegId: PHONE_LEG }));
    await run(ctrl.dialEvent, answer({ DialAction: 'connected' }));
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, direction: 'inbound', endedAt: new Date() }));
    await run(ctrl.dialEvent, answer());
    expect(CallLog.updateOne).not.toHaveBeenCalled();
  });

  it('hang-up: recorded only for the phone that had the call', async () => {
    await run(ctrl.dialEvent, { query: { log: LOG_ID, stage: 'phone' }, body: { DialAction: 'hangup', DialBLegUUID: PHONE_LEG } });
    const [u] = updatesTo();
    expect(u.filter).toEqual({ _id: LOG_ID, answeredLegId: PHONE_LEG, answeredLegEndedAt: null });
    expect(u.update.$set.answeredLegEndedAt).toBeInstanceOf(Date);
  });

  it('never changes what the caller hears (empty XML), and ignores reports without a log', async () => {
    const { res } = await run(ctrl.dialEvent, { query: { stage: 'phone' }, body: { DialAction: 'answer' } });
    expect(res.body).toBe(plivo.emptyXml());
    expect(CallLog.findById).not.toHaveBeenCalled();
  });
});

describe('the Dial\'s end report after a live answer', () => {
  it('keeps the live answer time and who answered', async () => {
    const answeredAt = new Date(Date.now() - 120 * 1000);
    const log = { ...phoneCall({ answeredAt }), save: jest.fn(async function () { return this; }) };
    CallLog.findById.mockResolvedValue(log);
    await run(ctrl.events, { query: { log: LOG_ID, leg: 'dial', stage: 'phone' }, body: { DialStatus: 'completed', DialBLegDuration: '30', DialBLegTo: '919000000002' } });
    expect(log.answeredAt).toBe(answeredAt);
    expect(log.agentUser).toBe(owner._id);
  });
});

describe('GET /my-live', () => {
  it('the call you answered on your phone, while you are still on it', async () => {
    CallLog.findOne.mockReturnValue(chain(phoneCall()));
    const { res } = await run(ctrl.myLiveCall, { method: 'GET', user: owner });
    const [q] = CallLog.findOne.mock.calls[0];
    expect(q).toEqual(expect.objectContaining({
      agentUser: owner._id, answeredIn: 'phone', endedAt: null, answeredLegEndedAt: null, direction: 'inbound', context: 'incoming',
    }));
    expect(q.createdAt.$gte).toBeInstanceOf(Date);
    expect(res.body.call).toEqual(expect.objectContaining({ id: LOG_ID, canTransfer: true, transferring: false }));
  });

  it('none: call null', async () => {
    CallLog.findOne.mockReturnValue(chain(null));
    const { res } = await run(ctrl.myLiveCall, { method: 'GET', user: owner });
    expect(res.body).toEqual({ success: true, call: null });
  });

  it('while its transfer rings: shown as transferring, no second Transfer', async () => {
    CallLog.findOne.mockReturnValue(chain(phoneCall({ transfers: [{ by: owner._id, outcome: 'ringing' }] })));
    const { res } = await run(ctrl.myLiveCall, { method: 'GET', user: owner });
    expect(res.body.call).toEqual(expect.objectContaining({ transferring: true, canTransfer: false }));
  });

  it('after a failed transfer the caller is still with you: Transfer again', async () => {
    CallLog.findOne.mockReturnValue(chain(phoneCall({ status: 'completed', transfers: [{ by: owner._id, outcome: 'failed' }] })));
    const { res } = await run(ctrl.myLiveCall, { method: 'GET', user: owner });
    expect(res.body.call).toEqual(expect.objectContaining({ canTransfer: true, lastTransferFailed: true }));
  });

  it('taken by a colleague as a transfer: no longer yours', async () => {
    CallLog.findOne.mockReturnValue(chain(phoneCall({ transfers: [{ by: owner._id, outcome: 'answered', answeredBy: tcEn._id }] })));
    const { res } = await run(ctrl.myLiveCall, { method: 'GET', user: owner });
    expect(res.body.call).toBeNull();
  });
});

describe('POST /:id/transfer — a call answered on a phone', () => {
  const transferReq = (user = owner) => ({ user, params: { id: LOG_ID } });

  it('is the same transfer: Plivo moves the customer\'s leg; the phone leg is checked 5s later', async () => {
    const timer = jest.spyOn(global, 'setTimeout');
    CallLog.findById.mockReturnValue(chain(phoneCall()));
    const { res } = await run(ctrl.transferCall, transferReq());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, transfer: 0, englishAvailable: 1, available: 2 }));
    const [call] = plivoCalls();
    expect(call.method).toBe('post');
    expect(call.url).toContain(`/Call/${A_LEG}/`);
    expect(call.data).toEqual(expect.objectContaining({ legs: 'aleg', aleg_url: `https://api.savelife.health/api/calls/transfer-answer?log=${LOG_ID}&t=0` }));
    // The transferring person is never rung by the telecaller steps.
    const push = updatesTo()[0].update.$push.transfers;
    expect(push.targets.map(String)).toEqual([tcEn._id, tcKa._id]);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), ctrl.PHONE_LEG_DROP_MS);
    expect(ctrl.PHONE_LEG_DROP_MS).toBe(5000);
    timer.mockRestore();
  });

  it('anyone who answered on their own phone may — not only the owner', async () => {
    CallLog.findById.mockReturnValue(chain(phoneCall({ agentUser: tcKa._id, agentName: 'Ravi' })));
    const { res } = await run(ctrl.transferCall, transferReq(tcKa));
    expect(res.statusCode).toBe(200);
    expect(updatesTo()[0].update.$push.transfers.targets.map(String)).toEqual([tcEn._id]);
  });

  it('someone else cannot transfer your call', async () => {
    CallLog.findById.mockReturnValue(chain(phoneCall()));
    const { res } = await run(ctrl.transferCall, transferReq(tcEn));
    expect(res.statusCode).toBe(403);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('your phone already hung up (the app still showed Transfer): refused, nothing changes', async () => {
    CallLog.findById.mockReturnValue(chain(phoneCall({ answeredLegEndedAt: new Date() })));
    const { res } = await run(ctrl.transferCall, transferReq());
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('ended');
    expect(CallLog.updateOne).not.toHaveBeenCalled();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('the caller already hung up: refused as ended', async () => {
    CallLog.findById.mockReturnValue(chain(phoneCall({ endedAt: new Date() })));
    const { res } = await run(ctrl.transferCall, transferReq());
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('ended');
  });

  it('the call ended just as Transfer was pressed (Plivo 404): "ended", not "still connected"', async () => {
    CallLog.findById
      .mockReturnValueOnce(chain(phoneCall()))
      .mockReturnValueOnce(chain({ _id: LOG_ID, endedAt: new Date() }));
    axios.request.mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } }));
    const timer = jest.spyOn(global, 'setTimeout');
    const { res } = await run(ctrl.transferCall, transferReq());
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ success: false, reason: 'ended' }));
    // Logged on the call as a failed transfer, as before.
    expect(updatesTo()[1].update.$set['transfers.0.outcome']).toBe('failed');
    expect(timer).not.toHaveBeenCalledWith(expect.any(Function), ctrl.PHONE_LEG_DROP_MS);
    timer.mockRestore();
  });

  it('Plivo refuses on a live call: you are still connected (502), as in the app', async () => {
    CallLog.findById
      .mockReturnValueOnce(chain(phoneCall()))
      .mockReturnValueOnce(chain({ _id: LOG_ID }));
    axios.request.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    const { res } = await run(ctrl.transferCall, transferReq());
    expect(res.statusCode).toBe(502);
    expect(res.body.reason).toBe('plivo_failed');
  });
});

describe('POST /:id/transfer — in-app calls are unchanged', () => {
  const appCall = (over = {}) => ({
    _id: LOG_ID, provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'ringing',
    providerCallId: A_LEG, agentUser: owner._id, answeredAt: new Date(), ...over,
  });

  it('transfers without any phone-leg backstop', async () => {
    const timer = jest.spyOn(global, 'setTimeout');
    CallLog.findById.mockReturnValue(chain(appCall()));
    const { res } = await run(ctrl.transferCall, { user: owner, params: { id: LOG_ID } });
    expect(res.statusCode).toBe(200);
    expect(timer).not.toHaveBeenCalledWith(expect.any(Function), ctrl.PHONE_LEG_DROP_MS);
    timer.mockRestore();
  });

  it('a Plivo 404 is still "did not go through" (502), as before', async () => {
    CallLog.findById.mockReturnValue(chain(appCall()));
    axios.request.mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } }));
    const { res } = await run(ctrl.transferCall, { user: owner, params: { id: LOG_ID } });
    expect(res.statusCode).toBe(502);
    expect(res.body.reason).toBe('plivo_failed');
  });
});

describe('dropping the phone leg after a transfer (backstop)', () => {
  it('hangs up only that phone leg if it is still on', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, answeredLegId: PHONE_LEG }));
    await expect(ctrl.dropAnsweredPhoneLeg(LOG_ID)).resolves.toBe(true);
    const calls = plivoCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({ method: 'delete' }));
    expect(calls[0].url).toContain(`/Call/${PHONE_LEG}/`);
    expect(calls[0].url).not.toContain(A_LEG);
    expect(updatesTo()[0].update.$set.answeredLegEndedAt).toBeInstanceOf(Date);
  });

  it('nothing to do once Plivo reported that phone hung up', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, answeredLegId: PHONE_LEG, answeredLegEndedAt: new Date() }));
    await expect(ctrl.dropAnsweredPhoneLeg(LOG_ID)).resolves.toBe(false);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('already gone at Plivo (404): quietly nothing', async () => {
    CallLog.findById.mockReturnValue(chain({ _id: LOG_ID, answeredLegId: PHONE_LEG }));
    axios.request.mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } }));
    await expect(ctrl.dropAnsweredPhoneLeg(LOG_ID)).resolves.toBe(false);
    expect(CallLog.updateOne).not.toHaveBeenCalled();
  });
});
