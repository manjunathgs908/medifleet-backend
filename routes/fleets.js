'use strict';
const express   = require('express');
const router    = express.Router();
const fleetCtrl = require('../controllers/fleetController');
const { protectOwner, authorize } = require('../middleware/auth');

router.use(protectOwner, authorize('owner'));

router.post  ('/',     fleetCtrl.createFleet);
router.get   ('/',     fleetCtrl.getFleets);
router.get   ('/:id',  fleetCtrl.getFleetById);
router.put   ('/:id',  fleetCtrl.updateFleet);
router.delete('/:id',  fleetCtrl.deleteFleet);

module.exports = router;
