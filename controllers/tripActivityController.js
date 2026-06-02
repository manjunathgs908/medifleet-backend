'use strict';
const TripActivity = require('../models/TripActivity');

exports.logActivity = async (req, res) => {
  try {
    const { tripId, driverId, ambulanceId, tripStatus, latitude, longitude, imageUrl, ambulanceDetails } = req.body;

    const activity = await TripActivity.create({
      tripId: tripId || null,
      driverId,
      ambulanceId,
      tripStatus,
      location: { latitude, longitude },
      imageUrl: imageUrl || null,
      ambulanceDetails: ambulanceDetails || {}
    });

    return res.status(201).json({ success: true, message: 'Activity logged!', activity });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getActivities = async (req, res) => {
  try {
    const { driverId, date } = req.query;
    const filter = {};
    if (driverId) filter.driverId = driverId;
    if (date) {
      const start = new Date(date);
      const end = new Date(date);
      end.setHours(23, 59, 59);
      filter.createdAt = { $gte: start, $lte: end };
    }
    const activities = await TripActivity.find(filter).sort({ createdAt: -1 });
    return res.json({ success: true, activities });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};