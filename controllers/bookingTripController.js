'use strict';
const BookingTrip = require('../models/BookingTrip');

const STAGE_ORDER = [
  'START_TRIP', 'REACHED_HOSPITAL', 'PATIENT_PICKED_BOOKING',
  'START_PICKUP_TRIP', 'CLIENT_DROPPED', 'RETURN_STARTED', 'END_TRIP_CLOSE_DUTY'
];

// Create new booking trip
exports.createTrip = async (req, res) => {
  try {
    const trip = await BookingTrip.create({ driver: req.user._id, vehicle: req.body.vehicle || '' });
    return res.status(201).json({ success: true, trip });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Update stage
exports.updateStage = async (req, res) => {
  try {
    const { stage, latitude, longitude, notes, cancelReason } = req.body;
    const trip = await BookingTrip.findOne({ _id: req.params.id, driver: req.user._id });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.isCompleted) return res.status(400).json({ success: false, message: 'Trip already completed' });

    // Validate stage order (no skipping)
    if (stage !== 'CANCEL_REQUESTED') {
      const currentIdx = STAGE_ORDER.indexOf(trip.currentStage);
      const newIdx = STAGE_ORDER.indexOf(stage);
      if (newIdx !== currentIdx && newIdx !== currentIdx + 1) {
        return res.status(400).json({ success: false, message: 'Cannot skip stages' });
      }
    }

    // Save stage data
    trip.stages[stage] = {
      status: stage,
      completedAt: new Date(),
      completedBy: req.user.name,
      location: { latitude, longitude },
      notes: notes || '',
      cancelReason: cancelReason || '',
    };

    trip.currentStage = stage;
    if (stage === 'END_TRIP_CLOSE_DUTY') {
      trip.isCompleted = true;
      // Calculate total duty hours
      const start = trip.stages['START_TRIP']?.completedAt;
      const end = new Date();
      if (start) trip.totalDutyHours = Math.round((end - start) / 3600000 * 10) / 10;
    }
    if (stage === 'CANCEL_REQUESTED') trip.isCancelled = true;

    await trip.save();
    return res.json({ success: true, trip });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Admin approve cancel
exports.approveCancel = async (req, res) => {
  try {
    const trip = await BookingTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    trip.stages['CANCEL_APPROVED_BY_ADMIN'] = {
      status: 'CANCEL_APPROVED_BY_ADMIN',
      completedAt: new Date(),
      completedBy: req.user.name,
      notes: req.body.notes || '',
    };
    trip.currentStage = 'CANCEL_APPROVED_BY_ADMIN';
    trip.isCompleted = true;
    await trip.save();
    return res.json({ success: true, trip });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Admin reopen trip
exports.reopenTrip = async (req, res) => {
  try {
    const trip = await BookingTrip.findByIdAndUpdate(req.params.id,
      { isCompleted: false, isCancelled: false },
      { new: true }
    );
    return res.json({ success: true, trip });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Get my trips (driver)
exports.myTrips = async (req, res) => {
  try {
    const trips = await BookingTrip.find({ driver: req.user._id }).sort({ createdAt: -1 });
    return res.json({ success: true, trips });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Get all trips (admin)
exports.getAllTrips = async (req, res) => {
  try {
    const trips = await BookingTrip.find().populate('driver', 'name phone').sort({ createdAt: -1 });
    return res.json({ success: true, trips });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Get single trip
exports.getTrip = async (req, res) => {
  try {
    const trip = await BookingTrip.findById(req.params.id).populate('driver', 'name phone');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    return res.json({ success: true, trip });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};