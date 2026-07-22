/**
 * routes/auth.js
 * ============================================================
 * POST /api/auth/* — password login (Owner/staff), phone+OTP login
 * (driver), and User (Owner-only) management.
 * ============================================================
 */
'use strict';
const express   = require('express');
const router    = express.Router();
const authCtrl  = require('../controllers/authController');
const unifiedAuthCtrl = require('../controllers/unifiedAuthController');
const { protect, authorize } = require('../middleware/auth');

router.post('/register',         protect, authorize('owner'), authCtrl.register);
router.post('/send-otp',         authCtrl.sendOtp);
router.post('/verify-otp',       authCtrl.verifyOtp);

// Unified login — single phone-only flow for the app (replaces the old
// Driver/Owner tab selection in LoginScreen.js). Additive: the two
// routes above stay exactly as they were for anything still calling them
// directly.
router.post('/unified-send-otp',   unifiedAuthCtrl.sendOtp);
router.post('/unified-verify-otp', unifiedAuthCtrl.verifyOtp);
router.post('/login',            authCtrl.loginPassword);
router.post('/refresh',          authCtrl.refresh);
router.post('/logout',           protect, authCtrl.logout);
router.get ('/me',               protect, authCtrl.getMe);
router.put ('/update-password',  protect, authorize('owner'), authCtrl.updatePassword);

// ── User management (Owner only) ──────────────────────────
const { User } = require('../models');

// GET /api/auth/users — list all staff
router.get('/users', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    const users = await User.find(filter).select('-password -otp -otpExpiry -refreshToken');
    return res.json({ success: true, users });
  } catch (err) { next(err); }
});

// PUT /api/auth/users/:id — edit user (name, salary config, etc.)
router.put('/users/:id', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { password, otp, refreshToken, ...safeFields } = req.body; // Strip auth fields
    const user = await User.findByIdAndUpdate(req.params.id, safeFields, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, user });
  } catch (err) { next(err); }
});

// PUT /api/auth/users/:id/deactivate
router.put('/users/:id/deactivate', protect, authorize('owner'), async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    return res.json({ success: true, message: 'User deactivated.' });
  } catch (err) { next(err); }
});

module.exports = router;
