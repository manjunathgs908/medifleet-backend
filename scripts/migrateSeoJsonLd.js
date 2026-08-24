/**
 * scripts/migrateSeoJsonLd.js
 * ============================================================
 * ONE-OFF MIGRATION, and an optional one.
 *
 * SeoArticle used to store its JSON-LD blocks in a path called `schema`.
 * `schema` is a reserved name on a Mongoose document — it is how a document
 * finds its own definition — so the path shadowed it and any property access
 * on a hydrated document threw. The path is now `jsonLd`.
 *
 * models/SeoArticle.js reads BOTH names, so the API works with or without
 * this script having run: a pre-rename document is normalised as it loads and
 * still serialises with both keys. Nothing is waiting on this. It only tidies
 * the storage so there is one shape in the collection instead of two.
 *
 * ── Two steps, deliberately ──────────────────────────────────
 *
 * STEP 1 (--apply) COPIES schema into jsonLd. It does not delete anything.
 * Afterwards every document carries both keys, the old value is still exactly
 * where it was, and rolling back is "do nothing". This is the step you run
 * against production.
 *
 * STEP 2 (--cleanup --apply) drops the now-redundant `schema` key, and only
 * from documents where it is byte-identical to `jsonLd`. Run it days later,
 * once step 1 has proven itself. Skipping it forever is a valid choice: a
 * duplicated key costs storage and nothing else.
 *
 * Splitting them is the whole point. A single $rename would move the value in
 * one shot with no window in which both copies exist, so a mistake would have
 * nothing left to recover from.
 *
 * Both steps are read-only without --apply, and both are re-runnable: their
 * filters exclude everything they have already done.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

// The model is required only for its collection name, so this cannot drift
// from what the app actually reads. Its compatibility layer is bypassed
// below: this script is about the raw stored shape, and the model exists to
// hide exactly that.
const SeoArticle = require('../models/SeoArticle');

// Fail fast and legibly rather than dumping a topology description after 30s.
const CONNECT_OPTS = { serverSelectionTimeoutMS: 10000 };

// ── Filters ──────────────────────────────────────────────────
// Every write below is driven by one of these. None of them can match a
// document that has already been dealt with, which is what makes both steps
// safe to re-run.

// Step 1: the old key is present and the new one is genuinely absent.
// `$exists: false` is what guarantees an existing jsonLd is never overwritten
// — a document with any jsonLd value at all, including null, is not matched.
const NEEDS_COPY = { schema: { $exists: true }, jsonLd: { $exists: false } };

// Step 2: both keys present AND identical. A document whose two copies have
// diverged is deliberately excluded — that is a fact to investigate, not a
// key to silently drop.
const SAFE_TO_DROP = {
  schema: { $exists: true },
  jsonLd: { $exists: true },
  $expr: { $eq: ['$schema', '$jsonLd'] },
};

const DIVERGED = {
  schema: { $exists: true },
  jsonLd: { $exists: true },
  $expr: { $ne: ['$schema', '$jsonLd'] },
};

// Host only, so a run can be pinned to a cluster without the credentials
// ending up in a terminal scrollback or a CI log.
function safeTarget(uri) {
  try {
    const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop().split('/')[0];
    const db = uri.split('/').pop().split('?')[0];
    return `${host}/${db || '(default)'}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}

// Flags are read per call, not at require time, so the mode is an argument
// rather than global state — which is what lets the write paths be tested.
async function main(argv = process.argv.slice(2)) {
  const APPLY = argv.includes('--apply');
  const CLEANUP = argv.includes('--cleanup');

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set.');

  const mode = CLEANUP ? 'STEP 2 — drop redundant `schema`' : 'STEP 1 — copy `schema` into `jsonLd`';
  console.log(`${mode}`);
  console.log(`Target : ${safeTarget(process.env.MONGO_URI)}`);
  console.log(`Mode   : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (read-only, writes nothing)'}\n`);

  await mongoose.connect(process.env.MONGO_URI, CONNECT_OPTS);
  const col = mongoose.connection.db.collection(SeoArticle.collection.collectionName);

  const total = await col.countDocuments({});
  const needsCopy = await col.countDocuments(NEEDS_COPY);
  const safeToDrop = await col.countDocuments(SAFE_TO_DROP);
  const diverged = await col.countDocuments(DIVERGED);
  const alreadyDone = await col.countDocuments({ jsonLd: { $exists: true }, schema: { $exists: false } });

  console.log(`${SeoArticle.collection.collectionName}: ${total} document(s) total`);
  console.log(`  legacy, schema only ......... ${needsCopy}`);
  console.log(`  both keys, identical ........ ${safeToDrop}`);
  console.log(`  both keys, DIVERGED ......... ${diverged}`);
  console.log(`  jsonLd only, fully migrated . ${alreadyDone}`);

  if (diverged) {
    console.log('\n  ! Diverged documents are never written to by either step.');
    const sample = await col.find(DIVERGED, { projection: { slug: 1 } }).limit(5).toArray();
    console.log(`    e.g. ${sample.map((d) => d.slug).join(', ')}`);
  }

  const target = CLEANUP ? safeToDrop : needsCopy;
  const verb = CLEANUP ? 'would have their redundant `schema` key dropped' : 'would be migrated';
  console.log(`\n==> ${target} document(s) ${verb}.`);

  if (target === 0) {
    console.log(CLEANUP ? '\nNothing to clean up.' : '\nNothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    const sample = await col.findOne(CLEANUP ? SAFE_TO_DROP : NEEDS_COPY, { projection: { slug: 1, title: 1 } });
    if (sample) console.log(`Example: ${sample.slug} — "${sample.title}"`);
    console.log(`\nDry run: nothing was written. Re-run with --apply${CLEANUP ? ' --cleanup' : ''} to write.`);
    await mongoose.disconnect();
    return;
  }

  // ── Writes start here, and only here ───────────────────────
  if (!CLEANUP) {
    // A copy, not a move. `schema` is untouched: after this every matched
    // document holds the same value under both keys.
    const res = await col.updateMany(NEEDS_COPY, [{ $set: { jsonLd: '$schema' } }]);
    console.log(`\nCopied into jsonLd: ${res.modifiedCount} document(s) (matched ${res.matchedCount}).`);

    // Read back. A write count is what the driver was told, not what is now
    // in the collection.
    const stillLegacy = await col.countDocuments(NEEDS_COPY);
    const nowDiverged = await col.countDocuments(DIVERGED);
    console.log(`Readback: ${stillLegacy} still schema-only, ${nowDiverged} diverged.`);
    if (stillLegacy) throw new Error(`${stillLegacy} document(s) were not copied — investigate before re-running.`);
    if (nowDiverged > diverged) throw new Error('A copy produced a mismatched value — STOP and investigate.');

    console.log('\nStep 1 done. Every legacy document now carries both keys, and');
    console.log('nothing has been deleted. Verify the SEO Studio, then run step 2');
    console.log('later if you want the duplicate key gone:');
    console.log('  node scripts/migrateSeoJsonLd.js --cleanup');
  } else {
    if (needsCopy) {
      throw new Error(`${needsCopy} document(s) still have schema only. Run step 1 first.`);
    }
    const res = await col.updateMany(SAFE_TO_DROP, { $unset: { schema: '' } });
    console.log(`\nDropped redundant schema key: ${res.modifiedCount} document(s).`);

    const remaining = await col.countDocuments({ schema: { $exists: true } });
    const withJsonLd = await col.countDocuments({ jsonLd: { $exists: true } });
    console.log(`Readback: ${withJsonLd} with jsonLd, ${remaining} still carrying schema.`);
    if (remaining !== diverged) {
      throw new Error(`Expected only the ${diverged} diverged document(s) to keep a schema key, found ${remaining}.`);
    }
    console.log('\nStep 2 done.');
  }

  await mongoose.disconnect();
}

// Exported so the write paths can be exercised against a stub collection in
// tests/migrateSeoJsonLd.test.js. A migration nobody can test until it is
// pointed at production is not a safe migration.
module.exports = { main, NEEDS_COPY, SAFE_TO_DROP, DIVERGED };

// Requiring this file — from a test, or from another script — must never
// start a migration. Only running it does.
if (require.main === module) {
  main().catch((err) => {
    // Connectivity is the usual failure here, and the driver answers it with
    // a page of topology. Say the useful thing instead.
    if (/ServerSelection|ReplicaSetNoPrimary|ETIMEDOUT|ENOTFOUND/i.test(err.message || '')) {
      console.error('\nCould not reach MongoDB. Nothing was read and nothing was written.');
      console.error('Run this from an allowlisted environment (a Render shell), not a laptop.');
      console.error(`\n(${err.message})`);
    } else {
      console.error('\nMigration failed:', err.message);
    }
    process.exit(1);
  });
}
