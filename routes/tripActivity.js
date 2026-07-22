'use strict';
const express = require('express');
const router = express.Router();
const { logActivity, getActivities } = require('../controllers/tripActivityController');
const { protect, authorize } = require('../middleware/auth');

router.post('/log', protect, authorize('driver'), logActivity);
router.get('/', protect, authorize('owner'), getActivities);

module.exports = router;