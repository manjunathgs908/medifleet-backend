'use strict';
const TripCallEvent = require('../models/TripCallEvent');
const { Trip } = require('../models');

// A dispatched trip the driver hasn't accepted/rejected within this window
// is surfaced as a synthetic NO_RESPONSE "event" below — computed fresh from
// live Trip state on every call, never persisted (NOT in TripCallEvent's
// own type enum — it never gets saved to that collection). This is a live
// snapshot, not a historical record: once the trip is confirmed/declined/
// reassigned it naturally drops out of this list on its own. from/to only
// filters the persisted event types; it doesn't apply to NO_RESPONSE.
const NO_RESPONSE_STALE_MS = 2 * 60 * 1000; // 2 min — native call's own 30s ring timeout, plus generous margin for dispatch/delivery latency

// Owner-facing query — "did this app actually get this push". Raw event
// list (persisted events + live NO_RESPONSE snapshot); computing "sent with
// no accept/reject" beyond that is a filter over this on the CRM side.
exports.getEvents = async (req, res) => {
  try {
    const { tripId, driverId, type, from, to } = req.query;
    const wantsNoResponse = !type || type === 'NO_RESPONSE';
    const wantsPersisted  = !type || type !== 'NO_RESPONSE';

    let events = [];

    if (wantsPersisted) {
      const filter = {};
      if (tripId) filter.tripId = tripId;
      if (driverId) filter.driverId = driverId;
      if (type) filter.type = type;
      if (from || to) {
        filter.at = {};
        if (from) filter.at.$gte = new Date(from);
        if (to) filter.at.$lte = new Date(to);
      }
      events = await TripCallEvent.find(filter).sort({ at: -1 }).limit(500).lean();
    }

    if (wantsNoResponse) {
      const staleFilter = {
        status: 'dispatched',
        driverConfirmed: false,
        dispatchedAt: { $lte: new Date(Date.now() - NO_RESPONSE_STALE_MS) },
      };
      if (tripId) staleFilter._id = tripId;
      if (driverId) staleFilter.driver = driverId;

      const staleTrips = await Trip.find(staleFilter).select('_id driver dispatchedAt').lean();
      const noResponseEvents = staleTrips.map((t) => ({
        tripId  : t._id,
        driverId: t.driver,
        type    : 'NO_RESPONSE',
        source  : 'backend',
        at      : t.dispatchedAt,
        meta    : { staleForMs: Date.now() - new Date(t.dispatchedAt).getTime() },
      }));
      events = events.concat(noResponseEvents);
    }

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    return res.json({ success: true, events });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
