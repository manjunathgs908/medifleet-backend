'use strict';
const express       = require('express');
const router        = express.Router();
const ambulanceCtrl = require('../controllers/ambulanceController');
const { protectOwner, authorize } = require('../middleware/auth');

router.use(protectOwner, authorize('owner'));

router.post  ('/',             ambulanceCtrl.createAmbulance);
router.get   ('/',              ambulanceCtrl.getAmbulances);
router.get   ('/:id',           ambulanceCtrl.getAmbulanceById);
router.put   ('/:id',           ambulanceCtrl.updateAmbulance);
router.delete('/:id',           ambulanceCtrl.deleteAmbulance);
router.put   ('/:id/document',  ambulanceCtrl.updateDocument);

module.exports = router;
