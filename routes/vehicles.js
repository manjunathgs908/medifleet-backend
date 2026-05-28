const express = require('express');
const router = express.Router();

// Get all vehicles
router.get('/', (req, res) => {
    res.json({ status: 'success', message: 'Vehicles route connected successfully.' });
});

module.exports = router;