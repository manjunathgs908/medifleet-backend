/**
 * tests/tenantIsolation.test.js
 * ============================================================
 * Phase 3 — what one partner must never be able to do to another, and
 * what a fleet Owner must never be able to reach at all.
 *
 * Two Owners, A and B, each with one driver and one ambulance. Every
 * owner-facing handler is driven with B's session against A's ids, and
 * the assertion is always the same shape: the database query carried
 * B's owner id, so it could not have matched A's row, and nothing was
 * written.
 *
 * Asserting the FILTER rather than only the 404 is deliberate. A handler
 * that forgot its owner scope would still 404 in a test whose mock
 * returns null, and the test would pass while the isolation was gone.
 * Reading back the predicate is what actually pins it.
 *
 * Also pins the structural reason CRM-only routes are closed to partners:
 * protect() resolves the subject with User.findById, and an Owner lives in
 * the owners collection, so an Owner token 401s. That is easy to undo
 * while "improving" protect(), which is exactly why it is a test.
 * ============================================================
 */
'use strict';

const modelStub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
  updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
});

jest.mock('../models', () => {
  const m = () => ({
    find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
    findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(),
    updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(), countDocuments: jest.fn(),
  });
  return { User: m(), Trip: m(), Attendance: m(), SalaryRecord: m(), Expense: m(), Notification: m(), Advance: m() };
});
jest.mock('../models/Ambulance',     () => modelStub());
jest.mock('../models/Assignment',    () => modelStub());
jest.mock('../models/Shift',         () => modelStub());
jest.mock('../models/Fleet',         () => modelStub());
jest.mock('../models/Owner',         () => modelStub());
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../utils/cloudinary',    () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/smsService',    () => ({ sendOtp: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn(),
}));

// tripController's notification stack, stubbed. expo-server-sdk ships ESM
// and jest cannot parse it, and none of it is reachable from a read path —
// these tests only exercise getTrips/getTripById.
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({
  notifyDriverAssigned: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/trackingNotifications', () => ({
  notifyTrackingLink: jest.fn(() => Promise.resolve()),
}));
jest.mock('../models/BookingOtp',    () => modelStub());
jest.mock('../models/TripCallEvent', () => modelStub());
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const jwt        = require('jsonwebtoken');
const Ambulance  = require('../models/Ambulance');
const Assignment = require('../models/Assignment');
const Fleet      = require('../models/Fleet');
const Owner      = require('../models/Owner');
const { User, Trip } = require('../models');

const ambulanceCtrl  = require('../controllers/ambulanceController');
const assignmentCtrl = require('../controllers/assignmentController');
const authCtrl       = require('../controllers/authController');
const tripCtrl       = require('../controllers/tripController');
const fleetCtrl      = require('../controllers/fleetController');
const auth           = require('../middleware/auth');

// ── the two tenants ──────────────────────────────────────────
const A = { owner: 'ownerA', driver: 'driverA', ambulance: 'ambA', trip: 'tripA' };
const B = { owner: 'ownerB', driver: 'driverB', ambulance: 'ambB', trip: 'tripB' };

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

// A mongoose Query stands in for its own result: every builder method
// returns the query, and awaiting it resolves. Mocking each chain by hand
// made the tests fail on the SHAPE of a call rather than on isolation,
// which is noise — this makes any chain length work.
const chain = (value) => {
  const q = {
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) {
    q[m] = () => q;
  }
  return q;
};

// B's fleet-Owner session.
const asB = (over = {}) => ({ user: { _id: B.owner }, actorType: 'owner', ...over });

// Every owner-scoped lookup misses, because B is asking for A's row.
const missAll = () => {
  Ambulance.findOne = jest.fn().mockReturnValue(chain(null));
  Ambulance.findOneAndUpdate = jest.fn().mockReturnValue(chain(null));
  Ambulance.find = jest.fn().mockReturnValue(chain([]));
  User.findOne = jest.fn().mockReturnValue(chain(null));
  User.findOneAndUpdate = jest.fn().mockReturnValue(chain(null));
  Fleet.findOne = jest.fn().mockReturnValue(chain(null));
};

// Every owner-scoped query must carry the asking owner's id.
const expectScopedTo = (mockFn, ownerId, argIndex = 0) => {
  expect(mockFn).toHaveBeenCalled();
  const filter = mockFn.mock.calls[0][argIndex];
  const scope = filter.owner ?? filter['owner'];
  expect(String(scope)).toBe(String(ownerId));
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe("A. B cannot touch A's ambulances", () => {
  beforeEach(missAll);

  test('cannot read one', async () => {
    const res = await call(ambulanceCtrl.getAmbulanceById, asB({ params: { id: A.ambulance } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, B.owner);
  });

  test('cannot update one', async () => {
    const res = await call(ambulanceCtrl.updateAmbulance,
      asB({ params: { id: A.ambulance }, body: { registrationNumber: 'HACKED' } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, B.owner);
  });

  test('cannot delete one', async () => {
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    const res = await call(ambulanceCtrl.deleteAmbulance, asB({ params: { id: A.ambulance } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOneAndUpdate, B.owner);
  });

  test('cannot upload a document to one', async () => {
    const res = await call(ambulanceCtrl.updateDocument,
      asB({ params: { id: A.ambulance }, body: { docType: 'rc', number: 'X' } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, B.owner);
  });

  test("listing returns only B's fleet", async () => {
    await call(ambulanceCtrl.getAmbulances, asB());
    expectScopedTo(Ambulance.find, B.owner);
  });
});

// ============================================================
describe("B. B cannot roster A's driver, or onto A's ambulance", () => {
  test("cannot assign A's driver to B's own ambulance", async () => {
    Ambulance.findOne = jest.fn().mockResolvedValue({
      _id: B.ambulance, registrationNumber: 'KA02BB2222',
      save: jest.fn(), populate: jest.fn(),
    });
    User.findOne = jest.fn().mockResolvedValue(null);   // A's driver is not in B's fleet

    const res = await call(ambulanceCtrl.setDefaultDriver,
      asB({ params: { id: B.ambulance }, body: { driverId: A.driver } }));

    expect(res.statusCode).toBe(404);
    // The owner filter on the DRIVER lookup is the cross-tenant guard.
    expect(User.findOne).toHaveBeenCalledWith({ _id: A.driver, role: 'driver', owner: B.owner });
    // Identical to "no such driver", so it cannot be used to probe ids.
    expect(res.body.message).toBe('Driver not found in your fleet.');
  });

  test("cannot assign B's own driver to A's ambulance", async () => {
    Ambulance.findOne = jest.fn().mockReturnValue(chain(null));

    const res = await call(ambulanceCtrl.setDefaultDriver,
      asB({ params: { id: A.ambulance }, body: { driverId: B.driver } }));

    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, B.owner);
    expect(User.findOne).not.toHaveBeenCalled();   // never got that far
  });

  test("cannot clear the driver on A's ambulance", async () => {
    Ambulance.findOne = jest.fn().mockReturnValue(chain(null));
    const res = await call(ambulanceCtrl.clearDefaultDriver, asB({ params: { id: A.ambulance } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, B.owner);
  });
});

// ============================================================
describe("C. B cannot manage A's drivers", () => {
  beforeEach(() => {
    User.findOne = jest.fn().mockResolvedValue(null);
    User.findOneAndUpdate = jest.fn().mockResolvedValue(null);
  });

  test('cannot list them — the list is scoped to B', async () => {
    User.find = jest.fn().mockReturnValue(chain([]));
    await call(authCtrl.listDrivers, asB());
    expectScopedTo(User.find, B.owner);
  });

  test('cannot approve', async () => {
    const res = await call(authCtrl.approveDriver, asB({ params: { id: A.driver } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: A.driver, role: 'driver', owner: B.owner });
  });

  test('cannot reject', async () => {
    const res = await call(authCtrl.rejectDriver, asB({ params: { id: A.driver }, body: { reason: 'x' } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: A.driver, role: 'driver', owner: B.owner });
  });

  test('cannot unbind their device', async () => {
    const res = await call(authCtrl.unbindDevice, asB({ params: { id: A.driver } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOne).toHaveBeenCalledWith({ _id: A.driver, role: 'driver', owner: B.owner });
  });

  test('cannot set their shift hours', async () => {
    const res = await call(authCtrl.setDriverShiftHours,
      asB({ params: { id: A.driver }, body: { shiftHours: 12 } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: A.driver, role: 'driver', owner: B.owner });
  });

  test('cannot force-end their duty', async () => {
    const res = await call(assignmentCtrl.forceEndDuty, asB({ params: { driverId: A.driver } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOne).toHaveBeenCalledWith({ _id: A.driver, role: 'driver', owner: B.owner });
  });
});

// ============================================================
describe("D. B's driver cannot start duty on A's ambulance", () => {
  const bDriver = { _id: B.driver, owner: B.owner, approvalStatus: 'approved' };

  test("the picker only ever lists B's fleet", async () => {
    Ambulance.find = jest.fn().mockReturnValue(chain([]));
    await call(assignmentCtrl.getAvailableAmbulances, { user: bDriver });
    expectScopedTo(Ambulance.find, B.owner);
  });

  test("the claim carries B's owner id, so A's ambulance cannot match", async () => {
    Assignment.findOne = jest.fn().mockResolvedValue(null);
    Ambulance.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    Ambulance.findOne = jest.fn().mockReturnValue(chain(null));

    const res = await call(assignmentCtrl.startDuty,
      { user: bDriver, body: { ambulanceId: A.ambulance } });

    expectScopedTo(Ambulance.findOneAndUpdate, B.owner);
    expect(res.statusCode).toBe(409);
    // "not found", never "reserved for X" — B learns nothing about A.
    expect(res.body.message).toBe('Ambulance not found.');
  });

  test("fleet-status shows only B's ambulances", async () => {
    Ambulance.find = jest.fn().mockReturnValue(chain([]));
    await call(assignmentCtrl.getFleetShiftStatus, asB());
    expectScopedTo(Ambulance.find, B.owner);
  });
});

// ============================================================
describe("E. B cannot see A's trips", () => {
  test("getTrips is filtered to B's own ambulances", async () => {
    Ambulance.find = jest.fn().mockReturnValue(chain([{ _id: B.ambulance }]));
    Trip.countDocuments = jest.fn().mockResolvedValue(0);
    Trip.find = jest.fn().mockReturnValue(chain([]));

    await call(tripCtrl.getTrips, asB());

    expectScopedTo(Ambulance.find, B.owner);
    expect(Trip.find.mock.calls[0][0].ambulance).toEqual({ $in: [B.ambulance] });
  });

  test('a crafted ?driverId= cannot widen an Owner\'s scope', async () => {
    Ambulance.find = jest.fn().mockReturnValue(chain([{ _id: B.ambulance }]));
    Trip.countDocuments = jest.fn().mockResolvedValue(0);
    Trip.find = jest.fn().mockReturnValue(chain([]));

    await call(tripCtrl.getTrips, asB({ query: { driverId: A.driver, vehicleId: 'vA' } }));

    const filter = Trip.find.mock.calls[0][0];
    expect(filter.ambulance).toEqual({ $in: [B.ambulance] });
    expect(filter.driver).toBeUndefined();
    expect(filter.vehicle).toBeUndefined();
  });

  test("getTripById 404s on A's trip rather than 403", async () => {
    Trip.findById = jest.fn().mockReturnValue(chain({
      _id: A.trip, ambulance: A.ambulance, driver: null,
      toObject: () => ({ _id: A.trip }), getLiveWaitState: () => null,
    }));
    Ambulance.exists = jest.fn().mockResolvedValue(null);   // not B's

    const res = await call(tripCtrl.getTripById, asB({ params: { id: A.trip } }));

    expect(res.statusCode).toBe(404);
    // 403 would confirm the trip exists.
    expect(res.statusCode).not.toBe(403);
    expect(Ambulance.exists).toHaveBeenCalledWith({ _id: A.ambulance, owner: B.owner });
  });
});

// ============================================================
describe("F. and the same in reverse — A cannot reach B", () => {
  const asA = (over = {}) => ({ user: { _id: A.owner }, actorType: 'owner', ...over });

  test("A cannot read B's ambulance", async () => {
    Ambulance.findOne = jest.fn().mockReturnValue(chain(null));
    const res = await call(ambulanceCtrl.getAmbulanceById, asA({ params: { id: B.ambulance } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Ambulance.findOne, A.owner);
  });

  test("A cannot approve B's driver", async () => {
    User.findOneAndUpdate = jest.fn().mockResolvedValue(null);
    const res = await call(authCtrl.approveDriver, asA({ params: { id: B.driver } }));
    expect(res.statusCode).toBe(404);
    expect(User.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: B.driver, role: 'driver', owner: A.owner });
  });

  test("A cannot read B's fleet", async () => {
    Fleet.findOne = jest.fn().mockReturnValue(chain(null));
    const res = await call(fleetCtrl.getFleetById, asA({ params: { id: 'fleetB' } }));
    expect(res.statusCode).toBe(404);
    expectScopedTo(Fleet.findOne, A.owner);
  });
});

// ============================================================
describe('G. CRM-only routes are unreachable by an Owner token', () => {
  const SECRET = 'test-secret';
  beforeEach(() => { process.env.JWT_SECRET = SECRET; });

  const run = async (mw, token) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    await mw(req, res, next);
    return { res, called: next.mock.calls.length > 0, req };
  };

  test('protect() refuses an Owner token — it resolves subjects in User', async () => {
    // THE structural reason every CRM route is closed to partners. If
    // someone "improves" protect() to also look in owners, salary, SOS,
    // trip-activity, the global advances list and getLiveBoard all open up
    // to every partner at once. This test is the tripwire.
    User.findById = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });

    const token = jwt.sign({ id: B.owner }, SECRET);
    const { res, called } = await run(auth.protect, token);

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/User not found/);
  });

  test('authorize("owner") alone does not separate the two actors', () => {
    // Both pass. Which is exactly why req.actorType exists — this asserts
    // the hazard is real, so the reason for actorType is not lost.
    const mw = auth.authorize('owner');
    for (const actor of [{ role: 'owner' }, { role: 'owner' }]) {
      const next = jest.fn();
      mw({ user: actor }, mockRes(), next);
      expect(next).toHaveBeenCalled();
    }
  });

  test('a driver token is refused by authorize("owner")', () => {
    const next = jest.fn();
    const res = mockRes();
    auth.authorize('owner')({ user: { role: 'driver' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test('protectUserOrOwner tags the actor so controllers can scope', async () => {
    User.findById = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    Owner.findById = jest.fn().mockResolvedValue({ _id: B.owner, isActive: true });

    const token = jwt.sign({ id: B.owner }, SECRET);
    const { called, req } = await run(auth.protectUserOrOwner, token);

    expect(called).toBe(true);
    expect(req.actorType).toBe('owner');
    expect(String(req.user._id)).toBe(B.owner);
  });

  test('protectUserOrOwner still prefers a User, and tags it as one', async () => {
    User.findById = jest.fn().mockReturnValue({
      select: () => Promise.resolve({ _id: 'crm1', isActive: true, role: 'owner', deviceId: undefined }),
    });
    Owner.findById = jest.fn();

    const token = jwt.sign({ id: 'crm1' }, SECRET);
    const { called, req } = await run(auth.protectUserOrOwner, token);

    expect(called).toBe(true);
    expect(req.actorType).toBe('user');
    expect(Owner.findById).not.toHaveBeenCalled();
  });

  test('protectUserOrOwner refuses an unknown subject', async () => {
    User.findById = jest.fn().mockReturnValue({ select: () => Promise.resolve(null) });
    Owner.findById = jest.fn().mockResolvedValue(null);

    const token = jwt.sign({ id: 'ghost' }, SECRET);
    const { res, called } = await run(auth.protectUserOrOwner, token);

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
describe('H. the user-edit whitelist', () => {
  // Exercised through the same allowlist the route uses, kept in step
  // with it by reading the route source — the handler is an inline
  // closure in routes/auth.js with no export to call directly.
  const raw = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

  // Comments stripped first. The handler now carries a note explaining
  // what it used to do, quoting `...safeFields` verbatim, and an assertion
  // that cannot tell running code from a description of deleted code would
  // fail on the documentation of its own fix.
  const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  test('owner is not an editable field on PUT /users/:id', () => {
    const block = src.slice(src.indexOf('const EDITABLE_USER_FIELDS'), src.indexOf('];', src.indexOf('const EDITABLE_USER_FIELDS')));
    expect(block).not.toMatch(/'owner'/);
    expect(block).not.toMatch(/'approvalStatus'/);
    expect(block).not.toMatch(/'deviceId'/);
    expect(block).not.toMatch(/'employeeId'/);
    expect(block).not.toMatch(/'pin'/);
  });

  test('the handler no longer spreads req.body', () => {
    expect(src).not.toMatch(/\.\.\.safeFields/);
  });

  test('moving a driver has its own route and checks for an active duty', () => {
    expect(src).toMatch(/users\/:id\/owner/);
    const block = src.slice(src.indexOf("users/:id/owner"));
    expect(block).toMatch(/Assignment\.findOne/);
    expect(block).toMatch(/active: true/);
    // and clears the roster it leaves behind
    expect(block).toMatch(/Ambulance\.updateMany/);
  });
});
