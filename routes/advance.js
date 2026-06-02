'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/advanceController');
const { protect, authorize } = require('../middleware/auth');

router.post('/', protect, authorize('driver'), ctrl.requestAdvance);
router.get('/my', protect, authorize('driver'), ctrl.myAdvances);
router.get('/', protect, authorize('owner'), ctrl.getAllAdvances);
router.put('/:id/approve', protect, authorize('owner'), ctrl.approveAdvance);
router.put('/:id/reject', protect, authorize('owner'), ctrl.rejectAdvance);

module.exports = router;