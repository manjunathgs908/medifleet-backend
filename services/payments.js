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
// minute after a failure.
const REQUIRED_INDEXES = [
  [Payment, { receiptNumber: 1 }, null],
  [Payment, { requestId: 1 }, 'requestId'],
  [Payment, { 'provider.paymentId': 1 }, 'provider.paymentId'],
  [Payment, { method: 1, reference: 1 }, 'reference'],
  [Payment.Issue, { provider: 1, paymentId: 1, reason: 1 }, null],
];
let indexState = { ok: false, checkedAt: 0, error: null };
const INDEX_RETRY_MS = 60 * 1000;
async function indexesReady() {
  if (indexState.ok) return true;
  if (indexState.checkedAt && Date.now() - indexState.checkedAt < INDEX_RETRY_MS) return false;
  try {
    await Payment.createIndexes();
    await Payment.Issue.createIndexes();
    const missing = [];
    for (const [model, key, partialField] of REQUIRED_INDEXES) {
      const list = await model.collection.indexes();
      const found = list.find((ix) => JSON.stringify(ix.key) === JSON.stringify(key) && ix.unique === true
        && (!partialField || ix.partialFilterExpression?.[partialField]));
      if (!found) missing.push(`${model.modelName} ${JSON.stringify(key)}`);
    }
    if (missing.length) throw new Error(`unique index not confirmed: ${missing.join(', ')}`);
    indexState = { ok: true, checkedAt: Date.now(), error: null };
    return true;
  } catch (err) {
    indexState = { ok: false, checkedAt: Date.now(), error: err.message };
    console.error(`[payments] NOT recording payments — uniqueness protection could not be confirmed: ${err.message}`);
    return false;
  }
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

  const refTaken = async () => {
    const dup = reference && await Payment.findOne({ method, reference }).select('receiptNumber trip');
    return dup && new PaymentRefused(409, `That reference is already on receipt ${dup.receiptNumber}${String(dup.trip) === String(tripId) ? '' : ' for another trip'} — check it is not the same payment.`);
  };
  const taken = await refTaken();
  if (taken) throw taken;

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

      const receiptNumber = await nextReceiptNumber(session, fy);
      const [payment] = await Payment.create([{
        receiptNumber, trip: trip._id, bill: bill?._id, kind, amountPaise, method,
        reference: reference || undefined, receivedAt, note: note || undefined,
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
    // The same reference committed by someone else at the same moment.
    if (err?.code === 11000 && /reference/.test(err.message || '')) {
      const dup = await refTaken();
      if (dup) throw dup;
    }
    throw err;
  } finally {
    await session.endSession();
  }
  return result;
}

// ── Inside trip completion's transaction ─────────────────────────
// Only for a bill created in that same transaction: its paidAmount
// becomes the advances already received, and they are linked to it.
async function applyAdvancesToNewBill(trip, bill, session) {
  await Trip.updateOne({ _id: trip._id }, { $inc: { paymentRev: 1 } }, { session });
  const advances = await Payment.find({ trip: trip._id, bill: null }).session(session).sort({ receivedAt: 1 });
  if (!advances.length) return bill;
  const paidPaise = advances.reduce((s, p) => s + p.amountPaise, 0);
  const totalPaise = toPaise(bill.grandTotal);
  bill.paidAmount = toRupees(paidPaise);
  bill.paymentStatus = statusFor(paidPaise, totalPaise);
  bill.paymentMode = advances.at(-1).method;
  if (bill.paymentStatus === 'paid') bill.paidAt = advances.at(-1).receivedAt;
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
  const byVerification = await Payment.aggregate([
    { $match: { receivedAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$verification', paise: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
  ]);
  const v = Object.fromEntries(byVerification.map((r) => [r._id, r.paise]));
  const [held] = await Payment.aggregate([{ $match: { bill: null } }, { $group: { _id: null, paise: { $sum: '$amountPaise' } } }]);
  const providerIssues = await Payment.Issue.countDocuments({ resolvedAt: null });
  return {
    period: { from, to },
    billedPaise, billedCount,
    collectedPaise: (v.staff_recorded || 0) + (v.provider_verified || 0),
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
  _resetIndexCheck: () => { indexState = { ok: false, checkedAt: 0, error: null }; },
};
