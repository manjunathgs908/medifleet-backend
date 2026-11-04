'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/aiCallerController');
const { protect, authorize } = require('../middleware/auth');

// AI telecaller PILOT. Plivo webhooks first (Plivo-signed, no login) —
// declared before the owner guard below.
router.post('/plivo/answer',       ctrl.answer);
router.post('/plivo/hangup',       ctrl.hangup);
router.post('/plivo/handoff',      ctrl.handoff);
router.post('/plivo/handoff-done', ctrl.handoffDone);
router.post('/plivo/goodbye',      ctrl.goodbye);
router.post('/plivo/recording',    ctrl.recording);

// The CRM pilot page — owner only.
router.get ('/status',    protect, authorize('owner'), ctrl.status);
router.put ('/toggle',    protect, authorize('owner'), ctrl.setToggle);
router.post('/calls',     protect, authorize('owner'), ctrl.startCall);
router.get ('/calls',     protect, authorize('owner'), ctrl.listCalls);
router.get ('/calls/:id', protect, authorize('owner'), ctrl.getCall);

module.exports = router;
