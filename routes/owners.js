'use strict';
const express   = require('express');
const router    = express.Router();
const ownerCtrl = require('../controllers/ownerController');
const { protectOwner, authorize } = require('../middleware/auth');

// Public — registration/login
router.post('/send-otp',   ownerCtrl.sendOtp);
router.post('/verify-otp', ownerCtrl.verifyOtp);

// Private [owner]
router.get ('/me',         protectOwner, authorize('owner'), ownerCtrl.getMe);
router.post('/kyc/upload', protectOwner, authorize('owner'), ownerCtrl.uploadKycDocument);

module.exports = router;
