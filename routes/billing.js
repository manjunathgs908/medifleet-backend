'use strict';
const express = require('express');
const router = express.Router();
const billingCtrl = require('../controllers/billingController');
const { protect, authorize } = require('../middleware/auth');

router.get('/dashboard', protect, authorize('owner'), billingCtrl.getFinancialDashboard);
router.get('/bills', protect, authorize('owner','telecaller'), billingCtrl.getBills);
router.get('/bills/:id', protect, authorize('owner','telecaller'), billingCtrl.getBillById);
router.put('/bills/:id/payment', protect, authorize('owner','telecaller'), billingCtrl.recordPayment);
router.post('/hospital-invoice/generate', protect, authorize('owner'), billingCtrl.generateHospitalInvoice);
router.get('/hospital-invoices', protect, authorize('owner'), billingCtrl.getHospitalInvoices);
router.put('/hospital-invoices/:id/status', protect, authorize('owner'), billingCtrl.updateInvoiceStatus);

module.exports = router;