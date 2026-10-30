/**
 * scripts/updateGuidePhoneNumber.js
 * ============================================================
 * Move the call number in published guide articles from 9986844442 to the
 * new Plivo line 918065591088.
 *
 *   node scripts/updateGuidePhoneNumber.js                  # dry run (default)
 *   node scripts/updateGuidePhoneNumber.js --apply          # write
 *   node scripts/updateGuidePhoneNumber.js --include-drafts # widen the scope
 *
 * DRY RUN BY DEFAULT, same contract as backfillNormalizedKeyword.js and
 * migrateSeoJsonLd.js.
 *
 * SCOPE. By default only articles the public can already read --
 * SeoArticle.PUBLIC_STATUSES, i.e. approved and published -- because those are
 * what /api/guides serves and what savelife-web renders. Drafts and rejects
 * are still SCANNED and reported, so a draft carrying the old number cannot
 * quietly reintroduce it at publish time; pass --include-drafts to rewrite
 * them too.
 *
 * WHAT COUNTS AS THE CALL NUMBER. Every format the content actually uses:
 *
 *   9986844442      99868 44442     99868-44442     99868.44442
 *   +919986844442   919986844442    09986844442     +91 99868 44442
 *   tel:+919986844442 and the same variants behind tel:
 *
 * All of them share one core, 99868 then an optional separator then 44442, so
 * a single core pattern plus an optional country/trunk prefix covers the lot
 * rather than a list of literals that will miss the next spelling.
 *
 * WHATSAPP IS NOT THE PLIVO NUMBER. The Plivo line is voice-only. Where the
 * old number appears inside a WhatsApp destination -- wa.me/..., a whatsapp:
 * URI, or api.whatsapp.com/send?phone= -- it becomes 918884092777, the
 * WhatsApp booking number, NOT the Plivo number. Sending WhatsApp traffic to
 * a voice-only line would silently break every chat link in the guides. This
 * is checked before the other two rules so a wa.me link can never be caught
 * by the generic text rule.
 *
 * REPLACEMENT, in order:
 *   1. WhatsApp destination -> 918884092777
 *   2. tel: URL             -> tel:+918065591088
 *   3. anything else (prose)-> +91 80655 91088
 *
 * AUDIT TRAIL IS LEFT ALONE. `corrections[].previous` and `repairLog` are a
 * record of what a document used to say. Rewriting them would make the
 * history claim something that never happened, and nothing renders them, so
 * they are reported separately and never written. If the only remaining
 * occurrences after a run are in those paths, that is the correct end state.
 *
 * WRITES: only the string fields listed in the per-document log, and only on
 * --apply. Never status, slug, dates, or a delete. A timestamped JSON backup
 * of every affected document, in full, is written BEFORE the first update.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');

const APPLY = process.argv.includes('--apply');
const INCLUDE_DRAFTS = process.argv.includes('--include-drafts');

// ── the numbers ───────────────────────────────────────────────
const NEW_CALL_TEL = '+918065591088';      // tel: form
const NEW_CALL_TEXT = '+91 80655 91088';   // how it reads on the page
const WHATSAPP = '918884092777';           // unchanged; voice line is not this

// 99868 + optional separator + 44442 covers 9986844442 and 99868 44442 alike.
const CORE = '99868[\\s.\\-]?44442';
// Optional +91 / 91 / 0 trunk prefix in front of it.
// The separator run lives INSIDE the optional group on purpose. Left outside
// it, `[\s.\-]*` still matches when no prefix is present and swallows the
// space in front of the number, so "Call 9986844442" came out as
// "Call+91 80655 91088". Caught by the unit tests before anything was written.
// Whitespace is allowed only AFTER a literal "+". Written as `\+?\s*91` the
// `\s*` also matches the space in front of a bare "919986844442", eating it.
const WITH_PREFIX = `(?:(?:\\+\\s*91|91|0)[\\s.\\-]*)?${CORE}`;

const WA_RE = new RegExp(
  `(wa\\.me/|api\\.whatsapp\\.com/send\\?phone=|whatsapp://send\\?phone=)\\+?\\s*(?:91|0)?[\\s.\\-]*${CORE}`,
  'gi',
);
const TEL_RE = new RegExp(`tel:\\s*${WITH_PREFIX}`, 'gi');
const ANY_RE = new RegExp(WITH_PREFIX, 'g');
// Counting pattern — any occurrence in any shape.
const COUNT_RE = new RegExp(WITH_PREFIX, 'g');

const countIn = (s) => (typeof s === 'string' ? (s.match(COUNT_RE) || []).length : 0);

/** Apply the three rules in order. WhatsApp first so it cannot be stolen. */
function rewrite(s) {
  return s
    .replace(WA_RE, (_m, prefix) => `${prefix}${WHATSAPP}`)
    .replace(TEL_RE, `tel:${NEW_CALL_TEL}`)
    .replace(ANY_RE, NEW_CALL_TEXT);
}

// Paths that are a record of the past rather than content. Matched as a
// prefix of the dotted path.
const HISTORY_PREFIXES = ['corrections', 'repairLog', 'duplicateOf'];
// `corrections` is an ARRAY, so its paths read `corrections[0].previous.content`
// and never `corrections.`. Matching only the dot form classified every audit
// snapshot as content and would have rewritten the history this script
// promises not to touch — the dry run reported 73 rewritable instead of 27.
const isHistory = (p) =>
  HISTORY_PREFIXES.some((h) => p === h || p.startsWith(`${h}.`) || p.startsWith(`${h}[`));

/**
 * Walk every string leaf of a plain object, depth-first, yielding the dotted
 * path. Arrays are indexed. This is how "any field" is honoured without a
 * hand-written list that drifts from the schema.
 */
function walkStrings(node, prefix, out) {
  if (typeof node === 'string') {
    if (countIn(node)) out.push({ path: prefix, value: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (node && typeof node === 'object' && !(node instanceof Date)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '_id' || k === '__v') continue;
      walkStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

const safeTarget = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Nothing was attempted.');
    process.exit(1);
  }

  console.log('');
  console.log(`Mode   : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`Scope  : ${INCLUDE_DRAFTS ? 'ALL articles' : 'public only (approved, published)'}`);
  console.log(`Target : ${safeTarget(process.env.MONGO_URI)}`);
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const all = await SeoArticle.find({}).lean();
    const isPublic = (d) => SeoArticle.PUBLIC_STATUSES.includes(d.status);

    const scanned = all.map((doc) => {
      const hits = walkStrings(doc, '', []);
      const content = hits.filter((h) => !isHistory(h.path));
      const history = hits.filter((h) => isHistory(h.path));
      return {
        doc,
        slug: doc.slug,
        status: doc.status,
        pub: isPublic(doc),
        content,
        history,
        total: hits.reduce((n, h) => n + countIn(h.value), 0),
        contentTotal: content.reduce((n, h) => n + countIn(h.value), 0),
      };
    }).filter((r) => r.total > 0);

    const inScope = scanned.filter((r) => (INCLUDE_DRAFTS ? true : r.pub));
    const outOfScope = scanned.filter((r) => !(INCLUDE_DRAFTS ? true : r.pub));

    // ── report ────────────────────────────────────────────────
    console.log('GUIDES CONTAINING THE OLD CALL NUMBER');
    console.log('');
    for (const r of scanned) {
      const tag = r.pub ? 'public' : `${r.status} (out of scope)`;
      console.log(`  ${r.slug}   [${tag}]   ${r.total} occurrence(s)`);
      for (const h of r.content) console.log(`      ${h.path.padEnd(34)} ${countIn(h.value)}`);
      for (const h of r.history) console.log(`      ${h.path.padEnd(34)} ${countIn(h.value)}   (history — never written)`);
    }
    if (!scanned.length) console.log('  none');

    const totalAll = scanned.reduce((n, r) => n + r.total, 0);
    const totalScope = inScope.reduce((n, r) => n + r.contentTotal, 0);
    console.log('');
    console.log(`  guides with the old number : ${scanned.length}`);
    console.log(`  occurrences, all fields    : ${totalAll}`);
    console.log(`  in scope and rewritable    : ${totalScope} across ${inScope.length} guide(s)`);
    if (outOfScope.length) {
      console.log(`  OUT OF SCOPE (drafts etc.) : ${outOfScope.reduce((n, r) => n + r.total, 0)} across ${outOfScope.length} guide(s)`);
      console.log('    -> re-run with --include-drafts to rewrite these too.');
    }
    console.log('');

    if (!APPLY) {
      console.log('DRY RUN — nothing was written.');
      console.log('To apply:  node scripts/updateGuidePhoneNumber.js --apply');
      console.log('');
      return;
    }
    if (!inScope.length) {
      console.log('Nothing in scope to write.');
      return;
    }

    // ── backup BEFORE the first write ─────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, `guides-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(inScope.map((r) => r.doc), null, 2), 'utf8');
    console.log(`Backup written: ${backupPath}  (${inScope.length} full document(s))`);
    console.log('');

    // ── write ─────────────────────────────────────────────────
    console.log('APPLYING');
    let fieldsWritten = 0;
    for (const r of inScope) {
      console.log(`  ${r.slug}`);
      // Mutate through the hydrated document and let Mongoose cast and write.
      // A hand-built $set cannot address a nested array element on a Mixed
      // subtree reliably, and doc.set() handles the dotted/indexed path.
      const fresh = await SeoArticle.findById(r.doc._id);
      for (const h of r.content) {
        const before = countIn(h.value);
        const next = rewrite(h.value);
        if (next === h.value) continue;
        fresh.set(h.path, next);
        fieldsWritten += 1;
        console.log(`      ${h.path.padEnd(34)} ${before} -> ${countIn(next)}`);
      }
      // validateBeforeSave:false — these documents predate some required
      // fields and we are editing prose, not fixing their schema.
      await fresh.save({ validateBeforeSave: false });
      if (r.history.length) {
        console.log(`      (${r.history.length} history field(s) left untouched by design)`);
      }
    }
    console.log('');
    console.log(`  fields written: ${fieldsWritten}`);
    console.log('');

    // ── re-verify ─────────────────────────────────────────────
    console.log('RE-VERIFY (fresh read)');
    const after = await SeoArticle.find({}).lean();
    let remainingContent = 0;
    let remainingHistory = 0;
    for (const doc of after) {
      if (!INCLUDE_DRAFTS && !isPublic(doc)) continue;
      for (const h of walkStrings(doc, '', [])) {
        const n = countIn(h.value);
        if (isHistory(h.path)) { remainingHistory += n; }
        else { remainingContent += n; console.log(`  STILL PRESENT: ${doc.slug} ${h.path} (${n})`); }
      }
    }
    console.log(`  remaining in content fields : ${remainingContent}`);
    console.log(`  remaining in history fields : ${remainingHistory}  (expected — never written)`);
    console.log('');
    if (remainingContent > 0) {
      console.error('VERIFICATION FAILED — the old number is still in a content field.');
      process.exit(1);
    }
    console.log('Done. Zero occurrences of the old call number remain in guide content.');
    console.log('');
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
