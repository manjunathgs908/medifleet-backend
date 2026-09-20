'use strict';
const express       = require('express');
const router        = express.Router();
const ambulanceCtrl = require('../controllers/ambulanceController');
const { protect, protectOwner, authorize, requireKycApproved } = require('../middleware/auth');

// Private [CRM owner/admin] — the platform admin's CRM session
// (protect, the User-model 'owner' role), NOT the fleet-Owner's own
// app session below. Registered before the router.use() block so it
// never touches protectOwner/requireKycApproved. Mirrors routes/
// owners.js's public+protectOwner+separate-protect-admin-block shape.
router.get('/admin', protect, authorize('owner'), ambulanceCtrl.listAmbulancesAdmin);

router.use(protectOwner, authorize('owner'), requireKycApproved);

router.post  ('/',             ambulanceCtrl.createAmbulance);
router.get   ('/',              ambulanceCtrl.getAmbulances);
router.get   ('/:id',           ambulanceCtrl.getAmbulanceById);
router.put   ('/:id',           ambulanceCtrl.updateAmbulance);
router.delete('/:id',           ambulanceCtrl.deleteAmbulance);
router.put   ('/:id/document',  ambulanceCtrl.updateDocument);
router.post  ('/:id/photos',    ambulanceCtrl.addPhoto);

// The owner's roster decision — who usually drives this ambulance, and how
// hard that is enforced at start-duty. Distinct from assignedDriver, which
// the duty system owns and PUT /:id refuses to touch.
router.put   ('/:id/default-driver', ambulanceCtrl.setDefaultDriver);
router.delete('/:id/default-driver', ambulanceCtrl.clearDefaultDriver);

module.exports = router;
