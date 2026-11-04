/**
 * routes/callbacks.js
 * ============================================================
 * Missed-call callback queue — mounted at /api/callbacks. CRM operations
 * staff (owner, telecaller), the same people who take and return customer
 * calls. See controllers/callbackController.js.
 * ============================================================
 */
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/callbackController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

router.use(protect, authorize(...OPERATIONS));

router.get('/',          ctrl.list);
router.get('/summary',   ctrl.summary);
router.get('/assignees', ctrl.assignees);
router.get('/not-routed', ctrl.notRouted);
router.post('/not-routed/:callId/queue',   ctrl.queueNotRouted);
router.post('/not-routed/:callId/dismiss', ctrl.dismissNotRouted);
router.patch('/:id/assign',   ctrl.assign);
router.patch('/:id/schedule', ctrl.schedule);
router.post('/:id/resolve',   ctrl.resolve);

module.exports = router;
