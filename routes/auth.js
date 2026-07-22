/**
 * ============================================================
 * ROUTES — All route definitions for MediFleet CRM
 * ============================================================
 * Each export below is a separate file path indicated by the
 * comment block. In production, split each section into its
 * own file at the indicated path.
 * ============================================================
 */

// ────────────────────────────────────────────────────────────
// routes/auth.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/auth.js */
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
router.put ('/update-password',  protect, authorize('owner','telecaller'), authCtrl.updatePassword);

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


// ────────────────────────────────────────────────────────────
// routes/vehicles.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/vehicles.js — paste into separate file */
/*
'use strict';
const express  = require('express');
const router   = express.Router();
const vehicleCtrl = require('../controllers/vehicleController');
const { protect, authorize } = require('../middleware/auth');

router.post  ('/',                     protect, authorize('owner'),              vehicleCtrl.createVehicle);
router.get   ('/',                     protect, authorize('owner','telecaller'), vehicleCtrl.getVehicles);
router.get   ('/compliance-dashboard', protect, authorize('owner'),              vehicleCtrl.complianceDashboard);
router.get   ('/:id',                  protect, authorize('owner','telecaller'), vehicleCtrl.getVehicleById);
router.put   ('/:id',                  protect, authorize('owner'),              vehicleCtrl.updateVehicle);
router.put   ('/:id/assign-driver',    protect, authorize('owner'),              vehicleCtrl.assignDriver);
router.put   ('/:id/gps',              protect,                                  vehicleCtrl.updateGps);
router.put   ('/:id/document',         protect, authorize('owner'),              vehicleCtrl.updateDocument);
router.post  ('/:id/service-log',      protect, authorize('owner'),              vehicleCtrl.addServiceLog);
router.get   ('/:id/service-logs',     protect, authorize('owner'),              vehicleCtrl.getServiceLogs);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/trips.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/trips.js — paste into separate file */
/*
'use strict';
const express   = require('express');
const router    = express.Router();
const tripCtrl  = require('../controllers/tripController');
const { protect, authorize } = require('../middleware/auth');

router.post('/',                    protect, authorize('owner','telecaller'), tripCtrl.createTrip);
router.get ('/live',                protect, authorize('owner','telecaller'), tripCtrl.getLiveBoard);
router.get ('/',                    protect,                                  tripCtrl.getTrips);
router.get ('/:id',                 protect,                                  tripCtrl.getTripById);
router.put ('/:id/assign',          protect, authorize('owner','telecaller'), tripCtrl.assignVehicle);
router.put ('/:id/status',          protect,                                  tripCtrl.updateStatus);
router.put ('/:id/complete',        protect,                                  tripCtrl.completeTrip);
router.put ('/:id/cancel',          protect, authorize('owner','telecaller'), tripCtrl.cancelTrip);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/billing.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/billing.js — paste into separate file */
/*
'use strict';
const express      = require('express');
const router       = express.Router();
const billingCtrl  = require('../controllers/billingController');
const { protect, authorize } = require('../middleware/auth');

router.get ('/dashboard',                  protect, authorize('owner'),              billingCtrl.getFinancialDashboard);
router.get ('/bills',                      protect, authorize('owner','telecaller'), billingCtrl.getBills);
router.get ('/bills/:id',                  protect, authorize('owner','telecaller'), billingCtrl.getBillById);
router.put ('/bills/:id/payment',          protect, authorize('owner','telecaller'), billingCtrl.recordPayment);
router.post('/hospital-invoice/generate',  protect, authorize('owner'),              billingCtrl.generateHospitalInvoice);
router.get ('/hospital-invoices',          protect, authorize('owner'),              billingCtrl.getHospitalInvoices);
router.put ('/hospital-invoices/:id/status', protect, authorize('owner'),            billingCtrl.updateInvoiceStatus);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/salary.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/salary.js — paste into separate file */
/*
'use strict';
const express      = require('express');
const router       = express.Router();
const salaryCtrl   = require('../controllers/salaryController');
const attendCtrl   = require('../controllers/salaryController'); // same file
const { protect, authorize, driverSelfOnly } = require('../middleware/auth');

// Salary
router.post('/calculate/:month/:year',  protect, authorize('owner'),               salaryCtrl.calculateSalaries);
router.get ('/summary/:month/:year',    protect, authorize('owner'),               salaryCtrl.getPayrollSummary);
router.get ('/:driverId/:month/:year',  protect, driverSelfOnly,                   salaryCtrl.getPayslip);
router.put ('/:id/approve',            protect, authorize('owner'),               salaryCtrl.approveSalary);
router.put ('/:id/mark-paid',          protect, authorize('owner'),               salaryCtrl.markSalaryPaid);
router.put ('/:id/deductions',         protect, authorize('owner'),               salaryCtrl.updateDeductions);

// Attendance
router.post('/attendance/clock-in',         protect, authorize('driver'),              attendCtrl.clockIn);
router.post('/attendance/clock-out',        protect, authorize('driver'),              attendCtrl.clockOut);
router.post('/attendance/shift-checklist',  protect, authorize('driver'),              attendCtrl.submitShiftChecklist);
router.get ('/attendance/:driverId',        protect, driverSelfOnly,                   attendCtrl.getAttendance);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/telephony.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/telephony.js — paste into separate file */
/*
'use strict';
const express       = require('express');
const router        = express.Router();
const { inboundCallWebhook, callStatusWebhook } = require('../controllers/telephonyController');

// No auth on webhooks — secured by HMAC signature instead
router.post('/inbound-webhook', inboundCallWebhook);
router.post('/call-status',     callStatusWebhook);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/leads.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/leads.js — paste into separate file */
/*
'use strict';
const express   = require('express');
const router    = express.Router();
const leadCtrl  = require('../controllers/telephonyController');
const { protect, authorize } = require('../middleware/auth');

// Webhook — no auth (secured by payload signatures)
router.get ('/fb/webhook',      leadCtrl.facebookVerify);
router.post('/fb/webhook',      leadCtrl.facebookLeadWebhook);
router.post('/google/webhook',  leadCtrl.googleLeadWebhook);

// CRM endpoints
router.get ('/', protect, authorize('owner','telecaller'), leadCtrl.getLeads);
router.put ('/:id', protect, authorize('owner','telecaller'), leadCtrl.updateLead);

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/compliance.js  (Manual cron trigger for admin)
// ────────────────────────────────────────────────────────────
/* FILE: routes/compliance.js — paste into separate file */
/*
'use strict';
const express  = require('express');
const router   = express.Router();
const { protect, authorize } = require('../middleware/auth');
const scheduler = require('../jobs/scheduler');

// Manual trigger endpoints for testing / admin override
router.post('/run-compliance-check', protect, authorize('owner'), async (req, res) => {
  await scheduler.runComplianceAlerts();
  res.json({ success: true, message: 'Compliance check triggered.' });
});

router.post('/run-emi-check', protect, authorize('owner'), async (req, res) => {
  await scheduler.runEmiCheck();
  res.json({ success: true, message: 'EMI check triggered.' });
});

router.post('/run-monthly-invoices', protect, authorize('owner'), async (req, res) => {
  await scheduler.runMonthlyHospitalInvoices();
  res.json({ success: true, message: 'Monthly invoice generation triggered.' });
});

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/hospitals.js
// ────────────────────────────────────────────────────────────
/* FILE: routes/hospitals.js — paste into separate file */
/*
'use strict';
const express   = require('express');
const router    = express.Router();
const { Hospital } = require('../models');
const { protect, authorize } = require('../middleware/auth');

router.post('/', protect, authorize('owner'), async (req, res, next) => {
  try {
    const hospital = await Hospital.create(req.body);
    res.status(201).json({ success: true, hospital });
  } catch(err) { next(err); }
});

router.get('/', protect, authorize('owner','telecaller'), async (req, res, next) => {
  try {
    const hospitals = await Hospital.find({ isActive: true }).sort({ name: 1 });
    res.json({ success: true, hospitals });
  } catch(err) { next(err); }
});

router.put('/:id', protect, authorize('owner'), async (req, res, next) => {
  try {
    const hospital = await Hospital.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found.' });
    res.json({ success: true, hospital });
  } catch(err) { next(err); }
});

module.exports = router;
*/


// ────────────────────────────────────────────────────────────
// routes/attendance.js  (standalone export)
// ────────────────────────────────────────────────────────────
/* FILE: routes/attendance.js — paste into separate file */
/*
'use strict';
const express     = require('express');
const router      = express.Router();
const salaryCtrl  = require('../controllers/salaryController');
const { protect, authorize, driverSelfOnly } = require('../middleware/auth');

router.post('/clock-in',        protect, authorize('driver'), salaryCtrl.clockIn);
router.post('/clock-out',       protect, authorize('driver'), salaryCtrl.clockOut);
router.post('/shift-checklist', protect, authorize('driver'), salaryCtrl.submitShiftChecklist);
router.get ('/:driverId',       protect, driverSelfOnly,      salaryCtrl.getAttendance);

module.exports = router;
*/

// This file serves as the master reference for all routes.
// In production, uncomment and save each section to its own file.
