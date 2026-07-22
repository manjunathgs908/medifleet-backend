'use strict';
const express   = require('express');
const router    = express.Router();
const ownerCtrl = require('../controllers/ownerController');
const { protect, protectOwner, authorize } = require('../middleware/auth');

// Public — registration/login
router.post('/send-otp',   ownerCtrl.sendOtp);
router.post('/verify-otp', ownerCtrl.verifyOtp);

// Private [owner] — the fleet-Owner's own app session (protectOwner).
// Deliberately ungated on kycStatus: an owner must always be able to log
// in, check their own status/rejection reason, and upload/re-upload KYC
// documents regardless of approval state.
router.get ('/me',            protectOwner, authorize('owner'), ownerCtrl.getMe);
router.post('/kyc/upload',    protectOwner, authorize('owner'), ownerCtrl.uploadKycDocument);
router.post('/act-as-driver', protectOwner, authorize('owner'), ownerCtrl.actAsDriver);

// Private [CRM owner/admin] — the platform admin's CRM session (protect,
// the User-model 'owner' role), reviewing/approving fleet Owners' KYC.
// Distinct actor and middleware from every route above.
router.get ('/',             protect, authorize('owner'), ownerCtrl.listOwners);
router.put ('/:id/approve',  protect, authorize('owner'), ownerCtrl.approveOwner);
router.put ('/:id/reject',   protect, authorize('owner'), ownerCtrl.rejectOwner);

module.exports = router;
