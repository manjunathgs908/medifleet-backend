/**
 * scripts/create-call-history-indexes.js
 * ============================================================
 * Two additive, non-unique indexes for the Call Logs views and the
 * lead-booking check. Run by a person, at a quiet hour — NOT by the app:
 * they are deliberately not declared in the schemas, because Mongoose
 * autoIndex (on by default, config/db.js does not turn it off) would then
 * build them on production the moment the new backend starts.
 *
 *   calllogs  { startedAt: -1, _id: -1 }            name startedAt_-1__id_-1
 *     "All call events" (newest first), period totals, "By customer" for a
 *     period, and main's existing GET /api/calls/performance date range —
 *     all of which scan the whole collection today.
 *   trips     { leadId: 1 }  partial: leadId exists  name leadId_1
 *     "does a trip already carry this lead?" on every booking from a lead
 *     (services/leadBooking.js) — a scan of every trip today. Partial, so
 *     only trips booked from a lead are in it.
 *
 * What can and cannot go wrong
 *   - Duplicate values are NOT a blocker: neither index is unique.
 *   - Neither changes what any query returns — only how fast. The app works
 *     without them (slower), so the order relative to the deploy is free.
 *   - A build CAN still fail or be aborted, and the report says so:
 *       * permissions — the database user needs the createIndex action
 *         (e.g. readWrite or dbAdmin on the database; Atlas "readWriteAnyDatabase");
 *       * resources — not enough free disk for the new index (about 5 MB per
 *         200,000 calls measured locally), or the build is interrupted
 *         (primary step-down / failover, a restart, killOp);
 *       * a conflicting index — the same name with a different key or
 *         options (IndexOptionsConflict / IndexKeySpecsConflict). The check
 *         below reports this BEFORE building and --apply skips it.
 *     A failed or aborted build leaves no partial index behind; rerun later.
 *   - During the build reads and writes continue; the build uses extra CPU
 *     and I/O, and MongoDB keeps an exclusive lock only briefly at its start
 *     and end.
 *
 *   node scripts/create-call-history-indexes.js            # read-only report (default)
 *   node scripts/create-call-history-indexes.js --apply    # create the missing ones
 *
 * The report lists each collection's document count, data size and current
 * indexes, and for each proposed index: present / missing / conflict.
 * Safe to rerun (an identical index is left alone). Creates, changes or
 * deletes no document. Exit code: 0 = all present (after --apply: created);
 * 1 = some missing (check mode); 3 = a conflict or a failed build; 2 = could
 * not connect.
 * Rollback: db.calllogs.dropIndex('startedAt_-1__id_-1'),
 *           db.trips.dropIndex('leadId_1') — no data is affected.
 * ============================================================
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

const PROPOSED = [
  { collection: 'calllogs', key: { startedAt: -1, _id: -1 }, options: { name: 'startedAt_-1__id_-1' } },
  { collection: 'trips', key: { leadId: 1 }, options: { name: 'leadId_1', partialFilterExpression: { leadId: { $exists: true } } } },
];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const specOf = (i) => ({ key: i.key, partial: i.partialFilterExpression, unique: !!i.unique, sparse: !!i.sparse });

// present | equivalent (same spec, other name) | conflict | missing
function stateOf(p, existing) {
  const want = specOf({ key: p.key, partialFilterExpression: p.options.partialFilterExpression });
  const byName = existing.find((i) => i.name === p.options.name);
  if (byName) return same(specOf(byName), want) ? { state: 'present' } : { state: 'conflict', detail: `an index named ${p.options.name} exists with a different key or options` };
  const twin = existing.find((i) => same(specOf(i), want));
  if (twin) return { state: 'present', detail: `an identical index exists as ${twin.name}` };
  const sameKey = existing.find((i) => same(i.key, p.key));
  if (sameKey) return { state: 'conflict', detail: `${sameKey.name} has the same key with different options` };
  return { state: 'missing' };
}

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const report = [];
  for (const p of PROPOSED) {
    const coll = db.collection(p.collection);
    const stats = await db.command({ collStats: p.collection }).catch(() => null);
    const existing = await coll.indexes().catch(() => []);
    const s = stateOf(p, existing);
    const row = {
      collection: p.collection,
      documents: stats?.count ?? null,
      dataMB: stats ? +(stats.size / 1048576).toFixed(1) : null,
      currentIndexes: existing.map((i) => i.name),
      proposed: p.options.name,
      ...s,
    };
    if (apply && s.state === 'missing') {
      const t = Date.now();
      try {
        await coll.createIndex(p.key, p.options);
        row.state = 'created';
        row.buildMs = Date.now() - t;
        const after = await db.command({ collStats: p.collection });
        row.indexSizeKB = Math.round((after.indexSizes?.[p.options.name] || 0) / 1024);
      } catch (err) {
        // permissions, disk, an interrupted build, a conflict created meanwhile
        row.state = 'failed';
        row.detail = `${err.codeName || err.code || 'error'}: ${err.message}`;
      }
    }
    report.push(row);
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'check', report }, null, 2));
  await mongoose.disconnect();
  const bad = report.some((r) => ['conflict', 'failed'].includes(r.state));
  process.exit(bad ? 3 : report.every((r) => ['present', 'created'].includes(r.state)) ? 0 : 1);
})().catch(async (err) => {
  console.error(`[indexes] failed: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
