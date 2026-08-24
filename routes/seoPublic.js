/**
 * routes/seoPublic.js
 * ============================================================
 * Public, unauthenticated reads of approved SEO articles. Mounted at
 * /api/guides in server.js.
 *
 * Separate from routes/seo.js on purpose. That router opens with
 * `router.use(protect, authorize('owner'))`, so every route in it is
 * owner-only by position -- which is fine until someone adds a public route
 * above that line by accident. Two files, two mounts, no ordering to get
 * wrong.
 * ============================================================
 */
'use strict';

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/seoPublicController');

// Generous: this is a cached read that the website calls during ISR
// revalidation, not per visitor. The limit exists to stop a scraper hammering
// Mongo, not to ration legitimate use.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

router.use(publicLimiter);

router.get('/', ctrl.list);
router.get('/:slug', ctrl.getBySlug);

module.exports = router;
