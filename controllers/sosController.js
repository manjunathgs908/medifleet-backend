/**
 * controllers/sosController.js
 * ============================================================
 * Driver SOS / emergency alert log. Additive, standalone — doesn't
 * touch Trip/Assignment lifecycle logic.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const SosAlert = require('../models/SosAlert');

// ============================================================
// @route   POST /api/sos
// @desc    Driver hits the SOS button. Logs the alert — must never
//          throw on a missing/invalid tripId, since a driver may hit
//          SOS with no active trip at all.
// @access  Private [driver]
// ============================================================
exports.createSosAlert = async (req, res, next) => {
  try {
    const { lat, lng, tripId } = req.body;
    const trip = (tripId && mongoose.Types.ObjectId.isValid(tripId)) ? tripId : undefined;

    await SosAlert.create({ driver: req.user._id, trip, lat, lng });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/sos
// @desc    Unresolved SOS alerts, newest first.
// @access  Private [owner] — the CRM's platform-wide ops session (protect,
//          authorize('owner')), same pattern as ownerCtrl.listOwners.
//          Deliberately NOT scoped by driver.owner: an SOS alert must
//          never go unseen because a driver record is missing its owner
//          link (has happened before — see scripts/link-drv001-to-owner.js).
//          Only one such CRM account exists today, so platform-wide
//          visibility has no real cross-tenant leak; revisit if the CRM
//          ever becomes multi-owner-tenant.
// ============================================================
exports.getSosAlerts = async (req, res, next) => {
  try {
    const alerts = await SosAlert.find({ resolved: false })
      .populate('driver', 'name phone')
      .populate('trip', 'tripNumber')
      .sort({ createdAt: -1 });

    return res.json({ success: true, alerts });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PATCH /api/sos/:id/resolve
// @desc    Mark an SOS alert resolved.
// @access  Private [owner] — see getSosAlerts for why unscoped.
// ============================================================
exports.resolveSosAlert = async (req, res, next) => {
  try {
    const alert = await SosAlert.findById(req.params.id);
    if (!alert) {
      return res.status(404).json({ success: false, message: 'SOS alert not found.' });
    }

    alert.resolved   = true;
    alert.resolvedAt = new Date();
    await alert.save();

    return res.json({ success: true, alert });
  } catch (err) {
    next(err);
  }
};
