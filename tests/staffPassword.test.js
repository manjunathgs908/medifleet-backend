'use strict';
/**
 * Telecaller logins: an owner sets / resets the password (PUT
 * /api/auth/users/:id/password), creating one needs a real password and a
 * 10-digit phone, and logging in accepts the phone however it is typed.
 */

jest.mock('../models', () => ({
  User: { findOne: jest.fn(), findById: jest.fn(), create: jest.fn() },
  Trip: {},
}));
jest.mock('../models/Owner', () => ({}));
jest.mock('../models/Ambulance', () => ({}));
jest.mock('../models/Assignment', () => ({}));
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/smsService', () => ({ sendOtp: jest.fn() }));

const { User } = require('../models');
const router = require('../routes/auth');
const authCtrl = require('../controllers/authController');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  q.select = () => q;
  return q;
};
const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.cookie = () => res;
  return res;
};
const layerOf = (path, method) => router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack;

const ID = '64b000000000000000000009';
const telecaller = (over = {}) => ({
  _id: ID, name: 'santosh', role: 'telecaller', phone: '9901995897',
  password: 'old-hash', refreshToken: 'old-refresh',
  save: jest.fn(async function () { return this; }), ...over,
});

async function setPassword(body, user = { _id: 'owner1', role: 'owner' }) {
  const handler = layerOf('/users/:id/password', 'put').at(-1).handle;
  const res = mockRes();
  const next = jest.fn();
  await handler({ params: { id: ID }, body, user }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('owner sets a telecaller\'s password', () => {
  it('only an owner gets past the route guard', () => {
    const guard = layerOf('/users/:id/password', 'put')[1].handle;
    const run = (role) => { let ok = false; guard({ user: { role } }, mockRes(), () => { ok = true; }); return ok; };
    expect(run('owner')).toBe(true);
    expect(run('telecaller')).toBe(false);
    expect(run('driver')).toBe(false);
  });

  it('saves the new password (hashed by the model hook), signs out old sessions, never echoes it', async () => {
    const u = telecaller();
    User.findById.mockReturnValue(chain(u));
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const res = await setPassword({ password: 'Santosh@2026' });
    expect(res.body.success).toBe(true);
    expect(u.password).toBe('Santosh@2026'); // pre-save hook bcrypts it
    expect(u.refreshToken).toBeUndefined();
    expect(u.save).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('Santosh@2026');
    expect(log.mock.calls.flat().join(' ')).not.toContain('Santosh@2026');
    log.mockRestore();
  });

  it('refuses a short or spaced password', async () => {
    for (const password of ['short', 'has space1', '']) {
      const res = await setPassword({ password });
      expect(res.statusCode).toBe(400);
    }
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('only for telecaller logins — not owners or drivers', async () => {
    User.findById.mockReturnValue(chain(telecaller({ role: 'owner' })));
    expect((await setPassword({ password: 'Longenough1' })).statusCode).toBe(400);
    User.findById.mockReturnValue(chain(telecaller({ role: 'driver' })));
    expect((await setPassword({ password: 'Longenough1' })).statusCode).toBe(400);
  });

  it('404 for an unknown user', async () => {
    User.findById.mockReturnValue(chain(null));
    expect((await setPassword({ password: 'Longenough1' })).statusCode).toBe(404);
  });
});

describe('creating a telecaller', () => {
  const register = async (body) => {
    const res = mockRes();
    await authCtrl.register({ body, user: { role: 'owner' } }, res, jest.fn());
    return res;
  };

  it('needs a password of 8+ characters', async () => {
    const res = await register({ name: 'santosh', phone: '9901995897', role: 'telecaller', password: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('stores the 10-digit phone the login form uses', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({ _id: 'u', name: 'santosh', phone: '9901995897', role: 'telecaller' });
    const res = await register({ name: 'santosh', phone: '+91 99019 95897', role: 'telecaller', password: 'Santosh@2026' });
    expect(res.statusCode).toBe(201);
    expect(User.create.mock.calls[0][0]).toEqual(expect.objectContaining({ phone: '9901995897', role: 'telecaller' }));
    expect(JSON.stringify(res.body)).not.toContain('Santosh@2026');
  });
});

describe('logging in', () => {
  it('finds a 10-digit account when the phone is typed with +91 and spaces', async () => {
    const u = { _id: 'u', role: 'telecaller', isActive: true, password: 'h', comparePassword: jest.fn(async () => false) };
    User.findOne.mockImplementation(({ phone }) => chain(phone === '9901995897' ? u : null));
    const res = mockRes();
    await authCtrl.loginPassword({ body: { phone: '+91 99019 95897', password: 'wrong' } }, res, jest.fn());
    expect(User.findOne).toHaveBeenLastCalledWith({ phone: '9901995897' });
    expect(u.comparePassword).toHaveBeenCalledWith('wrong');
    expect(res.statusCode).toBe(401);
  });
});
