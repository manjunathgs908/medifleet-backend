'use strict';

const express = require('express');
const router = express.Router();

const pricingCtrl = require('../controllers/pricingController');
const { protect, authorize } = require('../middleware/auth');

// Both GETs stay public: the website reads fares before anyone logs in, so
// putting a guard here would break the fare quote on savelife.health.
router.get('/', pricingCtrl.getPricing);
router.get('/:vehicleType', pricingCtrl.getPricingByVehicle);

// The writes were unauthenticated -- anyone who could reach the API could
// rewrite every fare in the system. Fares are edited directly in Atlas, so
// these two have no caller to break; same route-level guard the rest of the
// owner-only endpoints use.
router.post('/', protect, authorize('owner'), pricingCtrl.createPricing);
router.put('/:id', protect, authorize('owner'), pricingCtrl.updatePricing);

module.exports = router;
