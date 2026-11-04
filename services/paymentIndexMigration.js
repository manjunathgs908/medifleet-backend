'use strict';
/**
 * services/paymentIndexMigration.js
 * ============================================================
 * Uniqueness protection for receipts, and the one-time retirement of the
 * first release's reference index. Nothing here creates, changes or
 * removes a payment.
 *
 * The invariant: for each (method, reference) at most ONE receipt that has
 * not been reversed. A unique index on (method, reference, refSeq) alone
 * does not give that — two receipts with different refSeq would both be
 * accepted. It holds because, in addition:
 *   - a receipt reusing a reference gets refSeq = the number of earlier
 *     receipts with it (first use: no refSeq), and is written only if
 *     every earlier one was reversed — decided inside the recording
 *     transaction (services/payments.js recordPayment);
 *   - so the refSeq values in use are always "none, 1, 2, … n-1": any
 *     writer that missed a receipt computes a slot that is already taken
 *     and the unique index refuses it; any writer that saw the live
 *     receipt refuses itself;
 *   - refSeq is never stored as 0 or anything but a whole number ≥ 1
 *     (models/Payment.js), so "no refSeq" is the only first-use slot.
 * verifyProtections() checks the indexes AND that the stored data still
 * satisfies this (dense slots, at most one live receipt per reference).
 *
 * Migration — run by a person (scripts/migrate-payment-reference-index.js),
 * never by the app during payment traffic:
 *   1. create the new indexes (non-destructive; the app also does this);
 *   2. verify them and the data;
 *   3. only then drop the old { method, reference } index (another process
 *      having dropped it already is fine).
 * Until step 3 the old index stays: payments work exactly as before, and
 * reusing a reversed receipt's reference is refused with a clear message.
 * ============================================================
 */
const Payment = require('../models/Payment');

const OLD_INDEX = 'method_1_reference_1';
const REQUIRED = [
  [Payment, 'receiptNumber_1', { receiptNumber: 1 }, null],
  [Payment, 'requestId_1', { requestId: 1 }, 'requestId'],
  [Payment, 'provider.paymentId_1', { 'provider.paymentId': 1 }, 'provider.paymentId'],
  [Payment, 'method_1_reference_1_refSeq_1', { method: 1, reference: 1, refSeq: 1 }, 'reference'],
  [Payment, 'reverses_1', { reverses: 1 }, 'reverses'],
  [Payment.Issue, 'provider_1_paymentId_1_reason_1', { provider: 1, paymentId: 1, reason: 1 }, null],
];

async function indexReport() {
  const lists = new Map();
  for (const model of [Payment, Payment.Issue]) {
    // A collection that does not exist yet has no indexes.
    lists.set(model, await model.collection.indexes().catch((e) => { if (e?.codeName === 'NamespaceNotFound') return []; throw e; }));
  }
  const required = REQUIRED.map(([model, name, key, partialField]) => {
    const ix = lists.get(model).find((i) => JSON.stringify(i.key) === JSON.stringify(key));
    const ok = !!ix && ix.unique === true && (!partialField || !!ix.partialFilterExpression?.[partialField]);
    return { name, ok };
  });
  const old = lists.get(Payment).find((i) => i.name === OLD_INDEX);
  return { required, oldIndexPresent: !!old };
}

// Every (method, reference) in use: refSeq slots dense from "none", values
// whole numbers ≥ 1, and at most one receipt not reversed.
async function dataReport() {
  const rows = await Payment.aggregate([
    { $match: { reference: { $type: 'string' }, kind: { $ne: 'reversal' } } },
    { $lookup: { from: Payment.collection.name, localField: '_id', foreignField: 'reverses', as: 'rev' } },
    { $group: {
      _id: { method: '$method', reference: '$reference' },
      slots: { $push: { $ifNull: ['$refSeq', null] } },
      live: { $sum: { $cond: [{ $gt: [{ $size: '$rev' }, 0] }, 0, 1] } },
      n: { $sum: 1 },
    } },
  ]);
  const anomalies = [];
  let reused = 0;
  for (const r of rows) {
    const label = `${r._id.method} ${r._id.reference}`;
    if (r.n > 1) reused += 1;
    if (r.live > 1) anomalies.push(`${label}: ${r.live} receipts not reversed`);
    const bad = r.slots.filter((s) => s !== null && !(Number.isInteger(s) && s >= 1));
    if (bad.length) anomalies.push(`${label}: invalid refSeq ${JSON.stringify(bad)}`);
    const want = [null, ...Array.from({ length: r.n - 1 }, (_, i) => i + 1)];
    const got = [...r.slots].sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b));
    if (!bad.length && JSON.stringify(got) !== JSON.stringify(want)) anomalies.push(`${label}: refSeq slots ${JSON.stringify(got)} are not none,1..${r.n - 1}`);
  }
  return { references: rows.length, reusedReferences: reused, anomalies };
}

// Read-only. ready = every required unique index confirmed and the data
// satisfies the invariant. referenceReuseAvailable = the old index is gone.
async function readiness() {
  const [ix, data] = [await indexReport(), await dataReport()];
  const missing = ix.required.filter((r) => !r.ok).map((r) => r.name);
  return {
    ready: !missing.length && !data.anomalies.length,
    missingIndexes: missing,
    oldIndexPresent: ix.oldIndexPresent,
    referenceReuseAvailable: !missing.length && !data.anomalies.length && !ix.oldIndexPresent,
    data,
  };
}

// For the app before it records anything: create (never drop), then verify.
async function verifyProtections() {
  await Payment.createIndexes();
  await Payment.Issue.createIndexes();
  const r = await readiness();
  if (r.missingIndexes.length) throw new Error(`unique index not confirmed: ${r.missingIndexes.join(', ')}`);
  if (r.data.anomalies.length) throw new Error(`receipt references break the one-live-receipt rule: ${r.data.anomalies.slice(0, 5).join('; ')}`);
  return r;
}

// The explicit migration (script). `stopAfter` ('create' | 'verify') ends
// early — for rehearsing an interruption; rerunning continues safely.
async function migrate({ stopAfter, log = () => {} } = {}) {
  log('step 1: creating the new indexes (non-destructive)');
  await Payment.createIndexes();
  await Payment.Issue.createIndexes();
  if (stopAfter === 'create') return { stopped: 'create', ...(await readiness()) };
  log('step 2: verifying indexes and stored receipts');
  const before = await readiness();
  if (before.missingIndexes.length || before.data.anomalies.length) {
    log('NOT dropping the old index: protection not verified');
    return { migrated: false, ...before };
  }
  if (stopAfter === 'verify') return { stopped: 'verify', ...before };
  if (before.oldIndexPresent) {
    log(`step 3: dropping ${OLD_INDEX}`);
    await Payment.collection.dropIndex(OLD_INDEX).catch((e) => {
      if (e?.codeName !== 'IndexNotFound' && e?.code !== 27) throw e; // another process dropped it first
      log(`${OLD_INDEX} was already dropped`);
    });
  } else {
    log(`step 3: ${OLD_INDEX} already gone — nothing to drop`);
  }
  const after = await readiness();
  return { migrated: after.referenceReuseAvailable, ...after };
}

module.exports = { readiness, verifyProtections, migrate, OLD_INDEX };
