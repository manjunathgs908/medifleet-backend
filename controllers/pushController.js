'use strict';
/**
 * controllers/pushController.js
 * ============================================================
 * Web Push subscriptions for CRM operators — background "New booking"
 * alerts (services/bookingPush.js). Mounted at /api/push, owner and
 * telecaller only (routes/push.js).
 * ============================================================
 */
const PushSubscription = require('../models/PushSubscription');

// The server POSTs to whatever endpoint is stored, so only real browser
// push services are accepted — never an arbitrary (internal) URL.
const PUSH_HOSTS = [
  'fcm.googleapis.com',          // Chrome, Android, most Chromium browsers
  'android.googleapis.com',      // older Chrome
  'push.services.mozilla.com',   // Firefox (updates.push.services.mozilla.com)
  'push.apple.com',              // Safari / iOS home-screen apps (web.push.apple.com)
  'notify.windows.com',          // Edge (*.notify.windows.com)
];
const isPushEndpoint = (value) => {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
};
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9_\-=+/]+$/.test(v);

// ============================================================
// @route   GET /api/push/public-key
// @desc    The VAPID public key the browser subscribes with. enabled:false
//          (and no key) while the server's VAPID env isn't set.
// ============================================================
exports.publicKey = (req, res) => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  const enabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
  return res.json({ success: true, enabled, publicKey: enabled ? VAPID_PUBLIC_KEY : null });
};

// ============================================================
// @route   POST /api/push/subscribe
// @body    { subscription: PushSubscription.toJSON() }
// @desc    Save (or move to this operator) this browser's subscription.
// ============================================================
exports.subscribe = async (req, res, next) => {
  try {
    const sub = req.body?.subscription || {};
    if (!isPushEndpoint(sub.endpoint) || !isKey(sub.keys?.p256dh) || !isKey(sub.keys?.auth)) {
      return res.status(400).json({ success: false, message: 'Invalid push subscription.' });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      {
        $set: {
          keys     : { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          user     : req.user._id,
          userAgent: String(req.get('user-agent') || '').slice(0, 400),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/push/unsubscribe
// @body    { endpoint }
// @desc    Stop pushing to this browser — only the caller's own.
// ============================================================
exports.unsubscribe = async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ success: false, message: 'endpoint is required.' });
    }
    const result = await PushSubscription.deleteOne({ endpoint, user: req.user._id });
    return res.json({ success: true, removed: result?.deletedCount || 0 });
  } catch (err) {
    next(err);
  }
};
