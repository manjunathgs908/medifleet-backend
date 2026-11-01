/**
 * tests/callStatusLifecycle.test.js
 * ============================================================
 * Stale "Ringing" call logs. Plivo's reports for one incoming call — the
 * in-app Dial result, the phone Dial result and the hang-up — can arrive
 * late, twice, out of order or at the same moment, and sometimes not at all:
 *
 *   - a hang-up processed before the in-app Dial result must not be undone
 *     (that set calls back to "ringing" and dialled phones for a dead call)
 *   - two reports processed at the same moment must not overwrite each
 *     other: status / end time change only by conditional updates
 *   - a connected call is never turned back into a failure
 *   - a repeated hang-up keeps the first end time; another leg's hang-up
 *     does not end the call
 *   - a call whose final report never came is shown "Status unconfirmed" —
 *     never silently Missed/Completed, and its stored status is untouched
 *   - Plivo's live-call list is trusted only when complete, and asked at
 *     most once per 20s however many CRMs are open
 *
 * Models and Plivo are mocked — no database, no calls placed.
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
  User: { find: jest.fn(), updateOne: jest.fn(), findById: jest.fn() },
}));
jest.mock('../models/Ambulance', () => ({ exists: jest.fn() }));
jest.mock('../models/Quote', () => ({ findById: jest.fn() }));
jest.mock('../models/WhatsAppLead', () => ({ findById: jest.fn() }));
jest.mock('../models/CallLog', () => ({
  create: jest.fn(), findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../models/WebrtcDebugEvent', () => ({ create: jest.fn(async (d) => d), insertMany: jest.fn(), find: jest.fn() }));
jest.mock('../models/WebrtcEndpoint', () => ({ find: jest.fn(), findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  actual.get = jest.fn();
  actual.request = jest.fn(); // Plivo REST
  return actual;
});

const axios = require('axios');
const { User } = require('../models');
const CallLog = require('../models/CallLog');
const ctrl = require('../controllers/callController');
const plivo = require('../services/plivoService');
const RealCallLog = jest.requireActual('../models/CallLog');
const { liveStateOf } = require('../utils/callLiveness');

const LOG_ID = '64b000000000000000000001';
const run = async (handler, req) => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.type = () => res;
  res.send = (b) => { res.body = b; return res; };
  res.set = () => res;
  const next = jest.fn();
  await handler({ body: {}, query: {}, params: {}, get: () => undefined, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

// A tiny stand-in for MongoDB with the semantics that matter here: every
// webhook loads its OWN copy of the call; save() writes only the fields
// that handler changed; updateOne applies only if its condition holds at
// that moment. (The same scenarios also run against a real MongoDB in the
// release check; this keeps them in the normal test suite.)
const store = new Map();
const reviveDates = (k, x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x) ? new Date(x) : x);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), reviveDates));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function loadCopy(id) {
  const raw = store.get(String(id));
  if (!raw) return null;
  const loaded = clone(raw);
  const doc = clone(raw);
  doc.save = jest.fn(async function save() {
    const cur = store.get(String(id));
    for (const k of Object.keys(this)) {
      if (k !== 'save' && !same(this[k], loaded[k])) cur[k] = clone(this[k]);
    }
    return this;
  });
  return doc;
}
function matches(raw, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '_id') return String(raw._id) === String(cond);
    const v = raw[k];
    if (cond === null) return v === undefined || v === null;
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(v);
    if (cond && typeof cond === 'object' && '$ne' in cond) return v !== cond.$ne;
    return v === cond;
  });
}
function useStore() {
  CallLog.findById.mockImplementation(async (id) => loadCopy(id));
  CallLog.findOne.mockImplementation(async (q) => {
    const hit = [...store.values()].find((r) => r.providerCallId === q.providerCallId);
    return hit ? loadCopy(hit._id) : null;
  });
  CallLog.updateOne.mockImplementation(async (filter, update) => {
    const raw = [...store.values()].find((r) => matches(r, filter));
    if (!raw) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    Object.assign(raw, clone(update.$set));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
}
function putCall(over = {}) {
  store.clear();
  store.set(LOG_ID, {
    _id: LOG_ID, direction: 'inbound', context: 'incoming', status: 'ringing',
    providerCallId: 'A-LEG', startedAt: new Date(Date.now() - 60 * 1000),
    flow: ['app:15s'], routing: { decision: 'app_then_phone', appUsers: [] },
    ...over,
  });
  return () => store.get(LOG_ID);
}

const hangup = (body = {}) => run(ctrl.events, {
  method: 'POST', query: {},
  body: { CallUUID: 'A-LEG', Direction: 'inbound', CallStatus: 'completed', HangupCause: 'NORMAL_CLEARING', HangupCauseName: 'Normal Hangup', HangupSource: 'Caller', Duration: '9', ...body },
});
const dialReport = (stage, body) => run(ctrl.events, {
  method: 'POST', query: { log: LOG_ID, leg: 'dial', stage }, body: { From: '918884092777', ...body },
});

// Runs two webhooks so that BOTH load the call before EITHER writes —
// the concurrent case a plain save() gets wrong.
async function concurrently(a, b) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let loads = 0;
  const byId = CallLog.findById.getMockImplementation();
  const byOne = CallLog.findOne.getMockImplementation();
  const hold = (fn) => async (...args) => { const doc = await fn(...args); loads += 1; if (loads === 2) release(); await gate; return doc; };
  CallLog.findById.mockImplementation(hold(byId));
  CallLog.findOne.mockImplementation(hold(byOne));
  try {
    return await Promise.all([a(), b()]);
  } finally {
    CallLog.findById.mockImplementation(byId);
    CallLog.findOne.mockImplementation(byOne);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  ctrl._resetLiveIdsCache();
  User.find.mockReturnValue(chain([{ _id: 'u1', name: 'Desk', callMode: 'phone', phone: '9986844442' }]));
  axios.request.mockRejectedValue(new Error('no Plivo in tests'));
  useStore();
});

describe('out-of-order Plivo reports (one after another)', () => {
  it('REPRO: hang-up first, then the in-app Dial result — the call stays ended, no phones dialled', async () => {
    const call = putCall();
    await hangup();
    expect(call().status).toBe('missed');
    const endedAt = call().endedAt;
    expect(endedAt).toBeInstanceOf(Date);

    const res = await dialReport('app', { DialStatus: 'cancel', DialHangupCause: 'ORIGINATOR_CANCEL' });

    expect(call().status).toBe('missed');            // not set back to "ringing"
    expect(call().endedAt).toEqual(endedAt);
    expect(res.body).not.toContain('<Dial');         // no phone dial for a dead call
    expect(res.body).toContain('<Hangup/>');
    expect(User.find).not.toHaveBeenCalled();        // on-duty phones never looked up
    expect(call().flow.at(-1)).toMatch(/after hangup — not redialled/);
    expect(call().appLeg).toEqual(expect.objectContaining({ DialStatus: 'cancel' })); // diagnostics kept
  });

  it('normal order still works: in-app no answer rings phones, then the hang-up ends it', async () => {
    const call = putCall();
    const res = await dialReport('app', { DialStatus: 'no-answer' });
    expect(res.body).toContain('<Number>919986844442</Number>');
    expect(call().status).toBe('ringing');
    expect(call().dialledPhones).toEqual(['9986844442']);
    await hangup();
    expect(call().status).toBe('missed');
    expect(call().endedAt).toBeInstanceOf(Date);
  });

  it('hang-up before the phone Dial result: an answered call still ends Completed, with who answered', async () => {
    const call = putCall({ flow: ['app:15s', 'app:no-answer→phones:1:40s'] });
    await hangup();
    expect(call().status).toBe('missed');
    await dialReport('phone', { DialStatus: 'completed', DialBLegTo: '919986844442', DialBLegDuration: '30' });
    expect(call()).toEqual(expect.objectContaining({ status: 'completed', talkSec: 30, agentName: 'Desk' }));
  });

  it('a connected call is never turned back into a failure by a late or repeated report', async () => {
    const call = putCall({ status: 'completed', talkSec: 45, agentUser: 'u1', recordingUrl: 'https://x/rec.mp3' });
    await dialReport('phone', { DialStatus: 'no-answer' });
    expect(call()).toEqual(expect.objectContaining({ status: 'completed', talkSec: 45, agentUser: 'u1', recordingUrl: 'https://x/rec.mp3' }));
  });

  it('a repeated hang-up keeps the first end time', async () => {
    const first = new Date(Date.now() - 5000);
    const call = putCall({ status: 'missed', endedAt: first });
    await hangup();
    expect(call().endedAt).toEqual(first);
    expect(call().status).toBe('missed');
  });

  it('another leg\'s hang-up does not end the call', async () => {
    const call = putCall({ direction: 'outbound', context: 'lead', status: 'agent_answered', providerCallId: 'AGENT-LEG' });
    await run(ctrl.events, { method: 'POST', query: { log: LOG_ID }, body: { CallUUID: 'SOME-OTHER-LEG', CallStatus: 'completed' } });
    expect(call().status).toBe('agent_answered');
    expect(call().endedAt).toBeUndefined();
  });
});

describe('concurrent Plivo reports (both load the call before either writes)', () => {
  it('phone answered + hang-up at the same moment: Completed, never overwritten by Missed', async () => {
    const call = putCall({ flow: ['app:15s', 'app:no-answer→phones:1:40s'] });
    await concurrently(
      () => dialReport('phone', { DialStatus: 'completed', DialBLegTo: '919986844442', DialBLegDuration: '30' }),
      () => hangup(),
    );
    expect(call()).toEqual(expect.objectContaining({ status: 'completed', talkSec: 30 }));
    expect(call().endedAt).toBeInstanceOf(Date);
  });

  it('same, other way round', async () => {
    const call = putCall({ flow: ['app:15s', 'app:no-answer→phones:1:40s'] });
    await concurrently(
      () => hangup(),
      () => dialReport('phone', { DialStatus: 'completed', DialBLegTo: '919986844442', DialBLegDuration: '30' }),
    );
    expect(call().status).toBe('completed');
  });

  it('in-app no answer + hang-up at the same moment: ends Missed, not Ringing', async () => {
    const call = putCall();
    await concurrently(() => dialReport('app', { DialStatus: 'no-answer' }), () => hangup());
    expect(call().status).toBe('missed');
    expect(call().endedAt).toBeInstanceOf(Date);
  });

  it('two hang-ups at once: one end time, status Missed', async () => {
    const call = putCall();
    await concurrently(() => hangup(), () => hangup());
    expect(call().status).toBe('missed');
    expect(call().endedAt).toBeInstanceOf(Date);
    const ends = CallLog.updateOne.mock.calls.filter(([, u]) => u.$set.endedAt);
    expect(ends).toHaveLength(2);                                   // both tried …
    expect(ends.every(([f]) => f.endedAt === null)).toBe(true);     // … only while unset
  });

  it('status and end time are only ever written by conditional updates, never by save()', async () => {
    putCall();
    const saves = [];
    const realLoad = CallLog.findById.getMockImplementation();
    CallLog.findById.mockImplementation(async (id) => {
      const d = await realLoad(id);
      const save = d.save;
      d.save = jest.fn(async function wrapped() { saves.push({ status: this.status, endedAt: this.endedAt }); return save.call(this); });
      return d;
    });
    await dialReport('app', { DialStatus: 'no-answer' });
    await hangup();
    await dialReport('phone', { DialStatus: 'completed', DialBLegTo: '919986844442', DialBLegDuration: '5' });
    for (const [filter, update] of CallLog.updateOne.mock.calls) {
      if ('status' in update.$set) expect(filter.status).toBeDefined();
      if ('endedAt' in update.$set) expect(filter.endedAt).toBeNull();
    }
    // Every save() saw the status as it was loaded — it never carried a change.
    expect(saves.every((s) => ['ringing', 'missed'].includes(s.status))).toBe(true);
  });
});

describe('a call whose final report never came', () => {
  const doc = (over) => new RealCallLog({
    provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'ringing',
    customerPhone: '9986844442', providerCallId: 'A-LEG', startedAt: new Date(), ...over,
  });

  it('is shown "Status unconfirmed" — never relabelled Missed/Completed, stored status untouched', () => {
    const stuck = doc({ startedAt: new Date('2026-10-31T10:00:00Z'), trip: '64b0000000000000000000ff', agentName: 'santosh' }).toJSON();
    expect(stuck.status).toBe('ringing');
    expect(stuck.statusUnconfirmed).toBe(true);
    expect(stuck.statusUnconfirmedReason).toBe('too_old');
    expect(String(stuck.trip)).toBe('64b0000000000000000000ff'); // trip link kept
    expect(stuck.agentName).toBe('santosh');                     // attribution kept
  });

  it('hang-up received but no outcome: unconfirmed straight away', () => {
    const j = doc({ endedAt: new Date() }).toJSON();
    expect(j).toEqual(expect.objectContaining({ status: 'ringing', statusUnconfirmed: true, statusUnconfirmedReason: 'hangup_received' }));
  });

  it('a call ringing right now is still active; answered in the app is "in call"', () => {
    expect(doc({}).toJSON()).toEqual(expect.objectContaining({ liveState: 'active' }));
    expect(doc({}).toJSON().statusUnconfirmed).toBeUndefined();
    expect(doc({ answeredAt: new Date() }).toJSON().liveState).toBe('in_call');
  });

  it('final statuses are left alone', () => {
    for (const status of ['completed', 'missed', 'no_agents', 'agent_busy']) {
      const j = doc({ status, startedAt: new Date('2026-10-31T10:00:00Z') }).toJSON();
      expect(j.statusUnconfirmed).toBeUndefined();
      expect(j.liveState).toBeUndefined();
    }
  });

  it('an hour-long call in progress is not flagged before it could have ended', () => {
    expect(liveStateOf({ status: 'ringing', startedAt: new Date(Date.now() - 60 * 60 * 1000), answeredAt: new Date() }).state).toBe('in_call');
    expect(liveStateOf({ status: 'ringing', startedAt: new Date(Date.now() - 64 * 60 * 1000) }).state).toBe('active');
    expect(liveStateOf({ status: 'ringing', startedAt: new Date(Date.now() - 67 * 60 * 1000) }).state).toBe('unconfirmed');
  });
});

describe('Call Logs list: checked against Plivo\'s live calls (read only)', () => {
  const doc = (over) => new RealCallLog({
    provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'ringing', providerCallId: 'A-LEG',
    startedAt: new Date(Date.now() - 10 * 60 * 1000), ...over,
  });
  const listWith = async (logs) => {
    CallLog.find.mockReturnValue(chain(logs));
    const res = await run(ctrl.listLogs, { user: { _id: 'own', role: 'owner' }, query: {} });
    return JSON.parse(JSON.stringify(res.body)).logs;
  };
  const plivoAnswers = (data) => axios.request.mockImplementation(async ({ method, url }) => {
    if (method === 'get' && url.endsWith('/Call/?status=live')) return { data };
    throw new Error(`unexpected ${method} ${url}`);
  });
  const quiet = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

  it('a "ringing" call Plivo no longer has live is shown unconfirmed — and nothing is written', async () => {
    plivoAnswers({ api_id: 'x', calls: ['SOMETHING-ELSE'] });
    // As loaded from the database (not a new, unsaved document).
    const d = RealCallLog.hydrate({
      _id: '64b0000000000000000000aa', provider: 'plivo', direction: 'inbound', context: 'incoming',
      status: 'ringing', providerCallId: 'A-LEG', startedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    d.save = jest.fn();
    const [j] = await listWith([d]);
    expect(j).toEqual(expect.objectContaining({ status: 'ringing', statusUnconfirmed: true, statusUnconfirmedReason: 'not_live_on_plivo' }));
    expect(CallLog.updateOne).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
    expect(d.isModified()).toBe(false);
  });

  it('a call Plivo still has live stays active', async () => {
    plivoAnswers({ calls: ['A-LEG'] });
    const [j] = await listWith([doc({})]);
    expect(j.statusUnconfirmed).toBeUndefined();
    expect(j.liveState).toBe('active');
  });

  it.each([
    ['Plivo down', null],
    ['an unexpected answer', { api_id: 'x', message: 'something else' }],
    ['a page of a longer list', { objects: [{ call_uuid: 'OTHER' }], meta: { next: '/v1/...offset=20', total_count: 45 } }],
    ['a list whose total is bigger than what came back', { objects: [], meta: { next: null, total_count: 3 } }],
    ['ids that are not strings', { calls: [{ call_uuid: 'A-LEG' }] }],
  ])('%s: nothing is flagged', async (_label, data) => {
    const w = quiet();
    if (data) plivoAnswers(data); else axios.request.mockRejectedValue(Object.assign(new Error('down'), { response: { status: 503 } }));
    const [j] = await listWith([doc({})]);
    expect(j.statusUnconfirmed).toBeUndefined();
    expect(j.liveState).toBe('active');
    w.mockRestore();
  });

  it('a complete paged answer is accepted', async () => {
    plivoAnswers({ objects: [{ call_uuid: 'OTHER' }], meta: { next: null, total_count: 1 } });
    const [j] = await listWith([doc({})]);
    expect(j.statusUnconfirmedReason).toBe('not_live_on_plivo');
  });

  it('a call only a few minutes old is not checked; final calls never are', async () => {
    plivoAnswers({ calls: [] });
    await listWith([doc({ startedAt: new Date(Date.now() - 2 * 60 * 1000) }), doc({ status: 'missed' })]);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('bounded: many CRMs polling at once share ONE Plivo request per 20s; a failure is not retried within 20s', async () => {
    plivoAnswers({ calls: ['A-LEG'] });
    await Promise.all(Array.from({ length: 8 }, () => listWith([doc({})])));
    await listWith([doc({})]);
    expect(axios.request).toHaveBeenCalledTimes(1);

    ctrl._resetLiveIdsCache();
    axios.request.mockReset();
    axios.request.mockRejectedValue(new Error('down'));
    const w = quiet();
    await Promise.all(Array.from({ length: 5 }, () => listWith([doc({})])));
    await listWith([doc({})]);
    expect(axios.request).toHaveBeenCalledTimes(1);
    w.mockRestore();
  });

  it('listLiveCallIds throws rather than returning a partial list', async () => {
    plivoAnswers({ objects: [{ call_uuid: 'A' }], meta: { next: '/next', total_count: 30 } });
    await expect(plivo.listLiveCallIds()).rejects.toThrow(/incomplete|unexpected/);
  });
});

describe('performance totals', () => {
  it('counts an ended-without-outcome call as unconfirmed, not ringing, missed or answered', async () => {
    CallLog.find.mockReturnValue(chain([
      { direction: 'inbound', status: 'ringing', startedAt: new Date(Date.now() - 3 * 3600 * 1000) },
      { direction: 'inbound', status: 'ringing', startedAt: new Date() },
      { direction: 'inbound', status: 'missed', startedAt: new Date() },
    ]));
    User.find.mockReturnValue(chain([]));
    const res = await run(ctrl.performance, { user: { _id: 'own', role: 'owner' }, query: { from: new Date(Date.now() - 86400e3).toISOString(), to: new Date(Date.now() + 1000).toISOString() } });
    expect(res.body.team).toEqual(expect.objectContaining({ incoming: 3, missed: 1, answered: 0, inProgress: 1, unconfirmed: 1 }));
  });
});
