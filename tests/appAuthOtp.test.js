/**
 * tests/appAuthOtp.test.js
 * ============================================================
 * Customer-app phone login: send an OTP through the approved
 * SaveLife_App_OTP template, verify it, issue a session token.
 *
 * The properties worth holding still are mostly about what must NOT happen:
 * the website's template must not move, an unset app template must not read as
 * success, a wrong code must not be free to guess, a used code must not work
 * twice, and the token this issues must not open a driver's door.
 *
 * No database and no network: axios is mocked, so every MSG91 call is visible
 * as a call here, and the model is driven through real documents with their
 * real instance methods.
 * ============================================================
 */
'use strict';

jest.mock('axios');

const axios = require('axios');
const CustomerOtp = require('../models/CustomerOtp');
const smsService = require('../utils/smsService');
const ctrl = require('../controllers/appAuthController');

const APP_TEMPLATE = '6a99f7b8555866149098894x';   // 24 chars, shape only — not a real id
const WEB_TEMPLATE = '6a9a16f2cc7e2314e90aafd2';

// Minimal express doubles. `res` records rather than sends.
const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const call = async (handler, body) => {
  const res = mockRes();
  const next = jest.fn();
  await handler({ body }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
};

// A real document, so isExpired/isLocked/matches are the shipped ones.
const record = ({ otp = '123456', ageMs = 0, attempts = 0 } = {}) => {
  const doc = new CustomerOtp({
    phone: '9876543210',
    otp,
    otpExpiry: new Date(Date.now() + 10 * 60 * 1000 - ageMs),
    attempts,
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};
const stubFindOne = (doc) =>
  jest.spyOn(CustomerOtp, 'findOne').mockReturnValue({ select: () => Promise.resolve(doc) });

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-only-not-a-real-secret';
  process.env.MSG91_APP_TEMPLATE_ID = APP_TEMPLATE;
  process.env.MSG91_TEMPLATE_ID = WEB_TEMPLATE;
  process.env.MSG91_AUTH_KEY = 'test-only-not-a-real-key';
  delete process.env.TEST_OTP_ENABLED;
  axios.post = jest.fn().mockResolvedValue({ data: { type: 'success', request_id: 'r1' } });
  jest.spyOn(CustomerOtp, 'findOneAndUpdate').mockResolvedValue({});
  jest.spyOn(CustomerOtp, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
});
afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

const sentParams = () => axios.post.mock.calls[0][2].params;

// ============================================================
describe('A. sending the OTP', () => {
  test('a valid number sends through the SaveLife_App_OTP template', async () => {
    const res = await call(ctrl.sendOtp, { phone: '9876543210' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(sentParams().template_id).toBe(APP_TEMPLATE);
    expect(sentParams().mobile).toBe('919876543210');
  });

  test('the code is six digits and goes to the reserved `otp` param', async () => {
    // MSG91's v5 OTP endpoint fills the template's ##OTP## variable from this
    // parameter. If it were named anything else the SMS would arrive with an
    // empty placeholder.
    await call(ctrl.sendOtp, { phone: '9876543210' });
    expect(String(sentParams().otp)).toMatch(/^\d{6}$/);
  });

  test('the code is stored against the phone, with attempts reset', async () => {
    await call(ctrl.sendOtp, { phone: '9876543210' });
    const [filter, update] = CustomerOtp.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ phone: '9876543210' });
    expect(String(update.otp)).toMatch(/^\d{6}$/);
    expect(update.attempts).toBe(0);       // a resend is a fresh start
    expect(update.otpExpiry.getTime()).toBeGreaterThan(Date.now());
  });

  test('the OTP never appears in a production response', async () => {
    const res = await call(ctrl.sendOtp, { phone: '9876543210' });
    // Checked against the code actually generated, not against "any six
    // digits" -- the confirmation message contains the phone number, which is
    // ten digits and would match a loose pattern while proving nothing.
    const generated = String(sentParams().otp);
    expect(generated).toMatch(/^\d{6}$/);
    expect(res.body.otp).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(generated);
  });

  test.each([
    ['', 'Phone number is required'],
    ['12345', 'valid 10-digit'],
    ['5876543210', 'valid 10-digit'],       // must start 6-9
    ['98765432101', 'valid 10-digit'],
  ])('a bad number %p is refused without sending anything', async (phone, expected) => {
    const res = await call(ctrl.sendOtp, { phone });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(expected);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('an unset app template answers 503 instead of sending nothing', async () => {
    // The failure this guards: MSG91 accepts a request with no template and
    // answers 200, which would read as success and deliver no SMS.
    delete process.env.MSG91_APP_TEMPLATE_ID;
    const res = await call(ctrl.sendOtp, { phone: '9876543210' });
    expect(res.statusCode).toBe(503);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a payload-level MSG91 failure is a 502, not a success', async () => {
    // MSG91 returns HTTP 200 with type:'error' for a bad key or an unapproved
    // template, and axios does not throw on it.
    axios.post.mockResolvedValue({ data: { type: 'error', message: 'template not approved' } });
    const res = await call(ctrl.sendOtp, { phone: '9876543210' });
    expect(res.statusCode).toBe(502);
    expect(res.body.success).toBe(false);
  });

  test('the MSG91 auth key never appears in a response', async () => {
    axios.post.mockResolvedValue({ data: { type: 'error', message: 'bad authkey' } });
    const res = await call(ctrl.sendOtp, { phone: '9876543210' });
    expect(JSON.stringify(res.body)).not.toContain(process.env.MSG91_AUTH_KEY);
  });
});

// ============================================================
describe('B. the website and driver templates are untouched', () => {
  test('a two-argument caller still uses MSG91_TEMPLATE_ID', async () => {
    // The website booking flow and driver/owner login call sendOtp(phone, otp)
    // with no options. Adding the app template must not move them.
    await smsService.sendOtp('9876543210', '1234');
    expect(sentParams().template_id).toBe(WEB_TEMPLATE);
  });

  test('an explicit template overrides it only for that call', async () => {
    await smsService.sendOtp('9876543210', '123456', { templateId: APP_TEMPLATE });
    expect(sentParams().template_id).toBe(APP_TEMPLATE);

    axios.post.mockClear();
    await smsService.sendOtp('9876543210', '1234');
    expect(sentParams().template_id).toBe(WEB_TEMPLATE);
  });
});

// ============================================================
describe('C. verifying the OTP', () => {
  test('the right code returns a token and consumes the record', async () => {
    stubFindOne(record({ otp: '123456' }));
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '123456' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(CustomerOtp.deleteOne).toHaveBeenCalled();     // one-time use
  });

  test('a used code cannot be replayed', async () => {
    stubFindOne(null);                                    // deleted by the first use
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '123456' });
    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe('OTP_EXPIRED');
  });

  test('an expired code is refused and cleaned up', async () => {
    stubFindOne(record({ ageMs: 11 * 60 * 1000 }));
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '123456' });
    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe('OTP_EXPIRED');
    expect(CustomerOtp.deleteOne).toHaveBeenCalled();
  });

  test('a wrong code is refused, counted, and says how many tries are left', async () => {
    const doc = record({ otp: '123456', attempts: 0 });
    stubFindOne(doc);
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '000000' });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('OTP_INVALID');
    expect(res.body.attemptsRemaining).toBe(4);
    expect(doc.attempts).toBe(1);
    expect(doc.save).toHaveBeenCalled();
    expect(res.body.token).toBeUndefined();
  });

  test('guessing is capped — the code dies after five wrong answers', async () => {
    stubFindOne(record({ otp: '123456', attempts: 5 }));
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '123456' });
    // Locked beats correct: the right code offered after five wrong ones is
    // exactly what a successful search looks like.
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('OTP_LOCKED');
    expect(res.body.token).toBeUndefined();
  });

  test('missing input is refused before anything is looked up', async () => {
    const res = await call(ctrl.verifyOtp, { phone: '9876543210' });
    expect(res.statusCode).toBe(400);
  });

  test('the response never echoes the expected code', async () => {
    stubFindOne(record({ otp: '123456' }));
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '000000' });
    expect(JSON.stringify(res.body)).not.toContain('123456');
  });
});

// ============================================================
describe('D. the token is a customer token and nothing more', () => {
  test('it carries the phone and no user id', async () => {
    stubFindOne(record({ otp: '123456' }));
    const res = await call(ctrl.verifyOtp, { phone: '9876543210', otp: '123456' });

    const claims = require('jsonwebtoken').verify(res.body.token, process.env.JWT_SECRET);
    expect(claims.phone).toBe('9876543210');
    expect(claims.role).toBe('customer');
    // No `id`, deliberately: middleware/auth.js protect resolves req.user with
    // User.findById(decoded.id), so this token can never authenticate as a
    // driver or an owner -- it resolves to nothing and is refused.
    expect(claims.id).toBeUndefined();
  });

  test('it is signed, so a forged one does not verify', () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ phone: '9876543210', role: 'customer' }, 'the-wrong-secret');
    expect(() => jwt.verify(forged, process.env.JWT_SECRET)).toThrow();
  });
});
