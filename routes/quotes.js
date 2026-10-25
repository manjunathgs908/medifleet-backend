/**
 * routes/quotes.js
 * ============================================================
 * "Quote & Confirm" booking links — mounted at /api/quotes. See
 * controllers/quoteController.js.
 *
 * Two audiences on one router:
 *   - CRM staff (owner) create and list quotes.
 *   - The customer's public page reads, prices and confirms ONE quote,
 *     identified only by its random token. No login, so these are
 *     rate-limited per IP: the estimate costs a Google Directions call,
 *     and confirm books an ambulance.
 * ============================================================
 */
'use strict';
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const ctrl      = require('../controllers/quoteController');
const { protect, authorize } = require('../middleware/auth');

// Same shape and limits as routes/places.js — the page that calls these
// also calls places autocomplete, at a similar rate. Relies on
// app.set('trust proxy', ...) in server.js for the real client IP.
const publicLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 30,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { success: false, message: 'Too many requests. Please slow down and try again shortly.' },
});

// Declared before the owner routes so '/public/...' is never read by them.
router.get ('/public/:token',          publicLimiter, ctrl.getPublicQuote);
router.post('/public/:token/estimate', publicLimiter, ctrl.estimatePublicQuote);
router.post('/public/:token/confirm',  publicLimiter, ctrl.confirmPublicQuote);

// Private [owner] — same CRM-only access as dispatch.
router.post('/', protect, authorize('owner'), ctrl.createQuote);
router.get ('/', protect, authorize('owner'), ctrl.listQuotes);

module.exports = router;
