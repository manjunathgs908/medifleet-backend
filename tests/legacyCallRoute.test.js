/**
 * tests/legacyCallRoute.test.js
 * ============================================================
 * POST /api/call/connect (routes/callRoutes.js) — still used by the
 * website's tracking page and older driver-app builds. With Plivo
 * configured it must go through Plivo from PLIVO_NUMBER, never Exotel,
 * and its response must not carry either number.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PLIVO_AUTH_ID = 'MAXXXXXXXXXXXXXXXXXX';
process.env.PLIVO_AUTH_TOKEN = 'plivo-test-token';
process.env.PLIVO_NUMBER = '918065591088';
process.env.EXOTEL_SID = 'exotel-sid';
process.env.EXOTEL_API_KEY = 'exotel-key';

jest.mock('../models', () => ({
  Trip: { findOne: jest.fn() },
  Lead: { findOne: jest.fn() },
  User: { find: jest.fn() },
}));
jest.mock('../models/CallLog', () => ({ create: jest.fn() }));
jest.mock('../services/exotelService', () => ({ connectCall: jest.fn() }));
const mockCreateCall = jest.fn();
jest.mock('plivo', () => ({
  ...jest.requireActual('plivo'),
  Client: jest.fn(() => ({ calls: { create: mockCreateCall } })),
}));

const { Trip } = require('../models');
const CallLog = require('../models/CallLog');
const exotel = require('../services/exotelService');
const router = require('../routes/callRoutes');

const connect = router.stack.find((l) => l.route?.path === '/connect').route.stack[0].handle;

const CUSTOMER = '9986844442';
const trip = {
  _id: 't1', patientPhone: CUSTOMER, callLogs: [], save: jest.fn(),
  driver: { _id: 'd1', name: 'Ravi', phone: '9123456789', callPhone: '9876500000' },
};
const populated = (value) => ({ populate: () => Promise.resolve(value) });

const call = async (body) => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  await connect({ body }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  Trip.findOne.mockReturnValue(populated(trip));
  CallLog.create.mockImplementation(async (d) => ({ _id: 'log1', ...d, save: jest.fn() }));
  mockCreateCall.mockResolvedValue({ requestUuid: 'req-1' });
});

it('a customer calling from the tracking page goes through Plivo, from the company number', async () => {
  const res = await call({ tripId: 't1', initiator: 'customer' });

  expect(exotel.connectCall).not.toHaveBeenCalled();
  const [from, to] = mockCreateCall.mock.calls[0];
  expect(from).toBe('918065591088');
  expect(to).toBe(`91${CUSTOMER}`); // the customer started it, so they ring first
  expect(CallLog.create.mock.calls[0][0]).toEqual(expect.objectContaining({
    provider: 'plivo', callerId: '918065591088', firstLeg: 'customer', agentPhone: '9876500000',
  }));
  expect(res.body).toEqual({ success: true, call: { Sid: 'req-1', Status: 'initiated' } });
  expect(JSON.stringify(res.body)).not.toMatch(/9986844442|9876500000|9123456789/);
});

it('a driver on an older app build rings their own call ring number first', async () => {
  await call({ tripId: 't1', initiator: 'driver' });
  expect(exotel.connectCall).not.toHaveBeenCalled();
  expect(mockCreateCall.mock.calls[0][1]).toBe('919876500000');
  expect(CallLog.create.mock.calls[0][0].firstLeg).toBe('agent');
});
