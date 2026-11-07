/**
 * tests/aiCallerRules.test.js
 * ============================================================
 * AI telecaller conversation rules + WhatsApp pickup location + style
 * examples:
 *   A. date & time — today's date in IST from server time; today /
 *      tomorrow / day after / weekdays / day numbers already resolved,
 *      month-end and year rollover; never ask for month or year
 *   B. the rules — "urgent" is not a handoff (prompt AND the distress
 *      safety net), real emergencies still are (incl. Telugu); nearest
 *      hospital accepted; freezer box one question; Telugu; the opening
 *   C. tools — nearest-hospital drop, the WhatsApp-shared pickup, helper
 *      priced, past times refused, patient needs saved, freezer box
 *      request, send_location_request
 *   D. WhatsApp location — off by default; 24 h window -> one-tap button,
 *      outside it the template; one per number per 30 min; the pin fills
 *      the call's capture draft and AI call; a caller mid-way through a bot
 *      booking keeps the bot; a template button tap -> the one-tap button
 *   E. style examples — masked, cut to size, max N active; owner-only API;
 *      add from a captured call; the prompt preview
 *
 * Stubbed: the database (in-memory), WhatsApp sends, Places, the fare
 * quote, the booking. Nothing is sent and no call is placed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = 'test-only-ai-rules-secret';

function mockMemoryModel() {
  const store = [];
  let seq = 0;
  const get = (doc, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
  const matches = (doc, filter = {}) => Object.entries(filter).every(([k, v]) => {
    const val = get(doc, k);
    if (v === null) return val == null;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('$exists' in v) return (val !== undefined) === v.$exists;
      if ('$gte' in v) return val != null && new Date(val) >= new Date(v.$gte);
      if ('$in' in v) return v.$in.map(String).includes(String(val));
      if ('$ne' in v) return String(val) !== String(v.$ne);
    }
    return String(val) === String(v);
  });
  const sortBy = (rows, spec = {}) => {
    const [[key, dir] = []] = Object.entries(spec);
    return key ? [...rows].sort((a, b) => (get(a, key) > get(b, key) ? dir : get(a, key) < get(b, key) ? -dir : 0)) : rows;
  };
  const chain = (value, many) => {
    let v = value;
    const q = { then: (res, rej) => Promise.resolve(v).then(res, rej) };
    q.sort = (spec) => { v = many ? sortBy(v, spec) : v; return q; };
    q.limit = (n) => { v = many ? v.slice(0, n) : v; return q; };
    for (const m of ['populate', 'select', 'lean', 'exec']) q[m] = () => q;
    return q;
  };
  const setPath = (doc, path, value) => {
    const keys = path.split('.');
    let o = doc;
    keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    o[keys.at(-1)] = value;
  };
  const apply = (doc, update) => {
    Object.entries(update.$set || {}).forEach(([k, v]) => setPath(doc, k, v));
    Object.entries(update.$push || {}).forEach(([k, v]) => setPath(doc, k, [...(doc[k] || []), ...(v && v.$each ? v.$each : [v])]));
  };
  return {
    store,
    reset() { store.length = 0; seq = 0; },
    add(data) { const doc = { _id: `64f${String(++seq).padStart(21, '0')}`, createdAt: new Date(), updatedAt: new Date(), ...data }; store.push(doc); return doc; },
    create: jest.fn(async function create(data) { return this.add(data); }),
    find: jest.fn((filter) => chain(store.filter((d) => matches(d, filter)), true)),
    findOne: jest.fn((filter) => {
      const rows = store.filter((d) => matches(d, filter));
      const q = chain(rows[0] || null);
      q.sort = (spec) => { const s = sortBy(rows, spec); return chain(s[0] || null); };
      return q;
    }),
    findById: jest.fn((id) => chain(store.find((d) => String(d._id) === String(id)) || null)),
    exists: jest.fn(async (filter) => (store.some((d) => matches(d, filter)) ? { _id: 'x' } : null)),
    updateOne: jest.fn(async (filter, update, opts = {}) => {
      let doc = store.find((d) => matches(d, filter));
      if (!doc && opts.upsert) doc = this_add(store, filter, () => ++seq);
      if (doc) apply(doc, update);
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    }),
    findByIdAndUpdate: jest.fn(async (id, update) => {
      const doc = store.find((d) => String(d._id) === String(id));
      if (doc) apply(doc, update);
      return doc || null;
    }),
    deleteOne: jest.fn(async (filter) => {
      const i = store.findIndex((d) => matches(d, filter));
      if (i >= 0) store.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    }),
  };
}
// eslint-disable-next-line camelcase
function this_add(store, filter, next) { const doc = { _id: `64e${String(next()).padStart(21, '0')}`, ...filter }; store.push(doc); return doc; }

jest.mock('../models', () => {
  const m = () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() });
  return { Trip: m(), User: m(), Bill: m(), Income: m(), Notification: m(), Hospital: m(), Lead: m(), ChatMessage: m(), Vehicle: m() };
});
jest.mock('../models/Owner', () => ({ findById: jest.fn() }));
jest.mock('../models/AiCall', () => mockMemoryModel());
jest.mock('../models/CallLog', () => mockMemoryModel());
jest.mock('../models/LocationRequest', () => mockMemoryModel());
jest.mock('../models/WhatsAppContact', () => mockMemoryModel());
jest.mock('../models/WhatsAppSession', () => mockMemoryModel());
jest.mock('../models/CallStyleExample', () => mockMemoryModel());
jest.mock('../services/whatsappService', () => ({
  sendText: jest.fn(async () => ({ ok: 1 })),
  sendTemplate: jest.fn(async () => ({ ok: 1 })),
  sendLocationRequest: jest.fn(async () => ({ ok: 1 })),
}));
jest.mock('../services/whatsappFlow', () => ({
  resolvePlaceFromText: jest.fn(),
  resolveAddressForLocation: jest.fn(async (lat, lng, meta) => meta || 'Jayanagar 4th Block, Bengaluru'),
}));
jest.mock('../services/callCapture/session', () => ({ applySharedPickup: jest.fn(async () => true) }));
jest.mock('../services/nearbyHospital', () => ({ nearestHospital: jest.fn() }));
jest.mock('../controllers/tripController', () => ({ quoteTrip: jest.fn(), quoteWaitCharge: jest.fn(), createBookedTrip: jest.fn() }));
jest.mock('../services/bookingPush', () => ({ notifyIncomingBooking: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const AiCall = require('../models/AiCall');
const CallLog = require('../models/CallLog');
const LocationRequest = require('../models/LocationRequest');
const WhatsAppContact = require('../models/WhatsAppContact');
const WhatsAppSession = require('../models/WhatsAppSession');
const CallStyleExample = require('../models/CallStyleExample');
const whatsapp = require('../services/whatsappService');
const captureSession = require('../services/callCapture/session');
const { nearestHospital } = require('../services/nearbyHospital');
const { resolvePlaceFromText } = require('../services/whatsappFlow');
const { quoteTrip, quoteWaitCharge, createBookedTrip } = require('../controllers/tripController');
const prompt = require('../services/aiCaller/prompt');
const session = require('../services/aiCaller/session');
const tools = require('../services/aiCaller/tools');
const styleExamples = require('../services/aiCaller/styleExamples');
const locationRequests = require('../services/locationRequests');

// 14:05 IST on Saturday 7 November 2026.
const NOW = new Date('2026-11-07T08:35:00Z');
const at = (iso) => new Date(iso);

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  [AiCall, CallLog, LocationRequest, WhatsAppContact, WhatsAppSession, CallStyleExample].forEach((m) => m.reset());
  process.env = { ...ENV };
  delete process.env.WA_CALL_LOCATION_ENABLED;
  delete process.env.WA_LOCATION_TEMPLATE;
  delete process.env.AI_STYLE_EXAMPLES_MAX;
});
afterAll(() => { process.env = ENV; });

// ============================================================
describe('A. date and time awareness (IST, server time)', () => {
  test('today, tomorrow, day after — in every language the caller may use', () => {
    const b = prompt.dateBlock(NOW);
    expect(b).toMatch(/right now it is Saturday 7 November 2026, 14:05 India time \(IST\)/);
    expect(b).toMatch(/today \/ ಇವತ್ತು \/ आज \/ ఈరోజు \/ இன்று \/ ഇന്ന് = Saturday 7 November 2026/);
    expect(b).toMatch(/tomorrow \/ ನಾಳೆ \/ कल \/ రేపు \/ நாளை \/ നാളെ = Sunday 8 November 2026/);
    expect(b).toMatch(/day after tomorrow \/ ನಾಡಿದ್ದು \/ परसों \/ ఎల్లుండి \/ நாளை மறுநாள் \/ മറ്റന്നാൾ = Monday 9 November 2026/);
    expect(b).toMatch(/Monday = 9 Nov, .*Saturday = 14 Nov/);
    expect(b).toMatch(/NEVER ask the caller for the month or the year/);
    expect(b).toMatch(/"ನಾಳೆ = 8 November, ಸರಿನಾ\?"/);
    expect(b).toMatch(/tomorrow 5 pm = 2026-11-08 17:00/);
  });

  test('day numbers: passed -> next month, still ahead -> this month, today counts', () => {
    const d = (n, now = NOW) => prompt.resolveDayNumber(n, now).toISOString().slice(0, 10);
    expect(d(5)).toBe('2026-12-05');
    expect(d(7)).toBe('2026-11-07');
    expect(d(20)).toBe('2026-11-20');
    expect(d(31)).toBe('2026-12-31'); // November has no 31st
    expect(prompt.dateBlock(NOW)).toMatch(/5th = 5 Dec, 6th = 6 Dec, 7th = 7 Nov \(today\), 8th = 8 Nov/);
  });

  test('month-end and year rollover', () => {
    const jan31 = at('2027-01-31T06:00:00Z');
    expect(prompt.resolveDayNumber(31, jan31).toISOString().slice(0, 10)).toBe('2027-01-31');
    expect(prompt.resolveDayNumber(29, jan31).toISOString().slice(0, 10)).toBe('2027-03-29'); // Feb 2027 has 28 days
    expect(prompt.resolveDayNumber(1, jan31).toISOString().slice(0, 10)).toBe('2027-02-01');
    const dec20 = at('2026-12-20T06:00:00Z');
    expect(prompt.resolveDayNumber(5, dec20).toISOString().slice(0, 10)).toBe('2027-01-05');
    expect(prompt.dateBlock(at('2026-12-31T10:00:00Z'))).toMatch(/tomorrow \/ ನಾಳೆ \/ कल \/ రేపు \/ நாளை \/ നാളെ = Friday 1 January 2027/);
  });

  test('IST, not UTC: 00:30 IST is already the next day', () => {
    expect(prompt.dateBlock(at('2026-11-07T19:00:00Z'))).toMatch(/right now it is Sunday 8 November 2026, 00:30/);
  });

  test('a booking time already past (IST) is recognised', () => {
    expect(prompt.isPastIst('2026-11-07 13:00', NOW)).toBe(true);
    expect(prompt.isPastIst('2026-11-07 15:00', NOW)).toBe(false);
    expect(prompt.isPastIst('2026-11-08 09:00', NOW)).toBe(false);
  });
});

// ============================================================
describe('B. conversation rules', () => {
  const I = prompt.BASE_INSTRUCTIONS;
  test('urgent is never a reason to hand off; WhatsApp location for urgent callers', () => {
    expect(I).toMatch(/"urgent".*are NOT reasons to hand off/);
    expect(I).toMatch(/NEVER hand off just because the caller says "urgent"/);
    expect(I).toMatch(/send the WhatsApp location request straight away/);
  });
  test('nearest hospital accepted; freezer box one simple question; patient needs; Telugu; opening', () => {
    expect(I).toMatch(/nearest hospital \("ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆ"\), say OK and do NOT insist on a name/);
    expect(I).toMatch(/FREEZER BOX: when the caller says freezer box, ice box or ಶವ ಪೆಟ್ಟಿಗೆ, FIRST ask this one question: "ಫ್ರೀಜರ್ ಬಾಕ್ಸ್ ಮನೆಯಲ್ಲಿ ಇಡಲು ಬೇಕಾ, ಅಥವಾ ಪಾರ್ಥಿವ ಶರೀರವನ್ನು ವಾಹನದಲ್ಲಿ ಸಾಗಿಸಲು ಬೇಕಾ\?"/);
    expect(I).toMatch(/Box at home: ask the delivery ADDRESS \(with a landmark\), from WHEN it is needed \(start time\), and for HOW LONG/);
    expect(I).toMatch(/Body transport by vehicle: ask the pickup, the destination and the date and time\. The freezer depends on the package: Body Shifting — Tempo includes it; Body Mini — Eeco does not/);
    expect(I).toMatch(/oxygen/);
    expect(I).toMatch(/helper/);
    expect(I).toMatch(/Prioritise Kannada, English, Hindi, Telugu, Tamil and Malayalam/);
    expect(I).toMatch(/ANY other language, understand it and reply in that same language — never turn a caller away over language/);
    expect(I).toMatch(/NEVER give medical advice/);
    expect(session.OPENING).toBe(`${session.DISCLOSURE_KN} Ambulance ಬೇಕಾ?`);
  });
  test.each([
    'please come urgent', 'emergency, very urgent', 'ಅರ್ಜೆಂಟ್ ಬೇಕು', 'ತುಂಬಾ urgent ಸರ್', 'जल्दी भेजो urgent hai', 'emergency ambulance',
    'அவசரம், சீக்கிரம் வாங்க', 'ആംബുലൻസ് വേഗം വേണം, urgent',
  ])('the safety net does NOT hand off for "%s"', (t) => expect(session.isDistress(t)).toBe(false));
  test.each([
    'he is unconscious', 'not breathing', 'ಪ್ರಜ್ಞೆ ಇಲ್ಲ', 'saans nahi aa rahi', 'స్పృహ లేదు', 'ఊపిరి ఆడటం లేదు', 'గుండెపోటు',
    'அப்பா மயக்கம் ஆயிட்டாங்க', 'மூச்சு விடவில்லை', 'மாரடைப்பு', 'moochu illa',
    'അച്ഛന് ബോധമില്ല', 'ശ്വാസം കിട്ടുന്നില്ല', 'ഹൃദയാഘാതം', 'bodham illa',
  ])('a real emergency still hands off: "%s"', (t) => expect(session.isDistress(t)).toBe(true));
  test('Tamil and Malayalam are detected as the call language', () => {
    expect(session.scriptLanguage('வணக்கம்')).toBe('ta');
    expect(session.scriptLanguage('നമസ്കാരം')).toBe('ml');
    expect(session.scriptLanguage('Hello')).toBe('en');
  });
  test('Telugu is detected as the call language', () => {
    expect(session.scriptLanguage('నమస్కారం అండి')).toBe('te');
    expect(session.scriptLanguage('ನಮಸ್ಕಾರ')).toBe('kn');
  });
});

// ============================================================
describe('C. tools', () => {
  // approval: what the session reports about the caller's own answer to
  // the read-back — a clear yes here (the gate itself is tested in D).
  const ctx = (call) => ({ callId: call._id, phone: '9876543210', state: {}, approval: async () => ({ status: 'yes', heard: 'ಹೌದು' }) });
  const run = (name, args, c) => tools.HANDLERS[name](args, c);
  // Read back, the caller's yes, then book.
  const confirmAndBook = async (c, readBack, extra = {}) => {
    const rb = await run('read_back_booking', readBack, c);
    if (!rb.ok) return rb;
    return run('create_booking', { customer_confirmed: true, ...extra }, c);
  };
  const single = (name, lat, lng) => ({ status: 'single', place: { name, address: 'Bengaluru', lat, lng } });

  beforeEach(() => {
    quoteTrip.mockResolvedValue({ fare: { grandTotal: 1450 }, distanceKm: 4.2, oneWayKm: 4.2 });
    createBookedTrip.mockResolvedValue({ _id: 'trip1', tripNumber: 'TRP-1', estimatedFare: 1450 });
  });

  test('nearest hospital: no name needed, priced to the closest hospital, read back by name', async () => {
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('Jayanagar', 12.93, 77.58));
    nearestHospital.mockResolvedValueOnce({ name: 'Sagar Hospital', address: 'Jayanagar', lat: 12.94, lng: 77.59 });
    const r = await run('get_quote', { service_code: 'bls', pickup: 'Jayanagar', drop_nearest_hospital: true }, c);
    expect(nearestHospital).toHaveBeenCalledWith(12.93, 77.58);
    expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ dropLat: 12.94, dropLng: 77.59 }));
    expect(r).toMatchObject({ ok: true, drop: 'Sagar Hospital, Jayanagar', drop_is_nearest_hospital: true, estimated_fare_rupees: 1450 });
    expect(r.say).toMatch(/nearest hospital found, by name/);
  });

  test('no hospital found nearby: asks, never guesses', async () => {
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('Jayanagar', 12.93, 77.58));
    nearestHospital.mockResolvedValueOnce(null);
    expect(await run('get_quote', { service_code: 'bls', pickup: 'Jayanagar', drop_nearest_hospital: true }, c)).toMatchObject({ ok: false, reason: 'no_nearby_hospital' });
    expect(quoteTrip).not.toHaveBeenCalled();
  });

  test('the WhatsApp-shared pickup: waits for it, then uses its coordinates', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    expect(await run('get_quote', { service_code: 'bls', use_shared_location: true, drop: 'Victoria' }, c)).toMatchObject({ ok: false, reason: 'location_not_received' });
    call.sharedLocation = { lat: 12.9301, lng: 77.5802, address: '12 Main Rd, Jayanagar' };
    resolvePlaceFromText.mockResolvedValueOnce(single('Victoria Hospital', 12.96, 77.57));
    const r = await run('get_quote', { service_code: 'bls', use_shared_location: true, drop: 'Victoria' }, c);
    expect(r).toMatchObject({ ok: true, pickup: '12 Main Rd, Jayanagar' });
    expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ pickupLat: 12.9301, pickupLng: 77.5802 }));
    expect(resolvePlaceFromText).toHaveBeenCalledTimes(1); // only the drop was searched
  });

  test('missing pickup / drop: asks for them', async () => {
    const c = ctx(AiCall.add({}));
    expect(await run('get_quote', { service_code: 'bls', drop: 'x' }, c)).toMatchObject({ reason: 'need_pickup' });
    expect(await run('get_quote', { service_code: 'bls', pickup: 'x' }, c)).toMatchObject({ reason: 'need_drop' });
  });

  test('home pickup: both prices in one go (Pricing helperCharge via quoteTrip); either books without asking again', async () => {
    quoteTrip.mockImplementation(async (q) => ({ fare: { grandTotal: q.helperEnabled ? 1750 : 1450 }, distanceKm: 4.2, oneWayKm: 4.2 }));
    const call = AiCall.add({});
    const c = ctx(call);
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    const q = await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', patient_at: 'home' }, c);
    expect(quoteTrip).toHaveBeenCalledTimes(2);
    expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ helperEnabled: true }));
    expect(q).toMatchObject({ fare_without_helper_rupees: 1450, fare_with_helper_rupees: 1750, helper_extra_rupees: 300, estimated_fare_rupees: 1450 });
    expect(q.say).toMatch(/Quote both in one go: without helper ₹1450; with helper ₹1750\./);
    expect(q.say).toMatch(/Then ask if they want to book/);
    const r = await confirmAndBook(c, { when: 'now', helper_needed: true, patient_at: 'home', pickup_details: '12 Main Rd, near Ganesha temple' }, {
      patient_name: 'Lakshmi', patient_condition: 'fell at home, hip pain', oxygen_needed: false, patient_at: 'home',
    });
    expect(r.ok).toBe(true);
    expect(quoteTrip).toHaveBeenCalledTimes(2); // no re-quote
    expect(createBookedTrip.mock.calls[0][0]).toMatchObject({ helperEnabled: true, pickupLabel: '12 Main Rd, near Ganesha temple, A, Bengaluru' });
    expect(createBookedTrip.mock.calls[0][1]).toEqual({ bookingSource: 'ai_telecaller' });
    expect(call.needs).toEqual({ condition: 'fell at home, hip pain', oxygen: false, helper: true, patientAt: 'home', pickupDetails: '12 Main Rd, near Ganesha temple' });
  });

  test('the caller already said no helper: quoted without, "+₹X if you want a helper"', async () => {
    quoteTrip.mockImplementation(async (q) => ({ fare: { grandTotal: q.helperEnabled ? 1750 : 1450 }, distanceKm: 4.2, oneWayKm: 4.2 }));
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    const q = await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', helper_needed: false }, c);
    expect(q.say).toMatch(/Quote ₹1450 \(no helper\); just mention it is \+₹300 if they want a helper\./);
    expect(q).toMatchObject({ helper: false, estimated_fare_rupees: 1450 });
  });

  test('hospital pickup (discharge): no helper asked, offered or charged', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    resolvePlaceFromText.mockResolvedValueOnce(single('Baptist Hospital', 1, 2)).mockResolvedValueOnce(single('Home', 3, 4));
    const q = await run('get_quote', { service_code: 'bls', pickup: 'Baptist Hospital', drop: 'Home', patient_at: 'hospital', helper_needed: true }, c);
    expect(quoteTrip).toHaveBeenCalledTimes(1);
    expect(quoteTrip.mock.calls[0][0].helperEnabled).toBeUndefined();
    expect(q).toMatchObject({ helper: false, helper_offered: false, estimated_fare_rupees: 1450 });
    expect(q).not.toHaveProperty('fare_with_helper_rupees');
    expect(q.say).toMatch(/The patient is at a hospital: do NOT ask about a helper/);
    expect((await confirmAndBook(c, { when: 'now', helper_needed: true })).ok).toBe(true);
    expect(createBookedTrip.mock.calls[0][0].helperEnabled).toBeUndefined();
    expect(call.needs).toMatchObject({ helper: false, patientAt: 'hospital' });
  });

  test('long trip (over 300 km one way): ask more about the patient before booking; fare unchanged', async () => {
    quoteTrip.mockResolvedValue({ fare: { grandTotal: 18000 }, distanceKm: 450, oneWayKm: 450 });
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('Chennai', 3, 4));
    const q = await run('get_quote', { service_code: 'als_tempo', pickup: 'A', drop: 'Chennai', patient_at: 'hospital' }, c);
    expect(q).toMatchObject({ long_trip: true, estimated_fare_rupees: 18000 });
    expect(q).not.toHaveProperty('two_drivers');
    expect(q.say).toMatch(/Long trip: before booking, ask briefly what happened, whether oxygen or a nurse is needed, and any special care/);
  });

  test('over 1000 km: two drivers said and recorded — no charge invented (no Pricing field)', async () => {
    quoteTrip.mockResolvedValue({ fare: { grandTotal: 52000 }, distanceKm: 1200, oneWayKm: 1200 });
    const call = AiCall.add({});
    const c = ctx(call);
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('Delhi', 3, 4));
    const q = await run('get_quote', { service_code: 'als_tempo', pickup: 'A', drop: 'Delhi', patient_at: 'hospital' }, c);
    expect(q).toMatchObject({ two_drivers: true, long_trip: true, estimated_fare_rupees: 52000 });
    expect(q.say).toMatch(/Over 1000 km: tell the caller two drivers are assigned/);
    await confirmAndBook(c, { when: 'now' }, { nurse_needed: true, special_care: 'ventilator, suction' });
    expect(call.needs).toMatchObject({ twoDrivers: true, nurse: true, specialCare: 'ventilator, suction' });
  });

  test('nurse: asked for, recorded, never priced (no nurse charge in Pricing)', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    const q = await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', patient_at: 'hospital', nurse_needed: true }, c);
    expect(q.estimated_fare_rupees).toBe(1450);
    expect(q.say).toMatch(/no nurse charge in our price list — say the team will confirm the nurse charge; do not quote one/);
    const r = await confirmAndBook(c, { when: 'now' }, { nurse_needed: true });
    expect(r.say).toMatch(/the team will call shortly to confirm the ambulance \(it is not assigned yet\) and the nurse and its charge/);
    expect(call.needs.nurse).toBe(true);
  });

  test('a scheduled time already in the past is refused', async () => {
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B' }, c);
    const r = await confirmAndBook(c, { when: 'later', scheduled_time: '2020-01-01 10:00' });
    expect(r).toMatchObject({ ok: false, reason: 'past_time' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('freezer box at home: delivery address + start time + duration recorded for a callback, never priced', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    expect(await run('freezer_box_request', { start_time: 'now', days: 2 }, c)).toMatchObject({ ok: false, reason: 'need_address' });
    expect(await run('freezer_box_request', { address: '4th Cross, Basavanagudi', days: 2 }, c)).toMatchObject({ ok: false, reason: 'need_start' });
    expect(await run('freezer_box_request', { address: '4th Cross, Basavanagudi', start_time: 'now', days: 0 }, c)).toMatchObject({ ok: false, reason: 'need_duration' });
    expect(await run('freezer_box_request', { address: '4th Cross, Basavanagudi', start_time: '2020-01-01 10:00', days: 2 }, c)).toMatchObject({ ok: false, reason: 'past_time' });
    const r = await run('freezer_box_request', { address: '4th Cross, Basavanagudi, near BMS College', start_time: '2099-01-02 18:00', days: 3 }, c);
    expect(r.ok).toBe(true);
    expect(r.say).toMatch(/call back/);
    expect(call.request).toMatchObject({ type: 'freezer_box', address: '4th Cross, Basavanagudi, near BMS College', days: 3, startAt: new Date('2099-01-02T12:30:00Z') });
    expect(quoteTrip).not.toHaveBeenCalled();
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('send_location_request: WhatsApp off -> just ask the area; on -> sent for this AI call', async () => {
    const call = AiCall.add({});
    expect(await run('send_location_request', {}, ctx(call))).toMatchObject({ ok: false, reason: 'whatsapp_off' });
    process.env.WA_CALL_LOCATION_ENABLED = 'true';
    process.env.WA_LOCATION_TEMPLATE = 'pickup_location_request';
    const r = await run('send_location_request', {}, ctx(call));
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(LocationRequest.store[0]).toMatchObject({ source: 'ai_caller', aiCall: call._id, phone: '9876543210', status: 'sent' });
  });

  describe('round trip and waiting — the existing pricing, quoted, never handed off', () => {
    const quoteRT = async (c, args) => {
      resolvePlaceFromText.mockResolvedValueOnce(single('Jayanagar', 1, 2)).mockResolvedValueOnce(single('NIMHANS', 3, 4));
      return run('get_quote', { service_code: 'bls', pickup: 'Jayanagar', drop: 'NIMHANS', ...args }, c);
    };

    test('round trip: quoteTrip with tripType round_trip + the Pricing waiting charge; the total read back', async () => {
      quoteTrip.mockImplementation(async (q) => ({ fare: { grandTotal: q.helperEnabled ? 2700 : 2400 }, distanceKm: 16, oneWayKm: 8 }));
      quoteWaitCharge.mockResolvedValueOnce({ waitMinutes: 120, freeMinutes: 10, billableMinutes: 110, amount: 550, ratePerMin: 5, tier1Minutes: 120, tier2RatePerMin: 10 });
      const c = ctx(AiCall.add({}));
      const r = await quoteRT(c, { round_trip: true, wait_hours: 2 });
      expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ selectedType: 'bls', tripType: 'round_trip' }));
      expect(quoteWaitCharge).toHaveBeenCalledWith({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: 120 });
      expect(r).toMatchObject({
        ok: true, trip_type: 'round_trip', trip_fare_rupees: 2400, wait_hours: 2, waiting_charge_rupees: 550, estimated_fare_rupees: 2950,
        waiting_rule: 'first 10 minutes of waiting free, then ₹5/min for 120 minutes, then ₹10/min',
      });
      expect(r.say).toMatch(/Up-and-down fare ₹2400 \+ about 2 hours waiting ₹550 — read the TOTAL back clearly/);
      expect(r.say).toMatch(/Quote both in one go: without helper ₹2950; with helper ₹3250\./);
    });

    test('round trip with no wait: the round-trip fare, waiting rule still explained', async () => {
      quoteTrip.mockResolvedValueOnce({ fare: { grandTotal: 2400 }, distanceKm: 16, oneWayKm: 8 });
      quoteWaitCharge.mockResolvedValueOnce({ waitMinutes: 0, freeMinutes: 10, billableMinutes: 0, amount: 0, ratePerMin: 5, tier1Minutes: 120, tier2RatePerMin: 10 });
      const r = await quoteRT(ctx(AiCall.add({})), { round_trip: true });
      expect(r).toMatchObject({ ok: true, waiting_charge_rupees: 0, estimated_fare_rupees: 2400 });
    });

    test('booked as a round trip back to the pickup; dispatch sees the planned wait', async () => {
      quoteTrip.mockResolvedValueOnce({ fare: { grandTotal: 2400 }, distanceKm: 16, oneWayKm: 8 });
      quoteWaitCharge.mockResolvedValueOnce({ waitMinutes: 90, freeMinutes: 10, billableMinutes: 80, amount: 400, ratePerMin: 5, tier1Minutes: 120, tier2RatePerMin: 10 });
      const call = AiCall.add({});
      const c = ctx(call);
      await quoteRT(c, { round_trip: true, wait_hours: 1.5 });
      expect((await confirmAndBook(c, { when: 'now' })).ok).toBe(true);
      expect(createBookedTrip.mock.calls[0][0]).toMatchObject({ tripType: 'round_trip', returnAddress: 'Jayanagar, Bengaluru', dist: 8, effectiveDist: 16 });
      expect(call.needs).toMatchObject({ roundTrip: true, waitHours: 1.5 });
    });

    test('waiting asked without a round trip: confirm round trip first', async () => {
      const r = await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', wait_hours: 2 }, ctx(AiCall.add({})));
      expect(r).toMatchObject({ ok: false, reason: 'wait_needs_round_trip' });
      expect(quoteTrip).not.toHaveBeenCalled();
    });

    test('a nonsense wait is asked again', async () => {
      expect(await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', round_trip: true, wait_hours: -1 }, ctx(AiCall.add({})))).toMatchObject({ reason: 'bad_wait' });
      expect(await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', round_trip: true, wait_hours: 99 }, ctx(AiCall.add({})))).toMatchObject({ reason: 'bad_wait' });
    });

    test('no waiting price for the service: a callback, never a guess', async () => {
      quoteTrip.mockResolvedValueOnce({ fare: { grandTotal: 2400 }, distanceKm: 16, oneWayKm: 8 });
      quoteWaitCharge.mockResolvedValueOnce(null);
      expect(await quoteRT(ctx(AiCall.add({})), { round_trip: true, wait_hours: 1 })).toMatchObject({ ok: false, reason: 'no_price' });
    });

    test('one way is unchanged: no waiting lookup, same fields as before', async () => {
      const r = await quoteRT(ctx(AiCall.add({})), {});
      expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ tripType: 'one_way' }));
      expect(quoteWaitCharge).not.toHaveBeenCalled();
      expect(r).toMatchObject({ ok: true, trip_type: 'one_way', estimated_fare_rupees: 1450 });
      expect(r).not.toHaveProperty('waiting_charge_rupees');
    });

    test('the instructions: quote promptly, never re-ask, helper only at home, nurse, long trips, 2 drivers', () => {
      const I = prompt.BASE_INSTRUCTIONS;
      expect(I).toMatch(/QUOTE PROMPTLY — as soon as you know the service, pickup and drop, call get_quote straight away/);
      expect(I).toMatch(/Do not ask more questions first/);
      expect(I).toMatch(/NEVER ask the same question twice/);
      expect(I).toMatch(/If they already said no helper, quote without one and just mention "\+₹X if you want a helper"/);
      expect(I).toMatch(/If the patient is AT A HOSPITAL, never ask about a helper/);
      expect(I).toMatch(/NURSE: ask once, briefly/);
      expect(I).toMatch(/LONG TRIPS \(get_quote says long_trip\)/);
      expect(I).toMatch(/OVER 1000 km \(get_quote says two_drivers\): tell the caller two drivers are assigned/);
      expect(session.DELEGATE_INSTRUCTIONS).toMatch(/never quote a nurse charge/);
    });

    test('the instructions: ask the waiting time, quote it, never hand off for it', () => {
      expect(prompt.BASE_INSTRUCTIONS).toMatch(/"ಅಪ್ ಅಂಡ್ ಡೌನ್", "ಹೋಗಿ-ಬರೋದು"\) or say the ambulance must wait, ask how long it should wait/);
      expect(prompt.BASE_INSTRUCTIONS).toMatch(/get_quote with round_trip true and wait_hours/);
      expect(prompt.BASE_INSTRUCTIONS).toMatch(/never hand off or say you will check with the team for a round trip or waiting/);
      expect(session.DELEGATE_INSTRUCTIONS).toMatch(/round_trip true and wait_hours — quote it, never hand off/);
      const def = tools.definitions().find((d) => d.name === 'get_quote');
      expect(Object.keys(def.parameters.properties)).toEqual(expect.arrayContaining(['round_trip', 'wait_hours']));
    });
  });

  test('the tool definitions offer the new fields', () => {
    const defs = Object.fromEntries(tools.definitions().map((d) => [d.name, d]));
    expect(Object.keys(defs.get_quote.parameters.properties)).toEqual(expect.arrayContaining(['use_shared_location', 'drop_nearest_hospital', 'helper_needed']));
    expect(defs.get_quote.parameters.required).toEqual(['service_code']);
    expect(Object.keys(defs.create_booking.parameters.properties)).toEqual(expect.arrayContaining(['patient_condition', 'oxygen_needed', 'helper_needed', 'patient_at']));
    expect(defs.handoff_to_human.description).toMatch(/NOT for the word "urgent"/);
  });
});

// ============================================================
describe('D. WhatsApp pickup location', () => {
  const PHONE = '9876543210';
  const on = (template = 'pickup_location_request') => {
    process.env.WA_CALL_LOCATION_ENABLED = 'true';
    if (template) process.env.WA_LOCATION_TEMPLATE = template;
  };
  const pin = (extra = {}) => ({ id: 'wamid.1', from: `91${PHONE}`, type: 'location', location: { latitude: 12.93, longitude: 77.58, ...extra } });

  test('off unless WA_CALL_LOCATION_ENABLED=true: nothing sent, nothing stored', async () => {
    expect(await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' })).toEqual({ status: 'disabled' });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(whatsapp.sendLocationRequest).not.toHaveBeenCalled();
    expect(LocationRequest.store).toHaveLength(0);
  });

  test('outside the 24 h window: the approved template (language from env)', async () => {
    on();
    process.env.WA_LOCATION_TEMPLATE_LANG = 'en';
    expect(await locationRequests.request({ phone: `+91 ${PHONE}`, source: 'incoming_call', callLog: 'log1' })).toEqual({ status: 'sent', via: 'template' });
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith(`91${PHONE}`, 'pickup_location_request', 'en', []);
    expect(whatsapp.sendLocationRequest).not.toHaveBeenCalled();
    expect(LocationRequest.store[0]).toMatchObject({ phone: PHONE, callLog: 'log1', via: 'template', status: 'sent' });
  });

  test('inside the window (messaged us within 24 h): the one-tap "Send location" button, no template', async () => {
    on();
    WhatsAppContact.add({ phone: PHONE, lastInboundAt: new Date(Date.now() - 3 * 3600 * 1000) });
    expect(await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' })).toEqual({ status: 'sent', via: 'interactive' });
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledWith(`91${PHONE}`, locationRequests.ASK_TEXT);
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  test('outside the window with no template set: recorded as failed with the reason, nothing sent', async () => {
    on(null);
    const r = await locationRequests.request({ phone: PHONE, source: 'incoming_call' });
    expect(r.status).toBe('failed');
    expect(LocationRequest.store[0].error).toMatch(/WA_LOCATION_TEMPLATE is not set/);
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  test('WhatsApp refusing the template is recorded, never thrown', async () => {
    on();
    whatsapp.sendTemplate.mockResolvedValueOnce(null);
    const r = await locationRequests.request({ phone: PHONE, source: 'incoming_call' });
    expect(r.status).toBe('failed');
    expect(LocationRequest.store[0]).toMatchObject({ status: 'failed' });
  });

  test('a caller who rings twice in 30 min gets one message; the pin fills the latest call', async () => {
    on();
    await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' });
    expect(await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log2' })).toEqual({ status: 'already_sent', via: 'template' });
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
    expect(LocationRequest.store[0].callLog).toBe('log2');
  });

  test('not a mobile number: nothing sent', async () => {
    on();
    expect(await locationRequests.request({ phone: '12345', source: 'incoming_call' })).toEqual({ status: 'not_mobile' });
    expect(await locationRequests.request({ phone: '5123456789', source: 'incoming_call' })).toEqual({ status: 'not_mobile' });
  });

  test('the pin: recorded with its address, fills the call\'s capture draft + AI call, thanked; the bot never sees it', async () => {
    on();
    const call = AiCall.add({});
    await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' });
    LocationRequest.store[0].aiCall = call._id;
    const handled = await locationRequests.onInbound(pin());
    expect(handled).toBe(true);
    expect(LocationRequest.store[0]).toMatchObject({ status: 'received', location: { lat: 12.93, lng: 77.58, address: 'Jayanagar 4th Block, Bengaluru' } });
    expect(captureSession.applySharedPickup).toHaveBeenCalledWith('log1', { label: 'Jayanagar 4th Block, Bengaluru', lat: 12.93, lng: 77.58 });
    expect(call.sharedLocation).toMatchObject({ lat: 12.93, lng: 77.58, address: 'Jayanagar 4th Block, Bengaluru' });
    expect(whatsapp.sendText).toHaveBeenCalledWith(`91${PHONE}`, expect.stringMatching(/Thank you, we have your location: Jayanagar 4th Block/));
    expect(WhatsAppContact.store[0]).toMatchObject({ phone: PHONE });
  });

  test('Meta\'s own address on the pin is used when present', async () => {
    on();
    await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' });
    await locationRequests.onInbound(pin({ address: '5th Cross, JP Nagar' }));
    expect(LocationRequest.store[0].location.address).toBe('5th Cross, JP Nagar');
  });

  test('a caller mid-way through a bot booking: the pin is recorded for the call AND left for the bot', async () => {
    on();
    await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' });
    WhatsAppSession.add({ phone: `91${PHONE}`, step: 'AWAITING_PICKUP' });
    expect(await locationRequests.onInbound(pin())).toBe(false);
    expect(LocationRequest.store[0].status).toBe('received');
    expect(captureSession.applySharedPickup).toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('no pending request: a pin or text goes to the bot as before', async () => {
    expect(await locationRequests.onInbound(pin())).toBe(false);
    expect(await locationRequests.onInbound({ id: 'w2', from: `91${PHONE}`, type: 'text', text: { body: 'hi' } })).toBe(false);
    expect(captureSession.applySharedPickup).not.toHaveBeenCalled();
  });

  test('a tap on the template\'s button opens the window: the one-tap request follows', async () => {
    on();
    await locationRequests.request({ phone: PHONE, source: 'incoming_call', callLog: 'log1' });
    expect(await locationRequests.onInbound({ id: 'w3', from: `91${PHONE}`, type: 'button', button: { text: 'Share location' } })).toBe(true);
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledWith(`91${PHONE}`, locationRequests.ASK_TEXT);
    expect(LocationRequest.store[0].via).toBe('interactive');
  });

  test('already shared minutes ago (e.g. on the first call): reused, not asked again', async () => {
    on();
    const call = AiCall.add({});
    LocationRequest.add({ phone: PHONE, source: 'incoming_call', status: 'received', receivedAt: new Date(), location: { lat: 1, lng: 2, address: 'Here' } });
    expect(await locationRequests.request({ phone: PHONE, source: 'ai_caller', aiCall: call._id })).toEqual({ status: 'already_received' });
    expect(call.sharedLocation).toMatchObject({ lat: 1, lng: 2, address: 'Here' });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('E. style examples from real calls', () => {
  const ex = (extra = {}) => CallStyleExample.add({
    active: true, order: 0, title: 'Pickup first',
    transcript: [{ role: 'operator', text: 'ಹೇಳಿ ಸರ್, ಎಲ್ಲಿಂದ pickup?' }, { role: 'customer', text: 'Jayanagar, call 98450 12345' }],
    ...extra,
  });

  test('in the prompt: labelled, numbers always masked, details marked as not to copy', async () => {
    ex();
    const examples = await styleExamples.loadForPrompt();
    const block = prompt.styleBlock(examples);
    expect(block).toMatch(/HOW SAVELIFE'S OPERATORS TALK/);
    expect(block).toMatch(/Do NOT copy the details/);
    expect(block).toMatch(/SaveLife: ಹೇಳಿ ಸರ್, ಎಲ್ಲಿಂದ pickup\?/);
    expect(block).toMatch(/Caller: Jayanagar, call ••••••2345/);
    expect(block).not.toMatch(/98450/);
    expect(prompt.buildInstructions({ now: NOW, examples })).toContain(block);
  });

  test('only active examples, at most AI_STYLE_EXAMPLES_MAX, each cut to size', async () => {
    ex({ title: 'one' }); ex({ title: 'two' }); ex({ title: 'off', active: false }); ex({ title: 'three' }); ex({ title: 'four' });
    expect((await styleExamples.loadForPrompt()).map((e) => e.title)).toHaveLength(3);
    process.env.AI_STYLE_EXAMPLES_MAX = '1';
    expect(await styleExamples.loadForPrompt()).toHaveLength(1);
    process.env.AI_STYLE_EXAMPLES_MAX = '0';
    expect(await styleExamples.loadForPrompt()).toEqual([]);
    const long = styleExamples.forPrompt({ transcript: Array.from({ length: 40 }, () => ({ role: 'operator', text: 'x'.repeat(100) })) });
    expect(long.transcript.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(styleExamples.MAX_CHARS_PER_EXAMPLE);
  });

  test('loading failing never blocks a call', async () => {
    CallStyleExample.find.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(styleExamples.loadForPrompt()).resolves.toEqual([]);
  });

  describe('owner API', () => {
    const USERS = {
      owner1: { _id: 'owner1', name: 'Asha', role: 'owner', isActive: true },
      tc1   : { _id: 'tc1', name: 'Ravi', role: 'telecaller', isActive: true },
    };
    const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    let server; let base;
    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/ai-caller', require('../routes/aiCaller'));
      // eslint-disable-next-line no-unused-vars
      app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
      await new Promise((r) => { server = app.listen(0, r); });
      base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise((r) => server.close(r)));
    beforeEach(() => {
      const chain = (v) => { const q = { then: (a, b) => Promise.resolve(v).then(a, b) }; q.select = () => q; return q; };
      User.findById = jest.fn((id) => chain(USERS[id] || null));
    });
    const http = async (method, path, { token = tokenFor('owner1'), body } = {}) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };

    test('owner only: a telecaller gets 403', async () => {
      expect((await http('GET', '/api/ai-caller/style-examples', { token: tokenFor('tc1') })).status).toBe(403);
      expect((await http('POST', '/api/ai-caller/style-examples', { token: tokenFor('tc1'), body: { transcript: [] } })).status).toBe(403);
    });

    test('add from a captured call\'s transcript; listed as used among the candidates', async () => {
      const log = CallLog.add({
        createdAt: new Date(), summary: 'BLS to Victoria',
        transcript: [{ role: 'operator', text: 'Namaskara, SaveLife' }, { role: 'customer', text: 'Ambulance beku' }],
      });
      log.toJSON = () => ({ ...log, toJSON: undefined });
      const created = await http('POST', '/api/ai-caller/style-examples', { body: { callLogId: log._id, title: 'Good opening' } });
      expect(created.status).toBe(201);
      expect(created.body.example).toMatchObject({ title: 'Good opening', source: { callLog: log._id } });
      expect(created.body.example.transcript).toEqual([{ role: 'operator', text: 'Namaskara, SaveLife' }, { role: 'customer', text: 'Ambulance beku' }]);
      const cands = await http('GET', '/api/ai-caller/style-candidates');
      expect(cands.body.calls[0]).toMatchObject({ _id: log._id, turns: 2, used: true, summary: 'BLS to Victoria' });
    });

    test('pasted transcript validated; edit, switch off, delete', async () => {
      expect((await http('POST', '/api/ai-caller/style-examples', { body: { transcript: [{ role: 'robot', text: 'x' }] } })).status).toBe(400);
      const { body } = await http('POST', '/api/ai-caller/style-examples', { body: { title: 't', transcript: [{ role: 'operator', text: ' Hello  sir ' }] } });
      expect(body.example.transcript).toEqual([{ role: 'operator', text: 'Hello sir' }]);
      const id = body.example._id;
      expect((await http('PUT', `/api/ai-caller/style-examples/${id}`, { body: { active: false, title: 'renamed' } })).body.example).toMatchObject({ active: false, title: 'renamed' });
      expect((await http('DELETE', `/api/ai-caller/style-examples/${id}`)).status).toBe(200);
      expect(CallStyleExample.store).toHaveLength(0);
    });

    test('prompt preview: the instructions a call would get now, with the examples', async () => {
      ex();
      const { body } = await http('GET', '/api/ai-caller/prompt-preview');
      expect(body.styleExamples).toBe(1);
      expect(body.instructions).toMatch(/DATE AND TIME — right now it is/);
      expect(body.instructions).toMatch(/Caller: Jayanagar, call ••••••2345/);
    });
  });
});

// ============================================================
describe('F. read-back, approval, schedule, freezer flows, language', () => {
  const approve = (status) => async () => ({ status, heard: '' });
  const ctx = (call, status = 'yes') => ({ callId: call._id, phone: '9876543210', state: {}, approval: approve(status) });
  const run = (name, args, c) => tools.HANDLERS[name](args, c);
  const single = (name, lat, lng) => ({ status: 'single', place: { name, address: 'Bengaluru', lat, lng } });
  const quote = (c, args = {}) => {
    resolvePlaceFromText.mockResolvedValueOnce(single('Jayanagar', 1, 2)).mockResolvedValueOnce(single('Narayana Health', 3, 4));
    return run('get_quote', { service_code: 'bls', pickup: 'Jayanagar', drop: 'Narayana Health', ...args }, c);
  };
  beforeEach(() => {
    quoteTrip.mockResolvedValue({ fare: { grandTotal: 1450 }, distanceKm: 4.2, oneWayKm: 4.2 });
    createBookedTrip.mockResolvedValue({ _id: 'trip1', tripNumber: 'TRP-1', estimatedFare: 1450 });
  });

  test('home pickup at 6:00 PM, hospital appointment at 6:30 PM: kept separate in the read-back, the booking and the record', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    await quote(c, { patient_at: 'home' });
    const rb = await run('read_back_booking', {
      when: 'later', scheduled_time: '2099-01-02 18:00', appointment_time: '2099-01-02 18:30',
      patient_at: 'home', pickup_details: '42, 3rd Main, near Vijaya Bank',
    }, c);
    expect(rb.ok).toBe(true);
    expect(rb.summary).toMatch(/Pickup: 42, 3rd Main, near Vijaya Bank, Jayanagar, Bengaluru\. Drop: Narayana Health, Bengaluru\. Pickup time: \w{3} 2 Jan, 6:00 PM\. Hospital appointment: \w{3} 2 Jan, 6:30 PM \(separate from the pickup time\)\./);
    expect(rb.say).toMatch(/separately, the appointment time/);
    expect(rb.say).toMatch(/It is NOT booked yet/);
    expect((await run('create_booking', { customer_confirmed: true }, c)).ok).toBe(true);
    expect(createBookedTrip.mock.calls[0][0]).toMatchObject({ scheduleType: 'later', scheduleDate: '2099-01-02T18:00' });
    expect(call.needs.appointmentAt).toEqual(new Date('2099-01-02T13:00:00Z')); // 18:30 IST
  });

  test('an appointment at or before the pickup is refused — the appointment is not the pickup time', async () => {
    const c = ctx(AiCall.add({}));
    await quote(c, { patient_at: 'hospital' });
    const r = await run('read_back_booking', { when: 'later', scheduled_time: '2099-01-02 18:30', appointment_time: '2099-01-02 18:30' }, c);
    expect(r).toMatchObject({ ok: false, reason: 'pickup_not_before_appointment' });
  });

  test('home pickup without an exact address, landmark or pin: asked for before the read-back', async () => {
    const c = ctx(AiCall.add({}));
    await quote(c, { patient_at: 'home' });
    expect(await run('read_back_booking', { when: 'now' }, c)).toMatchObject({ ok: false, reason: 'need_pickup_details', say: expect.stringMatching(/exact address.*landmark/) });
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'not_read_back' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('a pickup change: the new get_quote voids the old quote and read-back; a failed re-quote leaves nothing to book', async () => {
    const c = ctx(AiCall.add({}));
    await quote(c, { patient_at: 'hospital' });
    expect((await run('read_back_booking', { when: 'now' }, c)).ok).toBe(true);
    resolvePlaceFromText.mockResolvedValueOnce({ status: 'multiple', places: [{ name: 'Manipal', address: 'Old Airport Rd', lat: 5, lng: 6 }, { name: 'Manipal', address: 'Hebbal', lat: 7, lng: 8 }] })
      .mockResolvedValueOnce(single('Narayana Health', 3, 4));
    expect(await run('get_quote', { service_code: 'bls', pickup: 'Manipal', drop: 'Narayana Health' }, c)).toMatchObject({ ok: false, reason: 'clarify_places' });
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'no_quote' });
    expect(await run('read_back_booking', { when: 'now' }, c)).toMatchObject({ ok: false, reason: 'no_quote' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('different details at create_booking than were read back: refused, read back again', async () => {
    const c = ctx(AiCall.add({}));
    await quote(c, { patient_at: 'hospital' });
    await run('read_back_booking', { when: 'later', scheduled_time: '2099-01-02 18:00' }, c);
    expect(await run('create_booking', { customer_confirmed: true, when: 'later', scheduled_time: '2099-01-02 19:00' }, c)).toMatchObject({ ok: false, reason: 'details_changed', changed: ['scheduled_time'] });
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'not_read_back' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test.each([['no', 'caller_said_no'], ['unclear', 'approval_unclear'], ['not_read_back', 'approval_not_read_back']])('caller answer "%s": no booking', async (status, reason) => {
    const c = ctx(AiCall.add({}), status);
    await quote(c, { patient_at: 'hospital' });
    await run('read_back_booking', { when: 'now' }, c);
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('a booking already on the AiCall (a retry after state was lost) is never booked twice', async () => {
    const c = ctx(AiCall.add({ trip: 'tripX' }));
    await quote(c, { patient_at: 'hospital' });
    await run('read_back_booking', { when: 'now' }, c);
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'already_booked', trip_number: 'tripX' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('body transport: pickup, destination, time — and "freezer box too?" recorded with the booking, never priced', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    await quote(c, { patient_at: 'hospital' });
    await run('read_back_booking', { when: 'later', scheduled_time: '2099-01-02 07:00' }, c);
    const r = await run('create_booking', { customer_confirmed: true, freezer_box_needed: true }, c);
    expect(r.say).toMatch(/and the freezer box and its charge/);
    expect(call.needs.freezerBox).toBe(true);
    expect(call.request).toBeUndefined(); // not a home freezer-box request
  });

  test('freezer box at home never books a vehicle', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    const r = await run('freezer_box_request', { address: '7 Temple St, Malleshwaram', start_time: 'now', hours: 12 }, c);
    expect(r.ok).toBe(true);
    expect(call.request).toMatchObject({ type: 'freezer_box', address: '7 Temple St, Malleshwaram', hours: 12 });
    expect(quoteTrip).not.toHaveBeenCalled();
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('WhatsApp disabled: not_sent, and she is told to ask the address on the call', async () => {
    const c = ctx(AiCall.add({}));
    const r = await run('send_location_request', {}, c);
    expect(r).toMatchObject({ ok: false, status: 'not_sent', reason: 'whatsapp_off' });
    expect(r.say).toMatch(/Do not say a link was sent.*Ask on the call for the address/);
    expect(c.state.whatsapp).toBe('off');
  });

  test('approval words: a no / not yet always wins; unclear is not a yes', () => {
    const approval = require('../services/aiCaller/approval');
    ['ಹೌದು ಮೇಡಮ್, ಬುಕ್ ಮಾಡಿ', 'ಮಾಡಿ ಮಾಡಿ', 'మాడి మాడి', 'yes please', 'ok book it', 'हाँ कर दो', 'சரி பண்ணுங்க', 'ശരി'].forEach((t) => expect([t, approval.classify(t)]).toEqual([t, 'yes']));
    ['ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ', 'ಬೇಡ', 'ಆಮೇಲೆ ಹೇಳ್ತೀನಿ', 'not yet', 'wait', 'अभी नहीं', 'బేడా', 'வேண்டாம்', 'ಹೌದು ಆದ್ರೆ ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ'].forEach((t) => expect([t, approval.classify(t)]).toEqual([t, 'no']));
    ['ಎಷ್ಟು ಹೊತ್ತಲ್ಲಿ ಬರುತ್ತೆ?', '', 'ಹಲೋ', 'मतलब कितना'].forEach((t) => expect([t, approval.classify(t)]).toEqual([t, 'unclear']));
  });

  test('language requests: explicit only; places and look-alike words are not requests', () => {
    const { detectLanguageRequest: d } = require('../services/aiCaller/language');
    expect(d('ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ')).toEqual({ lang: 'kn', name: 'Kannada' });
    expect(d('English please')).toEqual({ lang: 'en', name: 'English' });
    expect(d('Hindi mein boliye')).toEqual({ lang: 'hi', name: 'Hindi' });
    expect(d('ನನಗೆ ಕನ್ನಡ ಬರಲ್ಲ')).toEqual({ cannot: 'kn', name: 'Kannada' });
    ['ambulance pickup discharge', 'ಹಿಂದಿನ ರಸ್ತೆಯಲ್ಲಿ ಮನೆ', 'Tamil Nadu alli hogbeku', 'Dakshina Kannada alli', 'మనెల్లిదరే', 'Kannada beda English please']
      .forEach((t) => expect([t, d(t)]).toEqual([t, null]));
  });

  test('instructions: listen, language lock, branch, pickup vs appointment, WhatsApp honesty, booking only after a clear yes', () => {
    const I = prompt.BASE_INSTRUCTIONS;
    expect(I).toMatch(/LISTEN — let the caller finish/);
    expect(I).toMatch(/do not jump in with "ಸರಿ", "ಹೂಂ" or "ಓಕೆ" while they are still talking/);
    expect(I).toMatch(/ONE short question at a time/);
    expect(I).toMatch(/If the caller ASKS for a language \("ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ", "English please"/);
    expect(I).toMatch(/never by how a transcript is spelled/);
    expect(I).toMatch(/ask ONCE: "ಕನ್ನಡ ಅಥವಾ English — ಯಾವುದರಲ್ಲಿ ಮಾತಾಡಲಿ\?"/);
    expect(I).toMatch(/confirm which branch/);
    expect(I).toMatch(/PICKUP time .* is not the same as a hospital appointment/);
    expect(I).toMatch(/Say "ಲಿಂಕ್ ಕಳಿಸಿದ್ದೇನೆ" ONLY if it returns status sent/);
    expect(I).toMatch(/"ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ", "not yet", "wait", an unclear answer, or a change in any detail = do NOT book/);
    expect(I).toMatch(/Say "ಬುಕ್ಕಿಂಗ್ ಆಯ್ತು" ONLY after create_booking returned ok/);
    expect(I).toMatch(/If ANYTHING in the route changes .* call get_quote again and say the NEW fare/);
    expect(session.DELEGATE_INSTRUCTIONS).toMatch(/create_booking ONLY after the caller's clear yes to that read-back/);
  });
});

// ============================================================
describe('G. vehicles, freezer packages, Eeco over 800 km, places, staff questions', () => {
  const ctx = (call) => ({ callId: call._id, phone: '9876543210', state: {}, approval: async () => ({ status: 'yes', heard: 'ಹೌದು' }) });
  const run = (name, args, c) => tools.HANDLERS[name](args, c);
  const single = (name, lat, lng, types) => ({ status: 'single', place: { name, address: 'India', lat, lng, ...(types ? { types } : {}) } });
  const VEHICLE = { bls: 'Maruti Eeco', body_mini: 'Maruti Eeco', bls_tempo: 'Tempo Traveller', body_tempo: 'Tempo Traveller', als_tempo: 'Tempo Traveller' };
  // quoteTrip as the real one answers: the Pricing doc's vehicleType on the fare.
  const priced = (km, vehicleFor = VEHICLE) => quoteTrip.mockImplementation(async (q) => ({ distanceKm: km, oneWayKm: km, fare: { grandTotal: 1000 + Math.round(km), vehicleType: vehicleFor[q.selectedType] } }));
  const quote = (c, args) => {
    resolvePlaceFromText.mockResolvedValueOnce(single('Victoria Hospital', 1, 2)).mockResolvedValueOnce(single('Hubballi', 3, 4));
    return run('get_quote', { pickup: 'Victoria Hospital', drop: 'Hubballi', patient_at: 'hospital', ...args }, c);
  };
  beforeEach(() => {
    priced(420);
    createBookedTrip.mockResolvedValue({ _id: 'trip1', tripNumber: 'TRP-1', estimatedFare: 1420 });
  });

  test('Body Shifting — Tempo: the freezer is included in the quoted fare, in the read-back and on the booking', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    const q = await quote(c, { service_code: 'body_tempo' });
    expect(q).toMatchObject({ ok: true, freezer: 'included', vehicle: expect.stringMatching(/Tempo Traveller/) });
    expect(q.say).toMatch(/Freezer: INCLUDED in this Body Shifting — Tempo fare.*never say the team will quote a separate freezer charge/);
    const rb = await run('read_back_booking', { when: 'now' }, c);
    expect(rb.summary).toMatch(/Freezer: included in this fare\./);
    const r = await run('create_booking', { customer_confirmed: true, freezer_box_needed: true }, c);
    expect(r.say).toMatch(/The freezer is included — no separate freezer charge/);
    expect(r.say).not.toMatch(/freezer box and its charge/);
    expect(call.needs).toMatchObject({ freezerIncluded: true });
    expect(call.needs.freezerBox).toBeUndefined();
  });

  test('Body Mini — Eeco: no freezer; a freezer request offers the Tempo and re-quotes ONLY when chosen', async () => {
    const c = ctx(AiCall.add({}));
    const q = await quote(c, { service_code: 'body_mini', freezer_needed: true });
    expect(q).toMatchObject({ ok: true, freezer: 'not_included' });
    expect(q.say).toMatch(/does NOT include a freezer.*offer Body Shifting — Tempo.*only if they choose it, get_quote again with service_code body_tempo/);
    expect(quoteTrip.mock.calls.every(([a]) => a.selectedType === 'body_mini')).toBe(true); // not switched
    expect(await run('read_back_booking', { when: 'now', freezer_needed: true }, c)).toMatchObject({ ok: false, reason: 'freezer_not_on_eeco' });
    // The caller chooses the Tempo: a fresh quote for it.
    const t = await quote(c, { service_code: 'body_tempo' });
    expect(t).toMatchObject({ ok: true, freezer: 'included' });
    expect(quoteTrip.mock.calls.at(-1)[0].selectedType).toBe('body_tempo');
  });

  test('the quote contradicts the catalog: no freezer promised, the mismatch is recorded for staff', async () => {
    priced(420, { ...VEHICLE, body_tempo: 'Maruti Eeco' });
    const call = AiCall.add({});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const q = await quote(ctx(call), { service_code: 'body_tempo' });
      expect(q).toMatchObject({ ok: true, freezer: 'unverified', catalog_mismatch: expect.stringMatching(/Pricing says Maruti Eeco, the booking page says Tempo Traveller/) });
      expect(q.say).toMatch(/do not promise a freezer; say the team will confirm it/);
      expect(q).not.toHaveProperty('includes');
      await new Promise((r) => setImmediate(r));
      expect(call.catalogMismatches[0]).toMatchObject({ code: 'body_tempo', expected: 'tempo', pricing: 'Maruti Eeco' });
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ['bls', 800, null],
    ['bls', 800.4, 'bls_tempo'],
    ['body_mini', 800, null],
    ['body_mini', 812, 'body_tempo'],
    ['bls_tempo', 1200, null], // already a Tempo Traveller
  ])('%s at %s km: Tempo Traveller recommended -> %s (never switched)', async (code, km, expected) => {
    priced(km);
    const q = await quote(ctx(AiCall.add({})), { service_code: code });
    expect(q.ok).toBe(true);
    if (expected) {
      expect(q.recommend_tempo_traveller).toMatchObject({ service_code: expected, over_km: 800 });
      expect(q.say).toMatch(/ಈ ಪ್ರಯಾಣ 800 ಕಿಲೋಮೀಟರ್‌ಗಿಂತ ಹೆಚ್ಚು ಇದೆ/);
      expect(q.say).toMatch(/Do NOT change the vehicle yourself/);
      if (code === 'bls') expect(q.say).toMatch(/the same care level in a bigger vehicle; it is NOT an ICU ambulance/);
    } else {
      expect(q).not.toHaveProperty('recommend_tempo_traveller');
    }
    expect(quoteTrip.mock.calls.every(([a]) => a.selectedType === code)).toBe(true);
  });

  test('"Eeco ಅಂದ್ರೆ ಯಾವ ಗಾಡಿ?": a Maruti Suzuki Eeco used as an ambulance', async () => {
    const r = await run('service_info', { service_code: 'bls', question: 'what vehicle is Eeco' }, ctx(AiCall.add({})));
    expect(r).toMatchObject({ ok: true, vehicle: 'a Maruti Suzuki Eeco van used as an ambulance', care_level: 'BLS (basic life support)' });
    expect(r.say).toMatch(/ಅದು ಮಾರುತಿ ಸುಜುಕಿ ಈಕೋ ವಾಹನವನ್ನು ಆಂಬುಲೆನ್ಸ್ ಆಗಿ ಬಳಸುವ ಸೇವೆ/);
    const all = await run('service_info', { question: 'what is duty' }, ctx(AiCall.add({})));
    expect(all.say).toMatch(/ask once which service or arrangement/);
    expect(all.services.find((s) => s.code === 'als_tempo').includes).toEqual(expect.arrayContaining([expect.stringMatching(/nurse/)]));
  });

  test('"Assam": a whole state is refused — ask the town and the exact drop before any price', async () => {
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('Victoria Hospital', 1, 2, ['hospital', 'establishment']))
      .mockResolvedValueOnce(single('Assam', 26.2, 92.9, ['administrative_area_level_1', 'political']));
    const r = await run('get_quote', { service_code: 'body_tempo', pickup: 'Victoria Hospital', drop: 'Assam' }, c);
    expect(r).toMatchObject({ ok: false, reason: 'place_too_vague', which: 'drop', say: expect.stringMatching(/town or district \(or the PIN code\) and the exact drop/) });
    expect(quoteTrip).not.toHaveBeenCalled();
    resolvePlaceFromText.mockResolvedValueOnce(single('Victoria Hospital', 1, 2)).mockResolvedValueOnce(single('Guwahati Medical College', 26.1, 91.7, ['hospital', 'establishment']));
    expect((await run('get_quote', { service_code: 'body_tempo', pickup: 'Victoria Hospital', drop: 'GMCH Guwahati' }, c)).ok).toBe(true);
  });

  test('a vehicle change invalidates the old quote and approval', async () => {
    const c = ctx(AiCall.add({}));
    await quote(c, { service_code: 'body_mini' });
    expect((await run('read_back_booking', { when: 'now' }, c)).ok).toBe(true);
    await quote(c, { service_code: 'body_tempo' });
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'not_read_back' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('body transport is one way only, as on the booking pages', async () => {
    const r = await quote(ctx(AiCall.add({})), { service_code: 'body_tempo', round_trip: true });
    expect(r).toMatchObject({ ok: false, reason: 'one_way_only' });
  });

  test('ALS: the nurse is included — not "the team will confirm a nurse charge"', async () => {
    const q = await quote(ctx(AiCall.add({})), { service_code: 'als_tempo', nurse_needed: true });
    expect(q.say).toMatch(/a nurse is INCLUDED in this service/);
    expect(q.say).not.toMatch(/no nurse charge in our price list/);
  });

  test('discount / advance / conditional yes: recorded for staff, nothing booked, no pressure to book', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    await quote(c, { service_code: 'body_tempo' });
    await run('read_back_booking', { when: 'now' }, c);
    const r = await run('record_question', { topic: 'discount', question: 'book only with 10% discount', conditional_booking: true }, c);
    expect(r.say).toMatch(/team member will call back about the discount.*nothing is booked, and do not ask to book again/);
    expect(call.staffQuestions).toEqual([expect.objectContaining({ topic: 'discount', conditionalBooking: true })]);
    expect(await run('create_booking', { customer_confirmed: true }, c)).toMatchObject({ ok: false, reason: 'not_read_back' });
    await run('record_question', { topic: 'advance', question: 'how much advance' }, c);
    expect(call.staffQuestions[1]).toMatchObject({ topic: 'advance', conditionalBooking: false });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('instructions carry the vehicle and freezer rules', () => {
    const I = prompt.BASE_INSTRUCTIONS;
    expect(I).toMatch(/Body Shifting — Tempo: the freezer is INCLUDED in its fare/);
    expect(I).toMatch(/Body Mini — Eeco: NO freezer/);
    expect(I).toMatch(/ಅದು ಮಾರುತಿ ಸುಜುಕಿ ಈಕೋ ವಾಹನವನ್ನು ಆಂಬುಲೆನ್ಸ್ ಆಗಿ ಬಳಸುವ ಸೇವೆ/);
    expect(I).toMatch(/a Tempo Traveller is not an ICU ambulance/);
    expect(I).toMatch(/"Book only if you give a discount" is NOT a yes/);
    expect(I).toMatch(/do not keep repeating "ಜಿ", "ಮೇಡಂ" or "ಒಂದು ನಿಮಿಷ"/);
    expect(I).toMatch(/Never read the whole summary again: if create_booking says a part was not heard, repeat only that part/);
    expect(I).toMatch(/A clear no \("ಬೇಡ", "अभी बुक मत कीजिए"\): do not ask again/);
    expect(I).toMatch(/\("Assam"\), ask the town or district/);
  });
});
