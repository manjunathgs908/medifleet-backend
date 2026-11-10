/**
 * routes/calls.js
 * ============================================================
 * Plivo masked calling — mounted at /api/calls. See
 * controllers/callController.js. (The older Exotel routes stay at
 * /api/call, singular, in routes/callRoutes.js.)
 * ============================================================
 */
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/callController');
const tripCallCtrl = require('../controllers/tripCallController');
const { protect, protectUserOrOwner, authorize } = require('../middleware/auth');

const { OPERATIONS: CRM_CALLS } = require('../middleware/auth');

// Drivers, fleet owners (Owner accounts) and CRM staff may all place a
// masked call; controllers/callController.js decides whom each may reach.
router.post('/click-to-call', protectUserOrOwner, ctrl.clickToCall);

// Plivo webhooks — authenticated by Plivo's request signature, not a login.
// GET is accepted too in case the dashboard is set to GET.
router.all('/answer',    ctrl.requirePlivoSignature, ctrl.answer);
router.all('/incoming',  ctrl.requirePlivoSignature, ctrl.incoming);
router.all('/events',    ctrl.requirePlivoSignature, ctrl.events);
router.all('/recording', ctrl.requirePlivoSignature, ctrl.recording);
router.all('/test-answer', ctrl.requirePlivoSignature, ctrl.testAnswer);
// The customer's XML while their call is being transferred.
router.all('/transfer-answer', ctrl.requirePlivoSignature, ctrl.transferAnswer);
// The phone Dial's live report: a phone picked up, or hung up.
router.all('/dial-event', ctrl.requirePlivoSignature, ctrl.dialEvent);
// Driver <-> customer masked trip calls (controllers/tripCallController.js):
// the initiator answered -> bridge if the trip is still active; and the
// answer URL for the masking number's own application (a redial).
router.all('/trip-answer',  ctrl.requirePlivoSignature, tripCallCtrl.answer);
router.all('/trip-inbound', ctrl.requirePlivoSignature, tripCallCtrl.inbound);

// CRM only. protect() resolves CRM Users only, so a fleet Owner's token
// cannot reach these. Telecallers (CRM_CALLS) take and return customer
// calls; Plivo's live-call panel stays with the owner.
router.get('/logs', protect, authorize(...CRM_CALLS), ctrl.listLogs);
// Who took the calls: every person for the owner, only yourself otherwise.
router.get('/performance', protect, authorize(...CRM_CALLS), ctrl.performance);
router.get('/duty', protect, authorize(...CRM_CALLS), ctrl.getDuty);
router.put('/duty', protect, authorize(...CRM_CALLS), ctrl.setDuty);
router.get('/me',     protect, authorize(...CRM_CALLS), ctrl.getMe);
router.put('/me',     protect, authorize(...CRM_CALLS), ctrl.setMe);
router.get('/config', protect, authorize(...CRM_CALLS), ctrl.getConfig);
// "Ring my phone now (test)" — rings the user's own ring number.
router.post('/test-ring', protect, authorize(...CRM_CALLS), ctrl.testRing);
// The incoming call you answered on your own phone, while it lasts (polled).
router.get('/my-live', protect, authorize(...CRM_CALLS), ctrl.myLiveCall);

// What Plivo has live right now (each call counts toward its concurrency
// limit), and hanging up one stuck call by id.
router.get ('/plivo/live',              protect, authorize('owner'), ctrl.liveCalls);
router.post('/plivo/live/:uuid/hangup', protect, authorize('owner'), ctrl.hangupLiveCall);

// In-app (WebRTC) calling for CRM staff.
router.get ('/webrtc/token',    protect, authorize(...CRM_CALLS), ctrl.webrtcToken);
router.get ('/webrtc/login',    protect, authorize(...CRM_CALLS), ctrl.webrtcLogin);
router.post('/webrtc/presence', protect, authorize(...CRM_CALLS), ctrl.webrtcPresence);
// TEMPORARY: Plivo SDK event capture from each CRM tab.
router.post('/webrtc/debug',    protect, authorize(...CRM_CALLS), ctrl.postWebrtcDebug);
router.get ('/webrtc/debug',    protect, authorize(...CRM_CALLS), ctrl.getWebrtcDebug);
router.get ('/:id',             protect, authorize(...CRM_CALLS), ctrl.getCall);
router.get ('/:id/trail',       protect, authorize(...CRM_CALLS), ctrl.getCallTrail);
router.post('/:id/answered',    protect, authorize(...CRM_CALLS), ctrl.markAnswered);
// The savelife_welcome WhatsApp template to this call's customer (number
// resolved server-side; once per number per IST day).
router.post('/:id/send-welcome', protect, authorize(...CRM_CALLS), ctrl.sendWelcome);
// Live transfer of a connected incoming call (only by the person on it).
router.post('/:id/transfer',    protect, authorize(...CRM_CALLS), ctrl.transferCall);
// Recording playback, proxied with Plivo Basic Auth (the Plivo URL is never
// sent to the browser).
router.get('/:id/recording', protect, authorize(...CRM_CALLS), ctrl.streamRecording);

module.exports = router;
