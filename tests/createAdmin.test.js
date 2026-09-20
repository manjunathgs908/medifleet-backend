/**
 * tests/createAdmin.test.js
 * ============================================================
 * scripts/create-admin.js — the bootstrap that creates a CRM admin when
 * there is no admin left to create one with.
 *
 * The properties worth holding still are mostly about what must NOT
 * happen: the password must not be accepted from the command line, must
 * not be hashed here, and must not reach the database as a short one; the
 * script must not overwrite an existing account; and the document it
 * builds must not carry a deviceId, which would lock the new admin out on
 * its very first authenticated request.
 *
 * The model is mocked, so no database is touched and every write is
 * visible here as a call.
 * ============================================================
 */
'use strict';

const {
  parseArgs, buildAdminPayload, createAdmin, PASSWORD_MIN,
} = require('../scripts/create-admin');

// Stand-in for the real User model, carrying the one piece of schema the
// script interrogates. name/phone are the actual required paths on
// models/index.js's userSchema.
const mockUser = ({ existing = null, created = { _id: 'u1' } } = {}) => ({
  findOne: jest.fn().mockResolvedValue(existing),
  create : jest.fn().mockResolvedValue({
    name: 'Manjunath', phone: '9986844442', role: 'owner', isActive: true, ...created,
  }),
  schema : { requiredPaths: () => ['name', 'phone'] },
});

const GOOD = { name: 'Manjunath', phone: '9986844442', password: 'correct-horse' };

// ============================================================
describe('A. the password never comes from the command line', () => {
  test('--password is refused outright, not ignored', () => {
    const r = parseArgs(['--name', 'M', '--phone', '9986844442', '--password', 'hunter2']);
    expect(r.error).toMatch(/cannot be passed on the command line/i);
    expect(r.name).toBeUndefined();
  });

  test('--pass and --pwd are refused too', () => {
    expect(parseArgs(['--name', 'M', '--phone', '9986844442', '--pass', 'x']).error).toBeTruthy();
    expect(parseArgs(['--name', 'M', '--phone', '9986844442', '--pwd=x']).error).toBeTruthy();
  });

  test('a valid invocation parses name and phone and nothing else', () => {
    const r = parseArgs(['--name', '  Manjunath  ', '--phone', '9986844442']);
    expect(r).toEqual({ name: 'Manjunath', phone: '9986844442' });
    expect(r).not.toHaveProperty('password');
  });
});

// ============================================================
describe('B. argument validation', () => {
  test('a missing name is rejected', () => {
    expect(parseArgs(['--phone', '9986844442']).error).toMatch(/--name/);
  });

  test('a missing phone is rejected', () => {
    expect(parseArgs(['--name', 'M']).error).toMatch(/--phone/);
  });

  test.each([
    ['+919986844442', 'a +91 prefix'],
    ['99868444',      'too short'],
    ['1234567890',    'not starting 6-9'],
    ['99868 44442',   'a space'],
  ])('%s is rejected (%s)', (phone) => {
    expect(parseArgs(['--name', 'M', '--phone', phone]).error).toMatch(/valid 10-digit/i);
  });
});

// ============================================================
describe('C. the document it builds', () => {
  const payload = buildAdminPayload(GOOD);

  test('is a CRM admin that can actually log in', () => {
    expect(payload.role).toBe('owner');
    expect(payload.isActive).toBe(true);
  });

  test('carries no deviceId', () => {
    // protect() rejects a request whose token deviceId !== user.deviceId.
    // Password login mints a token with no deviceId, so an admin created
    // with one could log in and then be refused on every call after.
    expect(payload.deviceId).toBeUndefined();
  });

  test('carries no employeeId, pin, or owner link', () => {
    // employeeId is unique+sparse and belongs to the driver DRV-nnn
    // sequence; `owner` links a driver to a fleet Owner, and an admin is
    // not one of anybody's drivers.
    expect(payload.employeeId).toBeUndefined();
    expect(payload.pin).toBeUndefined();
    expect(payload.owner).toBeUndefined();
  });

  test('hands the password over in plaintext for the model to hash', () => {
    // Hashing here would double-hash: the schema's pre('save') fires on any
    // modified password, and the account could never log in.
    expect(payload.password).toBe(GOOD.password);
    expect(payload.password).not.toMatch(/^\$2[aby]\$/);   // not a bcrypt digest
  });

  test('does not look like a payable employee', () => {
    expect(payload.baseSalary).toBe(0);
    expect(payload.perTripBonus).toBe(0);
  });

  test('is not left awaiting approval', () => {
    expect(payload.approvalStatus).toBe('approved');
  });
});

// ============================================================
describe('D. creation', () => {
  test('refuses when a user with that phone already exists', async () => {
    const User = mockUser({ existing: { _id: 'existing1' } });

    const r = await createAdmin(GOOD, { User });

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/i);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('refuses a password under the minimum', async () => {
    const User = mockUser();

    const r = await createAdmin({ ...GOOD, password: 'a'.repeat(PASSWORD_MIN - 1) }, { User });

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(new RegExp(`at least ${PASSWORD_MIN}`));
    // Checked before the lookup, so a bad password costs no query.
    expect(User.findOne).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  test('refuses a missing password', async () => {
    const User = mockUser();
    const r = await createAdmin({ ...GOOD, password: undefined }, { User });
    expect(r.ok).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('creates the admin on a clean database', async () => {
    const User = mockUser();

    const r = await createAdmin(GOOD, { User });

    expect(r.ok).toBe(true);
    expect(User.findOne).toHaveBeenCalledWith({ phone: '9986844442' });
    expect(User.create).toHaveBeenCalledTimes(1);
    expect(User.create.mock.calls[0][0]).toMatchObject({
      name: 'Manjunath', phone: '9986844442', role: 'owner', isActive: true,
    });
  });

  test('reports a required field it does not set, rather than failing at save', async () => {
    const User = mockUser();
    // Simulate someone adding a required field to the User schema later.
    User.schema = { requiredPaths: () => ['name', 'phone', 'department'] };

    const r = await createAdmin(GOOD, { User });

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/department/);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('returns nothing secret', async () => {
    const User = mockUser();

    const r = await createAdmin(GOOD, { User });

    expect(JSON.stringify(r)).not.toContain(GOOD.password);
    expect(r.user).not.toHaveProperty('password');
  });
});
