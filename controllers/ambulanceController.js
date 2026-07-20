/**
 * controllers/ambulanceController.js
 * ============================================================
 * Ambulance CRUD + per-ambulance document/photo upload — Phase 1 of
 * the driver-auth redesign, extended in Phase 2 (Add Ambulance) with
 * serviceType/year/photos. Every operation is scoped to req.user._id
 * (the authenticated Owner). `assignedDriver` may reference an existing
 * `User` (driver) document by id — read-only reference, User untouched.
 * ============================================================
 */
'use strict';

const Ambulance = require('../models/Ambulance');
const Fleet     = require('../models/Fleet');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { byServiceType } = require('../utils/ambulanceServiceTypes');

const DOC_TYPES = ['rc', 'insurance', 'fitness', 'permit', 'pollution'];

// No Fleet-management UI exists yet (deliberately out of scope — Fleet
// stays an invisible implementation detail for now). If the owner didn't
// pass a fleetId, reuse their one auto-provisioned default Fleet, or
// create it on first use.
async function resolveFleet(ownerId, fleetId) {
  if (fleetId) {
    const fleet = await Fleet.findOne({ _id: fleetId, owner: ownerId });
    return fleet || null;
  }
  let fleet = await Fleet.findOne({ owner: ownerId, isActive: true }).sort({ createdAt: 1 });
  if (!fleet) {
    fleet = await Fleet.create({ owner: ownerId, name: 'My Fleet' });
  }
  return fleet;
}

// ============================================================
// @route   POST /api/ambulances
// @access  Private [owner]
// ============================================================
exports.createAmbulance = async (req, res, next) => {
  try {
    const { fleetId, registrationNumber, serviceType, year, deviceId, assignedDriverId } = req.body;

    if (!registrationNumber || !serviceType) {
      return res.status(400).json({ success: false, message: 'registrationNumber and serviceType are required.' });
    }

    const typeInfo = byServiceType[serviceType];
    if (!typeInfo) {
      return res.status(400).json({
        success: false,
        message: `serviceType must be one of: ${Object.keys(byServiceType).join(', ')}`,
      });
    }

    const fleet = await resolveFleet(req.user._id, fleetId);
    if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found for this owner.' });

    const ambulance = await Ambulance.create({
      owner : req.user._id,
      fleet : fleet._id,
      registrationNumber,
      serviceType,
      serviceTypeLabel: typeInfo.label,
      vehicleModel    : typeInfo.vehicleModel,
      year: year || undefined,
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
    const { registrationNumber, serviceType, year, deviceId, assignedDriverId, status, fleetId } = req.body;

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    if (fleetId) {
      const fleet = await Fleet.findOne({ _id: fleetId, owner: req.user._id });
      if (!fleet) return res.status(404).json({ success: false, message: 'Fleet not found for this owner.' });
      ambulance.fleet = fleet._id;
    }
    if (registrationNumber)             ambulance.registrationNumber = registrationNumber;
    if (serviceType) {
      const typeInfo = byServiceType[serviceType];
      if (!typeInfo) {
        return res.status(400).json({
          success: false,
          message: `serviceType must be one of: ${Object.keys(byServiceType).join(', ')}`,
        });
      }
      ambulance.serviceType      = serviceType;
      ambulance.serviceTypeLabel = typeInfo.label;
      ambulance.vehicleModel     = typeInfo.vehicleModel;
    }
    if (year !== undefined)             ambulance.year = year;
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
//          fitness/permit/pollution — PUC) and/or set its number/expiry.
// @access  Private [owner]
// ============================================================
exports.updateDocument = async (req, res, next) => {
  try {
    const { docType, base64, number, expiryDate } = req.body;

    if (!DOC_TYPES.includes(docType)) {
      return res.status(400).json({
        success: false,
        message: `docType must be one of: ${DOC_TYPES.join(', ')}`,
      });
    }

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    const existing = ambulance.documents?.[docType] || {};
    let { url, publicId } = existing;
    if (base64) {
      const result = await uploadToCloudinary(base64, `owners/${req.user._id}/ambulances/${ambulance._id}/documents`);
      url      = result.secure_url;
      publicId = result.public_id;
    }

    ambulance.documents = ambulance.documents || {};
    ambulance.documents[docType] = {
      url,
      publicId,
      number    : number !== undefined ? number : existing.number,
      expiryDate: expiryDate ? new Date(expiryDate) : existing.expiryDate,
    };
    await ambulance.save();

    return res.json({ success: true, documents: ambulance.documents });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/ambulances/:id/photos
// @desc    Add one ambulance photo (base64) — called once per photo,
//          same one-upload-per-call pattern as updateDocument above.
// @access  Private [owner]
// ============================================================
exports.addPhoto = async (req, res, next) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ success: false, message: 'base64 is required.' });

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    const result = await uploadToCloudinary(base64, `owners/${req.user._id}/ambulances/${ambulance._id}/photos`);
    ambulance.photos.push({ url: result.secure_url, publicId: result.public_id });
    await ambulance.save();

    return res.json({ success: true, photos: ambulance.photos });
  } catch (err) {
    next(err);
  }
};
