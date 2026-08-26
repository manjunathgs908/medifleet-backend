'use strict';

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const seoCtrl = require('../controllers/seoController');
const { protect, authorize } = require('../middleware/auth');

// Every route here is owner-only. Nothing in this router is public and
// nothing it does reaches the website.
router.use(protect, authorize('owner'));

// Generation is the expensive call -- two Claude requests per draft. Capped
// so a stuck client or an impatient operator cannot run up a bill; the read
// and review routes below are deliberately not limited.
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many generations. Wait a minute and try again.' },
});

router.get('/facts', seoCtrl.facts);
router.post('/generate', generateLimiter, seoCtrl.generate);
router.get('/articles', seoCtrl.list);
router.get('/articles/:id', seoCtrl.getById);
router.put('/articles/:id', seoCtrl.update);
// Owner-only like everything else in this router, and rate-limited with the
// same bucket as generate: a recheck is a Claude call too, and an operator
// hammering it costs exactly as much.
router.post('/articles/:id/recheck', generateLimiter, seoCtrl.recheck);
// Same bucket again: a repair is one more Claude call.
router.post('/articles/:id/repair', generateLimiter, seoCtrl.repair);
// Up to four Claude calls in one request, so the same bucket again.
router.post('/articles/:id/auto-repair', generateLimiter, seoCtrl.autoRepair);
router.put('/articles/:id/status', seoCtrl.setStatus);
router.delete('/articles/:id', seoCtrl.remove);

module.exports = router;
