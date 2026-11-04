'use strict';

const express = require('express');
const router = express.Router();
const { askAstra } = require('../services/openaiService');
const { protect, authorize } = require('../middleware/auth');

// Owner-only OpenAI connection check (costs one small request). Mounted at
// /api/ai/test.
router.get('/test', protect, authorize('owner'), async (req, res) => {
  try {
    const answer = await askAstra(
      'Reply with exactly: SaveLife GPT connection successful.'
    );

    res.json({
      success: true,
      answer,
    });
  } catch (error) {
    console.error('Astra test error:', error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
