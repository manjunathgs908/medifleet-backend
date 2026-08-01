'use strict';
const GeofenceEvent = require('../models/GeofenceEvent');

// Owner-facing query -- same filter shape as tripCallEventController.
exports.getEvents = async (req, res) => {
  try {
    const { driverId, type, from, to } = req.query;
    const filter = {};
    if (driverId) filter.driverId = driverId;
    if (type) filter.type = type;
    if (from || to) {
      filter.at = {};
      if (from) filter.at.$gte = new Date(from);
      if (to) filter.at.$lte = new Date(to);
    }
    const events = await GeofenceEvent.find(filter).sort({ at: -1 }).limit(500);
    return res.json({ success: true, events });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
