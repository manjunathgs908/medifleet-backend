/**
 * tests/callbackQueue.test.js
 * ============================================================
 * Missed-call callback queue — the rules that need no database:
 *   - which calls may become a task (only a definitively missed customer
 *     call; never ringing / unconfirmed / test / outgoing / not_routed)
 *   - when a task is due (CALLBACK_DUE_MINUTES, a scheduled time, a miss
 *     that arrives after scheduling) and bad settings falling back
 *   - "Call back" from the queue only places the masked call: it never
 *     writes to the task
 *   - masking of the task JSON by viewer
 * Route permissions are in telecallerAccess.test.js. Concurrency and
 * idempotency need a real MongoDB (unique index, conditional updates) and
 * were checked against an isolated in-memory one.
 * Models and Plivo are mocked — no database, no calls placed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';

const { dueStateOf, dueMinutes, settleSeconds } = require('../utils/callbackDue');
const { queueableReason } = require('../services/callbackQueue');

const MIN = 60 * 1000;
const NOW = new Date('2026-11-01T10:00:00Z').getTime();
const at = (m) => new Date(NOW + m * MIN);

describe('which calls can become a callback task', () => {
  const missed = { direction: 'inbound', context: 'incoming', callbackEligible: true, status: 'missed' };
  it.each([
    ['missed customer call', missed, null],
    ['nobody on duty (no_agents)', { ...missed, status: 'no_agents' }, null],
    ['still ringing / status unconfirmed', { ...missed, status: 'ringing' }, 'not_missed'],
    ['answered', { ...missed, status: 'completed' }, 'not_missed'],
    ['not routed by the CRM', { ...missed, status: 'not_routed' }, 'not_missed'],
    ['a staff ring phone calling in (not eligible)', { ...missed, callbackEligible: undefined }, 'not_eligible'],
    ['a call from before the queue existed', { ...missed, callbackEligible: undefined }, 'not_eligible'],
    ['test ring', { ...missed, direction: 'outbound', context: 'test_ring', status: 'agent_busy' }, 'not_inbound'],
    ['outgoing call, agent leg failed', { ...missed, direction: 'outbound', context: 'lead', status: 'agent_missed' }, 'not_inbound'],
  ])('%s', (_, call, reason) => {
    expect(queueableReason(call)).toBe(reason);
  });

  it('a person may add a not_routed call, and only that', () => {
    expect(queueableReason({ direction: 'inbound', status: 'not_routed' }, { manual: true })).toBe(null);
    expect(queueableReason({ direction: 'inbound', status: 'missed' }, { manual: true })).toBe('not_not_routed');
  });
});

describe('when a callback is due', () => {
  const base = { state: 'open', firstMissedAt: at(-20), lastMissedAt: at(-5), lastQueuedAt: at(-4) };

  it('unscheduled: first missed call + 15 minutes by default', () => {
    const d = dueStateOf(base, { now: NOW, minutes: 15 });
    expect(d.dueAt).toEqual(at(-5));
    expect(d.overdue).toBe(true);
    expect(dueStateOf({ ...base, firstMissedAt: at(-10) }, { now: NOW, minutes: 15 }).overdue).toBe(false);
  });

  it('scheduled after the latest miss: due at the scheduled time', () => {
    const d = dueStateOf({ ...base, nextCallbackAt: at(60), scheduledAt: at(-2) }, { now: NOW, minutes: 15 });
    expect(d.dueAt).toEqual(at(60));
    expect(d.overdue).toBe(false);
  });

  it('a miss that joins AFTER scheduling pulls the due time forward to that miss + threshold', () => {
    const d = dueStateOf({ ...base, nextCallbackAt: at(60), scheduledAt: at(-10), lastMissedAt: at(-11), lastQueuedAt: at(-1) }, { now: NOW, minutes: 15 });
    expect(d.dueAt).toEqual(at(4));
  });

  it('a resolved task has no due time', () => {
    expect(dueStateOf({ ...base, state: 'resolved' }, { now: NOW })).toBe(null);
  });

  it('thresholds come from the environment; bad values fall back', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CALLBACK_DUE_MINUTES = '30';
    expect(dueMinutes()).toBe(30);
    for (const bad of ['0', '-5', 'soon', '100000']) {
      process.env.CALLBACK_DUE_MINUTES = bad;
      expect(dueMinutes()).toBe(15);
    }
    delete process.env.CALLBACK_DUE_MINUTES;
    expect(dueMinutes()).toBe(15);
    process.env.CALLBACK_SETTLE_SECONDS = '0';
    expect(settleSeconds()).toBe(0);
    process.env.CALLBACK_SETTLE_SECONDS = 'x';
    expect(settleSeconds()).toBe(60);
    delete process.env.CALLBACK_SETTLE_SECONDS;
    warn.mockRestore();
  });
});

describe('task JSON masks the number by viewer', () => {
  const CallbackTask = require('../models/CallbackTask');
  const { runAsViewer } = require('../utils/phoneViewer');
  const doc = () => new CallbackTask({ customerPhone: '9886512345', firstMissedAt: at(-5), lastMissedAt: at(-5), resolution: { outcome: 'booked' } });

  it('telecaller: masked only', () => {
    const json = runAsViewer({ role: 'telecaller' }, () => doc().toJSON());
    expect(json.customerMasked).toBe('••••••2345');
    expect(json.customerPhone).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/9886512345/);
  });
  it('owner: full number too; outcome gets its label', () => {
    const json = runAsViewer({ role: 'owner' }, () => doc().toJSON());
    expect(json.customerPhone).toBe('9886512345');
    expect(json.resolution.outcomeLabel).toBe('Booked a trip');
  });
  it('no viewer (webhooks, public): masked only', () => {
    expect(doc().toJSON().customerPhone).toBeUndefined();
  });
});

describe('"Call back" from the queue never resolves the task', () => {
  const TASK_ID = '64b0000000000000000000aa';
  let ctrl; let CallLog; let CallbackTask; let plivo;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../models', () => ({ Trip: { findOne: jest.fn() }, Lead: { findById: jest.fn(), findOne: jest.fn() }, User: { find: jest.fn() } }));
    jest.doMock('../models/Ambulance', () => ({ exists: jest.fn() }));
    jest.doMock('../models/Quote', () => ({ findById: jest.fn() }));
    jest.doMock('../models/WhatsAppLead', () => ({ findById: jest.fn() }));
    jest.doMock('../models/WebrtcDebugEvent', () => ({ create: jest.fn(), insertMany: jest.fn(), find: jest.fn() }));
    jest.doMock('../models/WebrtcEndpoint', () => ({ find: jest.fn(), findOne: jest.fn(), updateMany: jest.fn() }));
    jest.doMock('../models/CallLog', () => ({ create: jest.fn(), findById: jest.fn() }));
    const task = { _id: TASK_ID, customerPhone: '9886512345', trip: undefined, lead: undefined };
    const chain = (v) => ({ select: () => Promise.resolve(v) });
    jest.doMock('../models/CallbackTask', () => ({
      findById: jest.fn(() => chain(task)),
      exists: jest.fn(),
      // Anything that could change a task:
      updateOne: jest.fn(), updateMany: jest.fn(), findOneAndUpdate: jest.fn(), findByIdAndUpdate: jest.fn(), create: jest.fn(), deleteOne: jest.fn(),
    }));
    ctrl = require('../controllers/callController');
    CallLog = require('../models/CallLog');
    CallbackTask = require('../models/CallbackTask');
    plivo = require('../services/plivoService');
    jest.spyOn(plivo, 'callFirstLeg').mockResolvedValue({ requestId: 'req-1' });
    jest.spyOn(plivo, 'logCall').mockImplementation(() => {});
    CallLog.create.mockImplementation(async (d) => ({ ...d, _id: 'log-1', save: jest.fn() }));
  });
  afterAll(() => { jest.resetModules(); jest.dontMock('../models/CallbackTask'); });

  it('places the masked call to the agent first, linked to the task; the task is not written', async () => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const next = jest.fn();
    await ctrl.clickToCall({ body: { callbackTaskId: TASK_ID }, user: { _id: 'u1', role: 'telecaller', name: 'Santosh', phone: '9000000002' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(plivo.callFirstLeg).toHaveBeenCalledWith({ phone: '9000000002', logId: 'log-1' });
    expect(CallLog.create).toHaveBeenCalledWith(expect.objectContaining({ context: 'call_back', callbackTask: TASK_ID, customerPhone: '9886512345' }));
    expect(JSON.stringify(res.body)).not.toMatch(/9886512345/);
    for (const m of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'create', 'deleteOne']) {
      expect(CallbackTask[m]).not.toHaveBeenCalled();
    }
  });
});

describe('the one-open-task index is confirmed before anything is queued', () => {
  let queue; let CallbackTask;
  const load = (indexes, createErr) => {
    jest.resetModules();
    jest.doMock('../models/CallLog', () => ({ find: jest.fn(), findById: jest.fn(), updateOne: jest.fn() }));
    jest.doMock('../models/CallbackTask', () => ({
      createIndexes: jest.fn(async () => { if (createErr) throw createErr; }),
      collection: { indexes: jest.fn(async () => indexes) },
      findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn(),
    }));
    queue = require('../services/callbackQueue');
    CallbackTask = require('../models/CallbackTask');
  };
  const good = [{ name: 'one_open_task_per_number', key: { customerPhone: 1 }, unique: true, partialFilterExpression: { state: 'open' } }];
  let errSpy;
  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());
  afterAll(() => { jest.resetModules(); jest.dontMock('../models/CallLog'); jest.dontMock('../models/CallbackTask'); });

  it.each([
    ['the build fails (e.g. duplicate open tasks already there)', [], Object.assign(new Error('E11000 duplicate key'), { code: 11000 })],
    ['the index is missing after the build', [], null],
    ['the index exists but is not unique', [{ ...good[0], unique: false }], null],
    ['the index is not partial on open tasks', [{ ...good[0], partialFilterExpression: undefined }], null],
  ])('%s -> not ready, sweep blocked, queueCall refuses, logged', async (_, idx, err) => {
    load(idx, err);
    expect(await queue.indexReady()).toBe(false);
    expect((await queue.sweep()).blocked).toBe(true);
    await expect(queue.queueCall('64b0000000000000000000c1')).rejects.toThrow(/index not confirmed/);
    expect(CallbackTask.findOneAndUpdate).not.toHaveBeenCalled();
    expect(CallbackTask.create).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join(' ')).toMatch(/NOT queueing missed calls/);
  });

  it('confirmed once read back from MongoDB, then cached', async () => {
    load(good, null);
    expect(await queue.indexReady()).toBe(true);
    expect(await queue.indexReady()).toBe(true);
    expect(CallbackTask.createIndexes).toHaveBeenCalledTimes(1);
  });
});

describe('a queued call later reported answered is taken off at once', () => {
  let ctrl; let CallLog; let queue;
  const LOG = '64b0000000000000000000d1';
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../models', () => ({ Trip: { findOne: jest.fn() }, Lead: { findById: jest.fn(), findOne: jest.fn() }, User: { find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) } }));
    jest.doMock('../models/CallLog', () => ({ findById: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), create: jest.fn() }));
    jest.doMock('../services/callbackQueue', () => ({ retractAnswered: jest.fn(async () => 'withdrawn') }));
    ctrl = require('../controllers/callController');
    CallLog = require('../models/CallLog');
    queue = require('../services/callbackQueue');
  });
  afterAll(() => { jest.resetModules(); jest.dontMock('../models/CallLog'); jest.dontMock('../services/callbackQueue'); });

  const dial = async (log, DialStatus, applies = true) => {
    CallLog.findById.mockResolvedValue({ ...log, save: jest.fn() });
    CallLog.updateOne.mockResolvedValue({ matchedCount: applies ? 1 : 0 });
    queue.retractAnswered.mockClear();
    const res = { status: () => res, json: () => res, type: () => res, send: () => res, set: () => res };
    await ctrl.events({ method: 'POST', query: { log: LOG, leg: 'dial', stage: 'phone' }, body: { CallUUID: 'A-1', DialStatus }, get: () => undefined }, res, (e) => { if (e) throw e; });
    await new Promise((r) => setImmediate(r));
  };
  const queued = { _id: LOG, direction: 'inbound', status: 'missed', providerCallId: 'A-1', callbackTask: '64b0000000000000000000e1' };

  it('missed -> completed on a queued call: retracted', async () => {
    await dial(queued, 'completed');
    expect(queue.retractAnswered).toHaveBeenCalledWith(LOG);
  });
  it('not when the call was never queued, the report is not "answered", or the update did not apply', async () => {
    await dial({ ...queued, callbackTask: undefined }, 'completed');
    expect(queue.retractAnswered).not.toHaveBeenCalled();
    await dial(queued, 'busy');
    expect(queue.retractAnswered).not.toHaveBeenCalled();
    await dial(queued, 'completed', false);
    expect(queue.retractAnswered).not.toHaveBeenCalled();
  });
});
