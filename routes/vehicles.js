'use strict';
const express = require('express');
const router = express.Router();
const vehicleCtrl = require('../controllers/vehicleController');
const { protect, authorize } = require('../middleware/auth');

router.post('/', protect, authorize('owner'), vehicleCtrl.createVehicle);
router.get('/', protect, authorize('owner','telecaller'), vehicleCtrl.getVehicles);
router.get('/compliance-dashboard', protect, authorize('owner'), vehicleCtrl.complianceDashboard);
router.get('/:id', protect, authorize('owner','telecaller'), vehicleCtrl.getVehicleById);
router.put('/:id', protect, authorize('owner'), vehicleCtrl.updateVehicle);
router.put('/:id/assign-driver', protect, authorize('owner'), vehicleCtrl.assignDriver);
router.put('/:id/gps', protect, vehicleCtrl.updateGps);
router.put('/:id/document', protect, authorize('owner'), vehicleCtrl.updateDocument);
router.post('/:id/service-log', protect, authorize('owner'), vehicleCtrl.addServiceLog);
router.get('/:id/service-logs', protect, authorize('owner'), vehicleCtrl.getServiceLogs);

module.exports = router;