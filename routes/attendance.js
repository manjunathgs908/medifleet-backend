'use strict';
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');

router.post('/clock-in', protect, authorize('driver'), async (req, res) => {
  try {
    res.json({ success: true, message: 'Clocked in successfully.', time: new Date() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/clock-out', protect, authorize('driver'), async (req, res) => {
  try {
    res.json({ success: true, message: 'Clocked out successfully.', time: new Date() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;