'use strict';
/**
 * services/payments.js
 * ============================================================
 * Recording money received for a trip, and what a bill's balance is.
 *
 *   balanceOf(bill, receiptsPaise)  total / received / outstanding / state,
 *                                   and why it needs reconciling, if it does
 *   recordPayment(...)              a staff-recorded receipt (advance before
 *                                   the bill exists, payment after)
 *   applyProviderPayment(...)       a Razorpay-verified receipt
 *   applyAdvancesToNewBill(...)     inside trip completion: advances become
 *                                   the new bill's paidAmount, counted once
 *
 * Every write is one MongoDB transaction that first bumps the trip's
 * paymentRev: two payments for one trip (or a payment and the trip's
 * completion) never commit from the same balance — the second one is
 * retried against the first one's result, so the limit (bill total, or
 * the trip's fare estimate for advances) can't be overshot together.
 * The receipt, the bill's paidAmount/paymentStatus and the receipt
 * number commit together or not at all.
 *
 * Money is whole paise (utils/money.js). Nothing here moves money, calls a
 * gateway, refunds, or messages anyone.
 * ============================================================
 */
const { Trip, Bill, HospitalInvoice } = require('../models');
const Payment = require('../models/Payment');
const { toPaise, toRupees, formatRupees } = require('../utils/money');

class PaymentRefused extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// ── Uniqueness protections must exist before any money is recorded ──
// The receipt number, the form key (requestId), the gateway payment id and
// the UPI/bank reference are each protected by a unique index. Until those
// are built and read back from MongoDB, nothing is recorded: a staff
// payment gets a clear 503, a gateway callback a 500 (so Razorpay retries
// later — the money stays on record at Razorpay). Re-checked at most once a
// minute after a failure. The check also verifies the stored receipts keep
// the one-live-receipt-per-reference rule (services/paymentIndexMigration.js).
// The app only ever CREATES indexes: retiring the first release's reference
// index is a separate, explicit step (scripts/migrate-payment-reference-index.js).
const indexMigration = require('./paymentIndexMigration');
let indexState = { ok: false, checkedAt: 0, error: null };
let indexCheck = null; // one check at a time
const INDEX_RETRY_MS = 60 * 1000;
const checkIndexes = () => indexMigration.verifyProtections();
async function indexesReady() {
  if (indexState.ok) return true;
  if (indexState.checkedAt && Date.now() - indexState.checkedAt < INDEX_RETRY_MS) return false;
  if (!indexCheck) {
    indexCheck = checkIndexes()
      .then(() => { indexState = { ok: true, checkedAt: Date.now(), error: null }; })
      .catch((err) => {
        indexState = { ok: false, checkedAt: Date.now(), error: err.message };
        console.error(`[payments] NOT recording payments — uniqueness protection could not be confirmed: ${err.message}`);
      })
      .finally(() => { indexCheck = null; });
  }
  await indexCheck;
  return indexState.ok;
}
const NOT_READY = 'Payments cannot be recorded right now: the database protections against duplicate receipts could not be confirmed. Nothing was recorded — try again in a minute, and tell the developer if it continues.';
async function requireIndexes() {
  if (!(await indexesReady())) throw new PaymentRefused(503, NOT_READY, { notReady: true });
}

// Bills consolidated into a hospital invoice, traced from the invoices
// themselves (HospitalInvoice.bills) as well as Bill.invoiceId — the
// existing invoice generator stops before it links bills, so many invoiced
// bills carry no invoiceId. Map billId -> { invoiceId, status }.
async function invoicedBills(session) {
  const invoices = await HospitalInvoice.find({}).select('bills status').session(session || null).lean();
  const map = new Map();
  for (const inv of invoices) for (const b of inv.bills || []) map.set(String(b), { invoiceId: inv._id, status: inv.status });
  return map;
}

const IST_MS = 330 * 60 * 1000;
// Indian financial year (April–March) of a moment, in India time: "2026-27".
function financialYear(at = new Date()) {
  const d = new Date(new Date(at).getTime() + IST_MS);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Created outside any transaction (an upsert racing inside one could fail
// on the counter's first ever use); the increment itself is transactional,
// so an aborted payment never uses up a number.
async function ensureCounter(fy) {
  await Payment.Counter.updateOne({ _id: `receipt:${fy}` }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((e) => {
    if (e?.code !== 11000) throw e;
  });
}
async function nextReceiptNumber(session, fy) {
  const c = await Payment.Counter.findOneAndUpdate({ _id: `receipt:${fy}` }, { $inc: { seq: 1 } }, { new: true, session });
  return `RCT/${fy}/${String(c.seq).padStart(6, '0')}`;
}

// ── Balance ──────────────────────────────────────────────────────
// `receiptsPaise`: the sum of this bill's receipts (null when unknown).
// `onInvoice`: the bill is listed in a hospital invoice (invoicedBills()).
function balanceOf(bill, receiptsPaise = null, { onInvoice = false } = {}) {
  const totalPaise = toPaise(bill?.grandTotal);
  const paidPaise = toPaise(bill?.paidAmount) || 0;
  const onHospitalInvoice = !!bill?.invoiceId || !!onInvoice;
  const reconcile = [];
  // Collected from the patient AND billed to the hospital: one of the two
  // must be undone — a person decides which.
  if (onHospitalInvoice && paidPaise > 0) reconcile.push('paid_and_invoiced');
  if (totalPaise == null || totalPaise <= 0) reconcile.push('no_total');
  if (paidPaise < 0) reconcile.push('negative_paid');
  if (totalPaise != null && paidPaise > totalPaise) reconcile.push('overpaid');
  if (receiptsPaise != null && receiptsPaise > paidPaise) reconcile.push('receipts_exceed_paid');
  const s = bill?.paymentStatus;
  if (s === 'paid' && totalPaise != null && paidPaise < totalPaise) reconcile.push('marked_paid_short');
  if ((s === 'pending' || s === 'partial') && totalPaise != null && totalPaise > 0 && paidPaise >= totalPaise) reconcile.push('status_behind');
  if (s === 'pending' && paidPaise > 0) reconcile.push('status_behind');

  const waived = s === 'waived';
  const outstandingPaise = waived || totalPaise == null ? 0 : Math.max(0, totalPaise - paidPaise);
  const state = waived ? 'waived'
    : totalPaise != null && totalPaise > 0 && paidPaise >= totalPaise ? 'paid'
      : paidPaise > 0 ? 'part_paid' : 'unpaid';
  return {
    totalPaise: totalPaise ?? 0,
    paidPaise,
    outstandingPaise,
    itemisedPaise: receiptsPaise,
    // Recorded as received before itemised receipts existed (or by a path
    // that kept no detail): it counts toward the balance, but when and how it
    // was collected is unverified — never reported as cash in any month.
    notItemisedPaise: receiptsPaise == null ? null : Math.max(0, paidPaise - receiptsPaise),
    state,
    onHospitalInvoice,
    // What can still be collected from the customer: nothing on a bill that
    // is billed to a hospital instead.
    collectiblePaise: onHospitalInvoice ? 0 : outstandingPaise,
    reconcile: [...new Set(reconcile)],
  };
}

const statusFor = (paidPaise, totalPaise) => (paidPaise >= totalPaise ? 'paid' : paidPaise > 0 ? 'partial' : 'pending');

async function receiptsTotal(filter, session) {
  const [row] = await Payment.aggregate([{ $match: filter }, { $group: { _id: null, paise: { $sum: '$amountPaise' } } }]).session(session || null);
  return row?.paise || 0;
}

// ── Staff-recorded receipt ───────────────────────────────────────
// Returns { payment, created } — created:false when `requestId` was already
// used for this very payment (a double click or retry).
async function recordPayment({ tripId, amountPaise, method, reference, receivedAt, note, requestId, user, now = new Date() }) {
  const same = (p) => String(p.trip) === String(tripId) && p.amountPaise === amountPaise && p.method === method;
  const replay = async () => {
    const prior = await Payment.findOne({ requestId });
    if (!prior) return null;
    if (!same(prior)) throw new PaymentRefused(409, 'This form was already used for a different payment. Reload and try again.');
    return { payment: prior, created: false };
  };
  await requireIndexes();
  const earlier = await replay();
  if (earlier) return earlier;

  // A reference already on a receipt is refused — unless every receipt that
  // carried it was reversed as a mistake: then this is the genuine payment
  // and gets the next refSeq (the unique index still stops two at once).
  const refCheck = async (session) => {
    if (!reference) return { refSeq: undefined };
    const prior = await Payment.find({ method, reference, kind: { $ne: 'reversal' } }).select('_id receiptNumber trip').session(session || null).lean();
    if (!prior.length) return { refSeq: undefined };
    const reversed = new Set((await Payment.find({ reverses: { $in: prior.map((p) => p._id) } }).select('reverses').session(session || null).lean()).map((r) => String(r.reverses)));
    const live = prior.find((p) => !reversed.has(String(p._id)));
    if (live) {
      return { taken: new PaymentRefused(409, `That reference is already on receipt ${live.receiptNumber}${String(live.trip) === String(tripId) ? '' : ' for another trip'} — check it is not the same payment.`) };
    }
    return { refSeq: prior.length };
  };
  const pre = await refCheck();
  if (pre.taken) throw pre.taken;
  // Reusing a reversed receipt's reference needs the old index retired
  // (an explicit migration step); until then it is refused, clearly.
  const REUSE_PENDING = 'That reference belongs to a reversed receipt. Reusing it needs the one-time payment index migration, which has not been run yet — nothing was recorded. Ask the developer to run it, or record this payment without the reference for now.';
  if (pre.refSeq && (await indexMigration.readiness()).oldIndexPresent) throw new PaymentRefused(409, REUSE_PENDING);

  const fy = financialYear(now);
  await ensureCounter(fy);
  const session = await Payment.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const trip = await Trip.findOneAndUpdate({ _id: tripId }, { $inc: { paymentRev: 1 } }, { new: true, session })
        .select('tripNumber status billId estimatedFare grandTotal createdAt');
      if (!trip) throw new PaymentRefused(404, 'Trip not found.');
      // A simultaneous submission of this same form committed first: this
      // run is a retry against its result — return that receipt, don't
      // judge the balance again.
      if (await Payment.exists({ requestId }).session(session)) throw new PaymentRefused(0, 'replay', { replay: true });
      if (receivedAt < new Date(new Date(trip.createdAt).getTime() - 24 * 3600 * 1000)) {
        throw new PaymentRefused(400, 'The received date is before this trip was booked.');
      }

      let bill = null;
      let limitPaise;
      let kind;
      if (trip.billId) {
        bill = await Bill.findById(trip.billId).session(session);
        if (!bill) throw new PaymentRefused(409, 'This trip\'s bill could not be found — reconcile it before recording payments.');
        const onInvoice = !!(await HospitalInvoice.exists({ bills: bill._id }).session(session));
        const bal = balanceOf(bill, await receiptsTotal({ bill: bill._id }, session), { onInvoice });
        if (bal.state === 'waived') throw new PaymentRefused(400, 'This bill was waived — nothing to collect.');
        if (bal.onHospitalInvoice) throw new PaymentRefused(400, 'This bill is on a hospital invoice — it is collected from the hospital, not recorded here.');
        if (bal.reconcile.length) throw new PaymentRefused(409, 'This bill\'s payment record needs reconciling before more payments are recorded.', { reconcile: bal.reconcile });
        limitPaise = bal.outstandingPaise;
        kind = 'payment';
        if (limitPaise <= 0) throw new PaymentRefused(409, 'This bill is already fully paid.');
      } else {
        if (trip.status === 'cancelled') throw new PaymentRefused(400, 'This trip was cancelled — no advance can be taken.');
        if (trip.status === 'completed') throw new PaymentRefused(409, 'This trip is completed but has no bill yet — reload and try again.');
        const estimatePaise = toPaise(trip.grandTotal) || toPaise(trip.estimatedFare);
        if (!estimatePaise) throw new PaymentRefused(400, 'This trip has no fare estimate, so an advance cannot be checked against it.');
        limitPaise = estimatePaise - await receiptsTotal({ trip: trip._id }, session);
        kind = 'advance';
        if (limitPaise <= 0) throw new PaymentRefused(409, 'Advances already cover this trip\'s estimated fare.');
      }
      if (amountPaise > limitPaise) {
        throw new PaymentRefused(409, `That is more than ${kind === 'advance' ? 'the fare estimate still uncovered' : 'the outstanding balance'} (${formatRupees(limitPaise)}).`, { limitPaise });
      }

      const ref = await refCheck(session);
      if (ref.taken) throw ref.taken;
      const receiptNumber = await nextReceiptNumber(session, fy);
      const [payment] = await Payment.create([{
        receiptNumber, trip: trip._id, bill: bill?._id, kind, amountPaise, method,
        reference: reference || undefined, refSeq: ref.refSeq, receivedAt, note: note || undefined,
        verification: 'staff_recorded', recordedBy: user._id, recordedByName: user.name, requestId,
      }], { session });

      if (bill) {
        const paidPaise = (toPaise(bill.paidAmount) || 0) + amountPaise;
        const status = statusFor(paidPaise, toPaise(bill.grandTotal));
        await Bill.updateOne({ _id: bill._id }, {
          $set: { paidAmount: toRupees(paidPaise), paymentStatus: status, paymentMode: method, ...(status === 'paid' ? { paidAt: receivedAt } : {}) },
        }, { session });
      }
      result = { payment, created: true };
    });
  } catch (err) {
    // The same requestId committed by a simultaneous submission.
    if (err?.replay || (err?.code === 11000 && /requestId/.test(err.message || ''))) {
      const again = await replay();
      if (again) return again;
    }
    // The old (method, reference) index still in place: reuse not yet possible.
    if (err?.code === 11000 && new RegExp(`index: ${indexMigration.OLD_INDEX} `).test(err.message || '')) {
      throw new PaymentRefused(409, REUSE_PENDING);
    }
    // The same reference committed by someone else at the same moment.
    if (err?.code === 11000 && /reference/.test(err.message || '')) {
      const again = await refCheck();
      throw again.taken || new PaymentRefused(409, 'Someone recorded a payment with that reference at the same moment — reload and check.');
    }
    throw err;
  } finally {
    await session.endSession();
  }
  return result;
}

// ── Reversal of a mistaken staff-recorded receipt ────────────────
// Owner-only (routes). Corrects the accounting record — no money moves.
// The original receipt is never changed: a new reversal record (REV/…)
// links to it, carries the negative amount, the owner, the time, the
// reason and its own request key, and the bill's paid amount / status are
// updated in the same transaction. One full reversal per receipt (unique
// index on `reverses`); a reversal can't itself be reversed.
const REVERSIBLE_METHODS = ['cash', 'upi', 'bank_transfer'];
const REASON_MIN = 10;
const REASON_MAX = 300;

// Why this receipt can't be reversed, or null. `bal` is its bill's balance
// (when it is on a bill); `reversedBy` its existing reversal, if any.
function reversalBlock(p, { bal = null, reversedBy = null } = {}) {
  if (p.kind === 'reversal') return 'A reversal can\'t itself be reversed.';
  if (p.kind === 'refund') return 'A refund can\'t be reversed here.';
  if (p.verification !== 'staff_recorded' || !REVERSIBLE_METHODS.includes(p.method)) {
    return 'Only staff-recorded cash, UPI or bank receipts can be reversed here — a Razorpay-verified payment needs the Razorpay dashboard.';
  }
  if (reversedBy) return `Already reversed (${reversedBy.receiptNumber}).`;
  if (bal) {
    if (bal.onHospitalInvoice) return 'This bill is on a hospital invoice — sort out the invoice first; the receipt can\'t be reversed here.';
    if (bal.state === 'waived') return 'This bill was waived — the receipt can\'t be reversed here.';
    if (bal.notItemisedPaise > 0) return 'This bill also carries older payments with no receipts behind them — the result would be ambiguous, so it needs reconciling first.';
    const other = bal.reconcile.filter((r) => r !== 'overpaid');
    if (other.length) return 'This bill\'s payment record needs reconciling first — a reversal would make it more ambiguous.';
    if (bal.paidPaise < p.amountPaise) return 'This bill shows less received than the receipt — it needs reconciling first.';
  }
  return null;
}

// ── Refund paid out to the customer (record only) ────────────────
// Owner-only (routes). Records money the owner already paid back outside
// the system (cash / UPI / bank) — this sends nothing and calls no gateway.
// RFD/<FY>/NNNNNN, negative amount dated when it was paid out, linked to
// the bill (or, before billing, the trip's advances). Up to what was
// received there; the bill's paid amount and status drop in the same
// transaction. Reported as money paid out, apart from collections.
const REFUND_METHODS = ['cash', 'upi', 'bank_transfer'];
async function recordRefund({ tripId, amountPaise, method, payoutReference, paidOutAt, reason, requestId, user, now = new Date() }) {
  await requireIndexes();
  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (text.length < REASON_MIN) throw new PaymentRefused(400, `Give a reason of at least ${REASON_MIN} characters.`);
  if (text.length > REASON_MAX) throw new PaymentRefused(400, `Keep the reason under ${REASON_MAX} characters.`);
  if (!REFUND_METHODS.includes(method)) throw new PaymentRefused(400, 'Pick cash, UPI or bank transfer.');

  const replay = async () => {
    const prior = await Payment.findOne({ requestId });
    if (!prior) return null;
    if (prior.kind !== 'refund' || String(prior.trip) !== String(tripId) || prior.amountPaise !== -amountPaise) {
      throw new PaymentRefused(409, 'This form was already used for something else. Reload and try again.');
    }
    return { refund: prior, created: false };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const fy = financialYear(now);
  await Payment.Counter.updateOne({ _id: `refund:${fy}` }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((e) => { if (e?.code !== 11000) throw e; });
  const session = await Payment.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const trip = await Trip.findOneAndUpdate({ _id: tripId }, { $inc: { paymentRev: 1 } }, { new: true, session }).select('billId createdAt');
      if (!trip) throw new PaymentRefused(404, 'Trip not found.');
      if (await Payment.exists({ requestId }).session(session)) throw new PaymentRefused(0, 'replay', { replay: true });
      if (paidOutAt < new Date(new Date(trip.createdAt).getTime() - 24 * 3600 * 1000)) {
        throw new PaymentRefused(400, 'The refund date is before this trip was booked.');
      }
      let bill = null;
      let receivedPaise;
      if (trip.billId) {
        bill = await Bill.findById(trip.billId).session(session);
        if (!bill) throw new PaymentRefused(409, 'This trip\'s bill could not be found — it needs reconciling first.');
        receivedPaise = toPaise(bill.paidAmount) || 0;
      } else {
        receivedPaise = await receiptsTotal({ trip: trip._id, bill: null }, session);
      }
      if (receivedPaise <= 0) throw new PaymentRefused(409, 'Nothing has been received on this trip, so there is nothing to refund.');
      if (amountPaise > receivedPaise) {
        throw new PaymentRefused(409, `That is more than was received (${formatRupees(receivedPaise)}).`, { limitPaise: receivedPaise });
      }
      const c = await Payment.Counter.findOneAndUpdate({ _id: `refund:${fy}` }, { $inc: { seq: 1 } }, { new: true, session });
      const [refund] = await Payment.create([{
        receiptNumber: `RFD/${fy}/${String(c.seq).padStart(6, '0')}`, trip: trip._id, bill: bill?._id, kind: 'refund',
        amountPaise: -amountPaise, method, payoutReference: payoutReference || undefined, receivedAt: paidOutAt,
        verification: 'staff_recorded', recordedBy: user._id, recordedByName: user.name, requestId, reason: text,
      }], { session });
      if (bill) {
        const paidPaise = receivedPaise - amountPaise;
        const status = statusFor(paidPaise, toPaise(bill.grandTotal));
        await Bill.updateOne({ _id: bill._id }, {
          $set: { paidAmount: toRupees(paidPaise), paymentStatus: status },
          ...(status === 'paid' ? {} : { $unset: { paidAt: 1 } }),
        }, { session });
      }
      result = { refund, created: true };
    });
  } catch (err) {
    if (err?.replay || (err?.code === 11000 && /requestId/.test(err.message || ''))) {
      const again = await replay();
      if (again) return again;
    }
    throw err;
  } finally {
    await session.endSession();
  }
  return result;
}

async function nextReversalNumber(session, fy) {
  const c = await Payment.Counter.findOneAndUpdate({ _id: `reversal:${fy}` }, { $inc: { seq: 1 } }, { new: true, session });
  return `REV/${fy}/${String(c.seq).padStart(6, '0')}`;
}

// Returns { reversal, created } — created:false when `requestId` was already
// used for this very reversal (a double click or retry).
async function reversePayment({ paymentId, reason, requestId, user, now = new Date() }) {
  await requireIndexes();
  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (text.length < REASON_MIN) throw new PaymentRefused(400, `Give a reason of at least ${REASON_MIN} characters.`);
  if (text.length > REASON_MAX) throw new PaymentRefused(400, `Keep the reason under ${REASON_MAX} characters.`);

  const replay = async () => {
    const prior = await Payment.findOne({ requestId });
    if (!prior) return null;
    if (prior.kind !== 'reversal' || String(prior.reverses) !== String(paymentId)) {
      throw new PaymentRefused(409, 'This form was already used for something else. Reload and try again.');
    }
    return { reversal: prior, created: false };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const original = await Payment.findById(paymentId);
  if (!original) throw new PaymentRefused(404, 'Receipt not found.');
  const already = await Payment.findOne({ reverses: original._id }).select('receiptNumber');
  const pre = reversalBlock(original, { reversedBy: already });
  if (pre) throw new PaymentRefused(already ? 409 : 400, pre);

  const fy = financialYear(now);
  await Payment.Counter.updateOne({ _id: `reversal:${fy}` }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((e) => { if (e?.code !== 11000) throw e; });
  const session = await Payment.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Serialised with every other payment, reversal and the trip's billing.
      const trip = await Trip.findOneAndUpdate({ _id: original.trip }, { $inc: { paymentRev: 1 } }, { new: true, session }).select('_id');
      if (!trip) throw new PaymentRefused(404, 'Trip not found.');
      if (await Payment.exists({ requestId }).session(session)) throw new PaymentRefused(0, 'replay', { replay: true });
      const prior = await Payment.findOne({ reverses: original._id }).select('receiptNumber').session(session);
      if (prior) throw new PaymentRefused(409, `Already reversed (${prior.receiptNumber}).`);
      // Re-read: billing may have linked an advance to a bill meanwhile.
      const orig = await Payment.findById(original._id).session(session);

      let bill = null;
      if (orig.bill) {
        bill = await Bill.findById(orig.bill).session(session);
        if (!bill) throw new PaymentRefused(409, 'This receipt\'s bill could not be found — it needs reconciling first.');
        const onInvoice = !!(await HospitalInvoice.exists({ bills: bill._id }).session(session));
        const bal = balanceOf(bill, await receiptsTotal({ bill: bill._id }, session), { onInvoice });
        const why = reversalBlock(orig, { bal });
        if (why) throw new PaymentRefused(409, why);
      } else if (await receiptsTotal({ trip: orig.trip, bill: null }, session) < orig.amountPaise) {
        throw new PaymentRefused(409, 'The advances on this trip don\'t add up to this receipt — it needs reconciling first.');
      }

      const receiptNumber = await nextReversalNumber(session, fy);
      const [reversal] = await Payment.create([{
        receiptNumber, trip: orig.trip, bill: orig.bill || undefined, kind: 'reversal',
        amountPaise: -orig.amountPaise, method: orig.method, receivedAt: now,
        verification: 'staff_recorded', recordedBy: user._id, recordedByName: user.name,
        requestId, reverses: orig._id, reason: text,
      }], { session });

      if (bill) {
        const paidPaise = (toPaise(bill.paidAmount) || 0) - orig.amountPaise;
        const status = statusFor(paidPaise, toPaise(bill.grandTotal));
        await Bill.updateOne({ _id: bill._id }, {
          $set: { paidAmount: toRupees(paidPaise), paymentStatus: status },
          ...(status === 'paid' ? {} : { $unset: { paidAt: 1 } }),
        }, { session });
      }
      result = { reversal, created: true };
    });
  } catch (err) {
    if (err?.replay || (err?.code === 11000 && /requestId/.test(err.message || ''))) {
      const again = await replay();
      if (again) return again;
    }
    // Another owner reversed it at the same moment.
    if (err?.code === 11000 && /reverses/.test(err.message || '')) {
      const r = await Payment.findOne({ reverses: original._id }).select('receiptNumber');
      throw new PaymentRefused(409, `Already reversed${r ? ` (${r.receiptNumber})` : ''}.`);
    }
    throw err;
  } finally {
    await session.endSession();
  }
  return result;
}

// Adds each receipt's reversal link (and, for reversals, what they reverse)
// to a list of receipts; `balFor(p)` gives the bill balance when on a bill.
async function withReversalLinks(list, balFor = () => null) {
  const ids = list.map((p) => p._id);
  const [reversals, reversed] = await Promise.all([
    Payment.find({ reverses: { $in: ids } }).select('receiptNumber receivedAt reverses').lean(),
    Payment.find({ _id: { $in: list.filter((p) => p.reverses).map((p) => p.reverses) } }).select('receiptNumber receivedAt amountPaise').lean(),
  ]);
  const byOriginal = new Map(reversals.map((r) => [String(r.reverses), r]));
  const originals = new Map(reversed.map((o) => [String(o._id), o]));
  return list.map((p) => {
    const json = typeof p.toJSON === 'function' ? p.toJSON() : { ...p };
    const rev = byOriginal.get(String(p._id));
    if (rev) json.reversedBy = { _id: rev._id, receiptNumber: rev.receiptNumber, at: rev.receivedAt };
    if (p.reverses) {
      const o = originals.get(String(p.reverses));
      if (o) json.reversesReceipt = { _id: o._id, receiptNumber: o.receiptNumber, receivedAt: o.receivedAt, amountPaise: o.amountPaise };
    }
    const why = reversalBlock(p, { bal: p.bill ? balFor(p) : null, reversedBy: rev });
    json.canReverse = !why;
    if (why && p.kind !== 'reversal') json.reverseBlockedWhy = why;
    return json;
  });
}

// ── Inside trip completion's transaction ─────────────────────────
// Only for a bill created in that same transaction: its paidAmount
// becomes the advances already received, and they are linked to it.
async function applyAdvancesToNewBill(trip, bill, session) {
  await Trip.updateOne({ _id: trip._id }, { $inc: { paymentRev: 1 } }, { session });
  // (Reversals of advances are included: their negative amounts net out.)
  const advances = await Payment.find({ trip: trip._id, bill: null }).session(session).sort({ receivedAt: 1 });
  if (!advances.length) return bill;
  const paidPaise = advances.reduce((s, p) => s + p.amountPaise, 0);
  const totalPaise = toPaise(bill.grandTotal);
  const lastReceived = advances.filter((p) => !['reversal', 'refund'].includes(p.kind)).at(-1);
  bill.paidAmount = toRupees(paidPaise);
  bill.paymentStatus = statusFor(paidPaise, totalPaise);
  if (paidPaise > 0) bill.paymentMode = lastReceived.method;
  if (bill.paymentStatus === 'paid') bill.paidAt = lastReceived.receivedAt;
  await bill.save({ session });
  await Payment.updateMany({ _id: { $in: advances.map((p) => p._id) } }, { $set: { bill: bill._id } }, { session });
  return bill;
}

// ── Provider payments needing review ─────────────────────────────
async function noteProviderIssue({ paymentId, orderId, reason, amount, currency, bill, payment, detail }) {
  await requireIndexes(); // not confirmed -> the webhook answers 500 and Razorpay retries
  await Payment.Issue.updateOne(
    { provider: 'razorpay', paymentId: String(paymentId), reason },
    { $setOnInsert: { orderId, amount, currency, bill, payment, detail } },
    { upsert: true },
  ).catch((e) => { if (e?.code !== 11000) throw e; });
  console.error(`[payments] Razorpay payment ${paymentId} needs review: ${reason}`);
}

// ── Razorpay-verified receipt ────────────────────────────────────
// Idempotent on the gateway's payment id: the app's verify call and the
// webhook can both arrive (in any order, at once, or retried) and it is
// recorded once. The amount recorded is what was actually captured when
// known (the webhook), else the order's amount (the app's verify call —
// Razorpay captures an order's full amount; part-payments are not enabled).
// The money was really taken, so it is always recorded — if it pushes the
// bill over its total (cash was recorded after the order was made), the
// bill shows as overpaid for a person to settle; nothing is discarded.
async function applyProviderPayment(bill, { paymentId, orderId, amountPaise, orderAmountPaise, capturedAt }) {
  await requireIndexes();
  const existing = await Payment.findOne({ 'provider.paymentId': paymentId });
  if (existing) {
    if (amountPaise && existing.amountPaise !== amountPaise) {
      await noteProviderIssue({ paymentId, orderId, reason: 'amount_differs_from_recorded', amount: amountPaise, currency: 'INR', bill: bill._id, payment: existing._id, detail: { recordedPaise: existing.amountPaise } });
    }
    return Bill.findById(bill._id);
  }
  const amount = amountPaise || orderAmountPaise || bill.razorpayOrderAmountPaise || toPaise(bill.grandTotal);
  const fy = financialYear();
  await ensureCounter(fy);
  const session = await Payment.startSession();
  try {
    await session.withTransaction(async () => {
      await Trip.updateOne({ _id: bill.trip }, { $inc: { paymentRev: 1 } }, { session });
      const fresh = await Bill.findById(bill._id).session(session);
      const receiptNumber = await nextReceiptNumber(session, fy);
      await Payment.create([{
        receiptNumber, trip: fresh.trip, bill: fresh._id, kind: 'payment', amountPaise: amount, method: 'online',
        reference: paymentId, receivedAt: capturedAt || new Date(), verification: 'provider_verified',
        provider: { name: 'razorpay', paymentId, orderId, orderAmountPaise: orderAmountPaise || undefined },
      }], { session });
      const paidPaise = (toPaise(fresh.paidAmount) || 0) + amount;
      const status = statusFor(paidPaise, toPaise(fresh.grandTotal));
      await Bill.updateOne({ _id: fresh._id }, {
        $set: { paidAmount: toRupees(paidPaise), paymentStatus: status, paymentMode: 'online', razorpayPaymentId: paymentId, ...(status === 'paid' ? { paidAt: new Date() } : {}) },
      }, { session });
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // The same payment recorded concurrently by the other callback — fine,
    // provided it really is that payment.
    if (!(await Payment.exists({ 'provider.paymentId': paymentId }))) throw err;
  } finally {
    await session.endSession();
  }
  return Bill.findById(bill._id);
}

// ── Totals for Dashboard / Finance / Billing ─────────────────────
// The India calendar month containing `at`: [start, end).
function istMonth(at = new Date()) {
  const d = new Date(new Date(at).getTime() + IST_MS);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_MS;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST_MS;
  return { start: new Date(start), end: new Date(end) };
}

// Billed revenue (bills raised in the period) and cash collected (money
// received in the period) are different things and reported apart.
//   collected        receipts received in the period — the only collections
//                    with a verified date. Amounts on older bills with no
//                    receipt behind them are never put in any month: they are
//                    "collection timing unverified", reported on their own.
//   outstanding      collectible from customers now — bills NOT billed to a
//                    hospital.
//   hospital         invoices not marked paid (their net payable, after the
//                    tie-up discount). The bills inside them are not also
//                    counted as outstanding, so nothing is counted twice.
// Income ledger entries are not used here (they are not reconciled).
async function collectionTotals({ from, to }) {
  const [bills, invoices, sumsRows] = await Promise.all([
    Bill.find({}).select('grandTotal paidAmount paymentStatus invoiceId paidAt createdAt').lean(),
    HospitalInvoice.find({}).select('bills status netPayable').lean(),
    Payment.aggregate([{ $match: { bill: { $ne: null } } }, { $group: { _id: '$bill', paise: { $sum: '$amountPaise' } } }]),
  ]);
  const sums = new Map(sumsRows.map((r) => [String(r._id), r.paise]));
  const invoiced = new Set(invoices.flatMap((i) => (i.bills || []).map(String)));
  const inPeriod = (d) => d && new Date(d) >= from && new Date(d) < to;

  let billedPaise = 0; let billedCount = 0; let outstandingPaise = 0; let reconcileCount = 0;
  let unverifiedPaise = 0; let unverifiedBills = 0; let invoicedBillCount = 0; let invoicedBillsGrossPaise = 0;
  for (const b of bills) {
    const bal = balanceOf(b, sums.get(String(b._id)) || 0, { onInvoice: invoiced.has(String(b._id)) });
    if (inPeriod(b.createdAt)) { billedPaise += bal.totalPaise; billedCount += 1; }
    outstandingPaise += bal.collectiblePaise;
    if (bal.onHospitalInvoice) { invoicedBillCount += 1; invoicedBillsGrossPaise += bal.totalPaise; }
    if (bal.reconcile.length) reconcileCount += 1;
    if (bal.notItemisedPaise > 0) { unverifiedPaise += bal.notItemisedPaise; unverifiedBills += 1; }
  }
  const openInvoices = invoices.filter((i) => i.status !== 'paid');
  const hospitalReceivablePaise = openInvoices.reduce((s, i) => s + (toPaise(i.netPayable) || 0), 0);
  // Money in: receipts net of reversals. Refunds are money OUT, reported apart.
  const byVerification = await Payment.aggregate([
    { $match: { receivedAt: { $gte: from, $lt: to }, kind: { $ne: 'refund' } } },
    { $group: { _id: '$verification', paise: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
  ]);
  const v = Object.fromEntries(byVerification.map((r) => [r._id, r.paise]));
  // Reversals made in the period (already netted into collected above,
  // because their amounts are negative and dated when they were made).
  const [rev] = await Payment.aggregate([
    { $match: { kind: 'reversal', receivedAt: { $gte: from, $lt: to } } },
    { $group: { _id: null, paise: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
  ]);
  const [ref] = await Payment.aggregate([
    { $match: { kind: 'refund', receivedAt: { $gte: from, $lt: to } } },
    { $group: { _id: null, paise: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
  ]);
  const [held] = await Payment.aggregate([{ $match: { bill: null } }, { $group: { _id: null, paise: { $sum: '$amountPaise' } } }]);
  const providerIssues = await Payment.Issue.countDocuments({ resolvedAt: null });
  return {
    period: { from, to },
    billedPaise, billedCount,
    collectedPaise: (v.staff_recorded || 0) + (v.provider_verified || 0), // net of reversals
    reversedPaise: -(rev?.paise || 0),
    reversalsCount: rev?.n || 0,
    // Refunds paid out to customers in the period (positive figure), and
    // what that leaves: collected − refunded.
    refundedPaise: -(ref?.paise || 0),
    refundsCount: ref?.n || 0,
    netCollectedPaise: (v.staff_recorded || 0) + (v.provider_verified || 0) + (ref?.paise || 0),
    collectedStaffRecordedPaise: v.staff_recorded || 0,
    collectedProviderVerifiedPaise: v.provider_verified || 0,
    // All-time, not in any month: recorded as received, timing unverified.
    collectionTimingUnverifiedPaise: unverifiedPaise,
    collectionTimingUnverifiedBills: unverifiedBills,
    outstandingPaise,
    hospital: {
      receivablePaise: hospitalReceivablePaise,
      openInvoices: openInvoices.length,
      byStatus: Object.fromEntries(['draft', 'sent', 'overdue'].map((s) => [s, openInvoices.filter((i) => i.status === s).reduce((t, i) => t + (toPaise(i.netPayable) || 0), 0)])),
      invoicedBills: invoicedBillCount,
      invoicedBillsGrossPaise,
    },
    advancesHeldPaise: held?.paise || 0,
    reconcileCount,
    providerIssues,
    incomeLedgerReconciled: false,
  };
}

module.exports = {
  istMonth, collectionTotals, balanceOf, invoicedBills, recordPayment, applyAdvancesToNewBill, applyProviderPayment,
  noteProviderIssue, receiptsTotal, financialYear, indexesReady, requireIndexes, PaymentRefused,
  reversePayment, reversalBlock, withReversalLinks, REASON_MIN, recordRefund,
  _resetIndexCheck: () => { indexState = { ok: false, checkedAt: 0, error: null }; },
};
