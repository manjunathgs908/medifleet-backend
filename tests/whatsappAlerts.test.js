/**
 * tests/whatsappAlerts.test.js
 * ============================================================
 * The CRM's incoming alert (ring + push) for WhatsApp, alongside bookings.
 *
 *   - a new WhatsApp lead alerts once (ring item + one push)
 *   - a conversation alerts once, at the FIRST step past language into a
 *     service (meaningfulAt) — not again on later steps or messages
 *   - a conversation that stops at the language step — or picks a
 *     language but no service — never alerts
 *   - acknowledge (Open / Dismiss) stops it ringing for everyone; first
 *     tap wins; an ended conversation reports gone, not an error
 *   - no double alert: concurrent claims and repeated pushes send once
 *
 * Drives the REAL whatsappFlow.handleMessage with real WhatsAppSession
 * documents (so saveSession, the step handlers and the catalog run
 * unchanged); only the database reads/writes, outbound WhatsApp sends and
 * web-push's network call are stubbed.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = 'test-only-wa-alert-secret';
const VAPID = {
  VAPID_PUBLIC_KEY : 'BKf_test_public_key',
  VAPID_PRIVATE_KEY: 'test_private_key',
  VAPID_SUBJECT    : 'mailto:test@example.com',
};

const modelStub = () => ({
  find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
  findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(), deleteMany: jest.fn(),
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
jest.mock('../models/Ambulance',           () => modelStub());
jest.mock('../models/Assignment',          () => modelStub());
jest.mock('../models/Shift',               () => modelStub());
jest.mock('../models/Owner',               () => modelStub());
jest.mock('../models/BookingOtp',          () => modelStub());
jest.mock('../models/Quote',               () => modelStub());
jest.mock('../models/PushSubscription',    () => modelStub());
jest.mock('../models/WhatsAppLead',        () => modelStub());
jest.mock('../models/WhatsAppFunnelEvent', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/TripCallEvent', () => ({
  create: jest.fn(() => Promise.resolve({})), find: jest.fn(), findOne: jest.fn(),
}));
jest.mock('../models/GeofenceEvent', () => modelStub());
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../utils/platformOwner', () => ({
  isPlatformDriver: jest.fn(), platformDriverIds: jest.fn(), platformOwnerIds: jest.fn(),
}));
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService',  () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/smsService',  () => ({ sendOtp: jest.fn(), sendAlert: jest.fn(), sendSms: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({ notifyDriverAssigned: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/trackingNotifications', () => ({ notifyTrackingLink: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/whatsappService', () => ({
  sendText: jest.fn(() => Promise.resolve()), sendButtons: jest.fn(() => Promise.resolve()),
  sendList: jest.fn(() => Promise.resolve()), sendLocationRequest: jest.fn(() => Promise.resolve()),
  sendTemplate: jest.fn(() => Promise.resolve()),
}));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const webpush = require('web-push');
const { Trip, User } = require('../models');
const WhatsAppSession = require('../models/WhatsAppSession');
const WhatsAppLead = require('../models/WhatsAppLead');
const PushSubscription = require('../models/PushSubscription');
const whatsappFlow = require('../services/whatsappFlow');
const incomingAlerts = require('../services/incomingAlerts');
const bookingPush = require('../services/bookingPush');

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'skip', 'limit', 'exec']) q[m] = () => q;
  return q;
};
const settle = () => new Promise((r) => setTimeout(r, 30)); // fire-and-forget alert/push calls

// Real ObjectId ids, as in production — crmAckBy on a real session
// document is an ObjectId path and would refuse anything else.
const USERS = {
  owner1: { _id: '64a000000000000000000001', name: 'Asha',  role: 'owner',      isActive: true },
  tc1   : { _id: '64a000000000000000000002', name: 'Ravi',  role: 'telecaller', isActive: true },
  tc2   : { _id: '64a000000000000000000003', name: 'Meena', role: 'telecaller', isActive: true },
  drv1  : { _id: '64a000000000000000000004', name: 'Drv',   role: 'driver',     isActive: true },
};
const BY_ID = Object.fromEntries(Object.values(USERS).map((u) => [u._id, u]));
const tokenFor = (name) => jwt.sign({ id: USERS[name]._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ── In-memory stores (sessions are real Mongoose documents) ──
let sessions; let leads; let subs;
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  const val = doc[k];
  if (v === null) return val == null;
  if (v && typeof v === 'object' && '$gte' in v) return val != null && val >= v.$gte;
  return String(val) === String(v);
});
const setAll = (doc, $set) => Object.entries($set).forEach(([k, v]) => {
  if (typeof doc.set === 'function') doc.set(k, v); else doc[k] = v;
});
// findOneAndUpdate / updateOne whose match + write is one step, as in MongoDB.
const atomicUpdate = (store) => async (cond, update) => {
  await new Promise((r) => setImmediate(r));
  const doc = store().find((d) => matches(d, cond));
  if (!doc) return null;
  setAll(doc, update.$set);
  return { _id: doc._id };
};
const ackView = (doc) => ({
  crmAckAt: doc.crmAckAt, crmAckAction: doc.crmAckAction,
  crmAckBy: doc.crmAckBy ? { _id: String(doc.crmAckBy), name: BY_ID[String(doc.crmAckBy)]?.name } : undefined,
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, VAPID);
  sessions = []; leads = []; subs = [];

  User.findById = jest.fn((id) => chain(BY_ID[String(id)] || null));
  Trip.find = jest.fn(() => chain([])); // no bookings unless a test adds one

  jest.spyOn(WhatsAppSession.prototype, 'save').mockImplementation(function save() { return Promise.resolve(this); });
  WhatsAppSession.findOne = jest.fn((filter) => chain(sessions.find((s) => matches(s, filter)) || null));
  WhatsAppSession.create = jest.fn(async (data) => { const s = new WhatsAppSession(data); sessions.push(s); return s; });
  WhatsAppSession.deleteOne = jest.fn(async (filter) => { sessions = sessions.filter((s) => !matches(s, filter)); return { deletedCount: 1 }; });
  WhatsAppSession.find = jest.fn((filter) => chain(sessions.filter((s) => matches(s, filter))));
  WhatsAppSession.findOneAndUpdate = jest.fn(atomicUpdate(() => sessions));
  WhatsAppSession.updateOne = jest.fn(async (cond, update) => {
    const hit = await atomicUpdate(() => sessions)(cond, update);
    return { matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 };
  });
  WhatsAppSession.findById = jest.fn((id) => {
    const s = sessions.find((d) => String(d._id) === String(id));
    return chain(s ? ackView(s) : null);
  });

  WhatsAppLead.create = jest.fn(async (data) => {
    const lead = { _id: new mongoose.Types.ObjectId(), status: 'new', createdAt: new Date(), ...data };
    leads.push(lead);
    return lead;
  });
  WhatsAppLead.find = jest.fn((filter) => chain(leads.filter((l) => matches(l, filter))));
  WhatsAppLead.findOne = jest.fn((filter) => chain(leads.find((l) => matches(l, filter)) || null));
  WhatsAppLead.findOneAndUpdate = jest.fn(atomicUpdate(() => leads));
  WhatsAppLead.findById = jest.fn((id) => {
    const l = leads.find((d) => String(d._id) === String(id));
    return chain(l ? ackView(l) : null);
  });

  subs = [
    { _id: 's1', endpoint: 'https://fcm.googleapis.com/fcm/send/tc1',  keys: { p256dh: 'k', auth: 'a' }, user: USERS.tc1 },
    { _id: 's2', endpoint: 'https://web.push.apple.com/owner1',         keys: { p256dh: 'k', auth: 'a' }, user: USERS.owner1 },
  ];
  PushSubscription.find = jest.fn(() => chain(subs));
  PushSubscription.deleteMany = jest.fn(async () => ({ deletedCount: 0 }));
  webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
});
afterEach(() => jest.restoreAllMocks());

// ── HTTP harness ────────────────────────────────────────────
let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/trips', require('../routes/trips'));
  app.use('/api/alerts', require('../routes/alerts'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const http = async (method, path, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const incoming = async (who = 'tc1') => (await http('GET', '/api/trips/incoming', { token: tokenFor(who) })).body;
const ack = (type, id, action, who = 'tc1') => http('PUT', `/api/alerts/${type}/${id}/acknowledge`, { token: tokenFor(who), body: { action } });

// ── WhatsApp customer, through the real bot ─────────────────
const PHONE = '919986844442';
const say = async (body, from = PHONE) => { await whatsappFlow.handleMessage({ from, type: 'text', text: { body } }); await settle(); };
const tap = async (id, from = PHONE) => { await whatsappFlow.handleMessage({ from, type: 'interactive', interactive: { button_reply: { id, title: id } } }); await settle(); };
const chatPushes = () => webpush.sendNotification.mock.calls.map(([, p]) => JSON.parse(p)).filter((p) => p.type === 'wa_chat');
const leadPushes = () => webpush.sendNotification.mock.calls.map(([, p]) => JSON.parse(p)).filter((p) => p.type === 'wa_lead');

// ============================================================
describe('A. a conversation that stops before choosing a service never alerts', () => {
  test('stopped at the language step (incl. "More" languages)', async () => {
    await say('hi');
    await tap('lang_more');
    expect(sessions[0].step).toBe('AWAITING_LANGUAGE_MORE');
    expect(sessions[0].meaningfulAt).toBeUndefined();
    expect((await incoming()).alerts).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('picked a language but no service yet (incl. "Other services")', async () => {
    await say('hi');
    await tap('lang_en');
    await tap('svc_more');
    expect(sessions[0].step).toBe('AWAITING_SERVICE_MORE');
    expect(sessions[0].meaningfulAt).toBeUndefined();
    expect((await incoming()).alerts).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('B. a meaningful conversation alerts once, at the transition', () => {
  test('choosing a service: one ring item + one push, typed and linked', async () => {
    await say('hi');
    await tap('lang_kn');      // Kannada — the alert is still in English for staff
    await tap('svc_emergency');
    const s = sessions[0];
    expect(s.step).toBe('AWAITING_SUBTYPE');
    expect(s.meaningfulAt).toBeInstanceOf(Date);

    const { alerts, trips } = await incoming();
    expect(trips).toEqual([]); // the bookings-only list is untouched
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a).toMatchObject({
      type: 'wa_chat', id: String(s._id), key: `wa_chat:${s._id}`,
      title: 'WhatsApp enquiry - Emergency Ambulance',
      service: 'Emergency Ambulance',
      stage: 'Chose a service, picking the type',
      phoneMasked: expect.stringMatching(/4442$/),
      language: 'kn',
    });
    expect(a.customerRef).toMatch(/^c_/);
    expect(a.link).toBe(`/whatsapp-conversations?customer=${encodeURIComponent(a.customerRef)}`);
    expect(a.phone).toBeUndefined();                    // telecaller: masked only
    expect(JSON.stringify(alerts)).not.toContain(PHONE);

    expect(chatPushes()).toHaveLength(2); // one per subscribed operator
    expect(chatPushes()[0]).toEqual({
      title: 'WhatsApp enquiry - Emergency Ambulance',
      body : 'Chose a service, picking the type · WhatsApp',
      type : 'wa_chat', url: a.link, tag: a.key,
    });
    expect(webpush.sendNotification.mock.calls[0][1]).not.toContain('4442'); // no phone on a lock screen
  });

  test('later steps and messages of the same conversation do not alert again', async () => {
    await say('hi');
    await tap('lang_en');
    await tap('svc_emergency');
    const first = sessions[0].meaningfulAt;
    await tap('sub_bls');                 // → AWAITING_PICKUP (also a meaningful step)
    await say('random text');             // re-prompt, same step
    expect(sessions[0].step).toBe('AWAITING_PICKUP');
    expect(sessions[0].meaningfulAt).toBe(first);
    expect(chatPushes()).toHaveLength(2); // still just the first alert's two sends

    // Still one ring item — now showing where they are.
    const { alerts } = await incoming();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ service: 'Emergency Ambulance / BLS (Maruti Eeco)', stage: 'Chose a service, sharing pickup next' });
  });

  test('the owner sees the full number; telecallers never do', async () => {
    await say('hi'); await tap('lang_en'); await tap('svc_emergency');
    expect((await incoming('owner1')).alerts[0].phone).toBe('9986844442'); // utils/phoneViewer's full form
    expect((await incoming('tc1')).alerts[0].phone).toBeUndefined();
  });

  test('concurrent claims on one conversation: exactly one is the transition', async () => {
    await say('hi'); await tap('lang_en');
    const id = sessions[0]._id;
    const results = await Promise.all([1, 2, 3].map(() => incomingAlerts.claimMeaningful(id)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

// ============================================================
describe('C. a new WhatsApp lead alerts once', () => {
  test('a service with no automated booking: lead created, one ring item + one push', async () => {
    await say('hi');
    await tap('lang_en');
    await tap('svc_more');
    await tap('svc_air_ambulance');  // no backendCode → lead capture
    expect(leads).toHaveLength(1);
    expect(sessions).toHaveLength(0); // conversation ended

    const { alerts } = await incoming();
    expect(alerts).toHaveLength(1);    // the lead only — no chat alert
    expect(alerts[0]).toMatchObject({
      type: 'wa_lead', id: String(leads[0]._id),
      title: 'New WhatsApp lead - Air Ambulance',
      service: 'Air Ambulance',
      link: '/whatsapp-leads',
      phoneMasked: expect.stringMatching(/4442$/),
    });
    expect(leadPushes()).toHaveLength(2);
    expect(leadPushes()[0]).toMatchObject({ title: 'New WhatsApp lead - Air Ambulance', url: '/whatsapp-leads', tag: `wa_lead:${leads[0]._id}` });
    expect(chatPushes()).toHaveLength(0);
    expect(leads[0].alertPushAt).toBeInstanceOf(Date);
  });

  test('pushes once: repeated or concurrent sends after the first send nothing', async () => {
    await say('hi'); await tap('lang_en'); await tap('svc_more'); await tap('svc_air_ambulance');
    const id = leads[0]._id;
    const again = await Promise.all([bookingPush.sendWhatsAppLead(id), bookingPush.sendWhatsAppLead(id)]);
    expect(again).toEqual([{ sent: 0, skipped: 'already_pushed' }, { sent: 0, skipped: 'already_pushed' }]);
    expect(leadPushes()).toHaveLength(2);
  });

  test('a lead already moved off "new" on the Leads page no longer rings', async () => {
    await say('hi'); await tap('lang_en'); await tap('svc_more'); await tap('svc_air_ambulance');
    leads[0].status = 'contacted';
    expect((await incoming()).alerts).toEqual([]);
  });
});

// ============================================================
describe('D. acknowledge stops it — for everyone, first tap wins', () => {
  const meaningfulChat = async () => { await say('hi'); await tap('lang_en'); await tap('svc_emergency'); return sessions[0]; };

  test('Open on a conversation: gone from every operator’s ring; a second tap is told who', async () => {
    const s = await meaningfulChat();
    const first = await ack('wa_chat', s._id, 'accepted', 'tc1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ acknowledged: true, ack: { action: 'accepted', by: { _id: USERS.tc1._id } } });
    expect((await incoming('tc2')).alerts).toEqual([]);
    expect((await incoming('owner1')).alerts).toEqual([]);

    const again = await ack('wa_chat', s._id, 'dismissed', 'tc2');
    expect(again.body).toMatchObject({ acknowledged: false, ack: { action: 'accepted', by: { name: 'Ravi' } } });
    expect(s.crmAckAction).toBe('accepted'); // not overwritten
  });

  test('the conversation keeps going after Dismiss: still never rings again', async () => {
    const s = await meaningfulChat();
    await ack('wa_chat', s._id, 'dismissed');
    await tap('sub_bls');
    expect((await incoming()).alerts).toEqual([]);
    expect(chatPushes()).toHaveLength(2);
  });

  test('Dismiss on a lead stops it; its status is untouched', async () => {
    await say('hi'); await tap('lang_en'); await tap('svc_more'); await tap('svc_air_ambulance');
    const res = await ack('wa_lead', leads[0]._id, 'dismissed');
    expect(res.body.acknowledged).toBe(true);
    expect((await incoming()).alerts).toEqual([]);
    expect(leads[0].status).toBe('new');
  });

  test('two operators at the same moment: exactly one wins', async () => {
    const s = await meaningfulChat();
    const [a, b] = await Promise.all([ack('wa_chat', s._id, 'accepted', 'tc1'), ack('wa_chat', s._id, 'dismissed', 'tc2')]);
    expect([a.body.acknowledged, b.body.acknowledged].sort()).toEqual([false, true]);
  });

  test('a conversation that has already ended reports gone — not an error', async () => {
    const s = await meaningfulChat();
    sessions = [];
    const res = await ack('wa_chat', s._id, 'accepted');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, acknowledged: false, gone: true });
  });

  test('bad type / action / id → 400; driver → 403; no token → 401', async () => {
    const s = await meaningfulChat();
    expect((await ack('booking', s._id, 'accepted')).status).toBe(400);
    expect((await ack('wa_chat', s._id, 'maybe')).status).toBe(400);
    expect((await ack('wa_chat', 'not-an-id', 'accepted')).status).toBe(400);
    expect((await ack('wa_chat', s._id, 'accepted', 'drv1')).status).toBe(403);
    expect((await http('PUT', `/api/alerts/wa_chat/${s._id}/acknowledge`, { body: { action: 'accepted' } })).status).toBe(401);
    expect((await incoming()).alerts).toHaveLength(1);
  });
});

// ============================================================
describe('E. alongside bookings', () => {
  test('one queue, oldest first, each with its type and link; bookings unchanged in `trips`', async () => {
    const tripDoc = {
      _id: 't1', status: 'booked', createdAt: new Date(Date.now() - 60000), patientName: 'Lakshmi',
      selectedType: 'BLS', pickup: { address: 'Jayanagar' },
      toJSON() { return { _id: 't1', patientName: 'Lakshmi', patientPhoneMasked: '••••••3210', selectedType: 'BLS', createdAt: this.createdAt }; },
    };
    Trip.find = jest.fn(() => chain([tripDoc]));
    await say('hi'); await tap('lang_en'); await tap('svc_emergency');

    const { trips, alerts } = await incoming();
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ _id: 't1', incomingVia: 'customer' });
    expect(alerts.map((a) => a.type)).toEqual(['booking', 'wa_chat']);
    expect(alerts[0]).toMatchObject({ key: 'booking:t1', title: 'New booking', link: '/dispatch?trip=t1', trip: { _id: 't1', incomingVia: 'customer' } });
  });

  test('no VAPID env: no push, but the ring still lists it', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await say('hi'); await tap('lang_en'); await tap('svc_emergency');
    warn.mockRestore();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect((await incoming()).alerts).toHaveLength(1);
  });
});
