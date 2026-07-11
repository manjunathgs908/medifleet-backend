/**
 * controllers/fleetController.js
 * ============================================================
 * Fleet CRUD — Phase 1 of the driver-auth redesign.
 * Every operation is scoped to req.user._id (the authenticated Owner) —
 * an owner can only see/manage their own fleets.
 * ============================================================
 */
'use strict';

const Fleet     = require('../models/Fleet');
const Ambulance = require('../models/Ambulance');

// ============================================================
// @route   POST /api/fleets
// @access  Private [owner]
// ============================================================
exports.createFleet = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Fleet name is required.' });

    const fleet = await Fleet.create({ owner: req.user._id, name });
    return res.status(201).json({ success: true, fleet });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/fleets
// @access  Private [owner]
// ============================================================
exports.getFleets = async (req, res, next) => {
  try {
    const fleets = await Fleet.find({ owner: req.user._id, isActive: true }).sort({ createdAt: -1 });
    return res.json({ success: true, fleets });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/fleets/:id
// @access  Private [owner]
// ============================================================
exports.getFleetById = async (req, res, next) => {
  try {
    const fleet = await Fleet.findOne({ _id: req.params.id, owner: req.user._id });
    if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found.' });

    const ambulances = await Ambulance.find({ fleet: fleet._id, isActive: true });
    return res.json({ success: true, fleet, ambulances });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/fleets/:id
// @access  Private [owner]
// ============================================================
exports.updateFleet = async (req, res, next) => {
  try {
    const { name } = req.body;
    const fleet = await Fleet.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { ...(name && { name }) },
      { new: true, runValidators: true }
    );
    if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found.' });
    return res.json({ success: true, fleet });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   DELETE /api/fleets/:id  (soft delete)
// @access  Private [owner]
// ============================================================
exports.deleteFleet = async (req, res, next) => {
  try {
    const fleet = await Fleet.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { isActive: false },
      { new: true }
    );
    if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found.' });
    return res.json({ success: true, message: 'Fleet removed.' });
  } catch (err) {
    next(err);
  }
};
