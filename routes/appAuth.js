/**
 * routes/appAuth.js
 * ============================================================
 * Customer-app phone login. Mounted at /api/app/auth in server.js.
 *
 * Public by design — a customer has no credential before this flow completes,
 * which is what the flow is for. Both routes are therefore rate limited by IP,
 * because an unauthenticated endpoint that sends SMS costs real money per call
 * and an unauthenticated endpoint that checks a code invites guessing.
 * ============================================================
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/appAuthController');

const router = express.Router();

// Sending costs an SMS. A person entering their number needs one, occasionally
// a second when the first is slow — five an hour is generous for that and
// ruinous for anyone hoping to bill us for their evening.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many OTP requests. Please try again later.' },
});

// Verifying is free to us, so the limit is about guessing rather than cost.
// The per-code attempt cap in CustomerOtp stops an attack on ONE number; this
// stops one client working through many.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
});

router.post('/send-otp', sendLimiter, ctrl.sendOtp);
router.post('/verify-otp', verifyLimiter, ctrl.verifyOtp);

module.exports = router;
