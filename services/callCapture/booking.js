'use strict';
/**
 * services/callCapture/booking.js
 * ============================================================
 * LIVE CALL CAPTURE -> a booking, ONLY when an operator books it. Used by
 * tripController.createTrip when POST /api/trips carries callCaptureId:
 *
 *   claim    CRM staff only; one booking per draft (an atomic lock, then
 *            the trip link) — a second press gets 409, not a second trip.
 *   withPhone  the form's number, or — left blank (or still showing the
 *            masked "••••••4442" a telecaller sees) — the number said on
 *            the call, else the caller's own number. A telecaller can
 *            book without ever seeing either.
 *   link / release  after the trip is created / if it was not.
 *
 * The trip itself is made by the same createBookedTrip as every booking
 * (route check, fare engine), status 'booked', bookingSource
 * 'ai_call_entry', bookedBy the operator — never auto-dispatched.
 * ============================================================
 */
const mongoose = require('mongoose');
const CallCapture = require('../../models/CallCapture');
const CallLog = require('../../models/CallLog');
const { OPERATIONS } = require('../../middleware/auth');
const { normalisePhone } = require('../../utils/phone');

const fail = (status, message) => ({ ok: false, status, message });

async function claim(id, user) {
  if (!user || !OPERATIONS.includes(user.role)) return fail(403, 'Only CRM staff can book from a call capture.');
  if (!mongoose.isValidObjectId(String(id))) return fail(404, 'Call capture not found.');
  const capture = await CallCapture.findOneAndUpdate(
    { _id: id, trip: null, bookingLock: { $ne: true } },
    { $set: { bookingLock: true } },
    { new: true },
  );
  if (!capture) {
    const existing = await CallCapture.findById(id).select('trip');
    if (!existing) return fail(404, 'Call capture not found.');
    return fail(409, existing.trip ? 'This call has already been booked.' : 'This call is being booked right now.');
  }
  const log = await CallLog.findById(capture.callLog).select('+customerPhone');
  return { ok: true, capture, callerPhone: log?.customerPhone || '' };
}

function withPhone(body, capture, callerPhone) {
  const typed = String(body.patientPhone ?? '').trim();
  if (typed && !typed.includes('•')) return body;
  const phone = capture.fields?.patientPhone || normalisePhone(callerPhone);
  return { ...body, patientPhone: phone || typed };
}

const link = (capture, trip) => CallCapture.updateOne({ _id: capture._id }, { $set: { trip: trip._id, bookedAt: new Date(), bookingLock: false } });
const release = (capture) => CallCapture.updateOne({ _id: capture._id }, { $set: { bookingLock: false } });

module.exports = { claim, withPhone, link, release };
