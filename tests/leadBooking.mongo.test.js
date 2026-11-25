'use strict';
/**
 * tests/leadBooking.mongo.test.js
 * ============================================================
 * Booking from a lead against a REAL, ISOLATED MongoDB (a throwaway local
 * replica set — transactions need one). Skipped unless MONGO_TEST_URL is set,
 * and refuses anything that is not localhost with a medifleet_test_* database,
 * so it can never touch production.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_leadbooking?replicaSet=rs0 npx jest tests/leadBooking.mongo.test.js
 *
 * Same guarantees as tests/leadBooking.test.js, with the real models,
 * the real unique _id, real conditional updates and real transactions:
 * simultaneous submissions, retries, an expired claim taken over while the
 * older request resumes, failures before/after trip creation and during
 * lead linking, conversion history exactly once.
 * ============================================================
 */
const URL = process.env.MONGO_TEST_URL || '';
const safe = (() => {
  try {
    const u = new (require('url').URL)(URL);
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && /^\/medifleet_test_[a-z0-9_]+$/.test(u.pathname);
  } catch { return false; }
})();
const maybe = URL && safe ? describe : describe.skip;
if (URL && !safe) throw new Error('MONGO_TEST_URL must be localhost and a medifleet_test_* database — refusing to run.');

// The booking HTTP handler (POST /api/trips) runs for real against the
// isolated database; only its outside world is stubbed: no Google (no key),
// no pushes/SMS/WhatsApp, no network. The fare is a fixed test value — the
// fare engine is not what these tests are about.
delete process.env.GOOGLE_MAPS_API_KEY;
jest.mock('axios', () => ({ get: async () => { throw new Error('no network in tests'); }, post: async () => { throw new Error('no network in tests'); } }));
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../services/bookingPush', () => ({ notifyIncomingBooking: jest.fn(), sendWhatsAppLead: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({ compute: async ({ distanceKm }) => ({ baseFare: 100000, distanceKm, additionalCharges: 0, grandTotal: 100000 }) }));

maybe('lead booking on a real isolated MongoDB', () => {
  let mongoose; let Lead; let Trip; let User; let LeadBookingClaim; let svc; let convertLead;
  let lead; let staff; let owner;

  beforeAll(async () => {
    mongoose = require('mongoose');
    await mongoose.connect(URL);
    ({ Lead, Trip, User } = require('../models'));
    LeadBookingClaim = require('../models/LeadBookingClaim');
    svc = require('../services/leadBooking');
    ({ convertLead } = require('../services/leadConversion'));
    await Promise.all([Lead, Trip, User, LeadBookingClaim].map((M) => M.init()));
  }, 60000);
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  beforeEach(async () => {
    await Promise.all([Lead, Trip, LeadBookingClaim].map((M) => M.deleteMany({})));
    staff = await User.findOneAndUpdate({ phone: '9000000001' }, { $set: { name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    owner = await User.findOneAndUpdate({ phone: '9000000002' }, { $set: { name: 'Owner (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    lead = await Lead.create({ patientName: 'Ravi (fictional)', phone: '9000000101', status: 'contacted', source: 'manual', assignedTo: staff._id, assignedToName: staff.name, rev: 2, history: [] });
  });

  const tripData = () => ({ patientName: 'Ravi (fictional)', patientPhone: '9000000101', baseFare: 1000, pickup: { address: 'Test pickup' }, status: 'booked', leadId: lead._id });
  async function book(user, opts = {}, inject = {}) {
    const r = await svc.claim(lead._id, user, opts);
    if (!r.ok) return r;
    try {
      const trip = await svc.createWithClaim(r.claim, tripData(), async (t, session) => {
        if (inject.beforeLink) await inject.beforeLink();
        return convertLead(lead._id, t, user._id, { session });
      });
      return { ok: true, trip };
    } catch (err) {
      await svc.settle(r.claim);
      if (err.code === 'LEAD_CLAIM_LOST') return { ...(await svc.statusOf(lead._id)), lost: true };
      return { ok: false, error: err.message };
    }
  }
  const state = async () => {
    const l = await Lead.findById(lead._id).lean();
    return { trips: await Trip.countDocuments({ leadId: lead._id }), link: l.convertedTrip ? String(l.convertedTrip) : null, history: (l.history || []).filter((h) => h.detail?.to === 'converted').length, claim: await LeadBookingClaim.findById(String(lead._id)).lean() };
  };

  test('one booking: trip, link, ONE history entry, claim done — all committed together', async () => {
    const r = await book(staff);
    expect(r.ok).toBe(true);
    const s = await state();
    expect(s).toMatchObject({ trips: 1, link: String(r.trip._id), history: 1 });
    expect(s.claim).toMatchObject({ state: 'done' });
  });

  test('ten simultaneous submissions: exactly one trip and one history entry', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => book(i % 2 ? owner : staff)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => ['IN_PROGRESS', 'ALREADY_BOOKED'].includes(r.code))).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('retries after success: ALREADY_BOOKED, nothing new', async () => {
    const first = await book(staff);
    const again = await Promise.all([book(owner), book(staff)]);
    expect(again.every((r) => r.code === 'ALREADY_BOOKED' && String(r.booking._id) === String(first.trip._id))).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('failure AFTER the trip is created, during lead linking: the transaction rolls back — no trip, no link, no history; a retry books once', async () => {
    const r = await book(staff, {}, { beforeLink: async () => { throw new Error('injected: linking failed'); } });
    expect(r.ok).toBe(false);
    expect(await state()).toMatchObject({ trips: 0, link: null, history: 0, claim: null });
    expect((await book(staff)).ok).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('expired claim taken over while the older request resumes: the older one creates nothing', async () => {
    const old = await svc.claim(lead._id, staff);
    const newer = await book(owner, { now: Date.now() + svc.STALE_MS + 1000 });
    expect(newer.ok).toBe(true);
    await expect(svc.createWithClaim(old.claim, tripData(), (t, session) => convertLead(lead._id, t, staff._id, { session })))
      .rejects.toMatchObject({ code: 'LEAD_CLAIM_LOST' });
    expect(await svc.settle(old.claim)).toEqual({ released: false });
    expect(await state()).toMatchObject({ trips: 1, history: 1, link: String(newer.trip._id) });
  });

  test('older and newer attempts committing at the same moment: one trip', async () => {
    const old = await svc.claim(lead._id, staff);
    const newer = await svc.claim(lead._id, owner, { now: Date.now() + svc.STALE_MS + 1000 });
    const rs = await Promise.allSettled([old, newer].map((c, i) => svc.createWithClaim(c.claim, tripData(), (t, session) => convertLead(lead._id, t, (i ? owner : staff)._id, { session }))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('failure BEFORE the trip is created (trip fails validation): nothing written, claim released, a retry books once', async () => {
    const r = await svc.claim(lead._id, staff);
    await expect(svc.createWithClaim(r.claim, { ...tripData(), patientName: undefined, pickup: undefined, status: 'not-a-status' }, (t, session) => convertLead(lead._id, t, staff._id, { session })))
      .rejects.toBeTruthy();
    expect(await svc.settle(r.claim)).toEqual({ released: true });
    expect(await state()).toMatchObject({ trips: 0, link: null, history: 0, claim: null });
    expect((await book(owner)).ok).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('conversion replayed for the same trip (a retried request / recovery run): still ONE history entry', async () => {
    const r = await book(staff);
    const again = await convertLead(lead._id, r.trip, staff._id);
    expect(again).toMatchObject({ converted: false, reason: 'already_this_trip' });
    const twice = await Promise.all([convertLead(lead._id, r.trip, owner._id), convertLead(lead._id, r.trip, staff._id)]);
    expect(twice.every((x) => x.converted === false)).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1, link: String(r.trip._id) });
  });

  test('two conversions racing for DIFFERENT trips outside a claim: only one links, one history entry', async () => {
    const [a, b] = await Trip.create([{ ...tripData() }, { ...tripData() }]);
    const rs = await Promise.all([convertLead(lead._id, a, staff._id), convertLead(lead._id, b, owner._id)]);
    expect(rs.filter((x) => x.converted)).toHaveLength(1);
    const s = await state();
    expect(s.history).toBe(1);
    expect([String(a._id), String(b._id)]).toContain(s.link);
  });

  test('a lead already linked elsewhere is never overwritten', async () => {
    const other = await Trip.create({ ...tripData(), leadId: undefined });
    await Lead.updateOne({ _id: lead._id }, { $set: { convertedTrip: other._id } });
    const r = await book(staff);
    expect(r).toMatchObject({ code: 'ALREADY_BOOKED' });
    expect((await state()).link).toBe(String(other._id));
  });

  // ── older orphaned bookings (Trip.leadId set, lead never recorded it) ──
  // Written the way the pre-transaction code could leave them: the trip was
  // saved with leadId, then the lead update never happened.
  const orphan = (o = {}) => Trip.create({ ...tripData(), ...o });
  const leadSnapshot = async () => {
    const l = await Lead.findById(lead._id).lean();
    return { status: l.status, rev: l.rev, history: (l.history || []).length, convertedTrip: l.convertedTrip || null };
  };
  // The real POST /api/trips handler, as CRM staff would call it.
  async function post(user, body) {
    const { createTrip } = require('../controllers/tripController');
    let status = 0; let json = null;
    const res = { status(c) { status = c; return this; }, json(b) { json = JSON.parse(JSON.stringify(b)); return this; } };
    await createTrip({ body: { patientName: 'Ravi (fictional)', pickupAddress: 'Test pickup', selectedType: 'BLS', dist: 5, ...body }, user }, res, (e) => { status = 500; json = { error: e?.message }; });
    return { status, json };
  }

  test('older orphaned trip: a new booking from the lead is refused for review, with the existing booking; lead and trip untouched, no claim left', async () => {
    const old = await orphan();
    const before = await leadSnapshot();
    const r = await svc.claim(lead._id, staff);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'ALREADY_BOOKED', needsReview: true, reason: 'trip_not_recorded_on_lead', tripCount: 1 });
    expect(r.booking).toMatchObject({ tripNumber: old.tripNumber, needsReview: true });
    expect(String(r.booking._id)).toBe(String(old._id));
    expect(r.message).toContain(`booking ${old.tripNumber}, but the lead was never marked as booked`);
    expect(await leadSnapshot()).toEqual(before); // nothing rewritten
    expect(await state()).toMatchObject({ trips: 1, link: null, history: 0, claim: null });
  });

  test('several older trips (one cancelled): all counted, listed oldest first, still refused', async () => {
    const a = await orphan({ status: 'cancelled' });
    const b = await orphan();
    const r = await svc.statusOf(lead._id);
    expect(r).toMatchObject({ code: 'ALREADY_BOOKED', needsReview: true, tripCount: 2 });
    expect(r.bookings.map((x) => x.tripNumber)).toEqual([a.tripNumber, b.tripNumber]);
    expect(r.bookings.map((x) => x.status)).toEqual(['cancelled', 'booked']);
    expect(r.message).toContain(`${a.tripNumber} (and 1 more)`);
  });

  test('POST /api/trips, 8 simultaneous requests for a lead with an older orphaned trip: all 409 for review, no new trip, no claim, lead unchanged', async () => {
    const old = await orphan();
    const before = await leadSnapshot();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post(i % 2 ? owner : staff, { leadId: String(lead._id) })));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(409));
    expect(rs.every((r) => r.json.code === 'ALREADY_BOOKED' && r.json.needsReview === true && r.json.booking.tripNumber === old.tripNumber)).toBe(true);
    expect(await leadSnapshot()).toEqual(before);
    expect(await state()).toMatchObject({ trips: 1, link: null, history: 0, claim: null });
  });

  test('an orphaned trip written AFTER the claim (outside this flow) is caught inside the transaction: nothing created, claim released, 409 for review', async () => {
    const r = await svc.claim(lead._id, staff);
    expect(r.ok).toBe(true);
    const late = await orphan();
    await expect(svc.createWithClaim(r.claim, tripData(), (t, session) => convertLead(lead._id, t, staff._id, { session })))
      .rejects.toMatchObject({ code: 'LEAD_HAS_TRIP' });
    expect(await svc.settle(r.claim)).toEqual({ released: true });
    expect(await svc.statusOf(lead._id)).toMatchObject({ code: 'ALREADY_BOOKED', needsReview: true, booking: { tripNumber: late.tripNumber } });
    expect(await state()).toMatchObject({ trips: 1, link: null, history: 0, claim: null });
  });

  test('POST /api/trips, 6 simultaneous requests for a clean lead: one 201, the rest 409; one trip, one history entry (real handler, real transaction)', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => post(i % 2 ? owner : staff, { leadId: String(lead._id) })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409).every((r) => ['IN_PROGRESS', 'ALREADY_BOOKED'].includes(r.json.code) && !r.json.needsReview)).toBe(true);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('a trip that carries a DIFFERENT lead does not block this one; bookings without a leadId are unchanged (two separate trips)', async () => {
    await orphan({ leadId: new mongoose.Types.ObjectId() });
    expect((await post(staff, { leadId: String(lead._id) })).status).toBe(201);
    const a = await post(staff, { patientPhone: '9000000199' });
    const b = await post(staff, { patientPhone: '9000000199' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await Trip.countDocuments({ patientPhone: '9000000199' })).toBe(2);
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });

  test('GET /api/leads/:id shows the orphaned trip as a booking that needs review (read only)', async () => {
    const old = await orphan();
    const before = await leadSnapshot();
    const { getOne } = require('../controllers/leadController');
    const { runAsViewer } = require('../utils/phoneViewer');
    let json = null;
    await new Promise((resolve, reject) => runAsViewer(staff, () => {
      const res = { status() { return this; }, json(b) { json = JSON.parse(JSON.stringify(b)); resolve(); return this; } };
      Promise.resolve(getOne({ params: { id: String(lead._id) }, user: staff }, res, reject)).catch(reject);
    }));
    expect(json.lead.booking).toMatchObject({ tripNumber: old.tripNumber, needsReview: true, tripCount: 1 });
    expect(String(json.lead.booking._id)).toBe(String(old._id));
    expect(await leadSnapshot()).toEqual(before);
  });
  // ── booking attribution (origin/main: ChatGPT Ads) alongside the lead guard ──
  test('attribution: an anonymous booking tagged chatgpt_ads is chatgpt_ads; staff, lead and untagged bookings keep their source; the lead guard still holds', async () => {
    const anon = await post(undefined, { patientPhone: '9000000181', utmSource: 'chatgpt_ads' });
    expect(anon.status).toBe(201);
    expect((await Trip.findById(anon.json.trip._id).lean()).bookingSource).toBe('chatgpt_ads');
    const plain = await post(undefined, { patientPhone: '9000000182' });
    expect((await Trip.findById(plain.json.trip._id).lean()).bookingSource).toBe('app'); // schema default, unchanged
    const staffTagged = await post(staff, { patientPhone: '9000000183', utmSource: 'chatgpt_ads' });
    expect((await Trip.findById(staffTagged.json.trip._id).lean()).bookingSource).toBe('app'); // staff bookings are not ad traffic
    const fromLead = await post(staff, { leadId: String(lead._id), utmSource: 'chatgpt_ads' });
    expect(fromLead.status).toBe(201);
    expect((await Trip.findById(fromLead.json.trip._id).lean()).bookingSource).toBe('app');
    const again = await post(owner, { leadId: String(lead._id) });
    expect(again).toMatchObject({ status: 409, json: { code: 'ALREADY_BOOKED' } });
    expect(await state()).toMatchObject({ trips: 1, history: 1 });
  });
});
