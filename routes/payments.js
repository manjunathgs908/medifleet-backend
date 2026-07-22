'use strict';
const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/paymentWebhookController');

// Account-wide Razorpay webhook — not trip-keyed, authenticated by
// X-Razorpay-Signature (see paymentWebhookController.js), not any of
// this app's own auth. Configure this exact URL in the Razorpay
// dashboard once a webhook secret is generated.
router.post('/webhook', handleWebhook);

module.exports = router;
