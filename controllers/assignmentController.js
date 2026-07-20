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
const { Trip }    = require('../models');

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

    // Login-time approval check can go stale (owner rejects mid-session,
    // JWT stays valid up to 7 days) — re-check here since going on duty is
    // the actual privileged action, not just holding a valid token.
    if (req.user.approvalStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'Your account is not approved yet. Contact your Owner/Admin.' });
    }

    if (!ambulanceId) {
      return res.status(400).json({ success: false, message: 'ambulanceId is required.' });
    }

    // Fast pre-check for a clear, specific error on the common case — NOT
    // the actual concurrency guarantee (see below). A findOne-then-create
    // here would race: two concurrent start-duty calls could both pass
    // this check before either write lands.
    const driverBusy = await Assignment.findOne({ driver: driverId, active: true });
    if (driverBusy) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active duty on a different ambulance. End your current duty first.',
      });
    }

    // Atomic claim — the {status:'available'} filter means only ONE of
    // two concurrent requests for the same ambulance can ever get a
    // non-null result back; the loser sees this as a normal "unavailable"
    // outcome, not a race it has to detect itself.
    const ambulance = await Ambulance.findOneAndUpdate(
      { _id: ambulanceId, status: 'available' },
      { status: 'assigned', assignedDriver: driverId },
      { new: true }
    );
    if (!ambulance) {
      const exists = await Ambulance.exists({ _id: ambulanceId });
      return res.status(409).json({
        success: false,
        message: exists
          ? 'This ambulance was just taken by another driver. Please pick a different one.'
          : 'Ambulance not found.',
      });
    }

    const location = toLocation(lat, lng);

    let assignment, shift;
    try {
      // Backstop for the driver-busy pre-check's own race (e.g. the same
      // driver double-tapping "start duty" from two ambulances at once) —
      // Assignment's partial unique index on {driver, active:true} rejects
      // a second one; caught below and rolled back.
      assignment = await Assignment.create({
        driver   : driverId,
        ambulance: ambulanceId,
        active   : true,
        deviceId,
        startLocation: location,
      });

      shift = await Shift.create({
        driver   : driverId,
        ambulance: ambulanceId,
        status   : 'active',
        deviceId,
        loginLocation: location,
      });
    } catch (err) {
      // Don't leave the ambulance stuck 'assigned' with nobody actually on duty.
      await Ambulance.updateOne({ _id: ambulanceId }, { status: 'available', assignedDriver: null });
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'You already have an active duty, or this ambulance was just taken. Please refresh and try again.',
        });
      }
      throw err;
    }

    return res.status(201).json({ success: true, message: 'Duty started.', assignment, shift, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/assignments/available-ambulances
// @desc    Ambulances a driver can pick at start-duty — scoped to the
//          driver's owner if linked (see User.owner), else platform-wide
//          (today's pre-Phase-4 single-tenant reality: drivers created
//          before this field existed).
// @access  Private [driver]
// ============================================================
exports.getAvailableAmbulances = async (req, res, next) => {
  try {
    const filter = { status: 'available', isActive: true };
    if (req.user.owner) filter.owner = req.user.owner;

    const ambulances = await Ambulance.find(filter)
      .select('registrationNumber serviceType serviceTypeLabel vehicleModel status year')
      .sort({ registrationNumber: 1 });

    return res.json({ success: true, ambulances });
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
      .populate('assignedDriver', 'name phone employeeId availability');

    const fleet = await Promise.all(ambulances.map(async (amb) => {
      const assignment = amb.status === 'assigned'
        ? await Assignment.findOne({ ambulance: amb._id, active: true })
        : null;
      const shift = assignment
        ? await Shift.findOne({ driver: assignment.driver, status: { $in: ['active', 'break'] } })
        : null;

      // Owner-facing display status — a single available/on_trip/off/
      // maintenance value derived from Ambulance.status (is anyone on
      // duty at all) combined with that driver's own live
      // availability.status (idle vs mid-trip), the field Phase 6A made
      // trustworthy. 'off' means the ambulance itself is unclaimed right
      // now, not necessarily broken.
      let displayStatus = 'off';
      if (amb.status === 'maintenance') {
        displayStatus = 'maintenance';
      } else if (amb.status === 'assigned') {
        displayStatus = amb.assignedDriver?.availability?.status === 'on_trip' ? 'on_trip' : 'available';
      }

      // Phase 6B bridge — only meaningful while the ambulance is actually
      // claimed; an unclaimed ambulance can't have a live trip on it.
      let activeTrip = null;
      if (amb.status === 'assigned') {
        const trip = await Trip.findOne({ ambulance: amb._id, status: { $in: ['dispatched', 'en_route'] } })
          .populate('dropHospital', 'name address');
        if (trip) {
          activeTrip = {
            id           : trip._id,
            tripNumber   : trip.tripNumber,
            status       : trip.status,
            patientName  : trip.patientName,
            patientPhone : trip.patientPhone,
            pickup       : trip.pickup,
            dropHospital : trip.dropHospital,
            dropAddress  : trip.dropAddress,
            emergencyType: trip.emergencyType,
            distanceKm   : trip.distanceKm,
            createdAt    : trip.createdAt,
          };
        }
      }

      return {
        ambulance: {
          id                : amb._id,
          registrationNumber: amb.registrationNumber,
          serviceType       : amb.serviceType,
          serviceTypeLabel  : amb.serviceTypeLabel,
          status            : amb.status,
          displayStatus,
          fleet             : amb.fleet,
          assignedDriver    : amb.assignedDriver ? {
            id      : amb.assignedDriver._id,
            name    : amb.assignedDriver.name,
            phone   : amb.assignedDriver.phone,
            location: amb.assignedDriver.availability?.lat != null ? {
              lat      : amb.assignedDriver.availability.lat,
              lng      : amb.assignedDriver.availability.lng,
              updatedAt: amb.assignedDriver.availability.updatedAt,
            } : null,
          } : null,
        },
        assignment,
        shift,
        activeTrip,
      };
    }));

    return res.json({ success: true, fleet });
  } catch (err) {
    next(err);
  }
};
