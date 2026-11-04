/**
 * tests/quoteWhatsApp.test.js
 * ============================================================
 * The WhatsApp message that carries a "Quote & Confirm" link.
 *
 *   - WhatsApp's real verdict is kept: accepted (with the message id —
 *     NOT delivery), rejected (Meta's error code and reason), or unknown
 *     (no answer). The CRM no longer guesses "is the template approved?".
 *   - delivery reports from Meta's webhook only move forward
 *   - a resend is explicit, one at a time, never of an accepted message,
 *     and needs confirmation when the first outcome is unknown
 *
 * No real WhatsApp: axios and the Quote model are mocked.
 * ============================================================
 */
'use strict';

process.env.WA_TOKEN = 'test-wa-token';
process.env.WA_PHONE_NUMBER_ID = '1234567890';
delete process.env.WA_QUOTE_TEMPLATE_LANG;

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

// A small stand-in for the Quote collection that evaluates the real query
// conditions the code sends ($and / $or / $in / $lt / null), so the
// one-at-a-time claim and forward-only statuses are actually exercised.
jest.mock('../models/Quote', () => {
  const store = new Map();
  const get = (o, k) => o[k];
  const test = (doc, filter) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and') return cond.every((f) => test(doc, f));
    if (k === '$or') return cond.some((f) => test(doc, f));
    const v = get(doc, k);
    if (k === '_id') return String(v) === String(cond);
    if (cond === null) return v === undefined || v === null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$in' in cond) return cond.$in.includes(v);
      if ('$ne' in cond) return v !== cond.$ne;
      if ('$lt' in cond) return v instanceof Date && v < cond.$lt;
    }
    return v === cond;
  });
  const apply = (doc, update) => {
    Object.assign(doc, update.$set || {});
    for (const k of Object.keys(update.$unset || {})) delete doc[k];
    for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
  };
  const q = (v) => { const p = Promise.resolve(v); p.select = () => p; p.lean = () => p; return p; };
  return {
    __store: store,
    findById: jest.fn((id) => q(store.has(String(id)) ? { ...store.get(String(id)) } : null)),
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const doc = [...store.values()].find((d) => test(d, filter));
      if (!doc) return null;
      apply(doc, update);
      return { ...doc };
    }),
    updateOne: jest.fn(async (filter, update) => {
      const doc = [...store.values()].find((d) => test(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      apply(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
});
jest.mock('../models', () => ({ Trip: {} }));
jest.mock('../controllers/tripController', () => ({ quoteTrip: jest.fn(), createBookedTrip: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({ findPricingDoc: jest.fn() }));
jest.mock('../services/trackingNotifications', () => ({ resolveTrackingUrl: jest.fn() }));

const axios = require('axios');
const Quote = require('../models/Quote');
const whatsapp = require('../services/whatsappService');
const notifications = require('../services/whatsappNotifications');
const delivery = require('../services/quoteDelivery');
const ctrl = require('../controllers/quoteController');

const ID = '64b0000000000000000000c1';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const store = Quote.__store;

const metaAccepted = (id = 'wamid.ACCEPTED') => axios.post.mockResolvedValueOnce({ data: { messaging_product: 'whatsapp', contacts: [{ wa_id: '919986844442' }], messages: [{ id }] } });
const metaRejects = (code, extra = {}) => axios.post.mockRejectedValueOnce({
  response: { status: 400, data: { error: { code, type: 'OAuthException', message: `(#${code}) error`, error_data: { details: extra.details || 'details from Meta' }, fbtrace_id: 'TRACE', ...extra } } },
  message: 'Request failed with status code 400',
});
const metaTimesOut = () => axios.post.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' });

function putQuote(over = {}) {
  store.clear();
  store.set(ID, {
    _id: ID, token: TOKEN, phone: '9986844442', status: 'sent',
    sentAt: new Date(Date.now() - 60e3), expiresAt: new Date(Date.now() + 3600e3), whatsappSent: false, ...over,
  });
  return () => store.get(ID);
}
const res = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const resend = async (body = {}) => {
  const r = res();
  const next = jest.fn();
  await ctrl.resendWhatsapp({ params: { id: ID }, body, user: { _id: 'staff1' } }, r, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return r;
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.post.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('Meta\'s verdict is kept, not guessed', () => {
  it('accepted: the message id comes back — and it is called accepted, not delivered', async () => {
    metaAccepted('wamid.1');
    const r = await notifications.notifyQuoteLink('9986844442', `https://crm.savelife.health/q/${TOKEN}`);
    expect(r).toEqual(expect.objectContaining({ outcome: 'accepted', messageId: 'wamid.1' }));
    const [url, payload, opts] = axios.post.mock.calls[0];
    expect(url).toContain('/1234567890/messages');
    expect(payload).toEqual({
      messaging_product: 'whatsapp', to: '919986844442', type: 'template',
      template: { name: 'booking_quote_link', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: `https://crm.savelife.health/q/${TOKEN}` }] }] },
    });
    expect(opts.timeout).toBe(15000);
  });

  it('template missing in that language (132001): says so, names the language, keeps the code', async () => {
    metaRejects(132001, { details: 'template name (booking_quote_link) does not exist in en' });
    const r = await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toMatch(/does not exist in language "en"/);
    expect(r.reason).toMatch(/WhatsApp error 132001/);
    expect(r.error).toEqual({ code: 132001, subcode: null, httpStatus: 400 });
    expect(r.retryLater).toBe(false);
  });

  it.each([
    [131026, /number may not be on WhatsApp/],
    [190, /access token has expired or is invalid/],
    [131030, /test mode/],
    [131042, /Payment issue/],
    [132000, /different number of variables/],
  ])('error %s is explained as what it is — not as "template not approved"', async (code, expected) => {
    metaRejects(code);
    const r = await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(r.reason).toMatch(expected);
    expect(r.reason).not.toMatch(/is the booking_quote_link template approved\?/);
  });

  it('an unrecognised error shows Meta\'s own title and details with the code', async () => {
    metaRejects(999999, { error_user_title: 'Something odd', details: 'odd details' });
    const r = await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(r.reason).toBe('WhatsApp rejected the message (error 999999): Something odd: odd details');
  });

  it('timeout: outcome unknown — it may have been sent', async () => {
    metaTimesOut();
    const r = await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(r.outcome).toBe('unknown');
    expect(r.reason).toMatch(/may or may not have reached the customer/);
  });

  it('the language can be set by WA_QUOTE_TEMPLATE_LANG without a code change', async () => {
    process.env.WA_QUOTE_TEMPLATE_LANG = 'en_US';
    metaAccepted();
    await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(axios.post.mock.calls[0][1].template.language.code).toBe('en_US');
    delete process.env.WA_QUOTE_TEMPLATE_LANG;
  });

  it('other WhatsApp senders keep their old contract (data or null)', async () => {
    metaAccepted('wamid.T');
    expect(await whatsapp.sendText('919986844442', 'hi')).toEqual(expect.objectContaining({ messages: [{ id: 'wamid.T' }] }));
    metaRejects(131026);
    expect(await whatsapp.sendText('919986844442', 'hi')).toBeNull();
    metaTimesOut();
    expect(await whatsapp.sendText('919986844442', 'hi')).toBeNull();
  });

  it('the access token is never logged', async () => {
    const err = console.error;
    metaRejects(190);
    await notifications.notifyQuoteLink('9986844442', 'https://x/q/t');
    expect(JSON.stringify(err.mock.calls)).not.toContain('test-wa-token');
  });
});

describe('what is stored for the quote', () => {
  it('accepted: status accepted + message id; the CRM does not call it delivered', async () => {
    const q = putQuote();
    metaAccepted('wamid.OK');
    const out = await delivery.sendQuoteLink(q(), 'https://x/q/t');
    expect(out.ok).toBe(true);
    expect(q()).toEqual(expect.objectContaining({ whatsappStatus: 'accepted', whatsappSent: true, whatsappMessageId: 'wamid.OK', whatsappAttempts: 1 }));
    expect(q().whatsappSendingAt).toBeUndefined();
    expect(q().whatsappError).toBeUndefined();
  });

  it('rejected: the reason and code are stored; the quote itself is untouched', async () => {
    const q = putQuote();
    metaRejects(132001);
    await delivery.sendQuoteLink(q(), 'https://x/q/t');
    expect(q()).toEqual(expect.objectContaining({ whatsappStatus: 'rejected', whatsappSent: false, whatsappErrorCode: '132001', status: 'sent' }));
    expect(q().whatsappError).toMatch(/does not exist in language/);
  });

  it('timeout: stored as unknown', async () => {
    const q = putQuote();
    metaTimesOut();
    await delivery.sendQuoteLink(q(), 'https://x/q/t');
    expect(q().whatsappStatus).toBe('unknown');
  });
});

describe('delivery reports from Meta\'s webhook', () => {
  const report = (status, extra = {}) => delivery.applyWhatsAppStatus({ id: 'wamid.OK', status, ...extra });

  it('move forward: accepted → sent → delivered → read', async () => {
    const q = putQuote({ whatsappStatus: 'accepted', whatsappSent: true, whatsappMessageId: 'wamid.OK' });
    for (const s of ['sent', 'delivered', 'read']) { await report(s); expect(q().whatsappStatus).toBe(s); }
  });

  it('never backwards: a late "sent" or "delivered" after "read" changes nothing', async () => {
    const q = putQuote({ whatsappStatus: 'read', whatsappMessageId: 'wamid.OK' });
    expect(await report('sent')).toBe(false);
    expect(await report('delivered')).toBe(false);
    expect(q().whatsappStatus).toBe('read');
  });

  it('failed after accepted: recorded with Meta\'s reason; never overrides a delivery', async () => {
    const q = putQuote({ whatsappStatus: 'accepted', whatsappSent: true, whatsappMessageId: 'wamid.OK' });
    await report('failed', { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is incapable of receiving this message' } }] });
    expect(q()).toEqual(expect.objectContaining({ whatsappStatus: 'failed', whatsappSent: false, whatsappErrorCode: '131026' }));
    expect(q().whatsappError).toMatch(/Not delivered: Message undeliverable — Receiver is incapable/);

    const d = putQuote({ whatsappStatus: 'delivered', whatsappMessageId: 'wamid.OK' });
    await report('failed', { errors: [{ code: 131000 }] });
    expect(d().whatsappStatus).toBe('delivered');
  });

  it('a report for some other message touches no quote', async () => {
    const q = putQuote({ whatsappStatus: 'accepted', whatsappMessageId: 'wamid.OK' });
    expect(await delivery.applyWhatsAppStatus({ id: 'wamid.SOMEONE-ELSE', status: 'read' })).toBe(false);
    expect(q().whatsappStatus).toBe('accepted');
  });
});

describe('resend — explicit, one at a time, never a duplicate of an accepted message', () => {
  it('after a rejection: sends again and records the new verdict', async () => {
    const q = putQuote({ whatsappStatus: 'rejected', whatsappError: 'x', whatsappAttempts: 1 });
    metaAccepted('wamid.2');
    const r = await resend();
    expect(r.statusCode).toBe(200);
    expect(r.body.quote.whatsapp).toEqual(expect.objectContaining({ status: 'accepted', canResend: false }));
    expect(q()).toEqual(expect.objectContaining({ whatsappStatus: 'accepted', whatsappAttempts: 2, whatsappMessageId: 'wamid.2' }));
  });

  it('accepted / sent / delivered / read: refused — it would send twice', async () => {
    for (const s of ['accepted', 'sent', 'delivered', 'read']) {
      putQuote({ whatsappStatus: s, whatsappSent: true });
      const r = await resend();
      expect([s, r.statusCode, r.body.code]).toEqual([s, 409, 'ALREADY_ACCEPTED']);
    }
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('unknown outcome: needs the operator\'s confirmation first', async () => {
    putQuote({ whatsappStatus: 'unknown', whatsappError: 'No answer' });
    const r1 = await resend();
    expect([r1.statusCode, r1.body.code]).toEqual([409, 'CONFIRM_POSSIBLE_DUPLICATE']);
    expect(axios.post).not.toHaveBeenCalled();
    metaAccepted();
    const r2 = await resend({ confirmPossibleDuplicate: true });
    expect(r2.statusCode).toBe(200);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('old quotes (before this change) that failed count as unknown — confirmation required', async () => {
    putQuote({ whatsappSent: false, whatsappError: 'WhatsApp send failed — is the booking_quote_link template approved?' });
    const r = await resend();
    expect(r.body.code).toBe('CONFIRM_POSSIBLE_DUPLICATE');
  });

  it('confirmed or expired links: refused', async () => {
    putQuote({ whatsappStatus: 'rejected', status: 'confirmed' });
    expect((await resend()).body.code).toBe('CONFIRMED');
    putQuote({ whatsappStatus: 'rejected', expiresAt: new Date(Date.now() - 1000) });
    expect((await resend()).body.code).toBe('EXPIRED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('double click / two operators at once: exactly ONE WhatsApp send', async () => {
    putQuote({ whatsappStatus: 'rejected', whatsappError: 'x' });
    let release;
    axios.post.mockImplementationOnce(() => new Promise((ok) => { release = () => ok({ data: { messages: [{ id: 'wamid.ONCE' }] } }); }));
    const first = resend();
    await new Promise((r) => setImmediate(r));
    const second = await resend();                 // while the first is in flight
    expect([second.statusCode, second.body.code]).toEqual([409, 'SEND_IN_PROGRESS']);
    release();
    expect((await first).statusCode).toBe(200);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('a send interrupted long ago (server restart) does not block a new one forever', async () => {
    putQuote({ whatsappStatus: 'unknown', whatsappSendingAt: new Date(Date.now() - 10 * 60e3) });
    metaAccepted();
    const r = await resend({ confirmPossibleDuplicate: true });
    expect(r.statusCode).toBe(200);
  });

  it('the CRM view keeps quote status and message status apart', async () => {
    putQuote({ status: 'viewed', viewedAt: new Date(), whatsappStatus: 'failed', whatsappError: 'Not delivered: x', whatsappErrorCode: '131026' });
    metaRejects(131026);
    const r = await resend();
    const q = r.body.quote;
    expect(q.status).toBe('viewed');                                   // the LINK
    expect(q.whatsapp).toEqual(expect.objectContaining({               // the MESSAGE
      status: 'rejected', errorCode: '131026', canResend: true, resendNeedsConfirm: false,
    }));
    expect(q.whatsapp.error).toMatch(/number may not be on WhatsApp/);
    expect(q.whatsappSent).toBe(false);                                // old field kept for older CRMs
  });
});
