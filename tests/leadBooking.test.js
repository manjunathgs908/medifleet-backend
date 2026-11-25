'use strict';
/**
 * tests/leadBooking.test.js — services/leadBooking.js + services/leadConversion.js
 * ============================================================
 * Booking from a lead, against in-memory stores with MongoDB's semantics
 * where they matter: unique _id (E11000), conditional updates, and a
 * transaction that is ALL OR NOTHING (a snapshot is restored on any error).
 * (tests/leadBooking.mongo.test.js runs the same guarantees on a real,
 * isolated MongoDB when one is provided.)
 *
 * Scenarios: who may book; server-side number; one booking per lead;
 * simultaneous submissions and retries; an expired claim taken over while
 * the older request later resumes; failures before the trip, during trip
 * creation, after it and during lead linking; history exactly once; never
 * overwriting an existing lead link.
 * ============================================================
 */
const mockDb = { leads: new Map(), trips: [], claims: new Map(), users: new Map([['u1', { _id: 'u1', name: 'Asha' }], ['o1', { _id: 'o1', name: 'Manjunath' }]]), fail: {} };
const mockClone = (v) => JSON.parse(JSON.stringify(v));
const mockChain = (v) => { const q = { select: () => q, lean: () => q, session: () => q, sort: () => q, limit: () => q, then: (r, j) => Promise.resolve(v == null ? v : mockClone(v)).then(r, j) }; return q; };
const mockMatches = (doc, f) => Object.entries(f).every(([k, v]) => {
  if (k === '$or') return v.some((alt) => mockMatches(doc, alt));
  if (k === 'rev' && v && typeof v === 'object' && '$in' in v) return v.$in.includes(doc.rev ?? null);
  if (v && typeof v === 'object' && '$exists' in v) return v.$exists ? doc[k] !== undefined : doc[k] === undefined;
  if (v === null) return doc[k] == null;
  return String(doc[k]) === String(v);
});
const mockApply = (d, u) => {
  Object.assign(d, u.$set || {});
  Object.keys(u.$unset || {}).forEach((k) => delete d[k]);
  Object.entries(u.$inc || {}).forEach(([k, n]) => { d[k] = (d[k] || 0) + n; });
  Object.entries(u.$push || {}).forEach(([k, v]) => { d[k] = [...(d[k] || []), v]; });
};
const mockStep = async (name) => { if (mockDb.fail[name]) { const f = mockDb.fail[name]; delete mockDb.fail[name]; if (typeof f === 'function') await f(); else throw new Error(`injected failure: ${name}`); } };

jest.mock('../models', () => ({
  Lead: {
    findById: (id) => mockChain(mockDb.leads.get(String(id)) || null),
    findOneAndUpdate: async (f, u) => {
      await mockStep('linkLead');
      const d = mockDb.leads.get(String(f._id));
      if (!d || !mockMatches(d, f)) return null;
      mockApply(d, u); return mockClone(d);
    },
  },
  Trip: {
    create: async ([doc]) => {
      await mockStep('createTrip');
      const t = { _id: `t${mockDb.trips.length + 1}`, tripNumber: `TRP-${mockDb.trips.length + 1}`, status: 'booked', createdAt: new Date(), ...doc };
      mockDb.trips.push(t); return [t];
    },
    findById: (id) => mockChain(mockDb.trips.find((t) => String(t._id) === String(id)) || null),
    // Trips that carry a lead (services/leadBooking.js orphan check).
    find: (f) => mockChain(mockDb.trips.filter((t) => t.leadId != null && String(t.leadId) === String(f.leadId))),
    findOne: (f) => mockChain(mockDb.trips.find((t) => t.leadId != null && String(t.leadId) === String(f.leadId)) || null),
    countDocuments: (f) => mockChain(mockDb.trips.filter((t) => t.leadId != null && String(t.leadId) === String(f.leadId)).length),
  },
  User: { findById: (id) => mockChain(mockDb.users.get(String(id)) || null) },
}));
jest.mock('../models/LeadBookingClaim', () => ({
  create: async (doc) => {
    if (mockDb.claims.has(doc._id)) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    mockDb.claims.set(doc._id, { ...doc }); return doc;
  },
  findById: (id) => mockChain(mockDb.claims.get(id) || null),
  findOneAndUpdate: async (f, u) => {
    const c = mockDb.claims.get(f._id);
    if (!c || !mockMatches(c, f)) return null;
    mockApply(c, u); return mockClone(c);
  },
  updateOne: async (f, u) => {
    await mockStep('claimCheck');
    const c = mockDb.claims.get(f._id);
    if (c && mockMatches(c, f)) { mockApply(c, u); return { matchedCount: 1 }; }
    return { matchedCount: 0 };
  },
  deleteOne: async (f) => {
    const c = mockDb.claims.get(f._id);
    if (c && mockMatches(c, f)) { mockDb.claims.delete(f._id); return { deletedCount: 1 }; }
    return { deletedCount: 0 };
  },
  // All or nothing: snapshot, run, restore on any error.
  startSession: async () => ({
    withTransaction: async (fn) => {
      const snap = { leads: mockClone([...mockDb.leads]), trips: mockClone(mockDb.trips), claims: mockClone([...mockDb.claims]) };
      try { await fn(); } catch (e) {
        mockDb.leads = new Map(snap.leads); mockDb.trips = snap.trips; mockDb.claims = new Map(snap.claims);
        throw e;
      }
    },
    endSession: async () => {},
  }),
}));

const svc = require('../services/leadBooking');
const { convertLead } = require('../services/leadConversion');

const LEAD = '64b0000000000000000000a1';
const STAFF = { _id: 'u1', role: 'telecaller', name: 'Asha' };
const OWNER = { _id: 'o1', role: 'owner', name: 'Manjunath' };
const lead = () => mockDb.leads.get(LEAD);
const conversions = () => (lead().history || []).filter((h) => h.detail?.to === 'converted');

// What createTrip does for a lead booking (controllers/tripController.js).
async function book(user, opts = {}) {
  const r = await svc.claim(LEAD, user, opts);
  if (!r.ok) return r;
  try {
    const trip = await svc.createWithClaim(r.claim, svc.withPhone({ patientName: 'Ravi', patientPhone: '' }, r.lead), (t, session) => convertLead(LEAD, t, user._id, { session }));
    return { ok: true, trip };
  } catch (err) {
    await svc.settle(r.claim);
    if (err.code === 'LEAD_CLAIM_LOST') return { ...(await svc.statusOf(LEAD)), lost: true };
    return { ok: false, error: err.message };
  }
}

beforeEach(() => {
  mockDb.leads = new Map([[LEAD, { _id: LEAD, patientName: 'Ravi', phone: '9986844442', status: 'contacted', assignedTo: 'u1', rev: 2, history: [{ type: 'assigned', detail: { to: 'Asha' } }] }]]);
  mockDb.trips = []; mockDb.claims = new Map(); mockDb.fail = {};
});

describe('who may book, and the protected number', () => {
  test('CRM staff only; unknown lead 404', async () => {
    expect((await svc.claim(LEAD, { role: 'driver' })).status).toBe(403);
    expect((await svc.claim(LEAD, null)).status).toBe(403);
    expect((await svc.claim('nope', OWNER)).status).toBe(404);
    expect((await svc.claim('64b0000000000000000000ff', OWNER)).status).toBe(404);
  });
  test('blank or masked phone -> the lead’s number server-side; a typed number wins', async () => {
    const { lead: l } = await svc.claim(LEAD, STAFF);
    expect(svc.withPhone({ patientPhone: '' }, l).patientPhone).toBe('9986844442');
    expect(svc.withPhone({ patientPhone: '••••••4442' }, l).patientPhone).toBe('9986844442');
    expect(svc.withPhone({ patientPhone: '9876543210' }, l).patientPhone).toBe('9876543210');
  });
});

describe('one booking per lead, history exactly once', () => {
  test('a booking: one trip, lead converted and linked, ONE conversion history entry, assignee kept', async () => {
    const r = await book(STAFF);
    expect(r.ok).toBe(true);
    expect(mockDb.trips).toHaveLength(1);
    expect(lead()).toMatchObject({ status: 'converted', convertedTrip: r.trip._id, assignedTo: 'u1' });
    expect(conversions()).toHaveLength(1);
    expect(conversions()[0]).toMatchObject({ byName: 'Asha', detail: { from: 'contacted', to: 'converted', trip: 'TRP-1' } });
    expect(mockDb.claims.get(LEAD)).toMatchObject({ state: 'done', trip: r.trip._id });
  });

  test('a retry / double tap afterwards: ALREADY_BOOKED with that booking, no second trip or history', async () => {
    const first = await book(STAFF);
    const again = await book(OWNER);
    expect(again).toMatchObject({ code: 'ALREADY_BOOKED', booking: { _id: first.trip._id } });
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
  });

  test('five simultaneous submissions: exactly one trip, the rest IN_PROGRESS or ALREADY_BOOKED', async () => {
    const rs = await Promise.all([STAFF, OWNER, STAFF, OWNER, STAFF].map((u) => book(u)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => ['IN_PROGRESS', 'ALREADY_BOOKED'].includes(r.code))).toBe(true);
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
  });

  test('converting again for the SAME trip writes no second history entry', async () => {
    const r = await book(STAFF);
    expect(await convertLead(LEAD, r.trip, 'u1')).toEqual({ converted: false, reason: 'already_this_trip' });
    expect(conversions()).toHaveLength(1);
  });

  test('a lead linked to a DIFFERENT trip keeps that link (never overwritten)', async () => {
    lead().convertedTrip = 'tOld';
    expect(await convertLead(LEAD, { _id: 'tNew', tripNumber: 'TRP-9' }, 'u1')).toEqual({ converted: false, reason: 'linked_elsewhere' });
    expect(lead().convertedTrip).toBe('tOld');
    expect(conversions()).toHaveLength(0);
  });
});

describe('failures at every step leave nothing half-done', () => {
  test.each([
    ['the claim check (before the trip)', 'claimCheck'],
    ['trip creation', 'createTrip'],
    ['lead linking (after the trip was created)', 'linkLead'],
  ])('failure during %s: no trip, no link, no history; the claim is freed and a retry books exactly once', async (_l, step) => {
    mockDb.fail[step] = true;
    const r = await book(STAFF);
    expect(r.ok).toBe(false);
    expect(mockDb.trips).toHaveLength(0);
    expect(lead().convertedTrip).toBeUndefined();
    expect(conversions()).toHaveLength(0);
    expect(mockDb.claims.has(LEAD)).toBe(false);
    const retry = await book(STAFF);
    expect(retry.ok).toBe(true);
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
  });

  test('a crash with the claim left pending (process died before settle): within the window others wait; after it, ONE takes over and books once', async () => {
    const stuck = await svc.claim(LEAD, STAFF); // never completed, never settled
    expect(stuck.ok).toBe(true);
    expect((await book(OWNER, { now: Date.now() + 60e3 })).code).toBe('IN_PROGRESS');
    const later = Date.now() + svc.STALE_MS + 1000;
    const [a, b] = await Promise.all([book(OWNER, { now: later }), book(STAFF, { now: later })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
  });

  test('an EXPIRED claim taken over while the OLDER request later resumes: the older one cannot create a second trip', async () => {
    const old = await svc.claim(LEAD, STAFF);                   // older request, then stalls
    const newer = await book(OWNER, { now: Date.now() + svc.STALE_MS + 1000 }); // takes over and books
    expect(newer.ok).toBe(true);
    let err = null;                                             // the older request resumes
    try {
      await svc.createWithClaim(old.claim, { patientName: 'Ravi' }, (t, s) => convertLead(LEAD, t, 'u1', { session: s }));
    } catch (e) { err = e; }
    expect(err?.code).toBe('LEAD_CLAIM_LOST');
    expect(await svc.settle(old.claim)).toEqual({ released: false }); // it does not free the newer one's claim
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
    expect(await svc.statusOf(LEAD)).toMatchObject({ code: 'ALREADY_BOOKED', booking: { _id: newer.trip._id } });
  });

  test('older request resumes while the newer one is still mid-booking: still exactly one trip', async () => {
    const old = await svc.claim(LEAD, STAFF);
    const late = Date.now() + svc.STALE_MS + 1000;
    const newerClaim = await svc.claim(LEAD, OWNER, { now: late });
    expect(newerClaim.ok).toBe(true);
    const results = await Promise.allSettled([
      svc.createWithClaim(old.claim, { patientName: 'Ravi' }, (t, s) => convertLead(LEAD, t, 'u1', { session: s })),
      svc.createWithClaim(newerClaim.claim, { patientName: 'Ravi' }, (t, s) => convertLead(LEAD, t, 'o1', { session: s })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(mockDb.trips).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
  });
});
