'use strict';
/**
 * The owner's Active/Inactive toggle on the Staff page:
 * PATCH /api/auth/users/:id/status  { isActive: true | false }
 *   - owner only
 *   - drivers and telecallers only; never the caller themselves
 *   - deactivating clears the refresh token and call duty
 *   - a driver on duty can't be deactivated (409 DRIVER_ON_DUTY)
 *   - setting the status it already has is a no-op 200
 *   - the old PUT /users/:id/deactivate is still there
 *   - protect() refuses a deactivated user (the switch actually bites)
 */

jest.mock('../models', () => ({
  User: { findById: jest.fn(), updateOne: jest.fn(), findByIdAndUpdate: jest.fn() },
  Trip: {},
}));
jest.mock('../models/Owner', () => ({}));
jest.mock('../models/Ambulance', () => ({}));
jest.mock('../models/Assignment', () => ({ findOne: jest.fn() }));
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/smsService', () => ({ sendOtp: jest.fn() }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { User } = require('../models');
const Assignment = require('../models/Assignment');
const router = require('../routes/auth');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  q.select = () => q;
  return q;
};
const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const layerOf = (path, method) => router.stack.find((l) => l.route?.path === path && l.route.methods[method])?.route.stack;

const ID = '64b000000000000000000009';
const OWNER = { _id: '64b0000000000000000000a1', role: 'owner' };
const staff = (over = {}) => ({ _id: ID, name: 'santosh', role: 'telecaller', isActive: true, ...over });

async function setStatus(body, { id = ID, user = OWNER } = {}) {
  const handler = layerOf('/users/:id/status', 'patch').at(-1).handle;
  const res = mockRes();
  const next = jest.fn();
  await handler({ params: { id }, body, user }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}

let info;
beforeEach(() => {
  jest.clearAllMocks();
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Assignment.findOne.mockResolvedValue(null);
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => info.mockRestore());

describe('PATCH /api/auth/users/:id/status', () => {
  it('is mounted with protect + owner-only authorize', () => {
    const stack = layerOf('/users/:id/status', 'patch');
    expect(stack).toBeDefined();
    expect(stack).toHaveLength(3); // protect, authorize, handler
    const guard = stack[1].handle;
    const run = (role) => { let ok = false; guard({ user: { role } }, mockRes(), () => { ok = true; }); return ok; };
    expect(run('owner')).toBe(true);
    expect(run('telecaller')).toBe(false);
    expect(run('driver')).toBe(false);
  });

  it('deactivates a telecaller: isActive false, refresh token cleared, call duty off', async () => {
    User.findById.mockReturnValue(chain(staff()));
    const res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: true, user: { _id: ID, isActive: false, role: 'telecaller' } });
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: ID },
      { $set: { isActive: false, callDuty: false }, $unset: { refreshToken: 1 } },
    );
    expect(info.mock.calls.flat().join(' ')).toContain(`by owner=${OWNER._id}`);
  });

  it('reactivates an inactive driver (only isActive is touched)', async () => {
    User.findById.mockReturnValue(chain(staff({ role: 'driver', isActive: false })));
    const res = await setStatus({ isActive: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: true, user: { isActive: true } });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: ID }, { $set: { isActive: true } });
    expect(Assignment.findOne).not.toHaveBeenCalled();
  });

  it('deactivates a driver who is off duty', async () => {
    User.findById.mockReturnValue(chain(staff({ role: 'driver' })));
    const res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(200);
    expect(Assignment.findOne).toHaveBeenCalledWith({ driver: ID, active: true });
    expect(User.updateOne).toHaveBeenCalled();
  });

  it('refuses to deactivate a driver on duty (409 DRIVER_ON_DUTY), changes nothing', async () => {
    User.findById.mockReturnValue(chain(staff({ role: 'driver', name: 'Ravi' })));
    Assignment.findOne.mockResolvedValue({ _id: 'a1', active: true });
    const res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'DRIVER_ON_DUTY' });
    expect(res.body.message).toContain('Ravi');
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('same status again is a no-op 200 (changed: false)', async () => {
    User.findById.mockReturnValue(chain(staff({ isActive: false })));
    const res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: false, user: { isActive: false } });
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('isActive must be a real boolean', async () => {
    for (const body of [{}, { isActive: 'false' }, { isActive: 1 }, { isActive: null }, undefined]) {
      const res = await setStatus(body);
      expect([JSON.stringify(body), res.statusCode]).toEqual([JSON.stringify(body), 400]);
    }
    expect(User.findById).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('owner cannot switch themselves off', async () => {
    const res = await setStatus({ isActive: false }, { id: OWNER._id });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('SELF');
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('owner logins (and anything not driver/telecaller) are refused', async () => {
    User.findById.mockReturnValue(chain(staff({ role: 'owner' })));
    const res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ROLE_NOT_ALLOWED');
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('bad id or unknown user is 404', async () => {
    let res = await setStatus({ isActive: false }, { id: 'not-an-id' });
    expect(res.statusCode).toBe(404);
    expect(User.findById).not.toHaveBeenCalled();
    User.findById.mockReturnValue(chain(null));
    res = await setStatus({ isActive: false });
    expect(res.statusCode).toBe(404);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('a database error goes to next()', async () => {
    User.findById.mockReturnValue(chain(staff()));
    User.updateOne.mockRejectedValue(new Error('boom'));
    await expect(setStatus({ isActive: false })).rejects.toThrow('boom');
  });
});

describe('existing behaviour kept', () => {
  it('PUT /users/:id/deactivate is still mounted, owner-only', () => {
    const stack = layerOf('/users/:id/deactivate', 'put');
    expect(stack).toHaveLength(3);
    let ok = false;
    stack[1].handle({ user: { role: 'telecaller' } }, mockRes(), () => { ok = true; });
    expect(ok).toBe(false);
  });

  it('protect() answers 403 for a deactivated user', async () => {
    const jwt = require('jsonwebtoken');
    const { protect } = require('../middleware/auth');
    User.findById.mockReturnValue(chain(staff({ isActive: false })));
    const token = jwt.sign({ id: ID }, process.env.JWT_SECRET);
    const res = mockRes();
    const next = jest.fn();
    await protect({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
