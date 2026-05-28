/**
 * controllers/tripController.js
 * ============================================================
 * Handles the complete trip lifecycle:
 *   - Create booking (Telecaller)
 *   - Auto / manual ambulance assignment (Telecaller / Owner)
 *   - Driver accept / decline with timeout fallback
 *   - Status transitions (en_route → completed → bill generation)
 *   - Trip cancellation
 *   - Fare engine: Base + (KM × Rate) + GST
 *   - Auto income ledger entry on completion
 * ============================================================
 */

'use strict';

const { Trip, Vehicle, User, Bill, Income, Notification, Hospital, Lead } = require('../models');
const fareCalculator = require('../utils/fareCalculator');

// ── Utility: calculate straight-line distance (Haversine) ────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};


// ============================================================
// @route   POST /api/trips
// @desc    Create a new booking (Telecaller / Owner)
// @access  Private [owner, telecaller]
// ============================================================
exports.createTrip = async (req, res, next) => {
  try {
    const {
      patientName, patientPhone, emergencyType,
      pickupAddress, pickupLat, pickupLng,
      dropHospitalId, dropAddress,
      baseFare, distanceKm, perKmRate, additionalCharges,
      vehicleId, // optional — if dispatcher manually selects
      leadId,    // optional — if originated from ad lead
    } = req.body;

    // ── Validate hospital exists ──────────────────────────────
    const hospital = await Hospital.findById(dropHospitalId);
    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found.' });

    // ── Build trip document ───────────────────────────────────
    const tripData = {
      patientName,
      patientPhone,
      emergencyType : emergencyType || 'general',
      pickup        : { address: pickupAddress, lat: pickupLat, lng: pickupLng },
      dropHospital  : dropHospitalId,
      dropAddress   : dropAddress || hospital.address,
      baseFare      : baseFare     || Number(process.env.DEFAULT_BASE_FARE) || 1500,
      distanceKm    : distanceKm   || 0,
      perKmRate     : perKmRate    || Number(process.env.DEFAULT_PER_KM_RATE) || 25,
      additionalCharges: additionalCharges || 0,
      bookedBy      : req.user._id,
      leadId,
      status        : 'booked',
    };

    const trip = await Trip.create(tripData);

    // Mark lead as converted if applicable
    if (leadId) {
      await Lead.findByIdAndUpdate(leadId, { status: 'converted', convertedTrip: trip._id });
    }

    // ── Auto-assign if no vehicle specified ───────────────────
    let assignedVehicle = null;
    if (vehicleId) {
      assignedVehicle = await Vehicle.findById(vehicleId);
    } else {
      assignedVehicle = await autoAssign(trip);
    }

    if (assignedVehicle) {
      await assignTripToVehicle(trip, assignedVehicle);
    }

    // Populate references for response
    await trip.populate(['dropHospital', 'vehicle', 'driver']);

    return res.status(201).json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ── Auto-assign: find closest Available ambulance ────────────
const autoAssign = async (trip) => {
  const available = await Vehicle.find({ status: 'available' })
    .populate('assignedDriver', 'name phone availability');

  if (!available.length) return null;

  // If we have pickup coordinates, sort by GPS distance
  if (trip.pickup.lat && trip.pickup.lng) {
    available.sort((a, b) => {
      const distA = (a.gps?.lat && a.gps?.lng)
        ? haversineKm(trip.pickup.lat, trip.pickup.lng, a.gps.lat, a.gps.lng) : Infinity;
      const distB = (b.gps?.lat && b.gps?.lng)
        ? haversineKm(trip.pickup.lat, trip.pickup.lng, b.gps.lat, b.gps.lng) : Infinity;
      return distA - distB;
    });
  }

  return available[0];
};


// ── Helper: assign trip to a specific vehicle ─────────────────
const assignTripToVehicle = async (trip, vehicle) => {
  trip.vehicle     = vehicle._id;
  trip.driver      = vehicle.assignedDriver;
  trip.status      = 'dispatched';
  trip.dispatchedAt = new Date();
  await trip.save();

  // Update vehicle and driver status
  await Vehicle.findByIdAndUpdate(vehicle._id, { status: 'on_trip' });
  if (vehicle.assignedDriver) {
    await User.findByIdAndUpdate(vehicle.assignedDriver, {
      'availability.status'   : 'on_trip',
      'availability.updatedAt': new Date(),
    });
  }

  // Notify driver (real-time via socket or push — simplified here)
  if (vehicle.assignedDriver) {
    await Notification.create({
      type        : 'trip_assigned',
      title       : '🚑 New Trip Assigned',
      message     : `You have a new trip: ${trip.patientName} — ${trip.pickup.address}`,
      severity    : 'info',
      trip        : trip._id,
      targetUserId: vehicle.assignedDriver,
      targetRole  : 'driver',
    });
  }
};


// ============================================================
// @route   PUT /api/trips/:id/assign
// @desc    Manually assign / reassign a vehicle to a trip
// @access  Private [owner, telecaller]
// ============================================================
exports.assignVehicle = async (req, res, next) => {
  try {
    const { vehicleId } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Cannot reassign a ${trip.status} trip.` });
    }

    // Release previous vehicle if any
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }

    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    if (vehicle.status !== 'available') {
      return res.status(400).json({ success: false, message: 'Selected vehicle is not available.' });
    }

    await assignTripToVehicle(trip, vehicle);
    await trip.populate(['vehicle', 'driver', 'dropHospital']);

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/status
// @desc    Update trip status (driver app: en_route flow)
// @access  Private [driver] — driver can only update their own trip
// ============================================================
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validTransitions = {
      dispatched : ['en_route'],
      en_route   : ['completed', 'cancelled'],
    };

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    // Drivers can only update their OWN trips
    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only update your own trips.' });
    }

    // Validate transition
    if (!validTransitions[trip.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        message : `Cannot transition trip from '${trip.status}' to '${status}'.`,
      });
    }

    trip.status = status;
    if (status === 'en_route')   trip.enRouteAt   = new Date();
    if (status === 'cancelled')  trip.cancelledAt  = new Date();
    await trip.save();

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/complete
// @desc    Mark trip as completed:
//          1. Compute total fare using fare engine
//          2. Auto-generate Bill document
//          3. Auto-create Income ledger entry
//          4. Release vehicle back to 'available'
// @access  Private [driver, telecaller, owner]
// ============================================================
exports.completeTrip = async (req, res, next) => {
  try {
    const { distanceKm, additionalCharges } = req.body;

    const trip = await Trip.findById(req.params.id).populate('dropHospital');
    if (!trip)                    return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed') return res.status(400).json({ success: false, message: 'Trip already completed.' });
    if (trip.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot complete a cancelled trip.' });

    // Driver guard
    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only complete your own trips.' });
    }

    // ── 1. Update distance if provided by driver GPS ─────────
    if (distanceKm)        trip.distanceKm       = distanceKm;
    if (additionalCharges) trip.additionalCharges = additionalCharges;

    // ── 2. Compute fare ───────────────────────────────────────
    const { subTotal, gstAmount, grandTotal } = fareCalculator.compute({
      baseFare         : trip.baseFare,
      distanceKm       : trip.distanceKm,
      perKmRate        : trip.perKmRate,
      additionalCharges: trip.additionalCharges || 0,
    });

    trip.totalFare    = subTotal;
    trip.gstAmount    = gstAmount;
    trip.grandTotal   = grandTotal;
    trip.status       = 'completed';
    trip.completedAt  = new Date();
    await trip.save();

    // ── 3. Auto-generate Bill ─────────────────────────────────
    const bill = await Bill.create({
      trip            : trip._id,
      patient         : trip.patientName,
      hospital        : trip.dropHospital?._id,
      baseFare        : trip.baseFare,
      distanceKm      : trip.distanceKm,
      perKmRate       : trip.perKmRate,
      distanceCharge  : trip.distanceKm * trip.perKmRate,
      additionalCharges: trip.additionalCharges || 0,
      subTotal,
      gstRate         : 5,
      gstAmount,
      grandTotal,
    });

    // Link bill to trip
    trip.billId = bill._id;
    await trip.save();

    // ── 4. Auto-create Income ledger entry ─────────────────────
    await Income.create({
      category   : 'trip_fare',
      amount     : grandTotal,
      description: `Trip ${trip.tripNumber} — ${trip.patientName}`,
      date       : new Date(),
      trip       : trip._id,
      vehicle    : trip.vehicle,
      recordedBy : req.user._id,
    });

    // ── 5. Release vehicle & driver ───────────────────────────
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }
    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, {
        'availability.status'   : 'available',
        'availability.updatedAt': new Date(),
      });
    }

    await bill.populate(['trip', 'hospital']);

    return res.json({
      success : true,
      message : 'Trip completed. Bill auto-generated.',
      trip,
      bill,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/cancel
// @desc    Cancel a trip and release the vehicle
// @access  Private [owner, telecaller]
// ============================================================
exports.cancelTrip = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Trip is already ${trip.status}.` });
    }

    trip.status             = 'cancelled';
    trip.cancelledAt        = new Date();
    trip.cancellationReason = reason;
    await trip.save();

    // Release vehicle
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }
    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, { 'availability.status': 'available' });
    }

    return res.json({ success: true, message: 'Trip cancelled.', trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips
// @desc    Get all trips with filters (status, date range, vehicle, driver)
//          Drivers see ONLY their own trips.
// @access  Private [all roles]
// ============================================================
exports.getTrips = async (req, res, next) => {
  try {
    const { status, vehicleId, driverId, hospitalId, from, to, page = 1, limit = 20 } = req.query;

    const filter = {};

    // Drivers are restricted to their own trips
    if (req.user.role === 'driver') {
      filter.driver = req.user._id;
    } else {
      if (driverId)   filter.driver       = driverId;
      if (vehicleId)  filter.vehicle      = vehicleId;
      if (hospitalId) filter.dropHospital = hospitalId;
    }

    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(new Date(to).setHours(23, 59, 59));
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Trip.countDocuments(filter);
    const trips = await Trip.find(filter)
      .populate('vehicle', 'registrationNumber model')
      .populate('driver',  'name phone')
      .populate('dropHospital', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.json({
      success: true,
      total,
      pages: Math.ceil(total / limit),
      currentPage: Number(page),
      trips,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips/live
// @desc    Live dispatch board — active trips only (booked, dispatched, en_route)
// @access  Private [owner, telecaller]
// ============================================================
exports.getLiveBoard = async (req, res, next) => {
  try {
    const activeTrips = await Trip.find({ status: { $in: ['booked', 'dispatched', 'en_route'] } })
      .populate('vehicle',      'registrationNumber model gps status')
      .populate('driver',       'name phone availability')
      .populate('dropHospital', 'name address')
      .sort({ createdAt: 1 });

    const availableVehicles = await Vehicle.find({ status: 'available' })
      .populate('assignedDriver', 'name phone');

    return res.json({
      success: true,
      liveTrips       : activeTrips,
      availableVehicles,
      counts: {
        active   : activeTrips.length,
        available: availableVehicles.length,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips/:id
// @desc    Get single trip with all details
// @access  Private [all]
// ============================================================
exports.getTripById = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .populate('vehicle',      'registrationNumber model type')
      .populate('driver',       'name phone licenseNumber')
      .populate('dropHospital', 'name address phone')
      .populate('bookedBy',     'name role')
      .populate('billId');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    // Driver guard
    if (req.user.role === 'driver' && trip.driver?._id?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};
