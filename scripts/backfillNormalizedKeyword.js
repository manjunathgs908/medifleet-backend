/**
 * scripts/backfillNormalizedKeyword.js
 * ============================================================
 * Populate normalizedKeyword on articles written before the field existed.
 *
 *   node scripts/backfillNormalizedKeyword.js            # dry run
 *   node scripts/backfillNormalizedKeyword.js --apply
 *
 * DRY RUN BY DEFAULT, same contract as migrateSeoJsonLd.js.
 *
 * Why this is needed: the duplicate-keyword pre-flight in seoGenerator.js
 * queries findOne({ normalizedKeyword }), which cannot match a document that
 * does not carry the field. Every article generated before the field shipped
 * is therefore invisible to it, and regenerating one of those keywords
 * creates another copy with no warning — the exact failure the feature was
 * built to stop.
 *
 * Why it is not a plain updateMany: normalizedKeyword is UNIQUE. Two articles
 * already share a keyword, so writing the computed value to both would fail
 * on the second write with E11000.
 *
 * The resolution, and the reason nothing is deleted: the index is also
 * SPARSE. A document without the field is simply not in the index. So each
 * colliding group gets exactly one winner written, and the losers are left
 * with no field at all — present, intact, unindexed. The pre-flight finds the
 * winner and refuses the regeneration, which is the behaviour that was
 * wanted; the losers keep their content, their status and their history.
 *
 * Deciding which article "owns" a keyword is a data question with a defensible
 * answer (see WINNER RULE). Deciding whether a loser should exist at all is an
 * editorial question, and this script does not touch it.
 *
 * WRITES: normalizedKeyword, and nothing else. Never status, content, faqs,
 * checks, slug, corrections or anything on the document. Never a delete.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');

const APPLY = process.argv.includes('--apply');

// ── WINNER RULE ───────────────────────────────────────────────
// Lower rank wins. An approved or published article is the one the outside
// world may already have seen, so it owns its keyword. Between two unpublished
// articles a draft outranks a rejection, because a rejection is a decision
// against that article rather than a candidate. Ties fall to the oldest, which
// is the one the later duplicate was a re-run OF.
const STATUS_RANK = { published: 0, approved: 0, draft: 1, in_review: 1, rejected: 2 };
const rankOf = (s) => (s in STATUS_RANK ? STATUS_RANK[s] : 3);

const stamp = (d) => (d?.createdAt instanceof Date ? d.createdAt.getTime() : null);

/**
 * Order a group best-first, then say whether the top place is unambiguous.
 * Ambiguous means: same status rank AND no usable createdAt to separate them.
 * The script aborts on ambiguity rather than picking one, because a coin toss
 * here silently decides which article owns a keyword forever.
 */
function pickWinner(group) {
  const sorted = [...group].sort((a, b) => {
    const r = rankOf(a.status) - rankOf(b.status);
    if (r !== 0) return r;
    const ta = stamp(a); const tb = stamp(b);
    if (ta === null || tb === null) return 0;
    return ta - tb;
  });

  if (sorted.length === 1) return { winner: sorted[0], losers: [], ambiguous: false, reason: 'only article for this keyword' };

  const [first, second] = sorted;
  const sameRank = rankOf(first.status) === rankOf(second.status);
  const t1 = stamp(first); const t2 = stamp(second);
  const undecidable = sameRank && (t1 === null || t2 === null || t1 === t2);

  return {
    winner: undecidable ? null : first,
    losers: undecidable ? [] : sorted.slice(1),
    ambiguous: undecidable,
    reason: sameRank
      ? `same status (${first.status}), older createdAt wins`
      : `status ${first.status} outranks ${second.status}`,
    // Two live articles for one keyword is not a tie to break, it is a problem
    // to report: both may be indexed by Google right now.
    bothPublic: rankOf(first.status) === 0 && rankOf(second.status) === 0,
    sorted,
  };
}

const line = (d, tag) =>
  `      ${tag.padEnd(8)} ${String(d.slug).padEnd(48)} [${String(d.status).padEnd(9)}] created ${d.createdAt?.toISOString?.().slice(0, 19) || '(none)'}  _id=${d._id}`;

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Nothing was attempted.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const docs = await SeoArticle.find({}, 'slug status keyword normalizedKeyword createdAt').lean();
    console.log(`\nMode     : ${APPLY ? 'APPLY — writes normalizedKeyword' : 'DRY RUN — writes nothing'}`);
    console.log(`Articles : ${docs.length}\n`);

    // ── Group by the computed key ───────────────────────────────
    const groups = new Map();
    for (const d of docs) {
      const key = SeoArticle.normaliseKeyword(d.keyword);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }

    const plan = [];
    let ambiguousCount = 0;
    let alreadySet = 0;

    console.log('='.repeat(78));
    for (const [key, group] of groups) {
      console.log(`\n  normalizedKeyword: ${JSON.stringify(key)}   (${group.length} article${group.length > 1 ? 's' : ''})`);
      for (const d of group) {
        const has = d.normalizedKeyword !== undefined;
        console.log(line(d, has ? 'HAS-NK' : '—'));
      }

      const r = pickWinner(group);

      if (r.ambiguous) {
        ambiguousCount++;
        console.log('      >>> AMBIGUOUS: same status and no createdAt to separate them.');
        console.log('      >>> Nothing will be written for this keyword. Resolve it by hand.');
        continue;
      }
      if (r.bothPublic) {
        console.log('      >>> WARNING: two approved/published articles share this keyword.');
        console.log('      >>> Both may be publicly visible. Indexing one does not fix that.');
      }

      console.log(`      WINNER   ${r.winner.slug}   (${r.reason})`);
      for (const l of r.losers) {
        console.log(`      skip     ${l.slug} — left with no normalizedKeyword; sparse index ignores it, document untouched`);
      }

      if (r.winner.normalizedKeyword !== undefined) {
        alreadySet++;
        console.log(`      would write: nothing — winner already has ${JSON.stringify(r.winner.normalizedKeyword)}`);
        continue;
      }
      console.log(`      would write: { normalizedKeyword: ${JSON.stringify(key)} } on _id=${r.winner._id}`);
      plan.push({ _id: r.winner._id, slug: r.winner.slug, key });
    }
    console.log(`\n${'='.repeat(78)}`);

    console.log(`\nSummary`);
    console.log(`  distinct keywords     : ${groups.size}`);
    console.log(`  colliding groups      : ${[...groups.values()].filter((g) => g.length > 1).length}`);
    console.log(`  winners already set   : ${alreadySet}`);
    console.log(`  ambiguous (skipped)   : ${ambiguousCount}`);
    console.log(`  writes planned        : ${plan.length}`);
    console.log(`  documents deleted     : 0  (this script never deletes)`);
    console.log(`  other fields touched  : none`);

    if (!APPLY) {
      console.log('\nDRY RUN. Nothing was written. Re-run with --apply to perform the writes above.\n');
      return;
    }

    // ── Apply ─────────────────────────────────────────────────
    console.log('\nApplying…');
    let written = 0; const clashes = [];
    for (const p of plan) {
      try {
        // Idempotent: the guard means a re-run, or a value written by anything
        // else in between, is a no-op rather than an overwrite.
        const res = await SeoArticle.updateOne(
          { _id: p._id, normalizedKeyword: { $exists: false } },
          { $set: { normalizedKeyword: p.key } },
        );
        if (res.modifiedCount === 1) { written++; console.log(`  wrote  ${JSON.stringify(p.key)} -> ${p.slug}`); }
        else console.log(`  no-op  ${p.slug} (already had a value)`);
      } catch (err) {
        // E11000 means something else claimed this key between the plan and
        // the write. Report the pair and keep going — a half-finished run that
        // says so is better than one that aborts silently in the middle.
        if (err?.code === 11000) {
          clashes.push(p);
          console.error(`  CLASH  ${JSON.stringify(p.key)} -> ${p.slug}: already held by another document. Skipped.`);
          continue;
        }
        throw err;
      }
    }

    // ── Verification pass ─────────────────────────────────────
    console.log('\nVerifying…');
    const after = await SeoArticle.find({}, 'slug status keyword normalizedKeyword').lean();
    const byKey = new Map();
    for (const d of after) {
      if (d.normalizedKeyword === undefined) continue;
      if (!byKey.has(d.normalizedKeyword)) byKey.set(d.normalizedKeyword, []);
      byKey.get(d.normalizedKeyword).push(d.slug);
    }
    const doubles = [...byKey.entries()].filter(([, s]) => s.length > 1);
    const missingWinners = plan.filter((p) => !after.find((d) => String(d._id) === String(p._id) && d.normalizedKeyword === p.key));

    console.log(`  written               : ${written} of ${plan.length}`);
    console.log(`  clashes               : ${clashes.length}`);
    console.log(`  indexed documents     : ${byKey.size}`);
    console.log(`  keys held by >1 doc   : ${doubles.length} ${doubles.length ? JSON.stringify(doubles) : '(none — index intact)'}`);
    console.log(`  planned but not set   : ${missingWinners.length}`);
    console.log(`  total documents       : ${after.length} (unchanged)`);

    if (doubles.length || missingWinners.length) {
      console.error('\nVERIFICATION FAILED. Inspect the output above before doing anything else.');
      process.exit(1);
    }
    console.log('\nDone. Only normalizedKeyword was written.\n');
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
