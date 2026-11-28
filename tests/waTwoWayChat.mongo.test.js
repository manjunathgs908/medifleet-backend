'use strict';
/**
 * tests/waTwoWayChat.mongo.test.js
 * ============================================================
 * Two-way WhatsApp chat (message log, human takeover, staff send, ambulance
 * gallery) through the REAL webhook + routers + bot + whatsappService on a
 * REAL, ISOLATED MongoDB (throwaway local replica set). Skipped unless
 * MONGO_TEST_URL is set; refuses anything but localhost + medifleet_test_*.
 *
 *   MONGO_TEST_URL=mongodb://127.0.0.1:<port>/medifleet_test_chat?replicaSet=rs0 npx jest tests/waTwoWayChat.mongo.test.js
 *
 * WhatsApp is MOCKED one level below whatsappService — axios' adapter — so
 * the real send functions and the real outbound logging run, and nothing
 * can reach the network. All numbers and people fictional.
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
process.env.WA_APP_SECRET = 'test-only-wa-app-secret';
process.env.WA_TOKEN = 'test-only-token';
process.env.WA_PHONE_NUMBER_ID = 'TESTPHONEID';
for (const k of ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'GOOGLE_MAPS_API_KEY']) delete process.env[k];

// The WhatsApp Cloud API, mocked at axios' adapter: records every request,
// answers like Meta, can be told to fail. Nothing leaves the process.
const mockAx = { calls: [], failSend: false, n: 0 };
jest.mock('axios', () => {
  const a = jest.requireActual('axios');
  a.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    if (!url.startsWith('https://graph.facebook.com/')) throw new Error(`no network in tests (${url})`);
    mockAx.n += 1;
    const isMedia = url.endsWith('/media');
    const body = isMedia ? null : JSON.parse(config.data);
    mockAx.calls.push({ url, body, isMedia });
    if (mockAx.failSend && !isMedia) {
      const e = new Error('Request failed'); e.response = { data: { error: { code: 131047, message: 'Re-engagement message (test)' } } }; throw e;
    }
    return { data: isMedia ? { id: `media-${mockAx.n}` } : { messages: [{ id: `wamid.TEST${mockAx.n}` }] }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
  return a;
});
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

jest.setTimeout(120000);

maybe('WhatsApp two-way chat (real isolated MongoDB, WhatsApp mocked at axios)', () => {
  let mongoose; let server; let base; let jwt; let crypto;
  let User; let WhatsAppContact; let WhatsAppConversation; let WhatsAppMessage; let WhatsAppFunnelEvent; let WhatsAppSession; let WaGalleryPhoto; let WaChatMedia; let StaffProfile;
  let customerRef;
  let owner; let asha; let ravi;
  const A = '9000000801'; const B = '9000000802'; const C = '9000000803'; // fictional customers
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9), Buffer.from([0xff, 0xd9])]);
  const dataUrl = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;
  let seq = 0;

  beforeAll(async () => {
    mongoose = require('mongoose');
    await mongoose.connect(URL, { heartbeatFrequencyMS: 3600e3 });
    await mongoose.connection.dropDatabase();
    const express = require('express');
    jwt = require('jsonwebtoken');
    crypto = require('crypto');
    ({ User } = require('../models'));
    WhatsAppContact = require('../models/WhatsAppContact');
    WhatsAppConversation = require('../models/WhatsAppConversation');
    WhatsAppMessage = require('../models/WhatsAppMessage');
    WhatsAppFunnelEvent = require('../models/WhatsAppFunnelEvent');
    WhatsAppSession = require('../models/WhatsAppSession');
    WaGalleryPhoto = require('../models/WaGalleryPhoto');
    WaChatMedia = require('../models/WaChatMedia');
    StaffProfile = require('../models/StaffProfile');
    ({ customerRef } = require('../utils/customerPhone'));
    await Promise.all([User, WhatsAppContact, WhatsAppConversation, WhatsAppMessage, WhatsAppFunnelEvent, WhatsAppSession, WaGalleryPhoto, WaChatMedia, StaffProfile].map((M) => M.init()));
    owner = await User.create({ name: 'Manjunath (test)', role: 'owner', phone: '9000000012', password: 'x-test-only', isActive: true });
    asha = await User.create({ name: 'Asha (test)', role: 'telecaller', phone: '9000000011', password: 'x-test-only', isActive: true });
    ravi = await User.create({ name: 'Ravi (test)', role: 'telecaller', phone: '9000000013', password: 'x-test-only', isActive: true });
    const app = express();
    app.use(express.json({ limit: '15mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/api/whatsapp', require('../routes/whatsappRoutes'));
    app.use('/api/whatsapp-chats', require('../routes/waChats'));
    app.use('/api/staff-profile', require('../routes/staffProfile'));
    app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    mockAx.calls = []; mockAx.failSend = false;
    await Promise.all([WhatsAppContact, WhatsAppConversation, WhatsAppMessage, WhatsAppFunnelEvent, WhatsAppSession, WaGalleryPhoto, WaChatMedia, StaffProfile].map((M) => M.collection.deleteMany({})));
    const now = Date.now();
    await WhatsAppFunnelEvent.collection.insertMany([A, B, C].map((p, i) => ({ phone: `91${p}`, step: 'AWAITING_PICKUP', language: 'kn', enteredAt: new Date(now - (i + 1) * 60e3) })));
    await WhatsAppContact.collection.insertMany([
      { phone: A, lastInboundAt: new Date(now - 30 * 60e3) },
      { phone: B, lastInboundAt: new Date(now - 60 * 60e3) },
      { phone: C, lastInboundAt: new Date(now - 25 * 3600e3) }, // window closed
    ]);
  });

  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  async function call(user, method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') };
  }
  const ref = (p) => encodeURIComponent(customerRef(`91${p}`));
  const chatPath = (p, rest = '') => `/api/whatsapp-chats/${ref(p)}${rest}`;
  const assign = async (user, p, userId) => {
    const st = (await call(user, 'GET', chatPath(p))).json.chat;
    return call(user, 'PATCH', chatPath(p, '/assign'), { userId, rev: st.rev });
  };
  // A signed inbound webhook delivery, as Meta sends it.
  async function inbound(p, msg) {
    seq += 1;
    const message = { from: `91${p}`, id: `wamid.IN${Date.now()}${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg };
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex')}`;
    const r = await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    expect(r.status).toBe(200);
    return message;
  }
  async function statusReport(wamid, status) {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status }] } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex')}`;
    await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  }
  async function until(fn, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 600)); // the webhook is fire-and-forget
  const RAW = /(?<!\d)(91)?9000000\d{3}(?!\d)/;
  const botSendsTo = (p) => mockAx.calls.filter((c) => !c.isMedia && c.body?.to === `91${p}`);

  test('bot mode: a "hi" gets the bot\'s language prompt exactly as before; both sides are logged in order', async () => {
    await inbound(A, { type: 'text', text: { body: 'hi' } });
    await until(() => botSendsTo(A).length >= 1);
    const [sent] = botSendsTo(A);
    // The bot's own payload, untouched.
    expect(sent.body).toMatchObject({ messaging_product: 'whatsapp', to: `91${A}`, type: 'interactive', interactive: { type: 'button' } });
    expect(sent.body.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['lang_kn', 'lang_en', 'lang_more']);
    await until(async () => (await WhatsAppMessage.countDocuments({ phone: A })) >= 2);
    const t = await call(owner, 'GET', chatPath(A, '/messages'));
    expect(t.status).toBe(200);
    expect(t.json.messages.map((m) => [m.direction, m.sender, m.type])).toEqual([['inbound', 'customer', 'text'], ['outbound', 'bot', 'interactive']]);
    expect(t.json.messages[0].body).toBe('hi');
    expect(t.json.messages[1].options).toHaveLength(3);
    expect(t.json.messages[1].status).toBe('sent');
    expect(t.json.hasMore).toBe(false);
    expect(t.json.chat.mode.value).toBe('bot');
  });

  test('takeover pauses the bot for THAT customer only; hand back resumes it', async () => {
    await assign(owner, A, String(asha._id));
    const tk = await call(asha, 'POST', chatPath(A, '/takeover'));
    expect(tk.status).toBe(200);
    expect(tk.json.chat.mode).toMatchObject({ value: 'human', byName: 'Asha (test)' });
    expect(tk.json.chat.actions.handback.enabled).toBe(true);

    const lastBefore = (await WhatsAppContact.findOne({ phone: A }).lean()).lastInboundAt;
    await inbound(A, { type: 'text', text: { body: 'hi' } });          // A: human mode
    await inbound(B, { type: 'text', text: { body: 'hi' } });          // B: bot mode, same moment
    await until(() => botSendsTo(B).length >= 1);
    await settle();
    expect(botSendsTo(A)).toHaveLength(0);                             // bot silent for A
    expect(await WhatsAppSession.exists({ phone: `91${A}` })).toBeNull(); // bot never even started a session
    expect(await WhatsAppMessage.countDocuments({ phone: A, direction: 'inbound' })).toBe(1); // but A's message is logged
    const lastAfter = (await WhatsAppContact.findOne({ phone: A }).lean()).lastInboundAt;
    expect(lastAfter.getTime()).toBeGreaterThan(new Date(lastBefore).getTime()); // 24 h window still tracked

    const hb = await call(asha, 'POST', chatPath(A, '/handback'));
    expect(hb.json.chat.mode.value).toBe('bot');
    await inbound(A, { type: 'text', text: { body: 'hi' } });
    await until(() => botSendsTo(A).length >= 1);                      // bot back
    const conv = await WhatsAppConversation.findOne({ phone: A }).lean();
    expect(conv.history.map((h) => h.type)).toEqual(['assigned', 'takeover', 'handback']);
  });

  test('a location pin in human mode is logged as 📍 and nothing automated replies', async () => {
    await assign(owner, A, String(asha._id));
    await call(asha, 'POST', chatPath(A, '/takeover'));
    await inbound(A, { type: 'location', location: { latitude: 12.97, longitude: 77.59, name: 'Test Hospital', address: 'MG Road' } });
    await until(async () => WhatsAppMessage.exists({ phone: A, type: 'location' }));
    await settle();
    expect(botSendsTo(A)).toHaveLength(0);
    const t = await call(asha, 'GET', chatPath(A, '/messages'));
    expect(t.json.messages[0]).toMatchObject({ type: 'location', location: { lat: 12.97, lng: 77.59, name: 'Test Hospital', address: 'MG Road' } });
  });

  test('staff reply: assignee sends text → logged as staff, sets human mode; double tap sends once', async () => {
    await assign(owner, A, String(asha._id));
    const body = { text: 'Hello, I am arranging your ambulance.', clientMsgId: 'cid-0000000001' };
    const r = await call(asha, 'POST', chatPath(A, '/messages'), body);
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ direction: 'outbound', sender: 'staff', senderName: 'Asha (test)', type: 'text', status: 'sent', kind: 'reply' });
    expect(r.json.chat.mode.value).toBe('human');
    const again = await call(asha, 'POST', chatPath(A, '/messages'), body);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(botSendsTo(A)).toHaveLength(1);                              // ONE real send
    expect(botSendsTo(A)[0].body).toEqual({ messaging_product: 'whatsapp', to: `91${A}`, type: 'text', text: { body: body.text } });
    expect(await WhatsAppMessage.countDocuments({ phone: A })).toBe(1); // logged once (not again by postMessage)
    const conv = await WhatsAppConversation.findOne({ phone: A }).lean();
    expect(conv.history.at(-1)).toMatchObject({ type: 'takeover', via: 'reply' });
  });

  test('who may send: not-assigned telecaller 403, unassigned chat tells them to claim, owner may send anywhere', async () => {
    await assign(owner, A, String(asha._id));
    const r1 = await call(ravi, 'POST', chatPath(A, '/messages'), { text: 'hi' });
    expect(r1.status).toBe(403);
    expect(r1.json.message).toMatch(/assigned to Asha/);
    expect((await call(ravi, 'POST', chatPath(A, '/takeover'))).status).toBe(403);
    const r2 = await call(ravi, 'POST', chatPath(B, '/messages'), { text: 'hi' });
    expect(r2.status).toBe(403);
    expect(r2.json.message).toMatch(/Assign to me/);
    expect(r2.json.chat.actions.reply).toMatchObject({ enabled: false });
    const r3 = await call(owner, 'POST', chatPath(B, '/messages'), { text: 'Owner here' });
    expect(r3.status).toBe(200);
    expect(mockAx.calls).toHaveLength(1);
    // no token -> 401
    expect((await call(null, 'POST', chatPath(A, '/messages'), { text: 'x' })).status).toBe(401);
  });

  test('24-hour window enforced on the server: nothing sent, nothing logged outside it', async () => {
    await assign(owner, C, String(asha._id));
    const st = (await call(asha, 'GET', chatPath(C))).json.chat;
    expect(st.actions.reply.enabled).toBe(false);
    expect(st.actions.reply.reason).toMatch(/24-hour window/);
    const t = await call(asha, 'POST', chatPath(C, '/messages'), { text: 'hello' });
    expect(t.status).toBe(409);
    expect(t.json.code).toBe('WINDOW_CLOSED');
    await call(owner, 'PUT', '/api/whatsapp-chats/gallery/als/photo', { dataUrl: dataUrl(JPEG) });
    const g = await call(owner, 'POST', chatPath(C, '/messages/image'), { galleryId: 'als' });
    expect(g.status).toBe(409);
    expect(mockAx.calls).toHaveLength(0);
    expect(await WhatsAppMessage.countDocuments({ phone: C })).toBe(0);
    expect(await WaChatMedia.countDocuments({})).toBe(0);
  });

  test('ambulance gallery: 7 presets; owner sets photos; telecaller sends one via WhatsApp media (no link)', async () => {
    const g = await call(asha, 'GET', '/api/whatsapp-chats/gallery');
    expect(g.json.photos.map((p) => p.label)).toEqual(['BLS Maruti Eeco', 'BLS Tempo', 'ALS', 'ACLS', 'NICU', 'Body Shifting', 'Body Mini']);
    expect(g.json.canEdit).toBe(false);
    expect((await call(asha, 'PUT', '/api/whatsapp-chats/gallery/nicu/photo', { dataUrl: dataUrl(JPEG) })).status).toBe(403);
    expect((await call(owner, 'PUT', '/api/whatsapp-chats/gallery/nicu/photo', { dataUrl: dataUrl(JPEG) })).status).toBe(200);
    expect((await call(owner, 'PUT', '/api/whatsapp-chats/gallery/nicu/photo', { dataUrl: 'data:image/jpeg;base64,AAAA' })).status).toBe(400);
    const img = await call(asha, 'GET', '/api/whatsapp-chats/gallery/nicu/photo');
    expect(img.status).toBe(200);
    expect(img.type).toBe('image/jpeg');

    await assign(owner, A, String(asha._id));
    const none = await call(asha, 'POST', chatPath(A, '/messages/image'), { galleryId: 'als' });
    expect(none.status).toBe(400);
    expect(none.json.message).toMatch(/No photo has been added for ALS/);
    const s = await call(asha, 'POST', chatPath(A, '/messages/image'), { galleryId: 'nicu', caption: 'SaveLife NICU ambulance' });
    expect(s.status).toBe(200);
    expect(s.json.message).toMatchObject({ type: 'image', body: 'SaveLife NICU ambulance', media: { kind: 'gallery', label: 'NICU', galleryId: 'nicu' }, status: 'sent' });
    expect(mockAx.calls.map((c) => (c.isMedia ? 'upload' : c.body.type))).toEqual(['upload', 'image']);
    expect(mockAx.calls[1].body.image).toEqual({ id: 'media-' + (mockAx.n - 1), caption: 'SaveLife NICU ambulance' });
    expect(JSON.stringify(mockAx.calls[1].body)).not.toMatch(/link|https?:/);
  });

  test('uploaded photo: stored privately, viewable by staff through the chat, sent via media; bad/oversized refused', async () => {
    await assign(owner, A, String(asha._id));
    expect((await call(asha, 'POST', chatPath(A, '/messages/image'), { dataUrl: 'data:image/png;base64,' + JPEG.toString('base64') })).status).toBe(400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024 * 1024 + 10, 1)]);
    expect((await call(asha, 'POST', chatPath(A, '/messages/image'), { dataUrl: dataUrl(big) })).status).toBe(413);
    expect((await call(asha, 'POST', chatPath(A, '/messages/image'), { galleryId: 'nicu', dataUrl: dataUrl(JPEG) })).status).toBe(400);
    const r = await call(asha, 'POST', chatPath(A, '/messages/image'), { dataUrl: dataUrl(JPEG) });
    expect(r.status).toBe(200);
    expect(r.json.message.media.kind).toBe('upload');
    const m = await call(ravi, 'GET', chatPath(A, `/media/${r.json.message.media.uploadId}`));
    expect(m.status).toBe(200);
    expect(m.type).toBe('image/jpeg');
    // not reachable through another customer's chat
    expect((await call(owner, 'GET', chatPath(B, `/media/${r.json.message.media.uploadId}`))).status).toBe(404);
  });

  test('masking: telecallers never see the customer\'s number — not in fields, previews or message text; owner does', async () => {
    await assign(owner, A, String(asha._id));
    await inbound(A, { type: 'text', text: { body: `call me on ${A.slice(0, 5)} ${A.slice(5)} or +91-${A}` } });
    await inbound(A, { type: 'contacts', contacts: [{ name: { formatted_name: 'Test Relative' }, phones: [{ phone: '+91 90000 00899' }] }] });
    await until(async () => (await WhatsAppMessage.countDocuments({ phone: A, direction: 'inbound' })) >= 2);
    await until(() => botSendsTo(A).length >= 2);
    const t = await call(asha, 'GET', chatPath(A, '/messages'));
    expect(t.text).not.toMatch(RAW);
    expect(t.text).not.toMatch(/90000 00899|9000000899/);
    expect(t.json.messages[0].body).toBe('call me on ••••••0801 or ••••••0801');
    expect(t.json.messages.find((m) => m.type === 'contacts').body).toBe('Test Relative');
    const l = await call(asha, 'GET', '/api/whatsapp/conversations?days=7&bucket=all&assignee=all');
    expect(l.text).not.toMatch(RAW);
    const row = l.json.conversations.find((c) => c.phoneMasked === `••••••${A.slice(-4)}`);
    expect(row.lastMessage).toBeTruthy();
    const o = await call(owner, 'GET', chatPath(A, '/messages'));
    expect(o.json.messages[0].body).toContain(A.slice(5));             // the owner sees numbers, as everywhere
  });

  test('delivery reports tick sent → delivered → read, never backwards', async () => {
    await assign(owner, A, String(asha._id));
    const r = await call(asha, 'POST', chatPath(A, '/messages'), { text: 'On the way' });
    const wamid = (await WhatsAppMessage.findById(r.json.message.id).lean()).waMessageId;
    await statusReport(wamid, 'read');
    await until(async () => (await WhatsAppMessage.findById(r.json.message.id).lean()).status === 'read');
    await statusReport(wamid, 'delivered');
    await settle();
    expect((await WhatsAppMessage.findById(r.json.message.id).lean()).status).toBe('read');
  });

  test('a WhatsApp send failure: 502, row marked failed, bot NOT paused', async () => {
    await assign(owner, A, String(asha._id));
    mockAx.failSend = true;
    const r = await call(asha, 'POST', chatPath(A, '/messages'), { text: 'test' });
    expect(r.status).toBe(502);
    expect(r.json.chat.mode.value).toBe('bot');
    const row = await WhatsAppMessage.findOne({ phone: A }).lean();
    expect(row).toMatchObject({ status: 'failed', sender: 'staff' });
    const t = await call(asha, 'GET', chatPath(A, '/messages'));
    expect(t.json.messages[0].error).toMatch(/Re-engagement/);
  });

  test('owner unassigning a human-handled chat hands it back to the bot', async () => {
    await assign(owner, A, String(asha._id));
    await call(asha, 'POST', chatPath(A, '/takeover'));
    const u = await assign(owner, A, null);
    expect(u.json.chat.mode.value).toBe('bot');
    const conv = await WhatsAppConversation.findOne({ phone: A }).lean();
    expect(conv.history.map((h) => [h.type, h.via || null])).toEqual([['assigned', null], ['takeover', 'button'], ['unassigned', null], ['handback', 'unassigned']]);
  });

  test('the introduction and handover are logged as staff messages and shown inline', async () => {
    await assign(owner, A, String(asha._id));
    await call(asha, 'PUT', '/api/staff-profile/me', { displayName: 'Asha', languages: ['kn'], consent: true });
    await call(asha, 'PUT', '/api/staff-profile/me/photo', { dataUrl: dataUrl(JPEG) });
    expect((await call(asha, 'POST', chatPath(A, '/intro'))).status).toBe(200);
    await assign(owner, A, String(ravi._id));
    await call(ravi, 'PUT', '/api/staff-profile/me', { displayName: 'Ravi', languages: ['kn'], consent: true });
    expect((await call(ravi, 'POST', chatPath(A, '/handover'))).status).toBe(200);
    const t = await call(ravi, 'GET', chatPath(A, '/messages'));
    expect(t.json.messages.map((m) => [m.kind, m.sender, m.type])).toEqual([['intro', 'staff', 'image'], ['handover', 'staff', 'text']]);
    expect(t.json.messages[0].media).toMatchObject({ kind: 'profile', userId: String(asha._id) });
    expect(t.json.events.filter((e) => e.type === 'intro' || e.type === 'handover')).toHaveLength(0); // not doubled
    expect(t.json.events.map((e) => e.type)).toEqual(['assigned', 'assigned']);
  });

  test('older conversation with nothing logged: empty thread, hasMore false (the CRM shows the history note)', async () => {
    const t = await call(asha, 'GET', chatPath(B, '/messages'));
    expect(t.status).toBe(200);
    expect(t.json.messages).toEqual([]);
    expect(t.json.hasMore).toBe(false);
  });

  test('thread pages: 50 newest first page, then older with ?before', async () => {
    const now = Date.now();
    await WhatsAppMessage.insertMany(Array.from({ length: 60 }, (_, i) => ({ phone: A, direction: 'inbound', sender: 'customer', type: 'text', body: `m${i}`, status: 'received', at: new Date(now - (60 - i) * 1000) })));
    const p1 = await call(owner, 'GET', chatPath(A, '/messages'));
    expect(p1.json.messages).toHaveLength(50);
    expect(p1.json.messages[0].body).toBe('m10');
    expect(p1.json.hasMore).toBe(true);
    const p2 = await call(owner, 'GET', chatPath(A, `/messages?before=${p1.json.messages[0].id}`));
    expect(p2.json.messages.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    expect(p2.json.hasMore).toBe(false);
  });
});
