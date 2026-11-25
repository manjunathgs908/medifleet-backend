'use strict';
/**
 * GET /api/trips (the CRM Trips page) carries the opaque customerRef for
 * "View customer" — only for a CRM owner/telecaller User; a driver and a
 * fleet partner (also role 'owner', actorType 'owner') get the response they
 * always got. The number itself never appears for a telecaller.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

const { Trip } = require('../models');
const Ambulance = require('../models/Ambulance');
const ctrl = require('../controllers/tripController');
const { runAsViewer } = require('../utils/phoneViewer');
const { phoneFromRef } = require('../utils/customerPhone');

const PHONE = '9000000888'; // fictional
const chain = (v) => { const q = { then: (r, j) => Promise.resolve(v).then(r, j) }; for (const m of ['populate', 'sort', 'skip', 'limit', 'select', 'lean']) q[m] = () => q; return q; };

beforeEach(() => {
  jest.spyOn(Trip, 'countDocuments').mockResolvedValue(1);
  jest.spyOn(Trip, 'find').mockImplementation(() => chain([new Trip({ patientName: 'Meena (test)', patientPhone: PHONE, pickup: { address: 'x' }, status: 'booked' })]));
  jest.spyOn(Ambulance, 'find').mockReturnValue(chain([]));
});
afterEach(() => jest.restoreAllMocks());

async function list(user, actorType) {
  let text;
  await new Promise((resolve, reject) => runAsViewer(actorType === 'user' ? user : null, () => {
    ctrl.getTrips({ query: {}, user, actorType }, { json(b) { text = JSON.stringify(b); resolve(); } }, reject);
  }));
  return { text, body: JSON.parse(text) };
}

test('telecaller: customerRef present, number masked', async () => {
  const { text, body } = await list({ _id: 'u1', role: 'telecaller' }, 'user');
  expect(phoneFromRef(body.trips[0].customerRef)).toContain(PHONE);
  expect(text).not.toContain(PHONE);
  expect(body.trips[0].patientPhoneMasked).toBe('••••••0888');
});
test('CRM owner: customerRef present (and the full number, as before)', async () => {
  const { body } = await list({ _id: 'u2', role: 'owner' }, 'user');
  expect(body.trips[0].customerRef).toBeTruthy();
  expect(body.trips[0].patientPhone).toBe(PHONE);
});
test('fleet partner (role owner, actorType owner): no customerRef', async () => {
  const { body } = await list({ _id: 'o1', role: 'owner' }, 'owner');
  expect(body.trips[0].customerRef).toBeUndefined();
});
test('driver: no customerRef (driver app response unchanged apart from what it already had)', async () => {
  const { body } = await list({ _id: 'd1', role: 'driver' }, 'user');
  expect(body.trips[0].customerRef).toBeUndefined();
  expect('callNumber' in body.trips[0]).toBe(true);
});
