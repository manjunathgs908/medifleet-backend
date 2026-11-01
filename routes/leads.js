const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/leadController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

// The CRM Leads Dashboard and its follow-up workflow — see
// controllers/leadController.js. Owner and telecallers.
router.use(protect, authorize(...OPERATIONS));

router.get  ('/summary',        ctrl.summary);
router.get  ('/assignees',      ctrl.assignees);
router.patch('/:id/assign',     ctrl.assign);
router.patch('/:id/follow-up',  ctrl.followUp);
router.patch('/:id/status',     ctrl.setStatus);
router.post ('/:id/notes',      ctrl.addNote);
router.put  ('/:id',            ctrl.legacyUpdate);
router.get  ('/',               ctrl.list);

module.exports = router;
