/**
 * services/seoLivePages.js
 * ============================================================
 * Builds and refreshes the fingerprint index of savelife.health's existing
 * pages, so a generated draft can be checked against them before anyone is
 * asked to approve it.
 *
 * The page list comes from the site's own sitemap.xml rather than from a list
 * kept here. The sitemap is generated from savelife-web's page registry, so
 * it is the site's own statement of what it publishes -- and it cannot drift
 * from that registry the way a second hand-maintained list in this repo
 * would. Guide URLs are excluded: those ARE generated articles, already
 * fingerprinted in SeoArticle, and indexing them twice would have a draft
 * compete with itself.
 *
 * Everything degrades. A sitemap that will not load, a page that times out, a
 * site that is down -- none of them may fail a generation. They leave the
 * index as it was and the generator says how old it is.
 * ============================================================
 */
'use strict';

const SeoLivePage = require('../models/SeoLivePage');

// Same knobs, same names as the description fetcher in seoFacts.js: this is
// the same operation against the same site.
const FETCH_TIMEOUT_MS = Number(process.env.SEO_LIVE_FETCH_TIMEOUT_MS || 8000);
const CONCURRENCY = Number(process.env.SEO_LIVE_CONCURRENCY || 6);

// How old the index may be before a generation refreshes it. Six hours, to
// match SEO_DESCRIPTION_TTL_MS -- both are "how often does the live site
// change under us", and answering it twice with two numbers would be a lie
// about one of them.
const INDEX_TTL_MS = Number(process.env.SEO_LIVE_INDEX_TTL_MS || 6 * 60 * 60 * 1000);

// Guides are generated articles with their own fingerprints in SeoArticle.
const EXCLUDED = [/^\/guides\//, /^\/track(\/|$)/];

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ');

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ');

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The paths the site says it publishes, minus the ones that are themselves
 * generated. Returns [] if the sitemap cannot be read — the caller keeps the
 * index it already has rather than emptying it.
 */
async function fetchSitemapPaths(base) {
  const xml = await get(`${base}/sitemap.xml`);
  if (!xml) return [];

  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .map((url) => {
      try {
        return new URL(url).pathname;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((p) => (p.length > 1 ? p.replace(/\/$/, '') : '/'))
    .filter((p) => !EXCLUDED.some((re) => re.test(p)));

  return [...new Set(paths)].sort();
}

// Everything a reader sees, and nothing they do not. Scripts go first and by
// name: Next embeds its RSC payload in a <script>, and that payload is a
// second copy of the whole page. Fingerprinting it would double every page's
// text and quietly inflate every similarity score.
function extractText(html) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  return decodeEntities(stripTags(body)).replace(/\s+/g, ' ').trim();
}

function extractMeta(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return {
    title: decodeEntities(stripTags(title)).trim(),
    h1: decodeEntities(stripTags(h1)).trim(),
  };
}

/**
 * Refreshes the index from the live site.
 *
 * `shingle` is injected rather than imported. seoGenerator already owns the
 * fingerprint function, and importing it here would make the two modules
 * mutually dependent — while passing it in guarantees the index and the
 * articles are fingerprinted by literally the same code.
 *
 * Returns a summary. Never throws.
 */
async function refreshLivePageIndex({ base, shingle }) {
  const paths = await fetchSitemapPaths(base);
  if (!paths.length) {
    return { ok: false, reason: 'sitemap unavailable', indexed: 0, failed: 0, removed: 0 };
  }

  const queue = [...paths];
  const results = [];
  const failed = [];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const path = queue.shift();
      const html = await get(`${base}${path}`);
      if (!html) { failed.push(path); continue; }

      const text = extractText(html);
      const { title, h1 } = extractMeta(html);
      const words = text.split(' ').filter(Boolean);

      // A page with almost no prose is a redirect shell or an error page, not
      // something a draft could plausibly duplicate. Indexing it would give
      // every short draft a spurious near-match.
      if (words.length < 50) { failed.push(path); continue; }

      results.push({ path, title, h1, text, wordCount: words.length, shingles: shingle(`${h1} ${text}`) });
    }
  });
  await Promise.all(workers);

  if (!results.length) {
    return { ok: false, reason: 'every page fetch failed', indexed: 0, failed: failed.length, removed: 0 };
  }

  const fetchedAt = new Date();
  await SeoLivePage.bulkWrite(
    results.map((r) => ({
      updateOne: {
        filter: { path: r.path },
        update: { $set: { ...r, fetchedAt } },
        upsert: true,
      },
    })),
  );

  // Drop pages the sitemap no longer lists, but ONLY when the whole sweep
  // succeeded. A partial failure must not be read as "those pages were
  // deleted" — that would silently unprotect a page that still ranks.
  let removed = 0;
  if (!failed.length) {
    const res = await SeoLivePage.deleteMany({ path: { $nin: paths } });
    removed = res.deletedCount || 0;
  }

  return { ok: true, indexed: results.length, failed: failed.length, failedPaths: failed, removed, fetchedAt };
}

/** True when nothing has been indexed, or the newest row is older than the TTL. */
async function isIndexStale() {
  const newest = await SeoLivePage.findOne({}).sort({ fetchedAt: -1 }).select('fetchedAt').lean();
  if (!newest) return true;
  return Date.now() - new Date(newest.fetchedAt).getTime() > INDEX_TTL_MS;
}

/** Every indexed page, for comparison. Cheap: tens of rows, not thousands. */
async function loadLivePageIndex() {
  return SeoLivePage.find({}).select('path title h1 wordCount shingles fetchedAt').lean();
}

module.exports = {
  refreshLivePageIndex,
  loadLivePageIndex,
  isIndexStale,
  fetchSitemapPaths,
  extractText,
  INDEX_TTL_MS,
};
