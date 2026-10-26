'use strict';
const express = require('express');
const router = express.Router();
const { getEvents } = require('../controllers/tripCallEventController');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

router.get('/', protect, authorize(...OPERATIONS), getEvents);

module.exports = router;
