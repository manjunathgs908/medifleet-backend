/**
 * routes/assignments.js
 * ============================================================
 * Phase 3 of the driver-auth redesign — mounted at /api/assignments,
 * additive alongside Phase 1 (owners/fleets/ambulances) and Phase 2
 * (driver-auth) routes.
 * ============================================================
 */
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/assignmentController');
const { protect, protectOwner, authorize } = require('../middleware/auth');

// Private [driver]
router.get ('/available-ambulances', protect, authorize('driver'), ctrl.getAvailableAmbulances);
router.post('/start-duty', protect, authorize('driver'), ctrl.startDuty);
router.post('/break',      protect, authorize('driver'), ctrl.breakDuty);
router.post('/resume',     protect, authorize('driver'), ctrl.resumeDuty);
router.post('/end-duty',   protect, authorize('driver'), ctrl.endDuty);
router.get ('/my-active',  protect, authorize('driver'), ctrl.getMyActiveShift);
router.get ('/my-history', protect, authorize('driver'), ctrl.getAssignmentHistory);

// Private [owner]
router.get ('/fleet-status', protectOwner, authorize('owner'), ctrl.getFleetShiftStatus);

module.exports = router;
