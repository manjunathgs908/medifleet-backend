'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/freezerController');

router.get('/durations', ctrl.getDurations);
router.get('/floors', ctrl.getFloors);

module.exports = router;
