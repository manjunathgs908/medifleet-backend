'use strict';

// ============================================================
// services/customerBill.js — the customer's bill on WhatsApp.
// ============================================================
// When a trip completes, completeTrip has already written its Bill (fare
// from the Pricing slabs, waiting charges, GST, advances applied). Nothing
// here recomputes a fare: the message is read from that Bill.
//
//   queueBill  — right after completion: records the bill's customer copy
//                as pending_review (or no_phone), with any warnings.
//                Sends it at once ONLY when BILL_AUTO_SEND=true and there
//                are no warnings. Default: waits for the owner.
//   sendBill   — the owner's Send (or auto-send). Exactly once: one
//                conditional update claims the bill; a second tap, a
//                double click or two tabs find it claimed. A bill with
//                warnings is sent only when the owner acknowledges them.
//                A failed send can be retried; a sent bill is final.
//   dismissBill — the owner's "Don't send".
//
// Masking: the customer's number is read server-side only and listed
// masked; the message goes from the WhatsApp business number; its link is
// the trip's tracking token, never the trip id.
// ============================================================

const { Bill, Trip } = require('../models');
const whatsappNotifications = require('./whatsappNotifications');
const payments = require('./payments');
const { maskPhone } = require('../utils/customerPhone');
const { toPaise, formatRupees } = require('../utils/money');

// A bill this far from the booking-time estimate (either way) is held for
// a person's look. A tolerance, not a price.
const ESTIMATE_DRIFT = 0.25;
// A send claimed this long ago that never finished (the server restarted
// mid-send) may be claimed again.
const SENDING_STALE_MS = 2 * 60 * 1000;
const SENDABLE = ['pending_review', 'failed', 'no_phone'];
const TO_SEND = ['pending_review', 'failed', 'no_phone', 'sending'];

const autoSendOn = () => String(process.env.BILL_AUTO_SEND || '').trim().toLowerCase() === 'true';

const rupees = (v) => formatRupees(toPaise(v) || 0);

// Why a bill needs a person's look before it goes to the customer.
function warningsFor(trip, bill) {
  const w = [];
  const total = Number(bill?.grandTotal);
  if (trip?.dropWaitNeedsReview) w.push('drop_wait_review');
  if (!(Number(bill?.distanceKm) > 0)) w.push('no_distance');
  if (!(total > 0)) w.push('no_total');
  const est = Number(trip?.estimatedFare);
  if (est > 0 && total > 0 && Math.abs(total - est) / est > ESTIMATE_DRIFT) w.push('far_from_estimate');
  if (bill?.invoiceId || ['insurance', 'hospital_credit'].includes(bill?.paymentMode)) w.push('billed_elsewhere');
  return w;
}

// What the message says, from the Bill as stored.
function messageOf(bill, trip) {
  const bal = payments.balanceOf(bill);
  return {
    billNumber: bill.billNumber,
    tripNumber: trip.tripNumber,
    breakdown : `Fare ${rupees(bill.baseFare)} · Waiting ${rupees(bill.waitCharge)} · Extras ${rupees(bill.additionalCharges)} · GST ${rupees(bill.gstAmount)}`,
    total     : rupees(bill.grandTotal),
    paid      : formatRupees(bal.paidPaise),
    balance   : formatRupees(bal.outstandingPaise),
    trip,
  };
}

// Right after a trip completes (completeTrip, after its commit). Once per
// bill: a bill that already has a customer copy is left as it is.
async function queueBill(trip, bill) {
  const phone = whatsappNotifications.waPhone(trip?.patientPhone);
  const warnings = warningsFor(trip, bill);
  const state = phone ? 'pending_review' : 'no_phone';
  const r = await Bill.updateOne(
    { _id: bill._id, customerBill: { $exists: false } },
    { $set: { customerBill: { state, ...(warnings.length ? { warnings } : {}), queuedAt: new Date() } } },
  );
  if (!r?.modifiedCount) return { queued: false };
  console.info(`[customerBill] bill=${bill._id} trip=${trip.tripNumber} ${state}${warnings.length ? ` warnings=${warnings.join(',')}` : ''}${autoSendOn() ? ' (auto-send on)' : ''}`);
  if (state === 'pending_review' && !warnings.length && autoSendOn()) return sendBill(bill._id, { auto: true });
  return { queued: true, state, warnings };
}

// Result codes: sent | already_sent | dismissed | warnings | in_progress |
// no_phone | failed | not_found | not_queued.
async function sendBill(billId, { user = null, auto = false, acknowledgeWarnings = false } = {}) {
  const bill = await Bill.findById(billId).lean();
  if (!bill) return { ok: false, code: 'not_found' };
  const cb = bill.customerBill;
  if (!cb) return { ok: false, code: 'not_queued' };
  if (cb.state === 'sent') return { ok: false, code: 'already_sent', sentAt: cb.sentAt };
  if (cb.state === 'dismissed') return { ok: false, code: 'dismissed' };
  // Warnings: never sent automatically; sent by a person only when they
  // have seen them.
  if ((cb.warnings || []).length && (auto || !acknowledgeWarnings)) return { ok: false, code: 'warnings', warnings: cb.warnings };

  const now = new Date();
  const claimed = await Bill.updateOne(
    {
      _id: bill._id,
      $or: [
        { 'customerBill.state': { $in: SENDABLE } },
        { 'customerBill.state': 'sending', 'customerBill.sendingAt': { $lt: new Date(now.getTime() - SENDING_STALE_MS) } },
      ],
    },
    { $set: { 'customerBill.state': 'sending', 'customerBill.sendingAt': now }, $inc: { 'customerBill.attempts': 1 } },
  );
  if (!claimed?.modifiedCount) return { ok: false, code: 'in_progress' };

  // Only the send that claimed it may finish it.
  const finish = (set, unset) => Bill.updateOne(
    { _id: bill._id, 'customerBill.state': 'sending', 'customerBill.sendingAt': now },
    { $set: set, ...(unset ? { $unset: unset } : {}) },
  );
  const who = user ? { 'customerBill.by': user._id, 'customerBill.byName': user.name } : {};

  try {
    const trip = await Trip.findById(bill.trip).select('+trackingToken tripNumber patientPhone').lean();
    const phone = whatsappNotifications.waPhone(trip?.patientPhone);
    if (!trip || !phone) {
      await finish({ 'customerBill.state': 'no_phone', 'customerBill.error': 'No valid customer mobile on this trip.' });
      return { ok: false, code: 'no_phone' };
    }
    const res = await whatsappNotifications.notifyBill(phone, messageOf(bill, trip));
    if (!res || res.skipped) {
      const error = res?.reason || 'WhatsApp did not accept the message.';
      await finish({ 'customerBill.state': 'failed', 'customerBill.error': error, ...who });
      console.warn(`[customerBill] bill=${bill._id} not sent: ${error}`);
      return { ok: false, code: 'failed', error };
    }
    await finish(
      { 'customerBill.state': 'sent', 'customerBill.sentAt': new Date(), 'customerBill.auto': !!auto, 'customerBill.messageId': res?.messages?.[0]?.id, ...who },
      { 'customerBill.error': '' },
    );
    console.info(`[customerBill] bill=${bill._id} sent${auto ? ' (auto)' : ` by ${user?._id || '-'}`}`);
    return { ok: true, code: 'sent' };
  } catch (err) {
    await finish({ 'customerBill.state': 'failed', 'customerBill.error': String(err?.message || err).slice(0, 300), ...who }).catch(() => {});
    console.error(`[customerBill] bill=${bill._id} send failed:`, err?.message || err);
    return { ok: false, code: 'failed', error: 'The bill could not be sent. Try again.' };
  }
}

async function dismissBill(billId, user) {
  const r = await Bill.updateOne(
    { _id: billId, 'customerBill.state': { $in: SENDABLE } },
    { $set: { 'customerBill.state': 'dismissed', 'customerBill.dismissedAt': new Date(), 'customerBill.by': user._id, 'customerBill.byName': user.name } },
  );
  return { ok: r?.modifiedCount > 0 };
}

// The CRM's list. view: to_send (default) | sent | dismissed.
const VIEWS = { to_send: TO_SEND, sent: ['sent'], dismissed: ['dismissed'] };
async function listBills(view = 'to_send') {
  const states = VIEWS[view];
  if (!states) return null;
  const bills = await Bill.find({ 'customerBill.state': { $in: states } })
    .sort({ 'customerBill.queuedAt': -1 })
    .limit(200)
    .populate('trip', 'tripNumber patientName patientPhone completedAt estimatedFare')
    .lean();
  return bills.map((b) => {
    const bal = payments.balanceOf(b);
    return {
      billId     : b._id,
      billNumber : b.billNumber,
      tripId     : b.trip?._id,
      tripNumber : b.trip?.tripNumber,
      patient    : b.patient || b.trip?.patientName,
      // Masked, as everywhere: the full number never leaves the server.
      phoneMasked: maskPhone(b.trip?.patientPhone),
      completedAt: b.trip?.completedAt,
      baseFare   : b.baseFare,
      waitCharge : b.waitCharge,
      additionalCharges: b.additionalCharges,
      gstAmount  : b.gstAmount,
      grandTotal : b.grandTotal,
      estimatedFare: b.trip?.estimatedFare,
      paidPaise  : bal.paidPaise,
      balancePaise: bal.outstandingPaise,
      state      : b.customerBill.state,
      warnings   : b.customerBill.warnings || [],
      queuedAt   : b.customerBill.queuedAt,
      sentAt     : b.customerBill.sentAt,
      auto       : b.customerBill.auto,
      byName     : b.customerBill.byName,
      error      : b.customerBill.error,
    };
  });
}

module.exports = { queueBill, sendBill, dismissBill, listBills, warningsFor, messageOf, autoSendOn, ESTIMATE_DRIFT };
