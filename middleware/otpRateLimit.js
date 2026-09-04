/**
 * middleware/otpRateLimit.js
 * ============================================================
 * Rate limits for the OTP endpoints, shared by driver, owner and unified
 * login so the three cannot be given different ceilings by accident.
 *
 * WHY BOTH KEYS
 *
 * The five-attempt cap on an issued code (utils/otp.js) stops someone
 * guessing ONE code. On its own it is trivially bypassed: burn five guesses,
 * request a fresh code, burn five more. Limiting sends per phone is what
 * closes that loop — the attacker cannot keep buying new codes for the number
 * they are attacking.
 *
 * Limiting per IP closes the other direction: one client working through many
 * different numbers, which is both an enumeration sweep and, because every
 * send costs a real SMS, a way to spend our money.
 *
 * Neither limit alone is enough, so both are applied and a request has to pass
 * both to reach the controller.
 * ============================================================
 */
'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS = 3;

// Deliberately vague and identical to the wording used elsewhere: a limiter
// that says "too many requests for THIS number" confirms the number is worth
// attacking.
const message = {
  success: false,
  code: 'RATE_LIMITED',
  message: 'Too many OTP requests. Please wait a few minutes and try again.',
};

// Per phone. Falls back to the IP when no phone was supplied, so a malformed
// request cannot slip past by omitting the field the key is built from.
const perPhone = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_SENDS,
  standardHeaders: true,
  legacyHeaders: false,
  message,
  keyGenerator: (req, res) => {
    const phone = String(req.body?.phone || '').trim();
    // ipKeyGenerator normalises IPv6 into a /64 block; using req.ip raw would
    // let one IPv6 host present a practically unlimited number of keys.
    return phone ? `phone:${phone}` : `ip:${ipKeyGenerator(req, res)}`;
  },
});

// Per IP, across every number that client tries.
const perIp = rateLimit({
  windowMs: WINDOW_MS,
  // Higher than the per-phone ceiling on purpose: a household or office behind
  // one NAT address can legitimately hold several drivers.
  max: MAX_SENDS * 4,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

// Verifying costs us nothing, so this is about guessing rather than spend. The
// per-code cap stops an attack on one number; this stops one client running
// many codes in parallel.
const verifyLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
});

// Order matters only for which message is returned first; both must pass.
const sendOtpLimiter = [perIp, perPhone];

module.exports = { sendOtpLimiter, verifyLimiter, WINDOW_MS, MAX_SENDS };
