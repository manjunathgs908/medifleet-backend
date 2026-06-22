'use strict';

const FreezerDuration = require('../models/FreezerDuration');
const FreezerFloor    = require('../models/FreezerFloor');

const ALLOWED_BOX_IDS = ['normal_box', 'standard_box', 'vip_digital_box'];

function sanitizeQuery(req, res) {
  const { city, boxId } = req.query;

  if (typeof boxId !== 'string' || !ALLOWED_BOX_IDS.includes(boxId)) {
    res.status(400).json({
      success: false,
      message: `boxId must be one of: ${ALLOWED_BOX_IDS.join(', ')}`,
    });
    return null;
  }

  const filter = { boxId, active: true };
  if (typeof city === 'string' && city.trim()) {
    filter.city = city.trim();
  }
  return filter;
}

exports.getDurations = async (req, res) => {
  try {
    const filter = sanitizeQuery(req, res);
    if (!filter) return;

    const durations = await FreezerDuration.find(filter).sort({ sortOrder: 1, basePrice: 1 });
    res.json({ success: true, durations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getFloors = async (req, res) => {
  try {
    const filter = sanitizeQuery(req, res);
    if (!filter) return;

    const floors = await FreezerFloor.find(filter).sort({ sortOrder: 1 });
    res.json({ success: true, floors });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
