'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const placesCtrl = require('../controllers/placesController');

// Public, billed-per-call endpoints — cap abuse per IP.
// Requires app.set('trust proxy', ...) in server.js so req.ip reflects the
// real client (Render sits behind a proxy) rather than bucketing every user together.
const placesLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 30,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { success: false, message: 'Too many requests. Please slow down and try again shortly.' },
});

router.use(placesLimiter);

router.get('/autocomplete', placesCtrl.autocomplete);
router.get('/details',      placesCtrl.details);
router.get('/reverse',      placesCtrl.reverse);
router.get('/directions',   placesCtrl.directions);

module.exports = router;
