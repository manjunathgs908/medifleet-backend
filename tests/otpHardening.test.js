/**
 * tests/otpHardening.test.js
 * ============================================================
 * The login OTP, after hardening.
 *
 * What was there before: four digits, no attempt limit, no clearing on
 * success, and a 404 on send-otp for numbers with no account. Ten thousand
 * possibilities against an endpoint that answers all night is not a second
 * factor, and the 404 turned the same endpoint into a directory lookup.
 *
 * The properties pinned here are the ones that make it a credential:
 *
 *   - six digits, generated across the whole range
 *   - five wrong guesses and the code is dead, correct answer included
 *   - a used code cannot be used again
 *   - an unknown number is answered exactly like a known one
 *   - fresh codes are rate limited, so the attempt cap cannot be bought past
 *
 * Sessions are deliberately NOT re-tested here: sendTokenResponse,
 * issueOwnerSession, the JWT payload and device binding are untouched, and
 * tests/ has no coverage of them to disturb.
 * ============================================================
 */
'use strict';

const {
  generateOtp, otpExpiryFromNow, checkOtp, clearOtp, MAX_OTP_ATTEMPTS, OTP_LENGTH,
} = require('../utils/otp');

// A stand-in for a User/Owner document carrying the real instance methods.
const doc = ({ otp = '123456', ageMs = 0, otpAttempts = 0 } = {}) => ({
  otp,
  otpExpiry: new Date(Date.now() + 10 * 60 * 1000 - ageMs),
  otpAttempts,
  checkOtp,
  clearOtp,
  save: jest.fn().mockResolvedValue(undefined),
});

// ============================================================
describe('A. the code itself', () => {
  test('is six digits', () => {
    expect(OTP_LENGTH).toBe(6);
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  test('uses the whole range, including codes that start with zero', () => {
    // The old `1000 + random*9000` form could never produce a leading zero,
    // discarding a tenth of the space. Over 5000 draws a leading zero should
    // appear ~500 times; requiring at least one is a floor, not a coin flip.
    const draws = Array.from({ length: 5000 }, generateOtp);
    expect(draws.some((d) => d.startsWith('0'))).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(4000);   // not a constant
  });

  test('expires ten minutes out', () => {
    const ms = otpExpiryFromNow().getTime() - Date.now();
    expect(ms).toBeGreaterThan(9 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

// ============================================================
describe('B. checkOtp — the rules a controller relies on', () => {
  test('the right code passes', () => {
    expect(doc().checkOtp('123456')).toEqual({ ok: true });
  });

  test('a wrong code fails, counts the attempt, and says how many remain', () => {
    const d = doc();
    const v = d.checkOtp('000000');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('invalid');
    expect(v.attemptsRemaining).toBe(MAX_OTP_ATTEMPTS - 1);
    expect(d.otpAttempts).toBe(1);
  });

  test('five wrong guesses kill the code', () => {
    const d = doc();
    for (let i = 1; i <= MAX_OTP_ATTEMPTS; i++) {
      expect(d.checkOtp('000000').reason).toBe('invalid');
    }
    expect(d.otpAttempts).toBe(MAX_OTP_ATTEMPTS);
    // ...and the SIXTH answer is refused as locked even when it is correct.
    // A right answer arriving after five wrong ones is what a successful
    // search looks like, and must not be rewarded.
    expect(d.checkOtp('123456')).toMatchObject({ ok: false, reason: 'locked' });
  });

  test('an expired code is refused before anything else', () => {
    expect(doc({ ageMs: 11 * 60 * 1000 }).checkOtp('123456')).toMatchObject({ ok: false, reason: 'expired' });
  });

  test('a cleared code is refused as expired, so a replay cannot log in again', () => {
    const d = doc();
    expect(d.checkOtp('123456').ok).toBe(true);
    d.clearOtp();
    expect(d.otp).toBeUndefined();
    expect(d.otpAttempts).toBe(0);
    expect(d.checkOtp('123456')).toMatchObject({ ok: false, reason: 'expired' });
  });

  test('a number is compared as a string, not loosely', () => {
    expect(doc({ otp: '000123' }).checkOtp('123').ok).toBe(false);
    expect(doc({ otp: '000123' }).checkOtp('000123').ok).toBe(true);
  });
});

// ============================================================
describe('C. both login models carry the rules', () => {
  const { User } = require('../models');
  const Owner = require('../models/Owner');

  test.each([['User', User], ['Owner', Owner]])('%s has otpAttempts and the methods', (_n, Model) => {
    expect(Model.schema.path('otpAttempts')).toBeDefined();
    expect(typeof Model.prototype.checkOtp).toBe('function');
    expect(typeof Model.prototype.clearOtp).toBe('function');
  });

  test('otpAttempts is select:false, like otp itself', () => {
    // It must not ride along on an ordinary find and end up in a log line.
    expect(User.schema.path('otpAttempts').options.select).toBe(false);
    expect(Owner.schema.path('otpAttempts').options.select).toBe(false);
  });
});

// ============================================================
describe('D. the temporary test-OTP allowlist is gone', () => {
  test('utils/testOtp.js no longer exists', () => {
    expect(require('fs').existsSync(require('path').join(__dirname, '..', 'utils', 'testOtp.js'))).toBe(false);
  });

  test('no controller still references it', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'controllers');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/isTestOtpEnabled|getTestOtpCode|isTestOtpNumber|require\(['"]\.\.\/utils\/testOtp/);
    }
  });

  test('no login controller can still mint a four-digit code', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['authController.js', 'ownerController.js', 'unifiedAuthController.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', f), 'utf8');
      expect(src).not.toContain('Math.floor(1000 + Math.random() * 9000)');
      expect(src).toContain('generateOtp()');
    }
  });
});

// ============================================================
describe('E. send-otp answers unknown and known numbers identically', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'controllers', f), 'utf8');

  test('the driver 404 oracle is gone', () => {
    // "No active account found for this number" made send-otp a directory:
    // feed it numbers, keep the ones that do not 404.
    const src = read('authController.js');
    expect(src).not.toContain('No active account found for this number.');
  });

  test('verify no longer confirms an account exists either', () => {
    // Scoped to the verifyOtp bodies. "Owner not found" is still the right
    // answer on the authenticated admin routes (rejectOwner and friends),
    // where the caller is already trusted and nothing is leaked.
    const verifyBody = (f) => {
      const src = read(f);
      const at = src.indexOf('exports.verifyOtp');
      expect(at).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf('\nexports.', at + 1));
    };
    expect(verifyBody('authController.js')).not.toContain("message: 'User not found.'");
    expect(verifyBody('ownerController.js')).not.toContain("message: 'Owner not found.'");
    // ...and both answer a missing account the same way a wrong code is answered.
    expect(verifyBody('authController.js')).toContain('OTP_INVALID');
    expect(verifyBody('ownerController.js')).toContain('OTP_INVALID');
  });

  test('owner onboarding is untouched — an unknown number can still register', () => {
    // Deliberately NOT hidden: this is the documented owner sign-up path and
    // changing it would break onboarding.
    expect(read('ownerController.js')).toContain('Name is required to register a new owner.');
    expect(read('unifiedAuthController.js')).toContain('Name is required to register a new owner.');
  });
});

// ============================================================
describe('F. fresh codes are rate limited', () => {
  const express = require('express');
  const { sendOtpLimiter, MAX_SENDS } = require('../middleware/otpRateLimit');

  const appWith = () => {
    const app = express();
    app.use(express.json());
    app.post('/send-otp', sendOtpLimiter, (req, res) => res.json({ success: true }));
    return app;
  };

  const post = (app, phone) => new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const body = await r.json();
      server.close();
      resolve({ status: r.status, body });
    });
  });

  test('a phone is cut off after the send ceiling', async () => {
    const app = appWith();
    const seen = [];
    for (let i = 0; i < MAX_SENDS + 2; i++) seen.push((await post(app, '9876543210')).status);

    expect(seen.slice(0, MAX_SENDS).every((s) => s === 200)).toBe(true);
    expect(seen[MAX_SENDS]).toBe(429);
    // Without this, the five-attempt cap is bought past by simply asking for a
    // new code after every fifth guess.
  });

  test('the refusal does not confirm the number', async () => {
    const app = appWith();
    for (let i = 0; i < MAX_SENDS + 1; i++) await post(app, '9876543211');
    const blocked = await post(app, '9876543211');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).not.toMatch(/account|registered|exists|driver|owner/i);
  });

  test('routes actually mount the limiter', () => {
    const fs = require('fs');
    const path = require('path');
    const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    const owners = fs.readFileSync(path.join(__dirname, '..', 'routes', 'owners.js'), 'utf8');
    expect(auth).toMatch(/'\/send-otp',\s*sendOtpLimiter/);
    expect(auth).toMatch(/'\/unified-send-otp',\s*sendOtpLimiter/);
    expect(owners).toMatch(/'\/send-otp',\s*sendOtpLimiter/);
  });
});
