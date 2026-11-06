'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/callCaptureController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

// LIVE CALL CAPTURE — the drafts the listen-only transcriber fills during
// a customer call. Operations staff (the people who take calls). Plivo's
// audio arrives on the signed websocket (services/aiCaller/streamServer.js),
// not here.
router.get('/by-call/:logId', protect, authorize(...OPERATIONS), ctrl.byCall);
router.get('/:id',            protect, authorize(...OPERATIONS), ctrl.getOne);
router.get('/:id/events',     protect, authorize(...OPERATIONS), ctrl.events);

module.exports = router;
