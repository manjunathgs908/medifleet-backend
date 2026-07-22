'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/bookingTripController');
const { protect, authorize } = require('../middleware/auth');

router.post('/', protect, authorize('driver'), ctrl.createTrip);
router.put('/:id/stage', protect, authorize('driver'), ctrl.updateStage);
router.put('/:id/approve-cancel', protect, authorize('owner'), ctrl.approveCancel);
router.put('/:id/reopen', protect, authorize('owner'), ctrl.reopenTrip);
router.get('/my', protect, authorize('driver'), ctrl.myTrips);
router.get('/', protect, authorize('owner'), ctrl.getAllTrips);
router.get('/:id', protect, ctrl.getTrip);

module.exports = router;