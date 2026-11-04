'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pushController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

// Background "New booking" Web Push — CRM operators only.
router.use(protect, authorize(...OPERATIONS));

router.get ('/public-key',  ctrl.publicKey);
router.post('/subscribe',   ctrl.subscribe);
router.post('/unsubscribe', ctrl.unsubscribe);

module.exports = router;
