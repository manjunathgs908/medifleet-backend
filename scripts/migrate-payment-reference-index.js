/**
 * scripts/migrate-payment-reference-index.js
 * ============================================================
 * One-time, run by a person (e.g. Render shell), not by the app:
 * retires the first payment release's unique { method, reference } index
 * so a genuine payment can reuse the reference of a REVERSED mistaken
 * receipt. The replacement protection is created and verified first —
 * the unique { method, reference, refSeq } index, the one-reversal index,
 * and the stored data (at most one unreversed receipt per reference,
 * refSeq slots none,1,2,…) — and the old index is dropped only if all of
 * that checks out. Creates, changes or deletes no payment.
 *
 *   node scripts/migrate-payment-reference-index.js           # --check: read-only report
 *   node scripts/migrate-payment-reference-index.js --apply   # create, verify, then drop the old index
 *
 * Safe to rerun, and safe if interrupted at any point or run by two
 * processes at once. Exit code 0 = ready (and, with --apply, migrated).
 * Rollback note: once a reference has been reused after this, the
 * previous backend (78ec1fa) cannot rebuild its old index and will refuse
 * all payments — roll forward instead (see the release notes).
 * ============================================================
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const migration = require('../services/paymentIndexMigration');

(async () => {
  const apply = process.argv.includes('--apply');
  const stopAfter = (process.argv.find((a) => a.startsWith('--stop-after=')) || '').split('=')[1] || undefined; // rehearsal only
  await mongoose.connect(process.env.MONGO_URI);
  const result = apply
    ? await migration.migrate({ stopAfter, log: (m) => console.log(`[migrate] ${m}`) })
    : await migration.readiness();
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'check', ...result }, null, 2));
  await mongoose.disconnect();
  process.exit(result.ready && (!apply || result.migrated || result.stopped) ? 0 : 1);
})().catch(async (err) => {
  console.error(`[migrate] failed: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
