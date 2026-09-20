/**
 * tests/partnerOnboarding.test.js
 * ============================================================
 * Partner onboarding after the Owner-auto-creation removal, and the rule
 * that attendance and payroll belong to SaveLife's own drivers only.
 *
 * The properties pinned here are the ones that were bugs, or would be
 * expensive ones if they regressed:
 *
 *   - no login path creates an Owner any more, and an unknown number is
 *     answered exactly like a known one (it was a directory, and it minted
 *     unverified Owner rows)
 *   - an Owner is created only after its code is proven, and never with a
 *     kycStatus or isPlatformOwner the registrant chose
 *   - the driver-add 409 cannot be used to discover that a number drives
 *     for a competitor
 *   - an Attendance row is written for a SaveLife driver and not for a
 *     partner's, while the Shift is still recorded for both
 *   - a partner driver never reaches payroll, and getPayslip answers 404
 *     rather than 403 so it cannot sort drivers into ours and theirs
 *   - an Owner has no code path that sets isPlatformOwner on themselves
 *
 * No database and no network: the models and smsService are mocked, so
 * every write is visible here as a call. Follows tests/appAuthOtp.test.js.
 * ============================================================
 */
'use strict';

// Explicit factories, not automock: models/index.js builds real mongoose
// models, and jest's automocker walks a Document's prototype and trips over
// mongoose's internal symbols. Plain objects are also honest about what
// these tests are — the controllers' decisions, not mongoose's behaviour.
const modelStub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
  updateOne: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
});

jest.mock('../models', () => {
  const m = () => ({
    find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
    findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
    updateOne: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
  });
  return {
    User: m(), Trip: m(), Attendance: m(), SalaryRecord: m(),
    Expense: m(), Notification: m(), Advance: m(),
  };
});
jest.mock('../models/Owner',                  () => modelStub());
jest.mock('../models/PartnerRegistrationOtp', () => Object.assign(modelStub(), { MAX_ATTEMPTS: 5 }));
jest.mock('../models/Shift',                  () => modelStub());
jest.mock('../models/Assignment',             () => modelStub());
jest.mock('../models/Ambulance',              () => modelStub());
jest.mock('../models/GeofenceEvent',          () => modelStub());
jest.mock('../utils/smsService',  () => ({ sendOtp: jest.fn() }));
jest.mock('../utils/cloudinary',  () => ({ uploadToCloudinary: jest.fn() }));
// The controllers destructure these, so the test must configure the very
// same function objects rather than reassigning the module's properties.
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver : jest.fn(),
  platformDriverIds: jest.fn(),
  platformOwnerIds : jest.fn(),
}));
jest.mock('../controllers/ambulanceController', () => ({
  computeAmbulanceDisplayStatus: jest.fn(() => 'available'),
}));

const Owner = require('../models/Owner');
const PartnerRegistrationOtp = require('../models/PartnerRegistrationOtp');
const { User, Attendance, SalaryRecord } = require('../models');
const Shift      = require('../models/Shift');
const Assignment = require('../models/Assignment');
const Ambulance  = require('../models/Ambulance');
const smsService = require('../utils/smsService');
const platformOwner = require('../utils/platformOwner');

const ownerCtrl      = require('../controllers/ownerController');
const unified        = require('../controllers/unifiedAuthController');
const authCtrl       = require('../controllers/authController');
const assignmentCtrl = require('../controllers/assignmentController');
const salaryCtrl     = require('../controllers/salaryController');

// Minimal express doubles. `res` records rather than sends.
const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const call = async (handler, req = {}) => {
  const res = mockRes();
  const next = jest.fn();
  await handler({ body: {}, params: {}, query: {}, ...req }, res, next);
  if (next.mock.calls.length && next.mock.calls[0][0]) throw next.mock.calls[0][0];
  return res;
};

// A PartnerRegistrationOtp stand-in carrying the real method contract.
const otpRecord = ({ otp = '123456', expired = false, attempts = 0 } = {}) => ({
  _id: 'otp1',
  phone: '9876543210',
  otp,
  attempts,
  isExpired: () => expired,
  isLocked : () => attempts >= 5,
  matches  : (c) => c === otp,
  save     : jest.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  // clearAllMocks, not resetAllMocks: it wipes recorded calls but keeps the
  // jest.fn identities the controllers destructured at require time.
  jest.clearAllMocks();
  smsService.sendOtp.mockResolvedValue(undefined);
});

// ============================================================
describe('A. no login path creates an Owner', () => {
  test('owners/send-otp on an unknown number creates nothing and sends nothing', async () => {
    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });

    const res = await call(ownerCtrl.sendOtp, { body: { phone: '9876543210', name: 'Someone' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Owner.create).not.toHaveBeenCalled();
    // The old code built `new Owner(...)` and saved it inside this handler.
    expect(smsService.sendOtp).not.toHaveBeenCalled();
  });

  test('unified send-otp on an unknown number creates nothing', async () => {
    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    User.findOne  = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });

    const res = await call(unified.sendOtp, { body: { phone: '9876543210', name: 'Someone' } });

    expect(res.statusCode).toBe(200);
    expect(Owner.create).not.toHaveBeenCalled();
    expect(smsService.sendOtp).not.toHaveBeenCalled();
  });

  test('an unknown number is answered exactly like a known one', async () => {
    // Known: an Owner exists and is sent a code.
    const doc = {
      constructor: { modelName: 'Owner' },
      save: jest.fn().mockResolvedValue(undefined),
    };
    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(doc) });
    User.findOne  = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    const known = await call(unified.sendOtp, { body: { phone: '9876543210' } });

    // Unknown: nothing exists.
    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    User.findOne  = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    const unknown = await call(unified.sendOtp, { body: { phone: '9876543211' } });

    expect(known.statusCode).toBe(unknown.statusCode);
    // Same keys, so the caller cannot tell the two apart. `role` used to be
    // present on one and absent on the other, which was the whole leak.
    expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
    expect(known.body).not.toHaveProperty('role');
  });
});

// ============================================================
describe('B. registration creates the Owner only once the code is proven', () => {
  const goodBody = {
    phone: '9876543210', otp: '123456', name: 'Manjunath', businessName: 'SaveLife',
  };

  test('a wrong code creates nothing and spends an attempt', async () => {
    const rec = otpRecord();
    PartnerRegistrationOtp.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(rec) });

    const res = await call(ownerCtrl.register, { body: { ...goodBody, otp: '999999' } });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('OTP_INVALID');
    expect(Owner.create).not.toHaveBeenCalled();
    expect(rec.attempts).toBe(1);
    expect(rec.save).toHaveBeenCalled();
  });

  test('an expired code creates nothing', async () => {
    PartnerRegistrationOtp.findOne = jest.fn()
      .mockReturnValue({ select: () => Promise.resolve(otpRecord({ expired: true })) });

    const res = await call(ownerCtrl.register, { body: goodBody });

    expect(res.statusCode).toBe(410);
    expect(Owner.create).not.toHaveBeenCalled();
  });

  test('the right code creates the Owner at pending and spends the record', async () => {
    const rec = otpRecord();
    PartnerRegistrationOtp.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(rec) });
    PartnerRegistrationOtp.deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    Owner.create = jest.fn().mockResolvedValue({
      _id: 'o1', name: 'Manjunath', businessName: 'SaveLife', phone: '9876543210', kycStatus: 'pending',
    });

    const res = await call(ownerCtrl.register, { body: goodBody });

    expect(res.statusCode).toBe(201);
    expect(Owner.create).toHaveBeenCalledTimes(1);
    expect(Owner.create.mock.calls[0][0]).toMatchObject({ kycStatus: 'pending' });
    expect(PartnerRegistrationOtp.deleteOne).toHaveBeenCalledWith({ _id: 'otp1' });
    // No session — approval comes first.
    expect(res.body).not.toHaveProperty('accessToken');
  });

  test('the registrant cannot choose kycStatus or isPlatformOwner', async () => {
    PartnerRegistrationOtp.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(otpRecord()) });
    PartnerRegistrationOtp.deleteOne = jest.fn().mockResolvedValue({});
    Owner.create = jest.fn().mockResolvedValue({ _id: 'o1', kycStatus: 'pending' });

    await call(ownerCtrl.register, {
      body: { ...goodBody, kycStatus: 'approved', isPlatformOwner: true },
    });

    const created = Owner.create.mock.calls[0][0];
    expect(created.kycStatus).toBe('pending');
    expect(created).not.toHaveProperty('isPlatformOwner');
  });

  test('businessName is required', async () => {
    const res = await call(ownerCtrl.register, { body: { ...goodBody, businessName: '  ' } });
    expect(res.statusCode).toBe(400);
    expect(Owner.create).not.toHaveBeenCalled();
  });

  test('register/send-otp answers an existing number like a new one, and sends it nothing', async () => {
    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve({ _id: 'o1' }) });
    const existing = await call(ownerCtrl.sendRegistrationOtp, { body: { phone: '9876543210' } });

    Owner.findOne = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    PartnerRegistrationOtp.findOneAndUpdate = jest.fn().mockResolvedValue({});
    const fresh = await call(ownerCtrl.sendRegistrationOtp, { body: { phone: '9876543211' } });

    expect(existing.statusCode).toBe(fresh.statusCode);
    expect(existing.body.success).toBe(true);
    // One SMS in total — the already-registered number got none.
    expect(smsService.sendOtp).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
describe('C. the driver-add 409 reveals nothing', () => {
  test('an existing number is refused without saying why', async () => {
    User.findOne = jest.fn().mockResolvedValue({ _id: 'u1', owner: 'someOtherOwner' });

    const res = await call(authCtrl.createDriverAccount, {
      body: { name: 'A', phone: '9876543210' },
      user: { _id: 'owner1' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe("This number can't be added. Please contact SaveLife support.");
    // Nothing about drivers, owners, or existence.
    expect(res.body.message).not.toMatch(/exist|already|driver|owner|registered/i);
    expect(User.create).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('D. attendance follows isPlatformOwner', () => {
  // endDuty reads a live shift and assignment, then decides on attendance.
  const setupDuty = () => {
    const shift = {
      _id: 's1', status: 'active', shiftStart: new Date(Date.now() - 8 * 3600 * 1000),
      breaks: [], save: jest.fn().mockResolvedValue(undefined),
    };
    const assignment = {
      _id: 'a1', ambulance: 'amb1', active: true, save: jest.fn().mockResolvedValue(undefined),
    };
    Shift.findOne      = jest.fn().mockResolvedValue(shift);
    Assignment.findOne = jest.fn().mockResolvedValue(assignment);
    Ambulance.findById = jest.fn().mockResolvedValue({
      _id: 'amb1', save: jest.fn().mockResolvedValue(undefined),
    });
    Attendance.findOneAndUpdate = jest.fn().mockResolvedValue({});
    return { shift, assignment };
  };

  const driver = { _id: 'd1', shiftHours: 8, shiftType: 'day', owner: 'own1' };

  test('a SaveLife driver gets an Attendance row', async () => {
    const { shift } = setupDuty();
    platformOwner.isPlatformDriver.mockResolvedValue(true);

    await call(assignmentCtrl.endDuty, { body: {}, user: driver });

    expect(Attendance.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(shift.save).toHaveBeenCalled();           // shift still recorded
    expect(shift.status).toBe('ended');
  });

  test("a partner's driver gets no Attendance row, but the Shift is still recorded", async () => {
    const { shift } = setupDuty();
    platformOwner.isPlatformDriver.mockResolvedValue(false);

    await call(assignmentCtrl.endDuty, { body: {}, user: driver });

    expect(Attendance.findOneAndUpdate).not.toHaveBeenCalled();
    expect(shift.save).toHaveBeenCalled();
    expect(shift.status).toBe('ended');
    expect(shift.totalWorkingMinutes).toBeGreaterThan(0);
  });

  test('duty still ends cleanly for a partner driver — the ambulance is released', async () => {
    const { assignment } = setupDuty();
    platformOwner.isPlatformDriver.mockResolvedValue(false);

    const res = await call(assignmentCtrl.endDuty, { body: {}, user: driver });

    expect(res.body.success).toBe(true);
    expect(assignment.active).toBe(false);
  });
});

// ============================================================
describe('E. payroll is SaveLife-only', () => {
  test('calculateSalaries considers only platform drivers', async () => {
    platformOwner.platformDriverIds.mockResolvedValue(['d1']);
    User.find = jest.fn().mockResolvedValue([]);

    await call(salaryCtrl.calculateSalaries, {
      params: { month: '9', year: '2026' }, user: { _id: 'crm1', role: 'owner' },
    });

    expect(User.find).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'driver', _id: { $in: ['d1'] } }),
    );
  });

  test('getPayslip answers 404 for a partner driver — not 403', async () => {
    platformOwner.isPlatformDriver.mockResolvedValue(false);
    SalaryRecord.findOne = jest.fn();

    const res = await call(salaryCtrl.getPayslip, {
      params: { driverId: 'd9', month: '9', year: '2026' },
      user  : { _id: 'd9', role: 'driver', toString: () => 'd9' },
    });

    expect(res.statusCode).toBe(404);
    // 403 would have told the caller the driver exists but is a partner's.
    expect(res.statusCode).not.toBe(403);
    expect(SalaryRecord.findOne).not.toHaveBeenCalled();
  });

  test('getPayrollSummary filters historical rows to platform drivers', async () => {
    platformOwner.platformDriverIds.mockResolvedValue(['d1']);
    // find().populate() and then awaited — no .sort() in this chain.
    SalaryRecord.find = jest.fn().mockReturnValue({ populate: () => Promise.resolve([]) });

    await call(salaryCtrl.getPayrollSummary, {
      params: { month: '9', year: '2026' }, user: { _id: 'crm1', role: 'owner' },
    });

    expect(SalaryRecord.find).toHaveBeenCalledWith(
      expect.objectContaining({ driver: { $in: ['d1'] } }),
    );
  });
});

// ============================================================
describe('F. an Owner cannot make themselves a platform owner', () => {
  const routesSrc = require('fs')
    .readFileSync(require('path').join(__dirname, '..', 'routes', 'owners.js'), 'utf8');

  test('the setter is mounted behind the CRM session, never protectOwner', () => {
    const line = routesSrc.split('\n').find((l) => l.includes('platform-owner'));
    expect(line).toBeDefined();
    expect(line).toMatch(/\bprotect\b/);
    expect(line).not.toMatch(/protectOwner/);
  });

  test('no protectOwner route can write it — registration ignores it entirely', async () => {
    PartnerRegistrationOtp.findOne = jest.fn()
      .mockReturnValue({ select: () => Promise.resolve(otpRecord()) });
    PartnerRegistrationOtp.deleteOne = jest.fn().mockResolvedValue({});
    Owner.create = jest.fn().mockResolvedValue({ _id: 'o1', kycStatus: 'pending' });

    await call(ownerCtrl.register, {
      body: {
        phone: '9876543210', otp: '123456', name: 'X', businessName: 'Y',
        isPlatformOwner: true,
      },
    });

    expect(Owner.create.mock.calls[0][0]).not.toHaveProperty('isPlatformOwner');
  });

  test('the setter rejects a non-boolean rather than coercing it', async () => {
    Owner.findByIdAndUpdate = jest.fn();
    const res = await call(ownerCtrl.setPlatformOwner, {
      params: { id: 'o1' }, body: { isPlatformOwner: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    expect(Owner.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('a CRM admin can set it', async () => {
    Owner.findByIdAndUpdate = jest.fn().mockResolvedValue({
      _id: 'o1', name: 'SaveLife', phone: '9876543210', isPlatformOwner: true,
    });

    const res = await call(ownerCtrl.setPlatformOwner, {
      params: { id: 'o1' }, body: { isPlatformOwner: true },
    });

    expect(res.statusCode).toBe(200);
    expect(Owner.findByIdAndUpdate).toHaveBeenCalledWith('o1', { isPlatformOwner: true }, { new: true });
  });
});
