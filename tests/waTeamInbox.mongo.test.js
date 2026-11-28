'use strict';
/**
 * tests/waTeamInbox.mongo.test.js
 * ============================================================
 * Team inbox on the one WhatsApp number + the telecaller introduction card,
 * through the REAL routers (real JWT + protect + roles) on a REAL, ISOLATED
 * MongoDB (throwaway local replica set). Skipped unless MONGO_TEST_URL is
 * set; refuses anything but localhost + a medifleet_test_* database.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_wa?replicaSet=rs0 npx jest tests/waTeamInbox.mongo.test.js
 *
 * WhatsApp is MOCKED (services/whatsappService): nothing is ever sent to a
 * real customer. All numbers and people fictional.
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
process.env.CUSTOMER_REF_SECRET = process.env.CUSTOMER_REF_SECRET || 'test-only-customer-ref-secret';
process.env.JWT_SECRET = 'test-only-jwt-secret';
for (const k of ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN']) delete process.env[k];
jest.mock('axios', () => { const a = jest.requireActual('axios'); a.defaults.adapter = async () => { throw new Error('no network in tests'); }; return a; });

jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));
// The WhatsApp Cloud API, mocked: records every call; can be told to fail.
const mockWa = { calls: [], failUpload: false, failSend: false, delayMs: 0 };
jest.mock('../services/whatsappService', () => {
  const rec = (name) => async (...args) => {
    mockWa.calls.push({ name, args });
    if (mockWa.delayMs) await new Promise((r) => setTimeout(r, mockWa.delayMs));
    if (name === 'uploadMediaResult') return mockWa.failUpload ? { ok: false, error: { code: 131053, message: 'Media upload error (test)' } } : { ok: true, data: { id: `media-${mockWa.calls.length}` } };
    if (mockWa.failSend) return { ok: false, error: { code: 131047, message: 'Re-engagement message (test)' } };
    return { ok: true, data: { messages: [{ id: `wamid.TEST${mockWa.calls.length}` }] } };
  };
  return {
    uploadMediaResult: rec('uploadMediaResult'), sendImageResult: rec('sendImageResult'), sendTextResult: rec('sendTextResult'),
    sendText: rec('sendText'), sendButtons: rec('sendButtons'), sendList: rec('sendList'), sendTemplate: rec('sendTemplate'),
    sendTemplateResult: rec('sendTemplateResult'), sendDocument: rec('sendDocument'), sendLocationRequest: rec('sendLocationRequest'),
  };
});

jest.setTimeout(120000);

maybe('WhatsApp team inbox + introduction card (real isolated MongoDB, mocked WhatsApp)', () => {
  let mongoose; let express; let jwt; let server; let base;
  let User; let WhatsAppFunnelEvent; let WhatsAppContact; let WhatsAppConversation; let StaffProfile; let customerRef;
  let owner; let asha; let ravi;
  const A = '9000000701'; const B = '9000000702'; const C = '9000000703'; // fictional customers
  // A tiny valid JPEG (SOI … EOI) and PNG signature-prefixed payloads.
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const dataUrl = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;

  beforeAll(async () => {
    mongoose = require('mongoose');
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    await mongoose.connection.dropDatabase(); // a clean throwaway database every run
    express = require('express');
    jwt = require('jsonwebtoken');
    ({ User } = require('../models'));
    WhatsAppFunnelEvent = require('../models/WhatsAppFunnelEvent');
    WhatsAppContact = require('../models/WhatsAppContact');
    WhatsAppConversation = require('../models/WhatsAppConversation');
    StaffProfile = require('../models/StaffProfile');
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([User, WhatsAppFunnelEvent, WhatsAppContact, WhatsAppConversation, StaffProfile].map((M) => M.init()));
    owner = await User.create({ name: 'Manjunath (test)', role: 'owner', phone: '9000000002', password: 'x-test-only', isActive: true });
    asha = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000001', password: 'x-test-only', isActive: true });
    ravi = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000003', password: 'x-test-only', isActive: true });
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/whatsapp', require('../routes/whatsappRoutes'));
    app.use('/api/whatsapp-chats', require('../routes/waChats'));
    app.use('/api/staff-profile', require('../routes/staffProfile'));
    app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    mockWa.calls = []; mockWa.failUpload = false; mockWa.failSend = false; mockWa.delayMs = 0;
    await Promise.all([WhatsAppFunnelEvent, WhatsAppContact, WhatsAppConversation, StaffProfile].map((M) => M.collection.deleteMany({})));
    const now = Date.now();
    await WhatsAppFunnelEvent.collection.insertMany([A, B, C].map((p, i) => ({ phone: `91${p}`, step: 'AWAITING_PICKUP', language: 'kn', enteredAt: new Date(now - (i + 1) * 60e3) })));
    // A and B messaged within the last hour; C last messaged 25 hours ago (window closed).
    await WhatsAppContact.collection.insertMany([
      { phone: A, lastInboundAt: new Date(now - 30 * 60e3) },
      { phone: B, lastInboundAt: new Date(now - 60 * 60e3) },
      { phone: C, lastInboundAt: new Date(now - 25 * 3600e3) },
    ]);
  });

  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  async function call(user, method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text };
  }
  const ref = (p) => customerRef(`91${p}`); // as the list hands it out
  const list = (user, q = '') => call(user, 'GET', `/api/whatsapp/conversations?days=7&bucket=all${q}`);
  const rowOf = (r, p) => r.json.conversations.find((c) => c.phoneMasked === `••••••${p.slice(-4)}`);
  const assign = async (user, p, userId) => {
    const st = (await call(user, 'GET', `/api/whatsapp-chats/${encodeURIComponent(ref(p))}`)).json.chat;
    return call(user, 'PATCH', `/api/whatsapp-chats/${encodeURIComponent(ref(p))}/assign`, { userId, rev: st.rev });
  };
  const readyProfile = async (user, extra = {}) => {
    await call(user, 'PUT', '/api/staff-profile/me', { displayName: user.name.replace(' (test)', ''), languages: ['kn', 'hi', 'en'], consent: true, ...extra });
    await call(user, 'PUT', '/api/staff-profile/me/photo', { dataUrl: dataUrl(JPEG, 'image/jpeg') });
  };
  const RAW = /(?<!\d)(91)?9000000\d{3}(?!\d)/;

  // ── Feature A: assignment ──────────────────────────────────
  test('owner sees all chats and assigns / reassigns / unassigns; history kept; rev guards stale changes (409)', async () => {
    let r = await list(owner);
    expect(r.json.conversations).toHaveLength(3);
    expect(r.json.conversations.every((c) => c.assignee === null)).toBe(true);
    expect((await assign(owner, A, String(asha._id))).json.chat.assignee).toMatchObject({ name: 'Asha (test)' });
    expect((await assign(owner, A, String(ravi._id))).json.chat.assignee).toMatchObject({ name: 'Ravi (test)' });
    // a change from an out-of-date view (rev 0) is refused with the current state
    const stale = await call(owner, 'PATCH', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/assign`, { userId: String(asha._id), rev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.json.chat.assignee.name).toBe('Ravi (test)');
    expect((await assign(owner, A, null)).json.chat.assignee).toBeNull();
    const conv = await WhatsAppConversation.findOne({ phone: A }).lean();
    expect(conv.history.map((h) => h.type)).toEqual(['assigned', 'assigned', 'unassigned']);
    expect(conv.rev).toBe(3);
  });

  test('telecaller: sees only their chats by default (assignee=me), can claim only unassigned chats, never assigns others', async () => {
    await assign(owner, B, String(ravi._id));
    // Asha claims A ("Assign to me")
    const claim = await assign(asha, A, String(asha._id));
    expect(claim.status).toBe(200);
    expect(claim.json.chat.assignee.name).toBe('Asha (test)');
    expect((await WhatsAppConversation.findOne({ phone: A }).lean()).history[0].type).toBe('claimed');
    // cannot take Ravi's chat, cannot assign to someone else, cannot unassign
    expect((await assign(asha, B, String(asha._id))).status).toBe(409);
    expect((await assign(asha, C, String(ravi._id))).status).toBe(403);
    expect((await assign(asha, A, null)).status).toBe(403);
    // default telecaller view: only hers
    const mine = await list(asha, '&assignee=me');
    expect(mine.json.conversations.map((c) => c.phoneMasked)).toEqual(['••••••0701']);
    const unassigned = await list(asha, '&assignee=unassigned');
    expect(unassigned.json.conversations.map((c) => c.phoneMasked)).toEqual(['••••••0703']);
    expect((await list(asha, `&assignee=${ravi._id}`)).status).toBe(403);
    // owner can filter by any person
    expect((await list(owner, `&assignee=${ravi._id}`)).json.conversations.map((c) => c.phoneMasked)).toEqual(['••••••0702']);
  });

  test('two telecallers claiming the same unassigned chat at once: exactly one gets it', async () => {
    const rs = await Promise.all([assign(asha, C, String(asha._id)), assign(ravi, C, String(ravi._id)), assign(asha, C, String(asha._id))]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).length).toBe(2);
    const conv = await WhatsAppConversation.findOne({ phone: C }).lean();
    expect(conv.history).toHaveLength(1);
  });

  test('masking: a telecaller never receives a raw customer number from the list, chat or assignment APIs; the owner does on the list', async () => {
    await assign(asha, A, String(asha._id));
    for (const r of [await list(asha), await list(asha, '&assignee=me'), await call(asha, 'GET', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}`), await assign(owner, B, String(asha._id))]) {
      if (r.json && r.json.conversations !== undefined) expect(r.text).not.toMatch(RAW);
    }
    expect((await list(asha)).text).not.toMatch(RAW);
    expect((await call(asha, 'GET', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}`)).text).not.toMatch(RAW);
    expect(rowOf(await list(owner), A).phone).toMatch(/9000000701$/); // owner: full number, as before
  });

  // ── Feature B: profile + consent ───────────────────────────
  test('profile: only the person sets their own; photo validated; consent recorded; the owner sees status but cannot see others\' raw bytes without being owner', async () => {
    let me = (await call(asha, 'GET', '/api/staff-profile/me')).json.profile;
    expect(me.ready).toBe(false);
    expect(me.gaps).toEqual(['consent', 'photo', 'name', 'languages']);
    expect((await call(asha, 'PUT', '/api/staff-profile/me/photo', { dataUrl: 'data:image/gif;base64,R0lGOD' })).status).toBe(400);
    expect((await call(asha, 'PUT', '/api/staff-profile/me/photo', { dataUrl: dataUrl(Buffer.from('not a jpeg'), 'image/jpeg') })).status).toBe(400);
    expect((await call(asha, 'PUT', '/api/staff-profile/me/photo', { dataUrl: dataUrl(Buffer.concat([JPEG, Buffer.alloc(410 * 1024)]), 'image/jpeg') })).status).toBe(413);
    expect((await call(asha, 'PUT', '/api/staff-profile/me', { displayName: 'Asha 9000000001' })).status).toBe(400);
    await readyProfile(asha);
    me = (await call(asha, 'GET', '/api/staff-profile/me')).json.profile;
    expect(me).toMatchObject({ ready: true, gaps: [], displayName: 'Asha', languages: ['kn', 'hi', 'en'], hasPhoto: true, consent: { given: true } });
    expect(me.preview.caption).toBe('ನಮಸ್ಕಾರ 🙏\nನಾನು Asha — SaveLife Booking ಸಹಾಯಕಿ.\nನಿಮ್ಮ ambulance ವ್ಯವಸ್ಥೆಗೆ ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ. ಕನ್ನಡ, ಹಿಂದಿ ಅಥವಾ English ನಲ್ಲಿ ಮಾತನಾಡಬಹುದು.');
    // photo: self and owner yes; another telecaller no
    expect((await call(asha, 'GET', '/api/staff-profile/me/photo')).status).toBe(200);
    expect((await call(owner, 'GET', `/api/staff-profile/${asha._id}/photo`)).status).toBe(200);
    expect((await call(ravi, 'GET', `/api/staff-profile/${asha._id}/photo`)).status).toBe(403);
    // owner list: status for everyone; a telecaller cannot list
    const all = (await call(owner, 'GET', '/api/staff-profile')).json.profiles;
    expect(all.find((p) => p.user.name === 'Asha (test)')).toMatchObject({ ready: true, hasPhoto: true });
    expect((await call(asha, 'GET', '/api/staff-profile')).status).toBe(403);
    // PNG accepted too
    expect((await call(ravi, 'PUT', '/api/staff-profile/me/photo', { dataUrl: dataUrl(PNG, 'image/png') })).status).toBe(200);
  });

  // ── Feature B: introduction ────────────────────────────────
  test('introduction: sends ONE image with the caption inside the 24 h window; then "already sent", never again', async () => {
    await readyProfile(asha);
    await assign(asha, A, String(asha._id));
    let row = rowOf(await list(asha, '&assignee=me'), A);
    expect(row.window.open).toBe(true);
    expect(row.actions.intro).toMatchObject({ state: 'ready', enabled: true });
    const r = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    expect(r.status).toBe(200);
    expect(mockWa.calls.map((c) => c.name)).toEqual(['uploadMediaResult', 'sendImageResult']);
    const [to, mediaId, caption] = mockWa.calls[1].args;
    expect(to).toBe(`91${A}`);
    expect(mediaId).toMatch(/^media-/);
    expect(caption).toContain('ನಾನು Asha — SaveLife Booking ಸಹಾಯಕಿ.');
    expect(Buffer.compare(mockWa.calls[0].args[0], JPEG)).toBe(0); // the stored photo, not a URL
    expect(r.json.chat.intro).toMatchObject({ sent: true, byName: 'Asha' });
    expect(r.json.chat.actions.intro).toMatchObject({ state: 'sent', enabled: false });
    // again: refused, nothing sent
    const again = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    expect(again.status).toBe(409);
    expect(mockWa.calls).toHaveLength(2);
    row = rowOf(await list(owner), A);
    expect(row.intro).toMatchObject({ sent: true, byName: 'Asha' });
    expect((await WhatsAppConversation.findOne({ phone: A }).lean()).intro.wamid).toMatch(/^wamid\.TEST/);
  });

  test('introduction: five simultaneous presses send exactly one', async () => {
    await readyProfile(asha);
    await assign(asha, A, String(asha._id));
    mockWa.delayMs = 150;
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(mockWa.calls.filter((c) => c.name === 'sendImageResult')).toHaveLength(1);
  });

  test('outside the 24-hour window: intro and handover disabled with the reason, and the server refuses — nothing reaches WhatsApp', async () => {
    await readyProfile(asha);
    await assign(asha, C, String(asha._id));
    const row = rowOf(await list(asha, '&assignee=me'), C);
    expect(row.window.open).toBe(false);
    expect(row.actions.intro).toMatchObject({ state: 'window_closed', enabled: false });
    expect(row.actions.intro.reason).toMatch(/24-hour window/);
    const r = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(C))}/intro`);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('WINDOW_CLOSED');
    expect(mockWa.calls).toHaveLength(0);
    // the customer messages again -> the window opens
    await WhatsAppContact.updateOne({ phone: C }, { $set: { lastInboundAt: new Date() } });
    expect((await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(C))}/intro`)).status).toBe(200);
  });

  test('consent is respected: without consent (or photo / name / languages) nothing is sent; withdrawing consent stops it', async () => {
    await assign(asha, A, String(asha._id));
    await readyProfile(asha, { consent: false });
    let r = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/agree to share your photo and name/);
    await call(asha, 'PUT', '/api/staff-profile/me', { consent: true });
    await call(asha, 'DELETE', '/api/staff-profile/me/photo');
    r = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/add a professional photo/);
    expect(mockWa.calls).toHaveLength(0);
  });

  test('only the assignee can introduce; a WhatsApp failure marks nothing sent and can be retried', async () => {
    await readyProfile(asha); await readyProfile(ravi);
    await assign(owner, A, String(asha._id));
    expect((await call(ravi, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`)).status).toBe(403);
    expect((await call(owner, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`)).status).toBe(403);
    mockWa.failSend = true;
    const r = await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    expect(r.status).toBe(502);
    expect(r.json.chat.intro.sent).toBe(false);
    mockWa.failSend = false;
    expect((await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`)).status).toBe(200);
  });

  test('reassignment: no second photo; the new assignee may send ONE handover message (inside the window)', async () => {
    await readyProfile(asha); await readyProfile(ravi);
    await assign(owner, A, String(asha._id));
    await call(asha, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/intro`);
    await assign(owner, A, String(ravi._id));
    const st = (await call(ravi, 'GET', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}`)).json.chat;
    expect(st.actions.intro).toMatchObject({ state: 'sent', enabled: false }); // no new photo
    expect(st.actions.handover).toMatchObject({ state: 'ready', enabled: true, fromName: 'Asha (test)' });
    mockWa.calls = [];
    const h = await call(ravi, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/handover`);
    expect(h.status).toBe(200);
    expect(mockWa.calls.map((c) => c.name)).toEqual(['sendTextResult']);
    expect(mockWa.calls[0].args[1]).toBe('ಇನ್ನು ಮುಂದೆ ನನ್ನ ಸಹೋದ್ಯೋಗಿ Ravi ನಿಮಗೆ ಸಹಾಯ ಮಾಡುತ್ತಾರೆ. ನೀವು ಕೊಟ್ಟ ವಿವರಗಳು ಅವರಿಗೆ ಲಭ್ಯವಿವೆ.');
    expect(h.json.chat.actions.handover).toMatchObject({ state: 'sent', enabled: false });
    expect((await call(ravi, 'POST', `/api/whatsapp-chats/${encodeURIComponent(ref(A))}/handover`)).status).toBe(409);
    expect(mockWa.calls).toHaveLength(1);
    // a first assignment (no previous assignee) offers no handover
    await assign(asha, B, String(asha._id));
    expect((await call(asha, 'GET', `/api/whatsapp-chats/${encodeURIComponent(ref(B))}`)).json.chat.actions.handover.state).toBe('none');
  });

  test('no login: 401; the list without assignee= behaves exactly as before (all chats)', async () => {
    expect((await call(null, 'GET', '/api/whatsapp-chats/x')).status).toBe(401);
    expect((await call(null, 'GET', '/api/staff-profile/me')).status).toBe(401);
    const r = await list(asha);
    expect(r.json.conversations).toHaveLength(3);
    expect(Object.keys(r.json.counts)).toEqual(['total', 'completed', 'dropped', 'live']);
  });
});
