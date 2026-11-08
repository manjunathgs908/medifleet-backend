/**
 * routes/auth.js
 * ============================================================
 * POST /api/auth/* — password login (Owner/staff), phone+OTP login
 * (driver), and User (Owner-only) management.
 * ============================================================
 */
'use strict';
const express   = require('express');
const mongoose  = require('mongoose');
const router    = express.Router();
const authCtrl  = require('../controllers/authController');
const unifiedAuthCtrl = require('../controllers/unifiedAuthController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');
const { sendOtpLimiter, verifyLimiter } = require('../middleware/otpRateLimit');

router.post('/register',         protect, authorize('owner'), authCtrl.register);
router.post('/send-otp',         sendOtpLimiter, authCtrl.sendOtp);
router.post('/verify-otp',       verifyLimiter, authCtrl.verifyOtp);

// Unified login — single phone-only flow for the app (replaces the old
// Driver/Owner tab selection in LoginScreen.js). Additive: the two
// routes above stay exactly as they were for anything still calling them
// directly.
router.post('/unified-send-otp',   sendOtpLimiter, unifiedAuthCtrl.sendOtp);
router.post('/unified-verify-otp', verifyLimiter, unifiedAuthCtrl.verifyOtp);
router.post('/login',            authCtrl.loginPassword);
router.post('/refresh',          authCtrl.refresh);
router.post('/logout',           protect, authCtrl.logout);
router.get ('/me',               protect, authCtrl.getMe);
router.put ('/update-password',  protect, authorize('owner'), authCtrl.updatePassword);

// ── User management (Owner only) ──────────────────────────
const { User } = require('../models');
const Owner      = require('../models/Owner');
const Ambulance  = require('../models/Ambulance');
const Assignment = require('../models/Assignment');

// GET /api/auth/users — list all staff
// Telecallers (operations) read it too — Fleet and the alert pages need
// driver names, phones and live availability — but never pay or device
// fields; adding, editing and deactivating staff stay owner-only.
const NOT_FOR_OPERATIONS = '-baseSalary -perTripBonus -deviceId -pin -pinChangeRequired';
router.get('/users', protect, authorize(...OPERATIONS), async (req, res, next) => {
  try {
    const { role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    const select = `-password -otp -otpExpiry -refreshToken${req.user.role === 'owner' ? '' : ` ${NOT_FOR_OPERATIONS}`}`;
    const users = await User.find(filter).select(select);
    return res.json({ success: true, users });
  } catch (err) { next(err); }
});

// Editable by a CRM admin through PUT /users/:id. An allowlist, not a
// denylist.
//
// This used to spread `...safeFields` after deleting password/otp/
// refreshToken — everything else on the User schema was writable, which
// on a multi-partner platform means an admin could set `owner` and move a
// driver between fleets as a silent side effect of an unrelated edit, or
// set approvalStatus, deviceId, pin or employeeId with no audit trail.
// A denylist also quietly grants every field added to the schema later.
//
// `owner` is deliberately absent: moving a driver between partners is a
// real operation with a precondition, and it has its own endpoint below.
const EDITABLE_USER_FIELDS = [
  'name', 'email', 'licenseNumber', 'licenseExpiry',
  'shiftType', 'driverType', 'shiftHours',
  'postingName', 'postingLat', 'postingLng',
  'baseSalary', 'perTripBonus',
  'speaksEnglish',
];

// PUT /api/auth/users/:id — edit user (name, salary config, etc.)
router.put('/users/:id', protect, authorize('owner'), async (req, res, next) => {
  try {
    const update = {};
    for (const field of EDITABLE_USER_FIELDS) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }

    // Tell the caller their field was ignored rather than silently
    // dropping it — a 200 that did not do what was asked is worse than a
    // 400, especially for `owner`, which now has its own endpoint.
    const rejected = Object.keys(req.body).filter((k) => !EDITABLE_USER_FIELDS.includes(k));
    if (rejected.length) {
      return res.status(400).json({
        success: false,
        code   : 'FIELD_NOT_EDITABLE',
        message: `These fields cannot be edited here: ${rejected.join(', ')}.`
          + (rejected.includes('owner') ? ' To move a driver to another fleet use PUT /api/auth/users/:id/owner.' : ''),
      });
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, user });
  } catch (err) { next(err); }
});

// PUT /api/auth/users/:id/owner — move a driver to another fleet.
//
// Its own endpoint because it is its own decision: it changes which
// partner's roster a driver appears on, which ambulances they can claim,
// and — through Owner.isPlatformOwner — whether they accrue attendance and
// payroll at all. That is not something that should happen as a by-product
// of editing a name.
//
// Refused while the driver holds an active Assignment. Moving them
// mid-shift would leave an ambulance in one fleet claimed by a driver now
// belonging to another, and startDuty's owner-scoped claim could never
// release it cleanly.
router.put('/users/:id/owner', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { ownerId } = req.body;
    if (ownerId === undefined) {
      return res.status(400).json({ success: false, message: 'ownerId is required (null to unlink).' });
    }

    const driver = await User.findOne({ _id: req.params.id, role: 'driver' });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });

    const active = await Assignment.findOne({ driver: driver._id, active: true });
    if (active) {
      return res.status(409).json({
        success: false,
        code   : 'DRIVER_ON_DUTY',
        message: `${driver.name} is on duty. End their duty before moving them to another fleet.`,
      });
    }

    if (ownerId !== null) {
      const owner = await Owner.findById(ownerId).select('_id name');
      if (!owner) return res.status(404).json({ success: false, message: 'Owner not found.' });
    }

    // Clear the roster too. defaultDriver and a 'locked' driverLock point
    // at a driver who is about to belong to a different fleet; left
    // behind, a locked ambulance would be reserved for someone who can no
    // longer claim it — unclaimable by that fleet entirely.
    await Ambulance.updateMany(
      { defaultDriver: driver._id },
      { $set: { defaultDriver: null, driverLock: 'open' } },
    );

    driver.owner = ownerId || undefined;
    await driver.save();

    return res.json({
      success: true,
      message: ownerId
        ? `${driver.name} moved to the new fleet. Any ambulance they were assigned to has been unassigned.`
        : `${driver.name} unlinked from their fleet.`,
      driver: { id: driver._id, name: driver.name, owner: driver.owner || null },
    });
  } catch (err) { next(err); }
});

// PUT /api/auth/users/:id/password — an owner sets or resets a staff
// login's password (telecallers: CRM phone + password login). Stored only
// as the bcrypt hash (User pre-save hook); never logged or sent back — the
// owner's screen shows what they typed once. Signs the user out of any
// existing session. Not for owners (they use /update-password themselves)
// or drivers (they log in to the app by OTP).
const MIN_STAFF_PASSWORD = 8;
router.put('/users/:id/password', protect, authorize('owner'), async (req, res, next) => {
  try {
    const password = String(req.body?.password ?? '');
    if (password.length < MIN_STAFF_PASSWORD || password.length > 128 || /\s/.test(password)) {
      return res.status(400).json({ success: false, message: `Password must be ${MIN_STAFF_PASSWORD}–128 characters, no spaces.` });
    }
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const user = await User.findById(req.params.id).select('+password +refreshToken');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role !== 'telecaller') {
      return res.status(400).json({ success: false, message: 'Passwords can be set here only for telecaller logins.' });
    }
    user.password = password;
    user.refreshToken = undefined;
    await user.save();
    console.info(`[auth] password set for user=${user._id} role=${user.role} by owner=${req.user._id}`);
    return res.json({ success: true, message: `Password set for ${user.name}.` });
  } catch (err) { next(err); }
});

// PUT /api/auth/users/:id/deactivate
router.put('/users/:id/deactivate', protect, authorize('owner'), async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    return res.json({ success: true, message: 'User deactivated.' });
  } catch (err) { next(err); }
});

// PATCH /api/auth/users/:id/status — the owner's Active/Inactive toggle on
// the Staff page. Body: { isActive: true | false }.
//
// isActive is a stored field (User.isActive), and it is what every login
// path and protect() check — so this one flag is the whole switch:
//   - false: protect() answers 403 on their very next request, password /
//     OTP / PIN login refuse, and the call-duty ring list, lead/callback
//     assignee lists and push alerts already skip them. Their refresh
//     token is cleared (nothing left to renew a session with) and call
//     duty is switched off, so reactivating does not silently put them
//     back on the incoming-call ring list.
//   - true: they can log in again (a fresh login — the old session is gone).
//
// Only drivers and telecallers: an owner can't switch themselves (or
// another owner login) off from here and lock the CRM out. A driver who
// holds an active Assignment is refused — cutting them off mid-duty would
// leave the ambulance claimed and the trip stranded; end their duty first.
// Setting the status it already has is a no-op 200.
//
// The older PUT /users/:id/deactivate stays as it is for anything still
// calling it.
const STATUS_ROLES = ['driver', 'telecaller'];
router.patch('/users/:id/status', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be true or false.' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ success: false, code: 'SELF', message: 'You cannot change your own status.' });
    }

    const user = await User.findById(req.params.id).select('name role isActive');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!STATUS_ROLES.includes(user.role)) {
      return res.status(400).json({ success: false, code: 'ROLE_NOT_ALLOWED', message: 'Only drivers and telecallers can be activated or deactivated here.' });
    }

    const view = () => ({ _id: user._id, name: user.name, role: user.role, isActive: user.isActive });
    if (user.isActive === isActive) {
      return res.json({ success: true, changed: false, message: `${user.name} is already ${isActive ? 'active' : 'inactive'}.`, user: view() });
    }

    if (!isActive && user.role === 'driver') {
      const onDuty = await Assignment.findOne({ driver: user._id, active: true });
      if (onDuty) {
        return res.status(409).json({
          success: false,
          code   : 'DRIVER_ON_DUTY',
          message: `${user.name} is on duty. End their duty before deactivating them.`,
        });
      }
    }

    // A targeted update, not user.save(): a legacy staff record with some
    // other field that no longer validates must not block the switch.
    await User.updateOne(
      { _id: user._id },
      isActive
        ? { $set: { isActive: true } }
        : { $set: { isActive: false, callDuty: false }, $unset: { refreshToken: 1 } },
    );
    user.isActive = isActive;
    console.info(`[auth] status ${isActive ? 'active' : 'inactive'} for user=${user._id} role=${user.role} by owner=${req.user._id}`);
    return res.json({ success: true, changed: true, message: `${user.name} is now ${isActive ? 'active' : 'inactive'}.`, user: view() });
  } catch (err) { next(err); }
});

module.exports = router;
