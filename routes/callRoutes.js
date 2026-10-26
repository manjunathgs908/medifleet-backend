/**
 * routes/callRoutes.js
 * ============================================================
 * Legacy masked call between a trip's driver and customer (the website's
 * tracking page and older driver-app builds). Goes through Plivo whenever
 * PLIVO_* is configured, so the customer sees PLIVO_NUMBER; the Exotel
 * path below only runs while it is not.
 * ============================================================
 */

'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { Trip } = require('../models');
const { connectCall } = require('../services/exotelService');
const plivo = require('../services/plivoService');
const { placePlivoCall, ringPhoneOf } = require('../controllers/callController');
const { normalisePhone } = require('../utils/phone');

// Public base URL Exotel posts call-status updates back to. Hardcoded
// like the other external API URLs in this codebase (see
// placesController.js) rather than a new env var — only meaningful in
// production, since Exotel can't reach a localhost dev server anyway.
const STATUS_CALLBACK_URL = 'https://api.savelife.health/api/call/status';

// Same 10-digit Indian mobile pattern already enforced on User.phone
// (models/index.js) — rejects missing values, the literal 'N/A'
// placeholder some old trips have, and anything that isn't a real
// 6-9-leading mobile number once a +91/91/0 prefix is stripped.
function isValidIndianMobile(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === 'N/A') return false;
  const digits = trimmed.replace(/\D/g, '');
  let local = digits;
  if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) local = digits.slice(1);
  return /^[6-9]\d{9}$/.test(local);
}

// ============================================================
// @route   POST /api/call/connect
// @desc    Places a masked call between the trip's driver and customer.
//          Exotel dials `initiator` first (From); once they answer,
//          Exotel dials the other party (To) and bridges the two legs.
// @access  Public — trip participants aren't JWT-authenticated in this
//          system (same as the other customer-facing trip routes in
//          routes/trips.js); tripId is the lookup key.
// ============================================================
router.post('/connect', async (req, res, next) => {
  try {
    const { tripId, initiator } = req.body;

    if (!tripId || !['driver', 'customer'].includes(initiator)) {
      return res.status(400).json({
        success: false,
        message: '"tripId" and a valid "initiator" ("driver" or "customer") are required.',
      });
    }

    const query = mongoose.Types.ObjectId.isValid(tripId)
      ? { _id: tripId }
      : { tripNumber: tripId };
    const trip = await Trip.findOne(query).populate('driver', 'name phone callPhone');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    const driverPhone   = trip.driver?.phone;
    const customerPhone = trip.patientPhone;

    // Validate BOTH numbers before ever calling Exotel — a masked call is
    // useless (and a wasted Exotel dial) if either leg can't actually be
    // reached. Driver checked first so its message wins if both are bad.
    const invalidDriverPhone   = !isValidIndianMobile(driverPhone);
    const invalidCustomerPhone = !isValidIndianMobile(customerPhone);

    if (invalidDriverPhone || invalidCustomerPhone) {
      const side  = invalidDriverPhone ? 'Driver' : 'Customer';
      const value = (invalidDriverPhone ? driverPhone : customerPhone) || 'missing';
      return res.status(400).json({
        success: false,
        message: `${side} phone number is not valid on this trip (${value}).`,
      });
    }

    // Plivo whenever it is configured, so the customer sees PLIVO_NUMBER on
    // this route too (the website's tracking page and older driver-app
    // builds still call it). Plivo rings the initiator first, from the
    // company number, then dials the other side from the same number.
    // Exotel below only runs while Plivo is not configured.
    if (plivo.isConfigured()) {
      const ring = ringPhoneOf(trip.driver);
      const { log, error } = await placePlivoCall({
        direction    : 'outbound',
        firstLeg     : initiator === 'driver' ? 'agent' : 'customer',
        agentType    : 'driver',
        agentUser    : trip.driver._id,
        agentName    : trip.driver.name,
        agentPhone   : normalisePhone(ring),
        customerPhone: normalisePhone(customerPhone),
        context      : 'trip',
        trip         : trip._id,
      }, initiator === 'driver' ? ring : customerPhone);
      if (error) return res.status(502).json({ success: false, message: error });
      // Same response shape this route always had.
      return res.json({ success: true, call: { Sid: log.providerRequestId || String(log._id), Status: 'initiated' } });
    }

    const from = initiator === 'driver' ? driverPhone : customerPhone;
    const to   = initiator === 'driver' ? customerPhone : driverPhone;

    let call;
    try {
      call = await connectCall({ from, to, statusCallbackUrl: STATUS_CALLBACK_URL });
    } catch (exotelErr) {
      console.error('[Exotel connect] API error:', exotelErr.response?.data || exotelErr.message);
      return res.status(502).json({ success: false, message: 'Could not connect the call right now. Please try again.' });
    }

    if (!call?.Sid) {
      return res.status(502).json({ success: false, message: 'Exotel did not return a call ID.' });
    }

    trip.callLogs.push({
      callSid  : call.Sid,
      initiator,
      status   : call.Status || 'initiated',
      startedAt: new Date(),
    });
    await trip.save();

    // Exotel's Call object carries both From and To -- the driver's and the
    // customer's real numbers. Only the id and status go back to the app.
    return res.json({ success: true, call: { Sid: call.Sid, Status: call.Status || 'initiated' } });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// @route   POST /api/call/status
// @desc    Exotel webhook — fired on call status changes/completion.
//          Updates the matching callLogs entry (by CallSid) on
//          whichever trip placed it.
// @access  Public (Exotel webhook)
// ============================================================
router.post('/status', async (req, res, next) => {
  try {
    const { CallSid, Status, RecordingUrl, ConversationDuration } = req.body;

    if (!CallSid) {
      return res.status(400).json({ success: false, message: '"CallSid" is required.' });
    }

    const trip = await Trip.findOne({ 'callLogs.callSid': CallSid });
    if (!trip) return res.json({ success: true }); // nothing to update, still ack the webhook

    const log = trip.callLogs.find(l => l.callSid === CallSid);
    if (Status) log.status = Status;
    if (RecordingUrl) log.recordingUrl = RecordingUrl;
    if (ConversationDuration != null) log.durationSec = Number(ConversationDuration) || 0;
    log.endedAt = new Date();

    await trip.save();

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
