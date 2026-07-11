/**
 * controllers/ambulanceController.js
 * ============================================================
 * Ambulance CRUD + per-ambulance document upload — Phase 1 of the
 * driver-auth redesign. Every operation is scoped to req.user._id
 * (the authenticated Owner). `assignedDriver` may reference an existing
 * `User` (driver) document by id — read-only reference, User untouched.
 * ============================================================
 */
'use strict';

const Ambulance = require('../models/Ambulance');
const Fleet     = require('../models/Fleet');
const { uploadToCloudinary } = require('../utils/cloudinary');

const DOC_TYPES = ['rc', 'insurance', 'fitness', 'permit', 'pollution'];

// ============================================================
// @route   POST /api/ambulances
// @access  Private [owner]
// ============================================================
exports.createAmbulance = async (req, res, next) => {
  try {
    const { fleetId, registrationNumber, deviceId, assignedDriverId } = req.body;

    if (!fleetId || !registrationNumber) {
      return res.status(400).json({ success: false, message: 'fleetId and registrationNumber are required.' });
    }

    const fleet = await Fleet.findOne({ _id: fleetId, owner: req.user._id });
    if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found for this owner.' });

    const ambulance = await Ambulance.create({
      owner : req.user._id,
      fleet : fleet._id,
      registrationNumber,
      deviceId,
      assignedDriver: assignedDriverId || undefined,
    });

    return res.status(201).json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/ambulances?fleetId=&status=
// @access  Private [owner]
// ============================================================
exports.getAmbulances = async (req, res, next) => {
  try {
    const { fleetId, status } = req.query;
    const filter = { owner: req.user._id, isActive: true };
    if (fleetId) filter.fleet = fleetId;
    if (status)  filter.status = status;

    const ambulances = await Ambulance.find(filter)
      .populate('fleet', 'name')
      .populate('assignedDriver', 'name phone')
      .sort({ createdAt: -1 });

    return res.json({ success: true, ambulances });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/ambulances/:id
// @access  Private [owner]
// ============================================================
exports.getAmbulanceById = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id })
      .populate('fleet', 'name')
      .populate('assignedDriver', 'name phone');
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });
    return res.json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/ambulances/:id
// @access  Private [owner]
// ============================================================
exports.updateAmbulance = async (req, res, next) => {
  try {
    const { registrationNumber, deviceId, assignedDriverId, status, fleetId } = req.body;

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    if (fleetId) {
      const fleet = await Fleet.findOne({ _id: fleetId, owner: req.user._id });
      if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found for this owner.' });
      ambulance.fleet = fleet._id;
    }
    if (registrationNumber)             ambulance.registrationNumber = registrationNumber;
    if (deviceId !== undefined)         ambulance.deviceId = deviceId;
    if (assignedDriverId !== undefined) ambulance.assignedDriver = assignedDriverId || null;
    if (status)                         ambulance.status = status;

    await ambulance.save();
    return res.json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   DELETE /api/ambulances/:id  (soft delete)
// @access  Private [owner]
// ============================================================
exports.deleteAmbulance = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { isActive: false },
      { new: true }
    );
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });
    return res.json({ success: true, message: 'Ambulance removed.' });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/ambulances/:id/document
// @desc    Upload/replace one compliance document (rc/insurance/
//          fitness/permit/pollution) and/or set its expiry date.
// @access  Private [owner]
// ============================================================
exports.updateDocument = async (req, res, next) => {
  try {
    const { docType, base64, expiryDate } = req.body;

    if (!DOC_TYPES.includes(docType)) {
      return res.status(400).json({
        success: false,
        message: `docType must be one of: ${DOC_TYPES.join(', ')}`,
      });
    }

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    let url = ambulance.documents?.[docType]?.url;
    if (base64) {
      const result = await uploadToCloudinary(base64, `owners/${req.user._id}/ambulances/${ambulance._id}`);
      url = result.secure_url;
    }

    ambulance.documents = ambulance.documents || {};
    ambulance.documents[docType] = {
      url,
      expiryDate: expiryDate ? new Date(expiryDate) : ambulance.documents[docType]?.expiryDate,
    };
    await ambulance.save();

    return res.json({ success: true, documents: ambulance.documents });
  } catch (err) {
    next(err);
  }
};
