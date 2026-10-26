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
const { protect, protectUserOrOwner, authorize } = require('../middleware/auth');

// Drivers, fleet owners (Owner accounts) and CRM staff may all place a
// masked call; controllers/callController.js decides whom each may reach.
router.post('/click-to-call', protectUserOrOwner, ctrl.clickToCall);

// Plivo webhooks — authenticated by Plivo's request signature, not a login.
// GET is accepted too in case the dashboard is set to GET.
router.all('/answer',    ctrl.requirePlivoSignature, ctrl.answer);
router.all('/incoming',  ctrl.requirePlivoSignature, ctrl.incoming);
router.all('/events',    ctrl.requirePlivoSignature, ctrl.events);
router.all('/recording', ctrl.requirePlivoSignature, ctrl.recording);

// CRM only. protect() resolves CRM Users only, so a fleet Owner's token
// cannot reach these.
router.get('/logs', protect, authorize('owner'), ctrl.listLogs);
router.get('/duty', protect, authorize('owner'), ctrl.getDuty);
router.put('/duty', protect, authorize('owner'), ctrl.setDuty);
router.get('/me',     protect, authorize('owner'), ctrl.getMe);
router.put('/me',     protect, authorize('owner'), ctrl.setMe);
router.get('/config', protect, authorize('owner'), ctrl.getConfig);
// Recording playback, proxied with Plivo Basic Auth (the Plivo URL is never
// sent to the browser).
router.get('/:id/recording', protect, authorize('owner'), ctrl.streamRecording);

module.exports = router;
