'use strict';
const express = require('express');
const router = express.Router();
const tripCtrl = require('../controllers/tripController');
const paymentCtrl = require('../controllers/paymentController');
// protectUserOrOwner on the two read routes only — a fleet Owner needs to
// see their own trips, and protect() alone cannot serve them because it
// looks subjects up in the User collection. Every other route here stays
// on protect(). See middleware/auth.js.
const { protect, protectUserOrOwner, authorize } = require('../middleware/auth');

router.post('/send-otp',   tripCtrl.sendBookingOtp);
router.post('/verify-otp', tripCtrl.verifyBookingOtp);
router.post('/estimate', protect, tripCtrl.estimateTrip);
router.post('/', tripCtrl.createTrip);
// Token-keyed public tracking. Declared before '/:id/track' and
// before any '/:id' pattern so 'track' is never read as an id.
router.get('/track/:token', tripCtrl.trackTripByToken);
// Legacy, still used by the released SaveLife mobile app — keep.
router.get('/:id/track', tripCtrl.trackTrip);
router.put('/:id/customer-cancel', tripCtrl.customerCancelTrip);
router.put('/:id/rate', tripCtrl.rateTrip);
router.get('/:id/customer-messages',  tripCtrl.getCustomerMessages);
router.post('/:id/customer-messages', tripCtrl.postCustomerMessage);
router.get('/:id/messages',  protect, authorize('driver'), tripCtrl.getDriverMessages);
router.post('/:id/messages', protect, authorize('driver'), tripCtrl.postDriverMessage);
router.post('/:id/payment/order',  paymentCtrl.createOrder);
router.post('/:id/payment/verify', paymentCtrl.verifyPayment);
router.put('/:id/push-token', tripCtrl.registerCustomerPushToken);
router.get('/live', protect, authorize('owner','driver'), tripCtrl.getLiveBoard);
router.get('/', protectUserOrOwner, tripCtrl.getTrips);
router.get('/:id', protectUserOrOwner, tripCtrl.getTripById);
router.put('/:id/assign', protect, authorize('owner'), tripCtrl.assignVehicle);
router.put('/:id/status', protect, tripCtrl.updateStatus);
router.put('/:id/arrive-pickup', protect, tripCtrl.arrivePickup);
router.put('/:id/reached-hospital', protect, tripCtrl.arriveDrop);
router.put('/:id/start-return', protect, tripCtrl.startReturn);
router.put('/:id/verify-otp', protect, tripCtrl.verifyPickupOtp);
router.put('/:id/complete', protect, tripCtrl.completeTrip);
router.put('/:id/confirm', protect, authorize('driver'), tripCtrl.confirmTrip);
router.put('/:id/decline', protect, authorize('driver'), tripCtrl.declineTrip);
router.put('/:id/cancel', protect, authorize('owner'), tripCtrl.cancelTrip);

module.exports = router;