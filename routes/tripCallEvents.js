'use strict';
const express = require('express');
const router = express.Router();
const { getEvents } = require('../controllers/tripCallEventController');
const { protect, authorize } = require('../middleware/auth');

router.get('/', protect, authorize('owner'), getEvents);

module.exports = router;
