/**
 * tests/waWelcomeLocation.test.js
 * ============================================================
 * The "📍 Send Location" quick-reply on the savelife_welcome template
 * (services/waWelcomeLocation.js), together with the real call-flow
 * services/locationRequests.js it shares the webhook with:
 *   A. the tap — matched loosely (English / Kannada, title or payload) and
 *      answered with the one-tap location request; nothing else is a tap
 *   B. the pin — recorded, a WhatsApp lead (source whatsapp) with the
 *      pickup created once and rung once, "is this the pickup point?" with
 *      Yes / Change
 *   C. a different location — another pin or a typed address replaces the
 *      pickup (same lead); several Places matches are never guessed
 *   D. Yes — confirmed on the request and the lead; later messages go to
 *      the bot
 *   E. the call — a live call capture for the same number gets the pickup
 *      exactly as call-capture does (applySharedPickup)
 *   F. the bot is untouched — off switch, no open request, "hi" / "menu",
 *      a call's own pending request keeps its flow
 *   G. the CRM alert for a pickup lead; the webhook wiring
 *
 * Stubbed: the database (in-memory), WhatsApp sends, Places / reverse
 * geocoding, the CRM push and the call-capture session. No message is sent.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-wa-welcome-secret';

// ── In-memory model helper ──────────────────────────────────
function mockMemoryModel() {
  const store = [];
  let seq = 0;
  const get = (doc, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
  const cmp = (val, v) => {
    if (v === null) return val == null;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.map(String).includes(String(val));
      if ('$ne' in v) return String(val) !== String(v.$ne);
      if ('$gte' in v) return val != null && new Date(val) >= new Date(v.$gte);
    }
    return String(val) === String(v);
  };
  const matches = (doc, filter = {}) => Object.entries(filter).every(([k, v]) => cmp(get(doc, k), v));
  const setPath = (doc, path, v) => {
    const keys = path.split('.');
    let o = doc;
    keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    o[keys[keys.length - 1]] = v;
  };
  const chain = (fn) => {
    let sortSpec = null;
    const q = {
      sort(s) { sortSpec = s; return q; },
      select() { return q; }, lean() { return q; }, populate() { return q; },
      then(res, rej) {
        return Promise.resolve().then(() => fn(sortSpec)).then(res, rej);
      },
    };
    return q;
  };
  const sorted = (list, spec) => {
    if (!spec) return list;
    const [[k, dir]] = Object.entries(spec);
    return [...list].sort((a, b) => (new Date(get(a, k)) - new Date(get(b, k))) * (dir < 0 ? -1 : 1));
  };
  return {
    store,
    reset() { store.length = 0; seq = 0; },
    add(doc) { const d = { _id: `id${++seq}`, createdAt: new Date(), ...doc }; store.push(d); return d; },
    findOne: jest.fn((filter) => chain((spec) => sorted(store.filter((d) => matches(d, filter)), spec)[0] || null)),
    findById: jest.fn((id) => chain(() => store.find((d) => String(d._id) === String(id)) || null)),
    exists: jest.fn(async (filter) => (store.some((d) => matches(d, filter)) ? { _id: 'x' } : null)),
    create: jest.fn(async (doc) => { const d = { _id: `id${++seq}`, createdAt: new Date(), ...doc }; store.push(d); return d; }),
    updateOne: jest.fn(async (filter, update, opts = {}) => {
      let doc = store.find((d) => matches(d, filter));
      if (!doc && opts.upsert) { doc = { _id: `id${++seq}`, ...filter }; store.push(doc); }
      if (!doc) return { modifiedCount: 0 };
      Object.entries(update.$set || {}).forEach(([k, v]) => setPath(doc, k, v));
      return { modifiedCount: 1 };
    }),
  };
}

jest.mock('../models/LocationRequest', () => mockMemoryModel());
jest.mock('../models/WhatsAppLead', () => mockMemoryModel());
jest.mock('../models/CallLog', () => mockMemoryModel());
jest.mock('../models/WhatsAppContact', () => mockMemoryModel());
jest.mock('../models/WhatsAppSession', () => mockMemoryModel());
jest.mock('../models/AiCall', () => mockMemoryModel());
jest.mock('../services/whatsappService', () => ({
  sendText: jest.fn(async () => ({ ok: 1 })),
  sendButtons: jest.fn(async () => ({ ok: 1 })),
  sendList: jest.fn(async () => ({ ok: 1 })),
  sendTemplate: jest.fn(async () => ({ ok: 1 })),
  sendLocationRequest: jest.fn(async () => ({ ok: 1 })),
}));
jest.mock('../services/bookingPush', () => ({ notifyWhatsAppLead: jest.fn(), notifyWhatsAppChat: jest.fn() }));
jest.mock('../services/callCapture/session', () => ({ applySharedPickup: jest.fn(async () => true) }));
jest.mock('../services/whatsappFlow', () => ({
  resolveAddressForLocation: jest.fn(async (lat, lng, meta) => meta || `Pinned ${lat},${lng}`),
  resolvePlaceFromText: jest.fn(async () => ({ status: 'none' })),
  handleMessage: jest.fn(async () => {}),
}));

const LocationRequest = require('../models/LocationRequest');
const WhatsAppLead = require('../models/WhatsAppLead');
const CallLog = require('../models/CallLog');
const WhatsAppSession = require('../models/WhatsAppSession');
const whatsapp = require('../services/whatsappService');
const bookingPush = require('../services/bookingPush');
const capture = require('../services/callCapture/session');
const flow = require('../services/whatsappFlow');
const locationRequests = require('../services/locationRequests');
const welcome = require('../services/waWelcomeLocation');

const FROM = '919876543210';
const TEN = '9876543210';
let n = 0;
const msg = (body) => ({ id: `wamid.${++n}`, from: FROM, ...body });
const tap = (text = '📍 Send Location / ಕಳುಹಿಸಿ', payload) => msg({ type: 'button', button: { text, ...(payload ? { payload } : {}) } });
const pin = (lat, lng, extra = {}) => msg({ type: 'location', location: { latitude: lat, longitude: lng, ...extra } });
const text = (body) => msg({ type: 'text', text: { body } });
const button = (id, title) => msg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });

// The webhook's order (routes/whatsappRoutes.js): call flow, welcome, bot.
async function inbound(m) {
  if (await locationRequests.onInbound(m)) return 'call';
  if (await welcome.onInbound(m)) return 'welcome';
  await flow.handleMessage(m);
  return 'bot';
}
const welcomeReq = () => LocationRequest.store.filter((r) => r.source === 'whatsapp_welcome');

beforeEach(() => {
  [LocationRequest, WhatsAppLead, CallLog, WhatsAppSession].forEach((M) => M.reset());
  require('../models/WhatsAppContact').reset();
  require('../models/AiCall').reset();
  Object.values(whatsapp).forEach((f) => f.mockClear());
  whatsapp.sendButtons.mockImplementation(async () => ({ ok: 1 }));
  bookingPush.notifyWhatsAppLead.mockClear();
  capture.applySharedPickup.mockClear();
  flow.handleMessage.mockClear();
  flow.resolvePlaceFromText.mockReset();
  flow.resolvePlaceFromText.mockImplementation(async () => ({ status: 'none' }));
  delete process.env.WA_WELCOME_LOCATION_ENABLED;
  process.env.WA_CALL_LOCATION_ENABLED = 'true';
});

// ============================================================
describe('A. the tap', () => {
  test('the template quick-reply gets the one-tap location request (bilingual), recorded as a welcome request', async () => {
    expect(await inbound(tap())).toBe('welcome');
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledWith(FROM, locationRequests.ASK_TEXT);
    expect(locationRequests.ASK_TEXT).toMatch(/ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ/);
    expect(locationRequests.ASK_TEXT).toMatch(/please tap the button below to send your pickup location/);
    expect(welcomeReq()).toEqual([expect.objectContaining({ phone: TEN, status: 'sent', via: 'interactive' })]);
    expect(flow.handleMessage).not.toHaveBeenCalled();
  });

  test('matched loosely: any case, payload only, the Kannada word alone, or an interactive reply with that title', () => {
    expect(welcome.isSendLocationTap(tap('send LOCATION'))).toBe(true);
    expect(welcome.isSendLocationTap(tap('📍', 'SEND_LOCATION'))).toBe(true);
    expect(welcome.isSendLocationTap(tap('ಕಳುಹಿಸಿ'))).toBe(true);
    expect(welcome.isSendLocationTap(button('x', '📍 Send Location'))).toBe(true);
    expect(welcome.isSendLocationTap(tap('Book now'))).toBe(false);
    expect(welcome.isSendLocationTap(text('send location'))).toBe(false); // typed, not a tap
    expect(welcome.isSendLocationTap(button('lang_en', 'English'))).toBe(false);
  });

  test('a second tap reuses the open request (no duplicate)', async () => {
    await inbound(tap());
    await inbound(tap());
    expect(welcomeReq()).toHaveLength(1);
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledTimes(2);
  });

  test('WhatsApp refusing the request is recorded as failed, and later messages go to the bot', async () => {
    whatsapp.sendLocationRequest.mockResolvedValueOnce(null);
    await inbound(tap());
    expect(welcomeReq()[0]).toMatchObject({ status: 'failed' });
    expect(await inbound(text('hello there'))).toBe('bot');
  });
});

// ============================================================
describe('B. the pin', () => {
  test('recorded; a WhatsApp lead with the pickup, rung once; "is this the pickup point?" with Yes / Change', async () => {
    await inbound(tap());
    expect(await inbound(pin(12.97, 77.59, { name: 'Jayanagar 4th Block' }))).toBe('welcome');

    const req = welcomeReq()[0];
    expect(req).toMatchObject({ status: 'received', pickupSource: 'pin', location: { lat: 12.97, lng: 77.59, address: 'Jayanagar 4th Block' } });
    expect(WhatsAppLead.store).toEqual([expect.objectContaining({
      phone: FROM, source: 'whatsapp', service: welcome.LEAD_SERVICE,
      pickup: expect.objectContaining({ label: 'Jayanagar 4th Block', lat: 12.97, lng: 77.59, source: 'pin' }),
    })]);
    expect(req.whatsappLead).toBe(WhatsAppLead.store[0]._id);
    expect(bookingPush.notifyWhatsAppLead).toHaveBeenCalledTimes(1);

    const [to, body, buttons] = whatsapp.sendButtons.mock.calls[0];
    expect(to).toBe(FROM);
    expect(body).toMatch(/📍 Location received: Jayanagar 4th Block/);
    expect(body).toMatch(/Is this the pickup point\? ✅ Reply Yes, OR send a different location \/ type the address if the patient is somewhere else\./);
    expect(body).toMatch(/ಇದೇ ಪಿಕಪ್ ಸ್ಥಳವೇ\?/);
    expect(buttons.map((b) => b.id)).toEqual([welcome.YES_ID, welcome.CHANGE_ID]);
    buttons.forEach((b) => expect(b.title.length).toBeLessThanOrEqual(20)); // WhatsApp's button title cap
    expect(flow.handleMessage).not.toHaveBeenCalled();
  });

  test('no pin name: the address comes from the bot\'s reverse geocoding', async () => {
    await inbound(tap());
    await inbound(pin(12.9, 77.5));
    expect(flow.resolveAddressForLocation).toHaveBeenCalledWith(12.9, 77.5, null);
    expect(welcomeReq()[0].location.address).toBe('Pinned 12.9,77.5');
  });

  test('if the buttons are refused, the same question goes as plain text', async () => {
    whatsapp.sendButtons.mockResolvedValueOnce(null);
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(whatsapp.sendText).toHaveBeenCalledWith(FROM, expect.stringMatching(/Is this the pickup point\?/));
  });
});

// ============================================================
describe('C. a different location', () => {
  test('a second pin replaces the pickup — same lead, rung once — and is asked again', async () => {
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    await inbound(pin(13.0, 77.6, { address: 'Hebbal' }));
    expect(welcomeReq()[0].location).toEqual({ lat: 13.0, lng: 77.6, address: 'Hebbal' });
    expect(WhatsAppLead.store).toHaveLength(1);
    expect(WhatsAppLead.store[0].pickup).toMatchObject({ label: 'Hebbal', lat: 13.0 });
    expect(bookingPush.notifyWhatsAppLead).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendButtons).toHaveBeenCalledTimes(2);
  });

  test('a typed address resolving to one place replaces the pickup (kept as typed)', async () => {
    flow.resolvePlaceFromText.mockResolvedValue({ status: 'single', place: { name: 'Apollo Hospital', address: 'Bannerghatta Road, Bengaluru', lat: 12.89, lng: 77.6 } });
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(await inbound(text('Apollo hospital bannerghatta'))).toBe('welcome');
    expect(welcomeReq()[0]).toMatchObject({ pickupSource: 'typed', typedText: 'Apollo hospital bannerghatta', location: { address: 'Apollo Hospital, Bannerghatta Road, Bengaluru' } });
    expect(WhatsAppLead.store[0].pickup).toMatchObject({ label: 'Apollo Hospital, Bannerghatta Road, Bengaluru', source: 'typed' });
  });

  test('typing the address instead of sharing a pin at all works too', async () => {
    flow.resolvePlaceFromText.mockResolvedValue({ status: 'single', place: { name: 'Jayanagar', address: 'Jayanagar, Bengaluru', lat: 12.93, lng: 77.58 } });
    await inbound(tap());
    await inbound(text('Jayanagar'));
    expect(welcomeReq()[0]).toMatchObject({ status: 'received', location: { address: 'Jayanagar, Bengaluru' } });
  });

  test('several matches are never guessed: asked for the area / a landmark; the pickup is unchanged', async () => {
    flow.resolvePlaceFromText.mockResolvedValue({ status: 'multiple', places: [{}, {}] });
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    await inbound(text('Manipal Hospital'));
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(FROM, expect.stringMatching(/more than one place for "Manipal Hospital"/));
    expect(welcomeReq()[0].location.address).toBe('Rajajinagar');
  });

  test('nothing found: asked to type the area and a landmark, or share the pin', async () => {
    await inbound(tap());
    await inbound(text('asdfgh'));
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(FROM, expect.stringMatching(/could not find "asdfgh"/));
  });

  test('the Change button (or "different location" / "ಬೇರೆ") sends the location request again', async () => {
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    whatsapp.sendLocationRequest.mockClear();
    await inbound(button(welcome.CHANGE_ID, '📍 Change / ಬದಲಿಸಿ'));
    await inbound(text('different location'));
    await inbound(text('ಬೇರೆ'));
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledTimes(3);
    expect(flow.resolvePlaceFromText).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('D. Yes', () => {
  test('the Yes button confirms on the request and the lead; thanked; the next message goes to the bot', async () => {
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(await inbound(button(welcome.YES_ID, '✅ Yes / ಹೌದು'))).toBe('welcome');
    expect(welcomeReq()[0].confirmedAt).toBeInstanceOf(Date);
    expect(WhatsAppLead.store[0].pickup.confirmedAt).toBeInstanceOf(Date);
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(FROM, welcome.DONE_TEXT);
    expect(welcome.DONE_TEXT).toMatch(/Our team will call you shortly to confirm the drop and the fare/);
    expect(await inbound(text('hello'))).toBe('bot');
  });

  test('typed yes in the customer\'s words counts', () => {
    ['yes', 'Yes.', 'ok', 'haan', 'ಹೌದು', 'ಸರಿ', 'हाँ', 'అవును', '✅', '👍'].forEach((t) => expect([t, welcome.YES_RE.test(t)]).toEqual([t, true]));
    ['yes take me to Manipal', 'Jayanagar', 'no'].forEach((t) => expect([t, welcome.YES_RE.test(t)]).toEqual([t, false]));
  });

  test('"yes" before any location just asks for it again (nothing confirmed)', async () => {
    await inbound(tap());
    whatsapp.sendLocationRequest.mockClear();
    await inbound(text('yes'));
    expect(whatsapp.sendLocationRequest).toHaveBeenCalledTimes(1);
    expect(welcomeReq()[0].confirmedAt).toBeUndefined();
    expect(WhatsAppLead.store).toHaveLength(0);
  });

  test('a voice note or photo while it is open gets a short nudge, not the bot', async () => {
    await inbound(tap());
    expect(await inbound(msg({ type: 'audio', audio: { id: 'a1' } }))).toBe('welcome');
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(FROM, expect.stringMatching(/Please share the pickup location pin, or type the address/));
  });
});

// ============================================================
describe('E. the pickup fills a live call capture, as call-capture does', () => {
  test('the number\'s call in the last 2 h: applySharedPickup with the pickup', async () => {
    CallLog.add({ customerPhone: TEN });
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(capture.applySharedPickup).toHaveBeenCalledWith(CallLog.store[0]._id, { label: 'Rajajinagar', lat: 12.9, lng: 77.5 });
  });

  test('an older call is left alone; no call, no capture touched', async () => {
    CallLog.add({ customerPhone: TEN, createdAt: new Date(Date.now() - 3 * 3600e3) });
    await inbound(tap());
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(capture.applySharedPickup).not.toHaveBeenCalled();
  });

  test('a call\'s own earlier request is answered by the same pin (marked received, its capture filled)', async () => {
    const callReq = LocationRequest.add({ phone: TEN, source: 'incoming_call', callLog: 'log9', status: 'sent', via: 'interactive', sentAt: new Date(Date.now() - 60e3) });
    await inbound(tap()); // newer: the welcome flow takes the pin
    expect(await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }))).toBe('welcome');
    expect(callReq).toMatchObject({ status: 'received', location: { address: 'Rajajinagar' } });
    expect(capture.applySharedPickup).toHaveBeenCalledWith('log9', { label: 'Rajajinagar', lat: 12.9, lng: 77.5 });
  });

  test('a call request that linked itself to the open welcome request (already_sent) gets the pin', async () => {
    await inbound(tap());
    welcomeReq()[0].callLog = 'log7';
    await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }));
    expect(capture.applySharedPickup).toHaveBeenCalledWith('log7', { label: 'Rajajinagar', lat: 12.9, lng: 77.5 });
  });
});

// ============================================================
describe('F. the existing flows are untouched', () => {
  test('no open welcome request: pins, text and buttons go to the bot exactly as before', async () => {
    expect(await inbound(pin(12.9, 77.5))).toBe('bot');
    expect(await inbound(text('hi'))).toBe('bot');
    expect(await inbound(button('lang_kn', 'ಕನ್ನಡ'))).toBe('bot');
    expect(welcomeReq()).toHaveLength(0);
    expect(WhatsAppLead.store).toHaveLength(0);
  });

  test('"hi" / "menu" while open closes the request and goes to the bot\'s menu', async () => {
    await inbound(tap());
    expect(await inbound(text('menu'))).toBe('bot');
    expect(welcomeReq()[0].status).toBe('closed');
    expect(await inbound(pin(12.9, 77.5))).toBe('bot');
  });

  test('off with WA_WELCOME_LOCATION_ENABLED=false: the tap goes to the bot', async () => {
    process.env.WA_WELCOME_LOCATION_ENABLED = 'false';
    expect(await inbound(tap())).toBe('bot');
    expect(whatsapp.sendLocationRequest).not.toHaveBeenCalled();
  });

  test('on by default (unset)', () => {
    expect(welcome.enabled()).toBe(true);
  });

  test('an open request older than 2 h has lapsed: the bot gets the pin', async () => {
    LocationRequest.add({ phone: TEN, source: 'whatsapp_welcome', status: 'sent', via: 'interactive', sentAt: new Date(Date.now() - 3 * 3600e3) });
    expect(await inbound(pin(12.9, 77.5))).toBe('bot');
  });

  test('a call\'s pending request (no welcome tap) keeps its own flow: the pin is the call\'s, thanked there', async () => {
    LocationRequest.add({ phone: TEN, source: 'incoming_call', callLog: 'log1', status: 'sent', via: 'interactive', sentAt: new Date() });
    expect(await inbound(pin(12.9, 77.5, { address: 'Rajajinagar' }))).toBe('call');
    expect(capture.applySharedPickup).toHaveBeenCalledWith('log1', { label: 'Rajajinagar', lat: 12.9, lng: 77.5 });
    expect(WhatsAppLead.store).toHaveLength(0);
  });

  test('the call template\'s own button tap (pending template request) is still the call flow\'s', async () => {
    LocationRequest.add({ phone: TEN, source: 'incoming_call', status: 'sent', via: 'template', sentAt: new Date() });
    expect(await inbound(tap('Send location'))).toBe('call');
    expect(welcomeReq()).toHaveLength(0);
  });

  test('a database error never throws: the message goes to the bot', async () => {
    await inbound(tap());
    LocationRequest.findOne.mockImplementationOnce(() => { throw new Error('db down'); }); // locationRequests
    LocationRequest.findOne.mockImplementationOnce(() => { throw new Error('db down'); }); // welcome
    expect(await inbound(pin(12.9, 77.5))).toBe('bot');
  });
});

// ============================================================
describe('G. the CRM alert and the webhook wiring', () => {
  test('a pickup lead\'s alert says so and carries the pickup; other leads are unchanged', () => {
    const { leadAlert } = require('../services/incomingAlerts');
    const base = { _id: 'L1', createdAt: new Date(), phone: FROM };
    const a = leadAlert({ ...base, service: welcome.LEAD_SERVICE, pickup: { label: 'Rajajinagar', lat: 12.9, lng: 77.5, confirmedAt: new Date() } });
    expect(a.stage).toBe('Shared pickup on WhatsApp (confirmed): Rajajinagar — call to book');
    expect(a.pickup).toEqual({ label: 'Rajajinagar', lat: 12.9, lng: 77.5, confirmed: true });
    expect(a.link).toBe('/whatsapp-leads');
    const b = leadAlert({ ...base, service: 'Air Ambulance' });
    expect(b.stage).toBe('Asked for a service with no automated booking — call back');
    expect(b).not.toHaveProperty('pickup');
  });

  test('the webhook runs the call flow, then the welcome flow, then the bot', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'whatsappRoutes.js'), 'utf8');
    const a = src.indexOf('await locationRequests.onInbound(message)');
    const b = src.indexOf('await waWelcomeLocation.onInbound(message)');
    const c = src.indexOf('await whatsappFlow.handleMessage(message)');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
