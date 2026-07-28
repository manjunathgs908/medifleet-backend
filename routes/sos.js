/**
 * routes/sos.js
 * ============================================================
 * Driver SOS / emergency alert — mounted at /api/sos, additive.
 * ============================================================
 */
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/sosController');
const { protect, authorize } = require('../middleware/auth');

// Private [driver]
router.post('/', protect, authorize('driver'), ctrl.createSosAlert);

// Private [owner] — CRM's platform-wide ops session, see sosController for why unscoped.
router.get  ('/',            protect, authorize('owner'), ctrl.getSosAlerts);
router.patch('/:id/resolve', protect, authorize('owner'), ctrl.resolveSosAlert);

module.exports = router;
