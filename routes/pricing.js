'use strict';

const express = require('express');
const router = express.Router();

const pricingCtrl = require('../controllers/pricingController');

router.get('/', pricingCtrl.getPricing);
router.get('/:vehicleType', pricingCtrl.getPricingByVehicle);
router.post('/', pricingCtrl.createPricing);
router.put('/:id', pricingCtrl.updatePricing);

module.exports = router;
