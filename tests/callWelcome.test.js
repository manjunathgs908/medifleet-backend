/**
 * tests/callWelcome.test.js
 * ============================================================
 * The savelife_pickup WhatsApp template to callers (services/callWelcome.js)
 * and POST /api/calls/:id/send-welcome:
 *   A. the send — template name, language, NO components when no image is
 *      configured (savelife_pickup), an image header only when one is,
 *      to the 91-prefixed real number
 *   B. once per number per IST calendar day — repeat calls the same day do
 *      not resend; the next IST day does (midnight IST, not UTC); two calls
 *      at the same moment send once; a failed send may be retried
 *   C. the auto-send switch — off unless WA_CALL_WELCOME_ENABLED=true
 *   D. failures explained — template not approved, bad image URL, opted
 *      out, not on WhatsApp, token
 *   E. the endpoint — real number read server-side, statuses and HTTP codes,
 *      shares the day's limit with the automatic send, auth on the route
 *
 * Stubbed: the database (in-memory, with the unique index) and the
 * WhatsApp send. No message is sent.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-call-welcome-secret';

function mockWelcomeModel() {
  const store = [];
  let seq = 0;
  const matches = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
  return {
    store,
    reset() { store.length = 0; seq = 0; },
    create: jest.fn(async (doc) => {
      if (store.some((d) => d.phone === doc.phone && d.istDate === doc.istDate)) {
        const e = new Error('E11000 duplicate key'); e.code = 11000; throw e;
      }
      const now = new Date();
      const d = { _id: `w${++seq}`, attempts: 1, createdAt: now, updatedAt: now, ...doc };
      store.push(d);
      return d;
    }),
    findOne: jest.fn(async (f) => store.find((d) => matches(d, f)) || null),
    updateOne: jest.fn(async (f, u) => {
      const d = store.find((x) => matches(x, f));
      if (d) { Object.assign(d, u.$set || {}); d.updatedAt = new Date(); }
      return { modifiedCount: d ? 1 : 0 };
    }),
    findOneAndUpdate: jest.fn(async (f, u) => {
      const d = store.find((x) => matches(x, f));
      if (!d) return null;
      Object.assign(d, u.$set || {});
      Object.keys(u.$unset || {}).forEach((k) => delete d[k]);
      Object.entries(u.$inc || {}).forEach(([k, v]) => { d[k] = (d[k] || 0) + v; });
      d.updatedAt = new Date();
      return d;
    }),
  };
}

jest.mock('../models/WhatsAppWelcomeSend', () => mockWelcomeModel());
jest.mock('../services/whatsappService', () => ({
  sendTemplateResult: jest.fn(async () => ({ ok: true, data: { messages: [{ id: 'wamid.W1' }] } })),
  sendTemplate: jest.fn(), sendText: jest.fn(), sendButtons: jest.fn(), sendList: jest.fn(), sendLocationRequest: jest.fn(),
}));

const WhatsAppWelcomeSend = require('../models/WhatsAppWelcomeSend');
const whatsapp = require('../services/whatsappService');
const callWelcome = require('../services/callWelcome');

const PHONE = '9986844442';
const IMG = 'https://savelife.health/wa/welcome-1200x628.jpg';
const sentCount = () => whatsapp.sendTemplateResult.mock.calls.length;

beforeEach(() => {
  WhatsAppWelcomeSend.reset();
  whatsapp.sendTemplateResult.mockClear();
  whatsapp.sendTemplateResult.mockImplementation(async () => ({ ok: true, data: { messages: [{ id: 'wamid.W1' }] } }));
  delete process.env.WA_WELCOME_IMAGE_URL;
  delete process.env.WA_WELCOME_TEMPLATE_HEADER;
  delete process.env.WA_WELCOME_TEMPLATE;
  delete process.env.WA_WELCOME_TEMPLATE_NAME;
  delete process.env.WA_WELCOME_TEMPLATE_LANG;
  delete process.env.WA_CALL_WELCOME_ENABLED;
  jest.useRealTimers();
});
afterAll(() => jest.useRealTimers());

// ============================================================
describe('A. the send', () => {
  test('default: savelife_pickup in "en", NO components (no header, no body params, no button params), to 91 + the real number', async () => {
    const r = await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(r).toMatchObject({ status: 'sent', wamid: 'wamid.W1' });
    expect(r.sentAt).toBeInstanceOf(Date);
    expect(whatsapp.sendTemplateResult).toHaveBeenCalledWith('919986844442', 'savelife_pickup', 'en', undefined);
    expect(WhatsAppWelcomeSend.store[0]).toMatchObject({ phone: PHONE, status: 'sent', source: 'manual', wamid: 'wamid.W1' });
  });

  test('WA_WELCOME_IMAGE_URL empty or blank behaves as unset: no components', async () => {
    process.env.WA_WELCOME_IMAGE_URL = '   ';
    expect((await callWelcome.send({ phone: PHONE, source: 'manual' })).status).toBe('sent');
    expect(whatsapp.sendTemplateResult.mock.calls[0][3]).toBeUndefined();
  });

  test('template name and language come from WA_WELCOME_TEMPLATE_NAME / WA_WELCOME_TEMPLATE_LANG', async () => {
    process.env.WA_WELCOME_TEMPLATE_NAME = 'savelife_pickup_v2';
    process.env.WA_WELCOME_TEMPLATE_LANG = 'en_US';
    await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(whatsapp.sendTemplateResult.mock.calls[0].slice(1, 3)).toEqual(['savelife_pickup_v2', 'en_US']);
  });

  test('the old WA_WELCOME_TEMPLATE setting is no longer read', async () => {
    process.env.WA_WELCOME_TEMPLATE = 'savelife_welcome';
    await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(whatsapp.sendTemplateResult.mock.calls[0][1]).toBe('savelife_pickup');
  });

  // The production bug (Meta 132018 "Template does not contain title
  // component, no parameters allowed"): the old banner URL was still set on
  // Render, and that alone added a header to savelife_pickup.
  test('132018 regression: the old banner URL still set -> STILL no components', async () => {
    process.env.WA_WELCOME_IMAGE_URL = 'https://api.savelife.health/welcome-banner.png';
    expect((await callWelcome.send({ phone: PHONE, source: 'manual' })).status).toBe('sent');
    expect(whatsapp.sendTemplateResult).toHaveBeenCalledWith('919986844442', 'savelife_pickup', 'en', undefined);
  });

  test.each(['none', 'NONE', 'text', 'imag', ''])('WA_WELCOME_TEMPLATE_HEADER=%p is not "image": no components', async (v) => {
    process.env.WA_WELCOME_TEMPLATE_HEADER = v;
    process.env.WA_WELCOME_IMAGE_URL = IMG;
    await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(whatsapp.sendTemplateResult.mock.calls[0][3]).toBeUndefined();
  });

  test('every send logs template, language, components and the runtime WA_WELCOME_IMAGE_URL (no customer number)', async () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.WA_WELCOME_IMAGE_URL = 'https://api.savelife.health/welcome-banner.png';
    await callWelcome.send({ phone: PHONE, source: 'manual' });
    const line = spy.mock.calls.find((c) => String(c[0]).startsWith('[callWelcome] sending'));
    spy.mockRestore();
    expect(line[1]).toEqual({
      template: 'savelife_pickup', language: 'en', header: 'none', components: 'none',
      WA_WELCOME_IMAGE_URL: 'https://api.savelife.health/welcome-banner.png (set but ignored: WA_WELCOME_TEMPLATE_HEADER is not "image")',
    });
    expect(JSON.stringify(line)).not.toContain(PHONE);
  });

  test('an image-header template still works: WA_WELCOME_TEMPLATE_HEADER=image + WA_WELCOME_IMAGE_URL -> the image is the only component', async () => {
    process.env.WA_WELCOME_TEMPLATE_HEADER = 'image';
    process.env.WA_WELCOME_IMAGE_URL = IMG;
    process.env.WA_WELCOME_TEMPLATE_NAME = 'savelife_welcome';
    await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(whatsapp.sendTemplateResult).toHaveBeenCalledWith('919986844442', 'savelife_welcome', 'en', [
      { type: 'header', parameters: [{ type: 'image', image: { link: IMG } }] },
    ]);
  });

  test('any number format resolves to the same 10 digits (+91, 91, spaces)', async () => {
    await callWelcome.send({ phone: '+91 99868 44442', source: 'manual' });
    expect(await callWelcome.send({ phone: '919986844442', source: 'incoming_call' })).toMatchObject({ status: 'already_sent_today' });
  });

  test('not an Indian mobile: nothing sent, nothing recorded', async () => {
    expect(await callWelcome.send({ phone: '12345', source: 'manual' })).toMatchObject({ status: 'not_mobile' });
    expect(await callWelcome.send({ phone: '+1 415 555 0100', source: 'manual' })).toMatchObject({ status: 'not_mobile' });
    expect(await callWelcome.send({ phone: undefined, source: 'manual' })).toMatchObject({ status: 'not_mobile' });
    expect(sentCount()).toBe(0);
    expect(WhatsAppWelcomeSend.store).toHaveLength(0);
  });
});

// ============================================================
describe('B. once per number per IST calendar day', () => {
  test('a repeat call the same day does not resend', async () => {
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('sent');
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('already_sent_today');
    expect((await callWelcome.send({ phone: PHONE, source: 'manual' })).status).toBe('already_sent_today');
    expect(sentCount()).toBe(1);
  });

  test('another number the same day is sent', async () => {
    await callWelcome.send({ phone: PHONE, source: 'incoming_call' });
    expect((await callWelcome.send({ phone: '9876543210', source: 'incoming_call' })).status).toBe('sent');
    expect(sentCount()).toBe(2);
  });

  test('the day is the India day: 23:50 IST and 00:10 IST are different days; 00:10 and 23:50 IST the same day are not', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-08T18:20:00Z')); // 23:50 IST, 8 Nov
    expect(callWelcome.istDate()).toBe('2026-11-08');
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('sent');

    jest.setSystemTime(new Date('2026-11-08T18:40:00Z')); // 00:10 IST, 9 Nov (still 8 Nov in UTC)
    expect(callWelcome.istDate()).toBe('2026-11-09');
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('sent');

    jest.setSystemTime(new Date('2026-11-09T18:20:00Z')); // 23:50 IST, 9 Nov
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('already_sent_today');
    expect(sentCount()).toBe(2);
    expect(WhatsAppWelcomeSend.store.map((d) => d.istDate)).toEqual(['2026-11-08', '2026-11-09']);
  });

  test('two calls at the same moment: one send', async () => {
    let release;
    whatsapp.sendTemplateResult.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, data: {} }); }));
    const first = callWelcome.send({ phone: PHONE, source: 'incoming_call' });
    await new Promise((r) => setImmediate(r));
    const second = await callWelcome.send({ phone: PHONE, source: 'incoming_call' });
    expect(second.status).toBe('in_progress');
    release();
    expect((await first).status).toBe('sent');
    expect(sentCount()).toBe(1);
  });

  test('a failed send may be retried the same day — the next call (or the button) tries again, and then it counts', async () => {
    whatsapp.sendTemplateResult.mockResolvedValueOnce({ ok: false, error: { code: 130429, message: 'rate' } });
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('failed');
    expect(WhatsAppWelcomeSend.store[0]).toMatchObject({ status: 'failed', error: expect.objectContaining({ reason: 'rate_limited' }) });
    expect((await callWelcome.send({ phone: PHONE, source: 'manual', sentBy: 'u1' })).status).toBe('sent');
    expect(WhatsAppWelcomeSend.store).toHaveLength(1);
    expect(WhatsAppWelcomeSend.store[0]).toMatchObject({ status: 'sent', attempts: 2, source: 'manual', sentBy: 'u1' });
    expect(WhatsAppWelcomeSend.store[0].error).toBeUndefined();
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('already_sent_today');
  });

  test('a send that crashed mid-way (stuck "sending" over 2 minutes) is retaken', async () => {
    WhatsAppWelcomeSend.store.push({ _id: 'old', phone: PHONE, istDate: callWelcome.istDate(), status: 'sending', source: 'incoming_call', attempts: 1, updatedAt: new Date(Date.now() - 3 * 60e3) });
    expect((await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).status).toBe('sent');
  });
});

// ============================================================
describe('C. the auto-send switch', () => {
  test('off unless WA_CALL_WELCOME_ENABLED=true: nothing sent or recorded', async () => {
    expect(await callWelcome.onIncomingCall(PHONE, 'log1')).toEqual({ status: 'disabled' });
    process.env.WA_CALL_WELCOME_ENABLED = 'yes';
    expect(await callWelcome.onIncomingCall(PHONE, 'log1')).toEqual({ status: 'disabled' });
    expect(sentCount()).toBe(0);
    expect(WhatsAppWelcomeSend.store).toHaveLength(0);
  });

  test('on: sent, recorded against the call', async () => {
    process.env.WA_CALL_WELCOME_ENABLED = 'true';
    expect((await callWelcome.onIncomingCall(PHONE, 'log1')).status).toBe('sent');
    expect(WhatsAppWelcomeSend.store[0]).toMatchObject({ source: 'incoming_call', callLog: 'log1' });
  });

  test('132018 regression on the auto-send path: old banner URL set -> payload has no components', async () => {
    process.env.WA_CALL_WELCOME_ENABLED = 'true';
    process.env.WA_WELCOME_IMAGE_URL = 'https://api.savelife.health/welcome-banner.png';
    expect((await callWelcome.onIncomingCall(PHONE, 'log1')).status).toBe('sent');
    expect(whatsapp.sendTemplateResult).toHaveBeenCalledWith('919986844442', 'savelife_pickup', 'en', undefined);
  });
});

// ============================================================
describe('D. failures explained', () => {
  const fail = (code, message = 'x') => whatsapp.sendTemplateResult.mockResolvedValueOnce({ ok: false, error: { code, message } });

  test('template not approved yet (132001): says so, naming the template and language', async () => {
    fail(132001, 'Template name does not exist in the translation');
    const r = await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(r).toMatchObject({ status: 'failed', reason: 'template_not_approved', code: 132001 });
    expect(r.message).toMatch(/no approved template "savelife_pickup" in language "en" — it may still be in review/);
  });

  test('image header configured but no usable https URL: refused before any send, with the setting to fix', async () => {
    process.env.WA_WELCOME_TEMPLATE_HEADER = 'image';
    for (const v of ['http://insecure.example/x.jpg', '', undefined]) {
      if (v === undefined) delete process.env.WA_WELCOME_IMAGE_URL; else process.env.WA_WELCOME_IMAGE_URL = v;
      const r = await callWelcome.send({ phone: PHONE, source: 'manual' });
      expect(r).toMatchObject({ status: 'failed', reason: 'image_url_invalid' });
      expect(r.message).toMatch(/WA_WELCOME_IMAGE_URL/);
    }
    expect(sentCount()).toBe(0);
    expect(WhatsAppWelcomeSend.store).toHaveLength(0);
  });

  test('a bad image URL is irrelevant when no header is configured: sent with no components', async () => {
    process.env.WA_WELCOME_IMAGE_URL = 'http://insecure.example/x.jpg';
    expect((await callWelcome.send({ phone: PHONE, source: 'manual' })).status).toBe('sent');
    expect(whatsapp.sendTemplateResult.mock.calls[0][3]).toBeUndefined();
  });

  test('132018 explained: with an image header configured, says to unset it', async () => {
    process.env.WA_WELCOME_TEMPLATE_HEADER = 'image';
    process.env.WA_WELCOME_IMAGE_URL = IMG;
    fail(132018, 'header: Template does not contain title component, no parameters allowed');
    const r = await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(r).toMatchObject({ status: 'failed', reason: 'template_rejected', code: 132018 });
    expect(r.message).toMatch(/unset WA_WELCOME_TEMPLATE_HEADER/);
  });

  test('132012 with no image: the message points at the template, not at an image', async () => {
    fail(132012, 'Parameter format does not match');
    const r = await callWelcome.send({ phone: PHONE, source: 'manual' });
    expect(r.reason).toBe('template_rejected');
    expect(r.message).toMatch(/"savelife_pickup" was sent with none/);
  });

  test.each([
    [132012, 'template_rejected'],
    [131026, 'not_on_whatsapp'],
    [131049, 'marketing_limit'],
    [131050, 'opted_out'],
    [190, 'auth'],
    [999999, 'whatsapp_error'],
    [undefined, 'whatsapp_error'],
  ])('Meta code %s -> %s', async (code, reason) => {
    fail(code);
    expect(await callWelcome.send({ phone: PHONE, source: 'manual' })).toMatchObject({ status: 'failed', reason });
  });

  test('a database error never throws', async () => {
    WhatsAppWelcomeSend.create.mockRejectedValueOnce(new Error('db down'));
    expect(await callWelcome.send({ phone: PHONE, source: 'incoming_call' })).toMatchObject({ status: 'failed', reason: 'server_error' });
  });
});

// ============================================================
describe('E. POST /api/calls/:id/send-welcome', () => {
  // The controller with the real service; only the CallLog lookup is stubbed.
  let ctrl;
  let CallLog;
  const LOG_ID = '64b000000000000000000009';
  const user = { _id: 'u7', role: 'telecaller', name: 'Asha' };
  const run = async (id) => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const next = jest.fn();
    await ctrl.sendWelcome({ params: { id }, user, body: {} }, res, next);
    if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
    return res;
  };
  beforeAll(() => {
    CallLog = require('../models/CallLog');
    ctrl = require('../controllers/callController');
  });
  let select;
  beforeEach(() => {
    select = jest.fn(async () => ({ _id: LOG_ID, customerPhone: PHONE }));
    jest.spyOn(CallLog, 'findById').mockImplementation(() => ({ select }));
  });
  afterEach(() => jest.restoreAllMocks());

  test('sends to the call\'s REAL number (read with +customerPhone server-side): 200 sent', async () => {
    const res = await run(LOG_ID);
    expect(select).toHaveBeenCalledWith('+customerPhone');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'sent', message: 'Welcome message sent on WhatsApp.' });
    expect(whatsapp.sendTemplateResult.mock.calls[0][0]).toBe('919986844442');
    expect(WhatsAppWelcomeSend.store[0]).toMatchObject({ source: 'manual', callLog: LOG_ID, sentBy: 'u7' });
    expect(JSON.stringify(res.body)).not.toContain(PHONE); // the number never goes back to the CRM
  });

  test('132018 regression on the button path: old banner URL set -> payload has no components', async () => {
    process.env.WA_WELCOME_IMAGE_URL = 'https://api.savelife.health/welcome-banner.png';
    const res = await run(LOG_ID);
    expect(res.body.status).toBe('sent');
    expect(whatsapp.sendTemplateResult).toHaveBeenCalledWith('919986844442', 'savelife_pickup', 'en', undefined);
  });

  test('works even with the auto-send switched off', async () => {
    delete process.env.WA_CALL_WELCOME_ENABLED;
    expect((await run(LOG_ID)).body.status).toBe('sent');
  });

  test('the same day again (after a call already sent it): 200 already_sent_today, nothing sent', async () => {
    process.env.WA_CALL_WELCOME_ENABLED = 'true';
    await callWelcome.onIncomingCall(PHONE, 'earlier-call');
    const res = await run(LOG_ID);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'already_sent_today', message: 'Already sent to this number today.' });
    expect(res.body.sentAt).toBeInstanceOf(Date);
    expect(sentCount()).toBe(1);
  });

  test('template not approved: 502 with the reason and a clear message', async () => {
    whatsapp.sendTemplateResult.mockResolvedValueOnce({ ok: false, error: { code: 132001, message: 'no translation' } });
    const res = await run(LOG_ID);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, status: 'failed', reason: 'template_not_approved', code: 132001 });
    expect(res.body.message).toMatch(/still be in review/);
  });

  test('a call with no mobile number: 400 not_mobile', async () => {
    select.mockResolvedValueOnce({ _id: LOG_ID, customerPhone: undefined });
    const res = await run(LOG_ID);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, status: 'not_mobile' });
  });

  test('unknown or malformed call id: 404', async () => {
    select.mockResolvedValueOnce(null);
    expect((await run(LOG_ID)).statusCode).toBe(404);
    expect((await run('not-an-id')).statusCode).toBe(404);
  });

  test('the route needs a CRM login with an operations role', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'calls.js'), 'utf8');
    expect(src).toMatch(/router\.post\('\/:id\/send-welcome',\s*protect, authorize\(\.\.\.CRM_CALLS\), ctrl\.sendWelcome\)/);
  });
});
