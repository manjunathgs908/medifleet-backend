/**
 * scripts/indexLivePages.js
 * ============================================================
 * Rebuilds the fingerprint index of savelife.health's existing pages, which
 * the generator compares every new draft against.
 *
 * The generator refreshes this itself when the index is older than
 * SEO_LIVE_INDEX_TTL_MS, so this script is for the cases where you want it
 * now: after publishing or rewriting a curated page, before a batch of
 * generations, or the first time on a fresh database.
 *
 * Read-only against the website. The only thing it writes is the index.
 *
 *   node scripts/indexLivePages.js           refresh, then print the index
 *   node scripts/indexLivePages.js --list    print what is indexed, fetch nothing
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const SeoLivePage = require('../models/SeoLivePage');
const { refreshLivePageIndex, loadLivePageIndex } = require('../services/seoLivePages');
const { shingle } = require('../services/seoGenerator');

const SITE = process.env.SEO_SITE_URL || 'https://www.savelife.health';
const LIST_ONLY = process.argv.includes('--list');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  if (!LIST_ONLY) {
    console.log(`Reading ${SITE}/sitemap.xml ...`);
    const result = await refreshLivePageIndex({ base: SITE, shingle });

    if (!result.ok) {
      // Not a crash: the previous index is still in place and still usable.
      console.error(`\nRefresh failed: ${result.reason}`);
      console.error('The existing index was left untouched.');
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log(`\nIndexed  : ${result.indexed}`);
    console.log(`Failed   : ${result.failed}`);
    if (result.failedPaths?.length) {
      console.log(`           ${result.failedPaths.join(', ')}`);
      console.log('           (stale rows were kept: a partial sweep must not be read as a deletion)');
    }
    console.log(`Removed  : ${result.removed}  (no longer in the sitemap)`);
  }

  const pages = await loadLivePageIndex();
  console.log(`\nIndex now holds ${pages.length} page(s):\n`);
  console.log('PATH'.padEnd(48) + 'WORDS'.padStart(7) + 'TRIGRAMS'.padStart(10));
  console.log('-'.repeat(66));
  for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(
      p.path.padEnd(48) +
      String(p.wordCount || 0).padStart(7) +
      String((p.shingles || []).length).padStart(10),
    );
  }

  const oldest = pages.reduce((acc, p) => (!acc || p.fetchedAt < acc ? p.fetchedAt : acc), null);
  if (oldest) console.log(`\nOldest row fetched: ${new Date(oldest).toISOString()}`);

  const empty = pages.filter((p) => !(p.shingles || []).length);
  if (empty.length) {
    console.log(`\nWARNING: ${empty.length} page(s) have no fingerprint and protect nothing:`);
    for (const p of empty) console.log(`  ${p.path}`);
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    if (/ServerSelection|ReplicaSetNoPrimary|ETIMEDOUT|ENOTFOUND/i.test(err.message || '')) {
      console.error('\nCould not reach MongoDB. Nothing was read and nothing was written.');
      console.error('Run this from an allowlisted environment (a Render shell), not a laptop.');
    } else {
      console.error('\nIndexing failed:', err.message);
    }
    process.exit(1);
  });
}

module.exports = { main, SeoLivePage };
