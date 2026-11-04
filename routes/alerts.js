'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/alertController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

// CRM incoming alerts that aren't bookings (WhatsApp leads / conversations)
// — see services/incomingAlerts.js. The list itself is GET /api/trips/incoming.
router.use(protect, authorize(...OPERATIONS));

router.put('/:type/:id/acknowledge', ctrl.acknowledge);

module.exports = router;
