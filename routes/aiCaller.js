'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/aiCallerController');
const style = require('../controllers/aiStyleController');
const { protect, authorize } = require('../middleware/auth');

// AI telecaller PILOT. Plivo webhooks first (Plivo-signed, no login) —
// declared before the owner guard below.
router.post('/plivo/answer',       ctrl.answer);
router.post('/plivo/next',         ctrl.next);   // after the stream ends (the XML <Redirect>)
router.post('/plivo/hangup',       ctrl.hangup);
router.post('/plivo/handoff-done', ctrl.handoffDone);
router.post('/plivo/recording',    ctrl.recording);

// The CRM pilot page — owner only.
router.get ('/status',    protect, authorize('owner'), ctrl.status);
router.put ('/toggle',    protect, authorize('owner'), ctrl.setToggle);
router.post('/calls',     protect, authorize('owner'), ctrl.startCall);
router.get ('/calls',     protect, authorize('owner'), ctrl.listCalls);
router.get ('/calls/:id', protect, authorize('owner'), ctrl.getCall);

// The real SaveLife calls the assistant copies the talking style of.
router.get   ('/style-examples',     protect, authorize('owner'), style.list);
router.post  ('/style-examples',     protect, authorize('owner'), style.create);
router.put   ('/style-examples/:id', protect, authorize('owner'), style.update);
router.delete('/style-examples/:id', protect, authorize('owner'), style.remove);
router.get   ('/style-candidates',   protect, authorize('owner'), style.candidates);
router.get   ('/prompt-preview',     protect, authorize('owner'), style.promptPreview);

module.exports = router;
