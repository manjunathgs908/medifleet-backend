'use strict';
const express = require('express');
const router = express.Router();
const billingCtrl = require('../controllers/billingController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

router.get('/dashboard', protect, authorize('owner'), billingCtrl.getFinancialDashboard);
router.get('/bills', protect, authorize('owner'), billingCtrl.getBills);
router.get('/bills/:id', protect, authorize('owner'), billingCtrl.getBillById);
router.put('/bills/:id/payment', protect, authorize('owner'), billingCtrl.legacyRecordPayment);
// Receipts: advances and payments (owner only, like the rest of billing).
router.post('/payments', protect, authorize('owner'), billingCtrl.recordPayment);
router.get('/payments/:id', protect, authorize('owner'), billingCtrl.getReceipt);
router.get('/advances', protect, authorize('owner'), billingCtrl.getAdvances);
router.get('/issuer', protect, authorize(...OPERATIONS), billingCtrl.getIssuer);
router.get('/provider-issues', protect, authorize('owner'), billingCtrl.getProviderIssues);
router.post('/hospital-invoice/generate', protect, authorize('owner'), billingCtrl.generateHospitalInvoice);
router.get('/hospital-invoices', protect, authorize('owner'), billingCtrl.getHospitalInvoices);
router.put('/hospital-invoices/:id/status', protect, authorize('owner'), billingCtrl.updateInvoiceStatus);

module.exports = router;
