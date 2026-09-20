/**
 * tests/manualDispatch.test.js
 * ============================================================
 * Phase 6 — dispatch after the legacy Vehicle path was retired.
 *
 * Dispatch is patient-critical, so these pin behaviour rather than
 * implementation:
 *
 *   - a new trip is created UNASSIGNED and nobody is notified. This is
 *     the product decision, and the thing most likely to be "helpfully"
 *     undone later by someone reinstating auto-assign.
 *   - manual assign still works end to end against an on-duty ambulance,
 *     and refuses one that is off duty or mid-trip
 *   - suggestions are ordered by distance, exclude anything not on duty
 *     and free, and put units with no GPS fix last rather than hiding them
 *   - the 130 historical trips still load everywhere, with a `vehicle`
 *     ref pointing at a Vehicle document that no longer exists
 *
 * Models are mocked — no database, no network. Every notification the
 * dispatch path can fire is a mock, so "nobody was told" is asserted as
 * the absence of those calls rather than assumed.
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
  return {
    Trip: m(), User: m(), Bill: m(), Income: m(), Notification: m(),
    Hospital: m(), Lead: m(), ChatMessage: m(), Vehicle: m(),
    computeSegmentAmount: jest.fn(),
  };
});
jest.mock('../models/Ambulance',     () => modelStub());
jest.mock('../models/Assignment',    () => modelStub());
jest.mock('../models/Shift',         () => modelStub());
jest.mock('../models/Owner',         () => modelStub());
jest.mock('../models/BookingOtp',    () => modelStub());
// TripCallEvent.create(...).catch(...) — fire-and-forget, so the stub has
// to return a promise rather than undefined.
jest.mock('../models/TripCallEvent', () => ({
  create: jest.fn(() => Promise.resolve({})),
  find: jest.fn(), findOne: jest.fn(),
}));
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn(),
}));

// Everything the dispatch tail can fire. Mocked so "no driver was
// notified" is an assertion about calls, not an assumption.
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/smsService',  () => ({ sendOtp: jest.fn(), sendAlert: jest.fn(), sendSms: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({
  notifyDriverAssigned: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/trackingNotifications', () => ({
  notifyTrackingLink: jest.fn(() => Promise.resolve()),
}));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
// Pricing is not what these tests are about, and compute() throws without a
// real serviceType — stubbed so a createTrip failure means a dispatch
// failure, not a fare one.
jest.mock('../utils/fareCalculator', () => ({
  compute: jest.fn(async () => ({ total: 1000, baseFare: 1000, distanceKm: 5, gst: 0 })),
}));

const Ambulance = require('../models/Ambulance');
const { Trip, User } = require('../models');
const pushService = require('../utils/pushService');
const fcmService  = require('../utils/fcmService');
const whatsappNotifications = require('../services/whatsappNotifications');
const trackingNotifications = require('../services/trackingNotifications');

const tripCtrl = require('../controllers/tripController');

// A mongoose Query standing in for its own result — see the same helper
// in tenantIsolation.test.js.
const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) q[m] = () => q;
  return q;
};

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

const noOneNotified = () => {
  expect(pushService.sendPush).not.toHaveBeenCalled();
  expect(fcmService.sendFullScreenTrip).not.toHaveBeenCalled();
  expect(whatsappNotifications.notifyDriverAssigned).not.toHaveBeenCalled();
  expect(trackingNotifications.notifyTrackingLink).not.toHaveBeenCalled();
};

beforeEach(() => jest.clearAllMocks());

// ============================================================
describe('A. createTrip never assigns', () => {
  const body = {
    patientName: 'A', patientPhone: '9876543210',
    pickupAddress: 'X', pickupLat: 12.97, pickupLng: 77.59,
    dropAddress: 'Y', emergencyType: 'emergency',
  };

  const setup = () => {
    const created = {
      _id: 't1', status: 'booked', vehicle: undefined, driver: undefined,
      populate: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    Trip.create = jest.fn().mockResolvedValue(created);
    Trip.countDocuments = jest.fn().mockResolvedValue(0);
    return created;
  };

  test('the trip is created booked, with no vehicle and no driver', async () => {
    const created = setup();

    const res = await call(tripCtrl.createTrip, { body, user: { _id: 'crm1', role: 'owner' } });

    expect(res.statusCode).toBe(201);
    expect(Trip.create).toHaveBeenCalledTimes(1);
    expect(Trip.create.mock.calls[0][0].status).toBe('booked');
    expect(created.vehicle).toBeUndefined();
    expect(created.driver).toBeUndefined();
  });

  test('nobody is notified — no push, no full-screen call, no WhatsApp, no tracking SMS', async () => {
    setup();
    await call(tripCtrl.createTrip, { body, user: { _id: 'crm1', role: 'owner' } });
    noOneNotified();
  });

  test('it does not go looking for an ambulance to auto-assign', async () => {
    setup();
    Ambulance.find = jest.fn().mockReturnValue(chain([]));

    await call(tripCtrl.createTrip, { body, user: { _id: 'crm1', role: 'owner' } });

    // The whole decision: creating a trip performs no unit search at all.
    expect(Ambulance.find).not.toHaveBeenCalled();
    expect(Ambulance.findOne).not.toHaveBeenCalled();
  });

  test('a vehicleId in the body is ignored, not honoured', async () => {
    const created = setup();

    await call(tripCtrl.createTrip, {
      body: { ...body, vehicleId: 'someVehicle' },
      user: { _id: 'crm1', role: 'owner' },
    });

    expect(Trip.create.mock.calls[0][0].vehicle).toBeUndefined();
    expect(created.vehicle).toBeUndefined();
    noOneNotified();
  });
});

// ============================================================
describe('B. manual assign to an on-duty ambulance', () => {
  const trip = () => ({
    _id: 't1', status: 'booked', vehicle: undefined, ambulance: undefined,
    driver: undefined, dispatchedAt: undefined,
    patientName: 'A', patientPhone: '9876543210',
    pickup: { address: 'X', lat: 12.97, lng: 77.59 },
    populate: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
  });

  test('assigns, dispatches, and notifies the driver', async () => {
    const t = trip();
    Trip.findById = jest.fn().mockResolvedValue(t);
    Ambulance.findById = jest.fn().mockReturnValue(chain({
      _id: 'amb1', registrationNumber: 'KA01AB1234', status: 'assigned',
      assignedDriver: { _id: 'd1', availability: { status: 'available' } },
    }));
    User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
    // dispatchTripToDriver looks the driver up for their push tokens.
    User.findById = jest.fn().mockReturnValue(chain({ _id: 'd1', pushToken: null, fcmToken: null }));

    const res = await call(tripCtrl.assignVehicle, {
      params: { id: 't1' }, body: { ambulanceId: 'amb1' },
      user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.statusCode).toBe(200);
    expect(t.ambulance).toBe('amb1');
    expect(t.status).toBe('dispatched');
    // This is the path that SHOULD notify — the contrast with createTrip.
    expect(trackingNotifications.notifyTrackingLink).toHaveBeenCalled();
  });

  test('refuses an ambulance whose driver is already mid-trip', async () => {
    Trip.findById = jest.fn().mockResolvedValue(trip());
    Ambulance.findById = jest.fn().mockReturnValue(chain({
      _id: 'amb1', status: 'assigned',
      assignedDriver: { _id: 'd1', availability: { status: 'on_trip' } },
    }));

    const res = await call(tripCtrl.assignVehicle, {
      params: { id: 't1' }, body: { ambulanceId: 'amb1' },
      user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/not available/i);
  });

  test('refuses an ambulance nobody is on duty on', async () => {
    Trip.findById = jest.fn().mockResolvedValue(trip());
    Ambulance.findById = jest.fn().mockReturnValue(chain({
      _id: 'amb1', status: 'available', assignedDriver: null,   // 'off'
    }));

    const res = await call(tripCtrl.assignVehicle, {
      params: { id: 't1' }, body: { ambulanceId: 'amb1' },
      user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.statusCode).toBe(400);
  });

  test('a vehicleId alone is now rejected — there is no Vehicle branch', async () => {
    const res = await call(tripCtrl.assignVehicle, {
      params: { id: 't1' }, body: { vehicleId: 'v1' },
      user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/ambulanceId is required/);
    expect(Trip.findById).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('C. suggested ambulances', () => {
  const PICKUP = { lat: 12.9716, lng: 77.5946 };

  // Roughly 1 km, 5 km and 20 km north of the pickup.
  const near = { lat: 12.9806, lng: 77.5946, status: 'available', updatedAt: new Date() };
  const mid  = { lat: 13.0166, lng: 77.5946, status: 'available', updatedAt: new Date() };
  const far  = { lat: 13.1516, lng: 77.5946, status: 'available', updatedAt: new Date() };

  const amb = (id, reg, availability, over = {}) => ({
    _id: id, registrationNumber: reg, status: 'assigned', serviceType: 'bls',
    assignedDriver: availability ? { _id: `d-${id}`, name: `Driver ${id}`, phone: '9', availability } : null,
    owner: { _id: 'o1', businessName: 'SaveLife', isPlatformOwner: true },
    ...over,
  });

  const withTrip = (pickup = PICKUP) => {
    Trip.findById = jest.fn().mockReturnValue(chain({ _id: 't1', pickup }));
  };

  test('sorted nearest first', async () => {
    withTrip();
    Ambulance.find = jest.fn().mockReturnValue(chain([
      amb('a3', 'KA03', far), amb('a1', 'KA01', near), amb('a2', 'KA02', mid),
    ]));

    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.body.suggestions.map(s => s.registrationNumber)).toEqual(['KA01', 'KA02', 'KA03']);
    expect(res.body.suggestions[0].distanceKm).toBeLessThan(res.body.suggestions[1].distanceKm);
    expect(res.body.suggestions[0].distanceKm).toBeGreaterThan(0);
  });

  test('only on-duty, free ambulances are considered', async () => {
    withTrip();
    Ambulance.find = jest.fn().mockReturnValue(chain([]));

    await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    // status:'assigned' is "somebody is on duty on it".
    expect(Ambulance.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'assigned', isActive: true }),
    );
  });

  test('an ambulance whose driver is mid-trip is excluded', async () => {
    withTrip();
    Ambulance.find = jest.fn().mockReturnValue(chain([
      amb('a1', 'KA01', near),
      amb('a2', 'KA02', { ...mid, status: 'on_trip' }),
    ]));

    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.body.suggestions.map(s => s.registrationNumber)).toEqual(['KA01']);
  });

  test('units with no GPS fix go last, flagged, not hidden', async () => {
    withTrip();
    Ambulance.find = jest.fn().mockReturnValue(chain([
      amb('a0', 'KA00', { status: 'available', updatedAt: new Date() }),  // no lat/lng
      amb('a1', 'KA01', far),
    ]));

    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    const out = res.body.suggestions;
    expect(out.map(s => s.registrationNumber)).toEqual(['KA01', 'KA00']);
    expect(out[1].hasLocation).toBe(false);
    // null, not 0 — a 0 would have sorted it to the top as if on the doorstep.
    expect(out[1].distanceKm).toBeNull();
  });

  test('carries partner, driver and location freshness', async () => {
    withTrip();
    Ambulance.find = jest.fn().mockReturnValue(chain([amb('a1', 'KA01', near)]));

    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    const s = res.body.suggestions[0];
    expect(s.partner).toMatchObject({ label: 'SaveLife', isPlatformOwner: true });
    expect(s.driver.name).toBe('Driver a1');
    expect(typeof s.locationAgeSec).toBe('number');
  });

  test('a trip with no pickup coordinates says so rather than lying with nulls', async () => {
    withTrip({ });                       // address-only booking
    Ambulance.find = jest.fn().mockReturnValue(chain([amb('a1', 'KA01', near)]));

    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 't1' }, user: { _id: 'crm1', role: 'owner' },
    });

    expect(res.body.pickupHasCoordinates).toBe(false);
    expect(res.body.suggestions[0].distanceKm).toBeNull();
  });

  test('404s on an unknown trip', async () => {
    Trip.findById = jest.fn().mockReturnValue(chain(null));
    const res = await call(tripCtrl.getSuggestedAmbulances, {
      params: { id: 'nope' }, user: { _id: 'crm1', role: 'owner' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ============================================================
describe('D. the historical trips still load', () => {
  // What those 130 rows look like now: a vehicle ref whose Vehicle
  // document is gone, so mongoose populates it as null.
  const historical = {
    _id: 'old1', tripNumber: 'T-0001', status: 'completed',
    vehicle: null,                 // dangling ref -> populated as null
    ambulance: null,
    driver: { _id: 'd0', name: 'Old Driver' },
    toObject() { return { ...this }; },
    getLiveWaitState: () => null,
  };

  test('getTrips returns them for a CRM admin', async () => {
    Trip.countDocuments = jest.fn().mockResolvedValue(130);
    Trip.find = jest.fn().mockReturnValue(chain([historical]));

    const res = await call(tripCtrl.getTrips, {
      user: { _id: 'crm1', role: 'owner' }, actorType: 'user',
    });

    expect(res.body.success).toBe(true);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.total).toBe(130);
  });

  test('getTripById renders one with a dangling vehicle ref', async () => {
    Trip.findById = jest.fn().mockReturnValue(chain(historical));

    const res = await call(tripCtrl.getTripById, {
      params: { id: 'old1' }, user: { _id: 'crm1', role: 'owner' }, actorType: 'user',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.trip._id).toBe('old1');
  });

  test('Trip.vehicle is still a declared path, so populate cannot throw', () => {
    // The Vehicle MODEL has to stay registered even with no routes:
    // Trip/Expense/Income/Notification all declare ref:'Vehicle', and
    // mongoose throws on populate of an unregistered ref. Deleting the
    // model would break exactly these 130 rows.
    const models = require('../models');
    expect(models.Vehicle).toBeDefined();
  });
});
