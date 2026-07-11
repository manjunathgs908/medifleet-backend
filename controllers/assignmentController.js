/**
 * controllers/assignmentController.js
 * ============================================================
 * Assignment + Shift management — Phase 3 of the driver-auth redesign.
 * Sits on top of the Phase 1 Ambulance model and the existing User
 * (driver) model; does not touch Trip/BookingTrip trip-lifecycle logic.
 *
 * Invariants enforced here:
 *   - At most one active Assignment per ambulance at a time.
 *   - At most one active Assignment per driver at a time
 *     (one driver = one active ambulance).
 * ============================================================
 */
'use strict';

const Assignment = require('../models/Assignment');
const Shift       = require('../models/Shift');
const Ambulance   = require('../models/Ambulance');

function toLocation(lat, lng) {
  return (lat != null && lng != null) ? { lat, lng } : undefined;
}

// ============================================================
// @route   POST /api/assignments/start-duty
// @desc    Bind a driver to an ambulance and open a Shift.
// @access  Private [driver]
// ============================================================
exports.startDuty = async (req, res, next) => {
  try {
    const driverId = req.user._id;
    const { ambulanceId, deviceId, lat, lng } = req.body;

    if (!ambulanceId) {
      return res.status(400).json({ success: false, message: 'ambulanceId is required.' });
    }

    const ambulance = await Ambulance.findById(ambulanceId);
    if (!ambulance) {
      return res.status(404).json({ success: false, message: 'Ambulance not found.' });
    }

    const ambulanceBusy = await Assignment.findOne({ ambulance: ambulanceId, active: true });
    if (ambulanceBusy) {
      return res.status(409).json({ success: false, message: 'Ambulance already assigned to another active driver.' });
    }

    const driverBusy = await Assignment.findOne({ driver: driverId, active: true });
    if (driverBusy) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active duty on a different ambulance. End your current duty first.',
      });
    }

    const location = toLocation(lat, lng);

    const assignment = await Assignment.create({
      driver   : driverId,
      ambulance: ambulanceId,
      active   : true,
      deviceId,
      startLocation: location,
    });

    const shift = await Shift.create({
      driver   : driverId,
      ambulance: ambulanceId,
      status   : 'active',
      deviceId,
      loginLocation: location,
    });

    ambulance.status         = 'assigned';
    ambulance.assignedDriver = driverId;
    await ambulance.save();

    return res.status(201).json({ success: true, message: 'Duty started.', assignment, shift });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/assignments/break
// @desc    Put the driver's active shift on break.
// @access  Private [driver]
// ============================================================
exports.breakDuty = async (req, res, next) => {
  try {
    const driverId = req.user._id;

    const shift = await Shift.findOne({ driver: driverId, status: 'active' });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'No active shift found.' });
    }

    shift.status = 'break';
    shift.breaks.push({ startedAt: new Date() });
    await shift.save();

    return res.json({ success: true, message: 'Break started.', shift });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/assignments/resume
// @desc    Resume duty from a break.
// @access  Private [driver]
// ============================================================
exports.resumeDuty = async (req, res, next) => {
  try {
    const driverId = req.user._id;

    const shift = await Shift.findOne({ driver: driverId, status: 'break' });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'No shift on break found.' });
    }

    const openBreak = [...shift.breaks].reverse().find(b => !b.endedAt);
    if (openBreak) openBreak.endedAt = new Date();
    shift.status = 'active';
    await shift.save();

    return res.json({ success: true, message: 'Duty resumed.', shift });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/assignments/end-duty
// @desc    Close the shift (computing totalWorkingMinutes), close the
//          Assignment, and release the Ambulance back to 'available'.
// @access  Private [driver]
// ============================================================
exports.endDuty = async (req, res, next) => {
  try {
    const driverId = req.user._id;
    const { lat, lng } = req.body;
    const location = toLocation(lat, lng);

    const shift = await Shift.findOne({ driver: driverId, status: { $in: ['active', 'break'] } });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'No active shift found.' });
    }

    const assignment = await Assignment.findOne({ driver: driverId, active: true });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'No active assignment found.' });
    }

    const now = new Date();

    // Close any still-open break before computing totals.
    const openBreak = shift.breaks.find(b => !b.endedAt);
    if (openBreak) openBreak.endedAt = now;

    const totalBreakMs = shift.breaks.reduce((sum, b) => {
      const end = b.endedAt || now;
      return sum + Math.max(0, end - b.startedAt);
    }, 0);

    const totalShiftMs = now - shift.shiftStart;
    const workingMs     = Math.max(0, totalShiftMs - totalBreakMs);

    shift.status              = 'ended';
    shift.shiftEnd            = now;
    // Kept as fractional minutes (2dp) rather than rounded whole minutes —
    // a whole-minute round-down would read as 0 for any shift under 30s.
    shift.totalWorkingMinutes = Math.round((workingMs / 60000) * 100) / 100;
    shift.logoutLocation      = location;
    await shift.save();

    assignment.active      = false;
    assignment.endTime     = now;
    assignment.endLocation = location;
    await assignment.save();

    const ambulance = await Ambulance.findById(assignment.ambulance);
    if (ambulance) {
      ambulance.status         = 'available';
      ambulance.assignedDriver = null;
      await ambulance.save();
    }

    return res.json({ success: true, message: 'Duty ended.', shift, assignment });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/assignments/my-active
// @desc    The driver's current active/break shift + assignment +
//          ambulance, or nulls if off duty.
// @access  Private [driver]
// ============================================================
exports.getMyActiveShift = async (req, res, next) => {
  try {
    const driverId = req.user._id;

    const shift = await Shift.findOne({ driver: driverId, status: { $in: ['active', 'break'] } })
      .sort({ createdAt: -1 });
    if (!shift) {
      return res.json({ success: true, shift: null, assignment: null, ambulance: null });
    }

    const assignment = await Assignment.findOne({ driver: driverId, active: true });
    const ambulance  = assignment ? await Ambulance.findById(assignment.ambulance) : null;

    return res.json({ success: true, shift, assignment, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/assignments/my-history?page=&limit=
// @desc    Paginated list of the driver's past assignments.
// @access  Private [driver]
// ============================================================
exports.getAssignmentHistory = async (req, res, next) => {
  try {
    const driverId = req.user._id;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [assignments, total] = await Promise.all([
      Assignment.find({ driver: driverId })
        .populate('ambulance', 'registrationNumber')
        .sort({ startTime: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Assignment.countDocuments({ driver: driverId }),
    ]);

    return res.json({
      success: true,
      assignments,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/assignments/fleet-status
// @desc    Every one of the owner's ambulances with its current
//          assignment/shift status — for a live fleet dashboard.
// @access  Private [owner]
// ============================================================
exports.getFleetShiftStatus = async (req, res, next) => {
  try {
    const ownerId = req.user._id;

    const ambulances = await Ambulance.find({ owner: ownerId, isActive: true })
      .populate('fleet', 'name')
      .populate('assignedDriver', 'name phone employeeId');

    const fleet = await Promise.all(ambulances.map(async (amb) => {
      const assignment = amb.status === 'assigned'
        ? await Assignment.findOne({ ambulance: amb._id, active: true })
        : null;
      const shift = assignment
        ? await Shift.findOne({ driver: assignment.driver, status: { $in: ['active', 'break'] } })
        : null;

      return {
        ambulance: {
          id                : amb._id,
          registrationNumber: amb.registrationNumber,
          status            : amb.status,
          fleet             : amb.fleet,
          assignedDriver    : amb.assignedDriver,
        },
        assignment,
        shift,
      };
    }));

    return res.json({ success: true, fleet });
  } catch (err) {
    next(err);
  }
};
