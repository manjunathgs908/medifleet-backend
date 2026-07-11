/**
 * routes/driverAuth.js
 * ============================================================
 * Phase 2 of the driver-auth redesign — Employee ID + PIN login,
 * mounted at /api/driver-auth alongside the existing /api/auth/*
 * (phone+password / OTP) routes, which are untouched.
 * ============================================================
 */
'use strict';
const express  = require('express');
const router   = express.Router();
const authCtrl = require('../controllers/authController');
const { protect, protectOwner, authorize } = require('../middleware/auth');

// Public — driver login
router.post('/login', authCtrl.loginWithPin);

// Private — driver changes their own PIN
router.post('/change-pin', protect, authCtrl.changePin);

// Private [owner] — driver onboarding/approval/device management
router.post('/register',           protectOwner, authorize('owner'), authCtrl.createDriverAccount);
router.put ('/:id/approve',        protectOwner, authorize('owner'), authCtrl.approveDriver);
router.put ('/:id/reject',         protectOwner, authorize('owner'), authCtrl.rejectDriver);
router.put ('/:id/unbind-device',  protectOwner, authorize('owner'), authCtrl.unbindDevice);

module.exports = router;
