/**
 * controllers/salaryController.js
 * ============================================================
 * Hybrid Salary Engine
 *
 * Formula:
 *   earnedBase   = baseSalary × (presentDays / workingDays)
 *   tripBonus    = completedTrips × perTripBonus
 *   grossSalary  = earnedBase + tripBonus
 *   netSalary    = grossSalary - deductions
 *
 * Endpoints:
 *   POST /api/salary/calculate/:month/:year  — Owner triggers calc
 *   GET  /api/salary/:driverId/:month/:year  — Get driver's payslip
 *   PUT  /api/salary/:id/approve             — Owner approves
 *   PUT  /api/salary/:id/mark-paid           — Owner marks as paid
 *   GET  /api/salary/payroll-summary         — Monthly totals
 *
 * ============================================================
 *
 * controllers/attendanceController.js
 * ============================================================
 * Driver Attendance & Shift Management
 *
 * Endpoints:
 *   POST /api/attendance/clock-in            — Driver clocks in
 *   POST /api/attendance/clock-out           — Driver clocks out
 *   POST /api/attendance/shift-checklist     — Submit pre-shift check
 *   GET  /api/attendance/:driverId           — Monthly records
 *   PUT  /api/attendance/:id                 — Admin override (absent→present etc.)
 * ============================================================
 */

'use strict';

const { SalaryRecord, Attendance, Trip, User, Expense, Notification } = require('../models');

// ── Count working days in a given month (Mon–Sat, no Sundays) ─
const getWorkingDays = (month, year) => {
  const days = new Date(year, month, 0).getDate(); // total days in month
  let count  = 0;
  for (let d = 1; d <= days; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0) count++; // 0 = Sunday
  }
  return count;
};


// ════════════════════════════════════════════════════════════
//  SALARY CONTROLLER
// ════════════════════════════════════════════════════════════

// ============================================================
// @route   POST /api/salary/calculate/:month/:year
// @desc    Run salary engine for ALL drivers for the given month.
//          Creates SalaryRecord documents (status='draft').
//          Can be re-run; will upsert existing drafts.
// @access  Private [owner]
// ============================================================
exports.calculateSalaries = async (req, res, next) => {
  try {
    const month = Number(req.params.month);
    const year  = Number(req.params.year);

    if (month < 1 || month > 12 || year < 2020) {
      return res.status(400).json({ success: false, message: 'Invalid month or year.' });
    }

    // ── All active drivers ────────────────────────────────────
    const drivers = await User.find({ role: 'driver', isActive: true });
    if (!drivers.length) {
      return res.status(404).json({ success: false, message: 'No active drivers found.' });
    }

    const workingDays = getWorkingDays(month, year);

    // ── Date range for the month ──────────────────────────────
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd   = new Date(year, month,     0, 23, 59, 59);

    const results = [];

    for (const driver of drivers) {
      // ── 1. Count present days from Attendance ────────────────
      const presentCount = await Attendance.countDocuments({
        driver : driver._id,
        date   : { $gte: monthStart, $lte: monthEnd },
        status : { $in: ['present', 'half_day'] },
      });

      // Half days count as 0.5
      const halfDays = await Attendance.countDocuments({
        driver: driver._id,
        date  : { $gte: monthStart, $lte: monthEnd },
        status: 'half_day',
      });

      const effectiveDays = presentCount - halfDays + (halfDays * 0.5);

      // ── 2. Count completed trips for this driver in month ─────
      const completedTrips = await Trip.countDocuments({
        driver      : driver._id,
        status      : 'completed',
        completedAt : { $gte: monthStart, $lte: monthEnd },
      });

      // ── 3. Compute salary components ─────────────────────────
      const baseSalary    = driver.baseSalary    || 15000;
      const perTripBonus  = driver.perTripBonus  || 100;

      // Pro-rated base: (effectiveDays / workingDays) × baseSalary
      const earnedBase      = workingDays > 0
        ? Math.round((effectiveDays / workingDays) * baseSalary)
        : 0;
      const tripBonusAmount = completedTrips * perTripBonus;
      const grossSalary     = earnedBase + tripBonusAmount;

      // Deductions are set manually by owner; keep existing value if record exists
      const existing = await SalaryRecord.findOne({ driver: driver._id, month, year });
      const deductions = existing?.deductions || 0;
      const netSalary  = Math.max(0, grossSalary - deductions);

      // ── 4. Upsert salary record ───────────────────────────────
      const record = await SalaryRecord.findOneAndUpdate(
        { driver: driver._id, month, year },
        {
          driver, month, year,
          workingDays,
          presentDays    : Math.round(effectiveDays),
          completedTrips,
          baseSalary,
          perTripBonus,
          earnedBase,
          tripBonusAmount,
          grossSalary,
          deductions,
          netSalary,
          status : existing?.status === 'paid' ? 'paid' : 'draft', // Never downgrade paid
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      results.push({
        driverId  : driver._id,
        driverName: driver.name,
        record    : record._id,
        netSalary,
      });
    }

    // ── 5. Notify Owner ───────────────────────────────────────
    const totalPayroll = results.reduce((s, r) => s + r.netSalary, 0);
    await Notification.create({
      type      : 'salary_generated',
      title     : '💰 Salary Calculation Complete',
      message   : `${results.length} salary records generated for ${month}/${year}. Total payroll: ₹${totalPayroll.toLocaleString('en-IN')}`,
      severity  : 'info',
      targetRole: 'owner',
    });

    return res.json({
      success: true,
      message: `Salaries calculated for ${results.length} drivers.`,
      month, year,
      workingDays,
      totalDrivers : results.length,
      totalPayroll,
      records      : results,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/salary/:driverId/:month/:year
// @desc    Get a specific driver's salary record (payslip data).
//          Drivers can only access their own; owner can see any.
// @access  Private [owner, driver (own only)]
// ============================================================
exports.getPayslip = async (req, res, next) => {
  try {
    const { driverId, month, year } = req.params;

    // Driver guard (also enforced by driverSelfOnly middleware)
    if (req.user.role === 'driver' && req.user._id.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const record = await SalaryRecord.findOne({
      driver: driverId,
      month : Number(month),
      year  : Number(year),
    }).populate('driver', 'name phone vehicleId shiftType');

    if (!record) {
      return res.status(404).json({ success: false, message: 'No salary record found for this period.' });
    }

    return res.json({ success: true, record });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/salary/summary/:month/:year
// @desc    Payroll summary for all drivers in a month
// @access  Private [owner]
// ============================================================
exports.getPayrollSummary = async (req, res, next) => {
  try {
    const { month, year } = req.params;

    const records = await SalaryRecord.find({ month: Number(month), year: Number(year) })
      .populate('driver', 'name phone');

    const summary = {
      totalDrivers   : records.length,
      totalBasePay   : records.reduce((s, r) => s + r.earnedBase,       0),
      totalTripBonus : records.reduce((s, r) => s + r.tripBonusAmount,  0),
      totalDeductions: records.reduce((s, r) => s + r.deductions,       0),
      totalNetPayroll: records.reduce((s, r) => s + r.netSalary,        0),
      draftCount     : records.filter(r => r.status === 'draft').length,
      approvedCount  : records.filter(r => r.status === 'approved').length,
      paidCount      : records.filter(r => r.status === 'paid').length,
    };

    return res.json({ success: true, summary, records });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/salary/:id/approve
// @desc    Owner approves a draft salary record
// @access  Private [owner]
// ============================================================
exports.approveSalary = async (req, res, next) => {
  try {
    const record = await SalaryRecord.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', approvedBy: req.user._id },
      { new: true }
    );
    if (!record) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    return res.json({ success: true, message: 'Salary approved.', record });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/salary/:id/mark-paid
// @desc    Mark salary as paid and auto-create Expense entry
// @access  Private [owner]
// ============================================================
exports.markSalaryPaid = async (req, res, next) => {
  try {
    const { paymentMode = 'bank_transfer' } = req.body;

    const record = await SalaryRecord.findById(req.params.id).populate('driver', 'name');
    if (!record) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    if (record.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Salary already marked as paid.' });
    }

    record.status      = 'paid';
    record.paidAt      = new Date();
    record.paymentMode = paymentMode;
    await record.save();

    // ── Auto-create Expense entry ──────────────────────────────
    await Expense.create({
      category   : 'salary',
      amount     : record.netSalary,
      description: `Salary — ${record.driver.name} — ${record.month}/${record.year}`,
      date       : new Date(),
      recordedBy : req.user._id,
    });

    return res.json({ success: true, message: 'Salary marked as paid. Expense entry created.', record });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/salary/:id/deductions
// @desc    Set deductions for a salary record (advances, penalties)
// @access  Private [owner]
// ============================================================
exports.updateDeductions = async (req, res, next) => {
  try {
    const { deductions, notes } = req.body;
    const record = await SalaryRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    if (record.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Cannot modify a paid salary record.' });
    }

    record.deductions = deductions || 0;
    record.netSalary  = Math.max(0, record.grossSalary - record.deductions);
    if (notes) record.notes = notes;
    await record.save();

    return res.json({ success: true, record });
  } catch (err) {
    next(err);
  }
};


// ════════════════════════════════════════════════════════════
//  ATTENDANCE CONTROLLER
// ════════════════════════════════════════════════════════════

// ============================================================
// @route   POST /api/attendance/clock-in
// @desc    Driver clocks in at start of shift
// @access  Private [driver]
// ============================================================
exports.clockIn = async (req, res, next) => {
  try {
    const { shift = 'day', lat, lng } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check if already clocked in today
    const existing = await Attendance.findOne({ driver: req.user._id, date: today });
    if (existing?.clockIn) {
      return res.status(400).json({ success: false, message: 'Already clocked in for today.' });
    }

    const record = await Attendance.findOneAndUpdate(
      { driver: req.user._id, date: today },
      {
        shift,
        clockIn : new Date(),
        status  : 'present',
        location: { lat, lng },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, message: 'Clocked in successfully.', record });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/attendance/clock-out
// @desc    Driver clocks out at end of shift
// @access  Private [driver]
// ============================================================
exports.clockOut = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const record = await Attendance.findOne({ driver: req.user._id, date: today });
    if (!record || !record.clockIn) {
      return res.status(400).json({ success: false, message: 'No clock-in found for today.' });
    }
    if (record.clockOut) {
      return res.status(400).json({ success: false, message: 'Already clocked out.' });
    }

    record.clockOut = new Date();
    // durationMinutes is auto-computed in the pre-save hook
    await record.save();

    // Set driver status to offline
    await User.findByIdAndUpdate(req.user._id, { 'availability.status': 'offline' });

    return res.json({
      success        : true,
      message        : 'Clocked out.',
      durationMinutes: record.durationMinutes,
      record,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/attendance/shift-checklist
// @desc    Driver submits mandatory pre-shift vehicle checklist.
//          If passed, driver status unlocked to 'available'.
// @access  Private [driver]
// ============================================================
exports.submitShiftChecklist = async (req, res, next) => {
  try {
    const { oxygenLevelPct, kitComplete, vehicleOk, notes } = req.body;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Oxygen must be >= 80% to unlock available status
    const OXYGEN_THRESHOLD = 80;
    const passed = oxygenLevelPct >= OXYGEN_THRESHOLD && kitComplete && vehicleOk;

    const record = await Attendance.findOneAndUpdate(
      { driver: req.user._id, date: today },
      {
        'shiftChecklist.oxygenLevelPct': oxygenLevelPct,
        'shiftChecklist.kitComplete'   : kitComplete,
        'shiftChecklist.vehicleOk'     : vehicleOk,
        'shiftChecklist.notes'         : notes,
        'shiftChecklist.submittedAt'   : new Date(),
        'shiftChecklist.passed'        : passed,
      },
      { upsert: true, new: true }
    );

    if (passed) {
      // Unlock driver availability
      await User.findByIdAndUpdate(req.user._id, {
        'availability.status'   : 'available',
        'availability.updatedAt': new Date(),
      });
    }

    const message = passed
      ? '✅ Checklist passed. You are now Available.'
      : `❌ Checklist failed. ${oxygenLevelPct < OXYGEN_THRESHOLD ? `Oxygen level ${oxygenLevelPct}% is below ${OXYGEN_THRESHOLD}%.` : ''} ${!kitComplete ? 'Kit incomplete.' : ''} ${!vehicleOk ? 'Vehicle check failed.' : ''}`;

    return res.json({ success: true, passed, message, record });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/attendance/:driverId
// @desc    Get attendance records for a driver (default: current month)
// @access  Private [owner, driver (own only)]
// ============================================================
exports.getAttendance = async (req, res, next) => {
  try {
    const { driverId } = req.params;
    const { month, year } = req.query;

    // Driver guard
    if (req.user.role === 'driver' && req.user._id.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const now   = new Date();
    const m     = Number(month) || (now.getMonth() + 1);
    const y     = Number(year)  || now.getFullYear();
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m, 0, 23, 59, 59);

    const records = await Attendance.find({
      driver: driverId,
      date  : { $gte: start, $lte: end },
    }).sort({ date: 1 });

    const summary = {
      present  : records.filter(r => r.status === 'present').length,
      absent   : records.filter(r => r.status === 'absent').length,
      halfDay  : records.filter(r => r.status === 'half_day').length,
      leave    : records.filter(r => r.status === 'leave').length,
      checklistPassed: records.filter(r => r.shiftChecklist?.passed).length,
    };

    return res.json({ success: true, month: m, year: y, summary, records });
  } catch (err) {
    next(err);
  }
};
