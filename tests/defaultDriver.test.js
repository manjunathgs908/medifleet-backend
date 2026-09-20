/**
 * tests/defaultDriver.test.js
 * ============================================================
 * Phase 2 — the owner's roster decision (Ambulance.defaultDriver +
 * driverLock), and the security fix that stopped the owner writing the
 * duty system's fields.
 *
 * The properties pinned here are the ones that would be expensive to
 * regress:
 *
 *   - the owner cannot write assignedDriver, and cannot move `status`
 *     while a driver is on duty — status is startDuty's claim latch, and
 *     unlatching it mid-shift lets two drivers take one ambulance
 *   - defaultDriver is scoped to the owner's own drivers, so a partner
 *     cannot roster someone else's driver by posting a raw id
 *   - a driver is the default of at most one ambulance, refused rather
 *     than silently moved
 *   - Remove never leaves an ambulance locked to nobody
 *   - a locked ambulance is hidden from other drivers and sorted first
 *     for its own, and the lock is enforced INSIDE startDuty's single
 *     atomic write, not in a read before it
 *   - shiftHours stays unset rather than defaulted, because "unset" is
 *     what endDuty reads as "skip attendance"
 *
 * The models are mocked — no database, no network. Every write is visible
 * here as a call, which is how the single-write claim in startDuty is
 * asserted rather than assumed.
 * ============================================================
 */
'use strict';

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
  return { User: m(), Trip: m(), Attendance: m(), SalaryRecord: m(), Expense: m(), Notification: m(), Advance: m() };
});
jest.mock('../models/Ambulance',  () => modelStub());
jest.mock('../models/Assignment', () => modelStub());
jest.mock('../models/Shift',      () => modelStub());
jest.mock('../models/Fleet',      () => modelStub());
jest.mock('../models/Owner',      () => modelStub());
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/smsService', () => ({ sendOtp: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn(),
}));

const Ambulance  = require('../models/Ambulance');
const Assignment = require('../models/Assignment');
const { User }   = require('../models');

const ambulanceCtrl  = require('../controllers/ambulanceController');
const assignmentCtrl = require('../controllers/assignmentController');
const authCtrl       = require('../controllers/authController');

const OWNER = 'owner1';
const DRIVER = 'driver1';
const OTHER_DRIVER = 'driver2';

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

const ownerReq = (over = {}) => ({ user: { _id: OWNER }, ...over });

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('A. the owner cannot write the duty system\'s fields', () => {
  test('updateAmbulance rejects assignedDriverId', async () => {
    const res = await call(ambulanceCtrl.updateAmbulance,
      ownerReq({ params: { id: 'amb1' }, body: { assignedDriverId: DRIVER } }));

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ASSIGNED_DRIVER_READ_ONLY');
    // Refused before the ambulance is even loaded.
    expect(Ambulance.findOne).not.toHaveBeenCalled();
  });

  test('updateAmbulance rejects clearing assignedDriver with null too', async () => {
    const res = await call(ambulanceCtrl.updateAmbulance,
      ownerReq({ params: { id: 'amb1' }, body: { assignedDriverId: null } }));
    expect(res.statusCode).toBe(400);
  });

  test('createAmbulance rejects assignedDriverId', async () => {
    const res = await call(ambulanceCtrl.createAmbulance,
      ownerReq({ body: { registrationNumber: 'KA01AB1234', serviceType: 'bls', assignedDriverId: DRIVER } }));

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ASSIGNED_DRIVER_READ_ONLY');
    expect(Ambulance.create).not.toHaveBeenCalled();
  });

  test("updateAmbulance rejects status:'assigned' — that is the duty system's", async () => {
    Ambulance.findOne = jest.fn().mockResolvedValue({ _id: 'amb1', save: jest.fn() });

    const res = await call(ambulanceCtrl.updateAmbulance,
      ownerReq({ params: { id: 'amb1' }, body: { status: 'assigned' } }));

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('STATUS_NOT_OWNER_SETTABLE');
  });

  test('updateAmbulance refuses a maintenance flip while a driver is on duty', async () => {
    const amb = { _id: 'amb1', save: jest.fn() };
    Ambulance.findOne = jest.fn().mockResolvedValue(amb);
    Assignment.findOne = jest.fn().mockReturnValue({
      populate: () => Promise.resolve({ _id: 'a1', driver: { name: 'Ravi' } }),
    });

    const res = await call(ambulanceCtrl.updateAmbulance,
      ownerReq({ params: { id: 'amb1' }, body: { status: 'maintenance' } }));

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('AMBULANCE_ON_DUTY');
    expect(res.body.message).toMatch(/Ravi/);
    expect(amb.save).not.toHaveBeenCalled();
  });

  test('updateAmbulance allows maintenance when nobody is on duty', async () => {
    const amb = { _id: 'amb1', save: jest.fn().mockResolvedValue(undefined) };
    Ambulance.findOne = jest.fn().mockResolvedValue(amb);
    Assignment.findOne = jest.fn().mockReturnValue({ populate: () => Promise.resolve(null) });

    const res = await call(ambulanceCtrl.updateAmbulance,
      ownerReq({ params: { id: 'amb1' }, body: { status: 'maintenance' } }));

    expect(res.statusCode).toBe(200);
    expect(amb.status).toBe('maintenance');
    expect(amb.save).toHaveBeenCalled();
  });
});

// ============================================================
describe('B. setting the default driver', () => {
  const approvedDriver = { _id: DRIVER, name: 'Ravi', role: 'driver', owner: OWNER, approvalStatus: 'approved' };
  const amb = () => ({
    _id: 'amb1', registrationNumber: 'KA01AB1234',
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  });

  test('requires a driverId', async () => {
    const res = await call(ambulanceCtrl.setDefaultDriver, ownerReq({ params: { id: 'amb1' }, body: {} }));
    expect(res.statusCode).toBe(400);
  });

  test('rejects an unknown driverLock', async () => {
    const res = await call(ambulanceCtrl.setDefaultDriver,
      ownerReq({ params: { id: 'amb1' }, body: { driverId: DRIVER, driverLock: 'welded' } }));
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/open, preferred, locked/);
  });

  test("looks the driver up scoped to the owner's own fleet", async () => {
    Ambulance.findOne = jest.fn().mockResolvedValue(amb());
    User.findOne = jest.fn().mockResolvedValue(null);

    const res = await call(ambulanceCtrl.setDefaultDriver,
      ownerReq({ params: { id: 'amb1' }, body: { driverId: OTHER_DRIVER } }));

    // The owner filter is the cross-tenant guard — without it an owner
    // could roster another partner's driver by posting a raw id.
    expect(User.findOne).toHaveBeenCalledWith({ _id: OTHER_DRIVER, role: 'driver', owner: OWNER });
    expect(res.statusCode).toBe(404);
    // Same answer as "does not exist", so it cannot be used to probe ids.
    expect(res.body.message).toBe('Driver not found in your fleet.');
  });

  test('refuses an unapproved driver', async () => {
    Ambulance.findOne = jest.fn().mockResolvedValue(amb());
    User.findOne = jest.fn().mockResolvedValue({ ...approvedDriver, approvalStatus: 'pending' });

    const res = await call(ambulanceCtrl.setDefaultDriver,
      ownerReq({ params: { id: 'amb1' }, body: { driverId: DRIVER } }));

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DRIVER_NOT_APPROVED');
  });

  test('refuses when the driver already holds another ambulance, and names it', async () => {
    const target = amb();
    Ambulance.findOne = jest.fn()
      .mockResolvedValueOnce(target)                                   // the target
      .mockReturnValueOnce({ select: () => Promise.resolve({           // the clash
        _id: 'amb2', registrationNumber: 'KA05CD9999',
      }) });
    User.findOne = jest.fn().mockResolvedValue(approvedDriver);

    const res = await call(ambulanceCtrl.setDefaultDriver,
      ownerReq({ params: { id: 'amb1' }, body: { driverId: DRIVER } }));

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DRIVER_ALREADY_ASSIGNED');
    expect(res.body.message).toMatch(/KA05CD9999/);
    expect(res.body.conflict.registrationNumber).toBe('KA05CD9999');
    // Crucially: the other ambulance is NOT silently cleared. A silent
    // clear on a 'locked' vehicle would leave it locked to nobody.
    expect(target.save).not.toHaveBeenCalled();
  });

  test('assigns, and sets the lock when given one', async () => {
    const target = amb();
    Ambulance.findOne = jest.fn()
      .mockResolvedValueOnce(target)
      .mockReturnValueOnce({ select: () => Promise.resolve(null) });
    User.findOne = jest.fn().mockResolvedValue(approvedDriver);

    const res = await call(ambulanceCtrl.setDefaultDriver,
      ownerReq({ params: { id: 'amb1' }, body: { driverId: DRIVER, driverLock: 'locked' } }));

    expect(res.statusCode).toBe(200);
    expect(target.defaultDriver).toBe(DRIVER);
    expect(target.driverLock).toBe('locked');
    expect(target.save).toHaveBeenCalled();
    // Never touches the duty field.
    expect(target.assignedDriver).toBeUndefined();
  });

  test('leaves driverLock alone when not supplied', async () => {
    const target = amb();
    target.driverLock = 'preferred';
    Ambulance.findOne = jest.fn()
      .mockResolvedValueOnce(target)
      .mockReturnValueOnce({ select: () => Promise.resolve(null) });
    User.findOne = jest.fn().mockResolvedValue(approvedDriver);

    await call(ambulanceCtrl.setDefaultDriver, ownerReq({ params: { id: 'amb1' }, body: { driverId: DRIVER } }));

    expect(target.driverLock).toBe('preferred');
  });

  test('Remove clears the lock too, so no ambulance is left locked to nobody', async () => {
    const target = { _id: 'amb1', registrationNumber: 'KA01AB1234', defaultDriver: DRIVER,
      driverLock: 'locked', save: jest.fn().mockResolvedValue(undefined) };
    Ambulance.findOne = jest.fn().mockResolvedValue(target);

    const res = await call(ambulanceCtrl.clearDefaultDriver, ownerReq({ params: { id: 'amb1' } }));

    expect(res.statusCode).toBe(200);
    expect(target.defaultDriver).toBeNull();
    // 'locked' with no defaultDriver is an ambulance nobody can claim.
    expect(target.driverLock).toBe('open');
  });
});

// ============================================================
describe('C. what a driver is offered at start-duty', () => {
  const driverReq = { user: { _id: DRIVER, owner: OWNER } };

  const rows = (list) => {
    Ambulance.find = jest.fn().mockReturnValue({
      select: () => ({ sort: () => Promise.resolve(list) }),
    });
  };

  test('the query excludes ambulances locked to someone else', async () => {
    rows([]);
    await call(assignmentCtrl.getAvailableAmbulances, driverReq);

    const filter = Ambulance.find.mock.calls[0][0];
    expect(filter.owner).toBe(OWNER);
    expect(filter.status).toBe('available');
    expect(filter.$or).toEqual([
      { driverLock: { $ne: 'locked' } },
      { driverLock: 'locked', defaultDriver: DRIVER },
    ]);
  });

  test("the driver's own ambulance comes first and is flagged", async () => {
    rows([
      { _id: 'a', registrationNumber: 'KA01AA1111', defaultDriver: OTHER_DRIVER, driverLock: 'preferred' },
      { _id: 'b', registrationNumber: 'KA09ZZ9999', defaultDriver: DRIVER,       driverLock: 'locked'    },
      { _id: 'c', registrationNumber: 'KA02BB2222', defaultDriver: null,          driverLock: 'open'      },
    ]);

    const res = await call(assignmentCtrl.getAvailableAmbulances, driverReq);
    const out = res.body.ambulances;

    expect(out[0].registrationNumber).toBe('KA09ZZ9999');
    expect(out[0].isMyDefault).toBe(true);
    // The rest keep registration order.
    expect(out.slice(1).map((a) => a.registrationNumber)).toEqual(['KA01AA1111', 'KA02BB2222']);
    expect(out.slice(1).every((a) => a.isMyDefault === false)).toBe(true);
  });

  test('a driver with no owner link is told, not shown the platform', async () => {
    const res = await call(assignmentCtrl.getAvailableAmbulances, { user: { _id: DRIVER } });
    expect(res.statusCode).toBe(403);
    expect(Ambulance.find).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('D. startDuty — the lock is part of the atomic claim', () => {
  const driver = { _id: DRIVER, owner: OWNER, approvalStatus: 'approved' };

  beforeEach(() => {
    Assignment.findOne = jest.fn().mockResolvedValue(null);   // not already on duty
  });

  test('the lock clause is INSIDE the findOneAndUpdate filter', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue({
      select: () => ({ populate: () => Promise.resolve(null) }),
    });

    await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'amb1' } });

    const [filter, update] = Ambulance.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toBe('available');          // the availability latch
    expect(filter.owner).toBe(OWNER);                 // the tenant guard
    expect(filter.$or).toEqual([                      // ...and the lock, same filter
      { driverLock: { $ne: 'locked' } },
      { driverLock: 'locked', defaultDriver: DRIVER },
    ]);
    expect(update).toEqual({ status: 'assigned', assignedDriver: DRIVER });
  });

  test('the claim is still exactly one write', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue({
      select: () => ({ populate: () => Promise.resolve(null) }),
    });

    await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'amb1' } });

    // One conditional write decides both "is it free" and "may I have it".
    // A pre-check would be check-then-act and reopen the race.
    expect(Ambulance.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Ambulance.updateOne).not.toHaveBeenCalled();
  });

  test('losing the race reports "just taken", not a lock error', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue({
      select: () => ({ populate: () => Promise.resolve({
        _id: 'amb1', registrationNumber: 'KA01AB1234', status: 'assigned',
        driverLock: 'open', defaultDriver: null,
      }) }),
    });

    const res = await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'amb1' } });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('AMBULANCE_TAKEN');
  });

  test('being locked out names the driver it is reserved for', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue({
      select: () => ({ populate: () => Promise.resolve({
        _id: 'amb1', registrationNumber: 'KA01AB1234', status: 'available',
        driverLock: 'locked', defaultDriver: { _id: OTHER_DRIVER, name: 'Suresh' },
      }) }),
    });

    const res = await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'amb1' } });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('AMBULANCE_LOCKED');
    expect(res.body.message).toMatch(/Suresh/);
  });

  test('a locked ambulance still claims for its own driver', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'amb1', registrationNumber: 'KA01AB1234' });
    Assignment.create = jest.fn().mockResolvedValue({ _id: 'as1' });
    const Shift = require('../models/Shift');
    Shift.create = jest.fn().mockResolvedValue({ _id: 's1' });

    const res = await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'amb1' } });

    expect(res.statusCode).toBe(201);
    expect(Ambulance.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('another partner\'s ambulance reports not found, not locked', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue({
      select: () => ({ populate: () => Promise.resolve(null) }),   // owner-scoped miss
    });

    const res = await call(assignmentCtrl.startDuty, { user: driver, body: { ambulanceId: 'foreign' } });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('Ambulance not found.');
  });
});

// ============================================================
describe('E. shiftHours', () => {
  test('is rejected when not 8, 12 or 24', async () => {
    User.findOne = jest.fn().mockResolvedValue(null);

    const res = await call(authCtrl.createDriverAccount,
      ownerReq({ body: { name: 'Ravi', phone: '9876543210', shiftHours: 10 } }));

    expect(res.statusCode).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('stays undefined when not supplied — never defaulted', async () => {
    User.findOne = jest.fn().mockResolvedValue(null);
    User.find = jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    User.create = jest.fn().mockResolvedValue({ _id: 'd1', name: 'Ravi', phone: '9876543210' });

    await call(authCtrl.createDriverAccount, ownerReq({ body: { name: 'Ravi', phone: '9876543210' } }));

    // "unset" is what endDuty reads as "not configured, skip attendance".
    // Defaulting to 8 here would start writing attendance against a shift
    // length nobody chose.
    expect(User.create.mock.calls[0][0].shiftHours).toBeUndefined();
  });

  test('is stored when supplied', async () => {
    User.findOne = jest.fn().mockResolvedValue(null);
    User.find = jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    User.create = jest.fn().mockResolvedValue({ _id: 'd1', name: 'Ravi', phone: '9876543210' });

    await call(authCtrl.createDriverAccount,
      ownerReq({ body: { name: 'Ravi', phone: '9876543210', shiftHours: 12 } }));

    expect(User.create.mock.calls[0][0].shiftHours).toBe(12);
  });

  test('the edit endpoint is scoped to the owner\'s own driver', async () => {
    User.findOneAndUpdate = jest.fn().mockResolvedValue({ _id: DRIVER, name: 'Ravi', shiftHours: 8 });

    const res = await call(authCtrl.setDriverShiftHours,
      ownerReq({ params: { id: DRIVER }, body: { shiftHours: 8 } }));

    expect(res.statusCode).toBe(200);
    expect(User.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: DRIVER, role: 'driver', owner: OWNER });
    expect(User.findOneAndUpdate.mock.calls[0][1]).toEqual({ shiftHours: 8 });
  });

  test('null clears it with $unset, not a null write', async () => {
    User.findOneAndUpdate = jest.fn().mockResolvedValue({ _id: DRIVER, name: 'Ravi' });

    const res = await call(authCtrl.setDriverShiftHours,
      ownerReq({ params: { id: DRIVER }, body: { shiftHours: null } }));

    expect(res.statusCode).toBe(200);
    // The enum would reject null; absent is the state endDuty reads.
    expect(User.findOneAndUpdate.mock.calls[0][1]).toEqual({ $unset: { shiftHours: '' } });
  });

  test('rejects a bad value on edit too', async () => {
    User.findOneAndUpdate = jest.fn();
    const res = await call(authCtrl.setDriverShiftHours,
      ownerReq({ params: { id: DRIVER }, body: { shiftHours: 6 } }));

    expect(res.statusCode).toBe(400);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
