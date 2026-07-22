'use strict';
const express       = require('express');
const router        = express.Router();
const ambulanceCtrl = require('../controllers/ambulanceController');
const { protectOwner, authorize, requireKycApproved } = require('../middleware/auth');

router.use(protectOwner, authorize('owner'), requireKycApproved);

router.post  ('/',             ambulanceCtrl.createAmbulance);
router.get   ('/',              ambulanceCtrl.getAmbulances);
router.get   ('/:id',           ambulanceCtrl.getAmbulanceById);
router.put   ('/:id',           ambulanceCtrl.updateAmbulance);
router.delete('/:id',           ambulanceCtrl.deleteAmbulance);
router.put   ('/:id/document',  ambulanceCtrl.updateDocument);
router.post  ('/:id/photos',    ambulanceCtrl.addPhoto);

module.exports = router;
