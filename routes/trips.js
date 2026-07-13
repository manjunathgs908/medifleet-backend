'use strict';
const express = require('express');
const router = express.Router();
const tripCtrl = require('../controllers/tripController');
const { protect, authorize } = require('../middleware/auth');

router.post('/', tripCtrl.createTrip);
router.get('/:id/track', tripCtrl.trackTrip);
router.get('/live', protect, authorize('owner','telecaller','driver'), tripCtrl.getLiveBoard);
router.get('/', protect, tripCtrl.getTrips);
router.get('/:id', protect, tripCtrl.getTripById);
router.put('/:id/assign', protect, authorize('owner','telecaller'), tripCtrl.assignVehicle);
router.put('/:id/status', protect, tripCtrl.updateStatus);
router.put('/:id/verify-otp', protect, tripCtrl.verifyPickupOtp);
router.put('/:id/complete', protect, tripCtrl.completeTrip);
router.put('/:id/decline', protect, authorize('driver'), tripCtrl.declineTrip);
router.put('/:id/cancel', protect, authorize('owner','telecaller'), tripCtrl.cancelTrip);

module.exports = router;