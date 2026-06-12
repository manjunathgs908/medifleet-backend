'use strict';
const express = require('express');
const router = express.Router();
const salaryCtrl = require('../controllers/salaryController');
const { protect, authorize } = require('../middleware/auth');

router.post('/calculate/:month/:year', protect, authorize('owner'), salaryCtrl.calculateSalaries);
router.get('/summary/:month/:year', protect, authorize('owner'), salaryCtrl.getPayrollSummary);
router.get('/:driverId/:month/:year', protect, salaryCtrl.getPayslip);
router.put('/:id/approve', protect, authorize('owner'), salaryCtrl.approveSalary);
router.put('/:id/mark-paid', protect, authorize('owner'), salaryCtrl.markSalaryPaid);
router.put('/:id/deductions', protect, authorize('owner'), salaryCtrl.updateDeductions);

module.exports = router;
