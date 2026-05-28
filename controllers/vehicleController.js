/**
 * controllers/vehicleController.js
 * ============================================================
 * Fleet Management & Compliance
 *
 * Endpoints cover:
 *   - Vehicle CRUD
 *   - Driver assignment
 *   - Document upload + expiry tracking
 *   - Compliance status dashboard
 *   - Service logbook CRUD
 *   - GPS position update (from driver app)
 * ============================================================
 */

'use strict';

const { Vehicle, Loan, ServiceLog, Notification, Expense } = require('../models');
const cloudinary = require('../utils/cloudinary');

// ============================================================
// @route   POST /api/vehicles
// @desc    Add a new vehicle to the fleet
// @access  Private [owner]
// ============================================================
exports.createVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.create(req.body);
    return res.status(201).json({ success: true, vehicle });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/vehicles
// @desc    Get all active fleet vehicles
// @access  Private [owner, telecaller]
// ============================================================
exports.getVehicles = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { isActive: true };
    if (status) filter.status = status;

    const vehicles = await Vehicle.find(filter)
      .populate('assignedDriver', 'name phone availability licenseNumber')
      .populate('loanId', 'emiAmount paidInstallments tenureMonths status')
      .sort({ createdAt: -1 });

    // Enrich each vehicle with compliance health
    const enriched = vehicles.map(v => {
      const vObj      = v.toObject();
      vObj.expiring   = v.getExpiringDocuments(30);  // Expiring within 30 days
      vObj.overdue    = v.getExpiringDocuments(0).filter(d => d.daysLeft < 0); // Already expired
      return vObj;
    });

    return res.json({ success: true, count: enriched.length, vehicles: enriched });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/vehicles/:id
// @desc    Get single vehicle with full details
// @access  Private [owner, telecaller]
// ============================================================
exports.getVehicleById = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .populate('assignedDriver', 'name phone availability')
      .populate('loanId');

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    const serviceLogs = await ServiceLog.find({ vehicle: vehicle._id })
      .sort({ date: -1 })
      .limit(20);

    return res.json({
      success: true,
      vehicle: {
        ...vehicle.toObject(),
        expiring  : vehicle.getExpiringDocuments(30),
        serviceLogs,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/vehicles/:id
// @desc    Update vehicle details
// @access  Private [owner]
// ============================================================
exports.updateVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    return res.json({ success: true, vehicle });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/vehicles/:id/assign-driver
// @desc    Assign or reassign a driver to a vehicle
// @access  Private [owner]
// ============================================================
exports.assignDriver = async (req, res, next) => {
  try {
    const { driverId } = req.body;
    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      { assignedDriver: driverId },
      { new: true }
    ).populate('assignedDriver', 'name phone');

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
    return res.json({ success: true, vehicle });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/vehicles/:id/gps
// @desc    Update vehicle GPS coordinates (called from driver app every 30s)
// @access  Private [driver]
// ============================================================
exports.updateGps = async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    await Vehicle.findByIdAndUpdate(req.params.id, {
      'gps.lat'      : lat,
      'gps.lng'      : lng,
      'gps.updatedAt': new Date(),
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/vehicles/:id/document
// @desc    Upload / update a compliance document for a vehicle.
//          Body: { docType: 'insurance'|'fitnessCertificate'|'rtoPermit'|'pucCertificate',
//                  number, issueDate, expiryDate, fileUrl }
//          On upload, reset the alertSent flag so cron can re-notify.
// @access  Private [owner]
// ============================================================
exports.updateDocument = async (req, res, next) => {
  try {
    const { docType, number, issueDate, expiryDate, fileUrl } = req.body;
    const validTypes = ['insurance', 'fitnessCertificate', 'rtoPermit', 'pucCertificate'];

    if (!validTypes.includes(docType)) {
      return res.status(400).json({ success: false, message: `Invalid docType. Must be one of: ${validTypes.join(', ')}` });
    }

    const updatePath = `documents.${docType}`;
    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      {
        [`${updatePath}.number`]    : number,
        [`${updatePath}.issueDate`] : issueDate,
        [`${updatePath}.expiryDate`]: expiryDate,
        [`${updatePath}.fileUrl`]   : fileUrl,
        [`${updatePath}.alertSent`] : false,   // Reset so cron can re-alert on new expiry
        [`${updatePath}.alertSentAt`]: null,
      },
      { new: true }
    );

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    return res.json({
      success  : true,
      message  : `${docType} document updated successfully.`,
      document : vehicle.documents[docType],
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/vehicles/compliance-dashboard
// @desc    Overview of all compliance issues across the fleet.
//          Returns expired docs, expiring-soon docs per vehicle.
// @access  Private [owner]
// ============================================================
exports.complianceDashboard = async (req, res, next) => {
  try {
    const vehicles = await Vehicle.find({ isActive: true });
    const now = new Date();

    const report = {
      expired      : [],
      expiringSoon : [],  // <= 15 days
      expiring30   : [],  // 16-30 days
      healthy      : [],
    };

    const docTypes = ['insurance', 'fitnessCertificate', 'rtoPermit', 'pucCertificate'];
    const docLabels = {
      insurance           : 'Insurance',
      fitnessCertificate  : 'Fitness Certificate',
      rtoPermit           : 'RTO Permit',
      pucCertificate      : 'PUC Certificate',
    };

    vehicles.forEach(v => {
      let vehicleIssues = [];

      docTypes.forEach(type => {
        const doc = v.documents?.[type];
        if (!doc?.expiryDate) return;

        const daysLeft = Math.ceil((new Date(doc.expiryDate) - now) / 86400000);

        if (daysLeft < 0) {
          vehicleIssues.push({ type, label: docLabels[type], daysLeft, status: 'expired' });
          report.expired.push({ vehicle: v.registrationNumber, vehicleId: v._id, doc: docLabels[type], daysLeft, expiryDate: doc.expiryDate });
        } else if (daysLeft <= 15) {
          vehicleIssues.push({ type, label: docLabels[type], daysLeft, status: 'critical' });
          report.expiringSoon.push({ vehicle: v.registrationNumber, vehicleId: v._id, doc: docLabels[type], daysLeft, expiryDate: doc.expiryDate });
        } else if (daysLeft <= 30) {
          vehicleIssues.push({ type, label: docLabels[type], daysLeft, status: 'warning' });
          report.expiring30.push({ vehicle: v.registrationNumber, vehicleId: v._id, doc: docLabels[type], daysLeft, expiryDate: doc.expiryDate });
        }
      });

      if (!vehicleIssues.length) {
        report.healthy.push({ vehicle: v.registrationNumber, vehicleId: v._id });
      }
    });

    return res.json({
      success: true,
      summary: {
        expiredCount     : report.expired.length,
        criticalCount    : report.expiringSoon.length,
        warningCount     : report.expiring30.length,
        healthyVehicles  : report.healthy.length,
        totalVehicles    : vehicles.length,
      },
      report,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/vehicles/:id/service-log
// @desc    Add a service log entry (oil change, tyre, O2 refill…)
// @access  Private [owner]
// ============================================================
exports.addServiceLog = async (req, res, next) => {
  try {
    const logData = { ...req.body, vehicle: req.params.id, loggedBy: req.user._id };
    const log = await ServiceLog.create(logData);

    // Auto-create Expense entry for the service cost
    if (logData.cost) {
      await Expense.create({
        category   : logData.serviceType === 'oxygen_refill' ? 'oxygen_refill' : 'maintenance',
        amount     : logData.cost,
        description: `${logData.serviceType} — ${req.params.id}`,
        vehicle    : req.params.id,
        date       : logData.date || new Date(),
        receiptUrl : logData.receiptUrl,
        recordedBy : req.user._id,
      });
    }

    // Update vehicle odometer if provided
    if (logData.odometerReading) {
      await Vehicle.findByIdAndUpdate(req.params.id, { odometer: logData.odometerReading });
    }

    return res.status(201).json({ success: true, log });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/vehicles/:id/service-logs
// @desc    Get service history for a vehicle
// @access  Private [owner]
// ============================================================
exports.getServiceLogs = async (req, res, next) => {
  try {
    const { serviceType } = req.query;
    const filter = { vehicle: req.params.id };
    if (serviceType) filter.serviceType = serviceType;

    const logs = await ServiceLog.find(filter)
      .populate('loggedBy', 'name')
      .sort({ date: -1 });

    return res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    next(err);
  }
};
