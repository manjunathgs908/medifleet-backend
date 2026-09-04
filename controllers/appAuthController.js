/**
 * controllers/appAuthController.js
 * ============================================================
 * Phone-OTP login for the SaveLife customer app (savelife-app).
 *
 * Deliberately its own file, not another branch inside authController.
 * That one logs in Users (drivers) and binds a device; ownerController logs in
 * Owners. A customer is neither: there is no account record, only a phone
 * number the SMS proved someone controls. Keeping the three apart means the
 * customer flow cannot inherit a rule written for a driver, and a driver rule
 * cannot be relaxed to accommodate a customer.
 *
 * WHAT THE TOKEN IS
 *
 * A JWT carrying { phone, role: 'customer' } and NO `id`. That is deliberate:
 * middleware/auth.js `protect` resolves req.user with User.findById(decoded.id),
 * so a customer token resolves to nothing and is refused with 401 on every
 * driver and owner route. It is a proof of phone ownership for customer
 * endpoints, and it is not a key to anything else.
 *
 * WHAT THE APP NEVER SEES
 *
 * The MSG91 auth key. The app calls this API; this API calls MSG91. There is
 * no path by which a credential reaches the handset, and there must not be —
 * a key shipped in a mobile binary is a published key.
 * ============================================================
 */
'use strict';

const jwt = require('jsonwebtoken');
const CustomerOtp = require('../models/CustomerOtp');
const smsService = require('../utils/smsService');

// Indian mobile numbers: ten digits starting 6-9. The same rule the website
// booking form is validated against, so a number that works in one works in
// the other.
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

// Ten minutes. Long enough for a delayed SMS on a bad signal, short enough
// that a code read over someone's shoulder is not useful tomorrow.
const OTP_TTL_MS = 10 * 60 * 1000;

// Six digits, to match the approved SaveLife_App_OTP template. Generated with
// a full-range integer rather than string padding so every code from 000000 to
// 999999 is equally likely — a leading digit that is never zero is a sixth of
// the space given away for nothing.
const generateOtp = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

const signCustomerToken = (phone) =>
  jwt.sign(
    { phone, role: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_CUSTOMER_EXPIRE || '30d' },
  );

// ============================================================
// @route   POST /api/app/auth/send-otp
// @desc    Send a 6-digit login OTP to a customer's phone via MSG91, using
//          the approved SaveLife_App_OTP template.
// @access  Public
// ============================================================
exports.sendOtp = async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }
    if (!INDIAN_MOBILE.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

    const otp = generateOtp();

    // Written before the SMS goes out, and attempts reset to zero: a resend is
    // a fresh start, or five wrong guesses would permanently lock a number
    // that simply never received the first message.
    await CustomerOtp.findOneAndUpdate(
      { phone },
      { otp, otpExpiry, attempts: 0 },
      { upsert: true, new: true },
    );

    // The app template, not the website one. Both are approved separately on
    // DLT and their bodies differ, so the id is passed explicitly rather than
    // left to the shared default in smsService.
    const templateId = process.env.MSG91_APP_TEMPLATE_ID;
    if (!templateId) {
      // Loud, not silent. An unset template id means MSG91 is asked to send
      // nothing and answers 200 for it, which would read as success here.
      console.error('[appAuth.sendOtp] MSG91_APP_TEMPLATE_ID is not set — no OTP sent');
      return res.status(503).json({
        success: false,
        message: 'OTP service is not configured. Please try again shortly.',
      });
    }

    const smsResult = await smsService.sendOtp(phone, otp, { templateId });
    console.log('[appAuth.sendOtp] MSG91 response for', phone, ':', JSON.stringify(smsResult));

    // MSG91 answers HTTP 200 with a payload-level failure for a bad authkey or
    // an unapproved template, and axios does not throw on that. Without this
    // the app would show "OTP sent" while nothing was ever delivered — the
    // exact way the first OTP rollout failed.
    if (smsResult?.type === 'error') {
      return res.status(502).json({
        success: false,
        message: 'Could not send the OTP right now. Please try again.',
      });
    }

    // Development only, so the flow can be driven without a handset. Never in
    // production: an OTP in an HTTP response is not an OTP.
    const devPayload = process.env.NODE_ENV === 'development' ? { otp } : {};

    return res.json({ success: true, message: `OTP sent to ${phone}.`, ...devPayload });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/app/auth/verify-otp
// @desc    Verify a customer's OTP and issue a session token.
// @access  Public
// ============================================================
exports.verifyOtp = async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const otp = String(req.body?.otp || '').trim();

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone number and OTP are required.' });
    }

    // +otp because the field is select:false on the model.
    const record = await CustomerOtp.findOne({ phone }).select('+otp');

    // No record covers two cases that are one answer to the caller: never
    // asked for a code, or asked so long ago the TTL index removed it. Saying
    // which would tell an attacker whether a number is in play.
    if (!record) {
      return res.status(410).json({
        success: false,
        code: 'OTP_EXPIRED',
        message: 'This code has expired. Please request a new one.',
      });
    }

    if (record.isExpired()) {
      await CustomerOtp.deleteOne({ _id: record._id });
      return res.status(410).json({
        success: false,
        code: 'OTP_EXPIRED',
        message: 'This code has expired. Please request a new one.',
      });
    }

    if (record.isLocked()) {
      return res.status(429).json({
        success: false,
        code: 'OTP_LOCKED',
        message: 'Too many incorrect attempts. Please request a new code.',
      });
    }

    if (!record.matches(otp)) {
      // Counted before the answer goes out, so a client that ignores the
      // response still burns the attempt.
      record.attempts = (record.attempts || 0) + 1;
      await record.save();

      const left = Math.max(0, CustomerOtp.MAX_ATTEMPTS - record.attempts);
      return res.status(400).json({
        success: false,
        code: 'OTP_INVALID',
        attemptsRemaining: left,
        message: left > 0
          ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. Please request a new one.',
      });
    }

    // One-time use. Deleted rather than marked, so a replay finds nothing at
    // all and is answered by the expired branch above.
    await CustomerOtp.deleteOne({ _id: record._id });

    return res.json({
      success: true,
      message: 'Verified.',
      token: signCustomerToken(phone),
      user: { phone, role: 'customer' },
    });
  } catch (err) {
    next(err);
  }
};
