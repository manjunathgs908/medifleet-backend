const express = require('express');
const router = express.Router();

// Get all bills
router.get('/bills', (req, res) => {
    res.json({ status: 'success', message: 'Billing route connected successfully.' });
});

module.exports = router;