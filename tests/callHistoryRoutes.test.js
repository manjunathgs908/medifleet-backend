'use strict';
/**
 * GET /api/calls/history and /api/calls/customers through the real router:
 * real JWT + protect() + authorize(OPERATIONS), real CallLog toJSON. Only the
 * database reads are stubbed (the real queries run against MongoDB in
 * tests/callStats.mongo.test.js). Read-only: no write is ever attempted.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { User, Trip, Lead } = require('../models');
const CallLog = require('../models/CallLog');
const { customerRef } = require('../utils/customerPhone');

const PHONE = '9000000777'; // fictional
const USERS = {
  owner: { _id: '64b0000000000000000000b1', role: 'owner', isActive: true, name: 'Owner (test)' },
  telecaller: { _id: '64b0000000000000000000b2', role: 'telecaller', isActive: true, name: 'Asha (test)' },
  driver: { _id: '64b0000000000000000000b3', role: 'driver', isActive: true, name: 'Driver (test)' },
};
const tokenFor = (role) => jwt.sign({ id: USERS[role]._id }, process.env.JWT_SECRET);
const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['select', 'sort', 'limit', 'lean', 'populate', 'allowDiskUse']) q[m] = () => q;
  return q;
};
let server; let base;
const writes = [];

beforeAll(async () => {
  jest.spyOn(User, 'findById').mockImplementation((id) => chain(Object.values(USERS).find((u) => u._id === String(id)) || null));
  jest.spyOn(CallLog, 'find').mockImplementation(() => chain([new CallLog({ provider: 'plivo', direction: 'inbound', context: 'incoming', status: 'completed', customerPhone: PHONE, startedAt: new Date() })]));
  jest.spyOn(CallLog, 'countDocuments').mockResolvedValue(1);
  jest.spyOn(CallLog, 'distinct').mockResolvedValue([]); // the candidates' CallUUIDs
  jest.spyOn(CallLog, 'aggregate').mockImplementation((stages) => {
    const facet = stages.find((s) => s.$facet)?.$facet;
    const value = facet?.rows // "By customer"
      ? [{ total: [{ n: 1 }], rows: [{ _id: PHONE, lastAt: new Date(), firstAt: new Date(), calls: 1, incoming: 1, answered: 1, missed: 0, unconfirmed: 0, outgoing: 0, connected: 0, driverCalls: 0, lastConnectedAt: new Date() }] }]
      : facet?.page // "All call events" with a filter
        ? [{ page: [{ _id: '64b0000000000000000000c1' }], records: [{ n: 1 }], calls: [{ logicalCalls: 1 }] }]
        : [{ logicalCalls: 1 }];
    return chain(value);
  });
  for (const M of [CallLog, Lead, Trip]) for (const w of ['create', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'insertMany']) jest.spyOn(M, w).mockImplementation(() => { writes.push(w); throw new Error('no writes here'); });
  jest.spyOn(Lead, 'find').mockReturnValue(chain([]));
  jest.spyOn(Trip, 'find').mockReturnValue(chain([]));
  const app = express();
  app.use('/api/calls', require('../routes/calls'));
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const get = async (role, path) => {
  const res = await fetch(base + path, { headers: role ? { authorization: `Bearer ${tokenFor(role)}` } : {} });
  return { status: res.status, text: await res.text() };
};

describe.each([['/api/calls/history'], ['/api/calls/customers']])('%s', (path) => {
  test('no login: 401', async () => { expect((await get(null, path)).status).toBe(401); });
  test('a driver: 403', async () => { expect((await get('driver', path)).status).toBe(403); });
  test('telecaller: 200, number masked, never in full', async () => {
    const r = await get('telecaller', path);
    expect(r.status).toBe(200);
    expect(r.text).toContain('••••••0777');
    expect(r.text).not.toContain(PHONE);
  });
  test('owner: 200 with the full number', async () => {
    const r = await get('owner', path);
    expect(r.status).toBe(200);
    expect(r.text).toContain(PHONE);
  });
  test('a telecaller cannot filter by someone else', async () => {
    expect((await get('telecaller', `${path}?staff=${USERS.owner._id}`)).status).toBe(403);
  });
  test('bad input is refused, not guessed', async () => {
    expect((await get('owner', `${path}?period=yesterdayish`)).status).toBe(400);
    expect((await get('owner', `${path}?cursor=%%%`)).status).toBe(400);
    expect((await get('owner', `${path}?from=2026-13-01`)).status).toBe(400);
  });
});
test('history for one customer accepts only an opaque reference', async () => {
  expect((await get('owner', `/api/calls/history?customerRef=${PHONE}`)).status).toBe(400);
  expect((await get('owner', `/api/calls/history?customerRef=${encodeURIComponent(customerRef(PHONE))}`)).status).toBe(200);
});
test('nothing was written', () => { expect(writes).toEqual([]); });
