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
  const apply = (doc, update) => Object.entries(update.$set || {}).forEach(([k, v]) => setPath(doc, k, v));
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
jest.mock('../controllers/tripController', () => ({ quoteTrip: jest.fn(), createBookedTrip: jest.fn() }));
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
const { quoteTrip, createBookedTrip } = require('../controllers/tripController');
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
    expect(I).toMatch(/FREEZER BOX: ask ONE simple question/);
    expect(I).toMatch(/Box at home: ask only the AREA and for HOW MANY DAYS/);
    expect(I).toMatch(/oxygen/);
    expect(I).toMatch(/helper/);
    expect(I).toMatch(/Prioritise Kannada, English, Hindi, Telugu, Tamil and Malayalam/);
    expect(I).toMatch(/ANY other language, understand it and reply in that same language — never turn a caller away over language/);
    expect(I).toMatch(/NEVER give medical advice/);
    expect(session.OPENING).toBe(`${session.DISCLOSURE_KN} ${session.DISCLOSURE_EN} Ambulance ಬೇಕಾ?`);
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
  const ctx = (call) => ({ callId: call._id, phone: '9876543210', state: {} });
  const run = (name, args, c) => tools.HANDLERS[name](args, c);
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

  test('helper is priced (Pricing via quoteTrip) and booked; a changed helper choice needs a new quote', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B', helper_needed: true }, c);
    expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({ helperEnabled: true }));
    expect(await run('create_booking', { when: 'now', customer_confirmed: true, helper_needed: false }, c)).toMatchObject({ ok: false, reason: 'requote_helper' });
    expect(createBookedTrip).not.toHaveBeenCalled();
    const r = await run('create_booking', {
      patient_name: 'Lakshmi', when: 'now', customer_confirmed: true, helper_needed: true,
      patient_condition: 'fell at home, hip pain', oxygen_needed: false, patient_at: 'home',
    }, c);
    expect(r.ok).toBe(true);
    expect(createBookedTrip.mock.calls[0][0]).toMatchObject({ helperEnabled: true });
    expect(createBookedTrip.mock.calls[0][1]).toEqual({ bookingSource: 'ai_telecaller' });
    expect(call.needs).toEqual({ condition: 'fell at home, hip pain', oxygen: false, helper: true, patientAt: 'home' });
  });

  test('a scheduled time already in the past is refused', async () => {
    const c = ctx(AiCall.add({}));
    resolvePlaceFromText.mockResolvedValueOnce(single('A', 1, 2)).mockResolvedValueOnce(single('B', 3, 4));
    await run('get_quote', { service_code: 'bls', pickup: 'A', drop: 'B' }, c);
    const r = await run('create_booking', { when: 'later', scheduled_time: '2020-01-01 10:00', customer_confirmed: true }, c);
    expect(r).toMatchObject({ ok: false, reason: 'past_time' });
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  test('freezer box at home: area + days recorded for a callback, never priced', async () => {
    const call = AiCall.add({});
    const c = ctx(call);
    expect(await run('freezer_box_request', { area: '', days: 2 }, c)).toMatchObject({ ok: false, reason: 'need_area' });
    expect(await run('freezer_box_request', { area: 'Basavanagudi', days: 0 }, c)).toMatchObject({ ok: false, reason: 'need_days' });
    const r = await run('freezer_box_request', { area: 'Basavanagudi', days: 3 }, c);
    expect(r.ok).toBe(true);
    expect(r.say).toMatch(/call back/);
    expect(call.request).toMatchObject({ type: 'freezer_box', area: 'Basavanagudi', days: 3 });
    expect(quoteTrip).not.toHaveBeenCalled();
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
