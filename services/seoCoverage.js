/**
 * services/seoCoverage.js
 * ============================================================
 * Is this keyword already covered by a page the site has?
 *
 * The duplicate-keyword guard next door answers "has an ARTICLE been written
 * for this keyword". It cannot answer the other half: savelife.health has 38
 * hand-written pages that predate the generator entirely, and generating a
 * guide for a topic one of them already owns produces a page that can never be
 * served. That is not hypothetical — "freezer box in Bangalore" was generated
 * twice, approved, and 404s on the public site, because lib/guides.js reserves
 * any slug the curated registry owns. Two systems claiming one URL.
 *
 * WHERE THE PAGE LIST COMES FROM
 *
 * SeoLivePage, which services/seoLivePages.js already fills from the live
 * sitemap. It is the same index the cannibalisation gate compares against, so
 * this adds no second list of URLs to keep in step with the website — when a
 * curated page is added or removed, both gates learn about it together.
 *
 * HOW A KEYWORD IS MATCHED TO A PAGE
 *
 * By requiring the SAME set of significant words, not overlapping ones:
 *
 *   "freezer box in Bangalore"  -> {freezer, box, bangalore}
 *   /freezer-box-bangalore      -> {freezer, box, bangalore}   MATCH
 *
 *   "ambulance service near Whitefield Bangalore"
 *                               -> {ambulance, service, whitefield, bangalore}
 *   /ambulance-service-bangalore-> {ambulance, service, bangalore}   NO MATCH
 *
 * Set EQUALITY is what keeps this safe. An overlap or similarity score would
 * block every ambulance keyword in Bangalore against every ambulance page in
 * Bangalore; equality cannot, because a keyword with an extra significant word
 * — a locality, a service type — is by definition a different set. Only
 * connective words are stripped, so nothing meaningful is discarded to force a
 * match. Verified against all 38 indexed pages and every existing article
 * keyword: the only articles it blocks are the two redundant freezer-box ones.
 *
 * Deliberately NOT fuzzy. No stemming, no synonyms, no edit distance, no
 * threshold to tune. A false positive here silently prevents a page that
 * should exist, and the operator gets no draft to look at to work out why.
 * ============================================================
 */
'use strict';

const SeoLivePage = require('../models/SeoLivePage');
const { slugify } = require('./seoSlug');

/**
 * Connective words only. Nothing that carries meaning is on this list — no
 * "ambulance", no "service", no place name — because stripping a meaningful
 * word is how two different topics start looking like one.
 */
const CONNECTIVES = new Set([
  'in', 'near', 'the', 'a', 'an', 'of', 'for', 'to', 'and',
  'at', 'on', 'by', 'with', 'my', 'your',
]);

/** The significant words of a phrase or a path, as a set. */
function significantTokens(text) {
  return new Set(
    slugify(String(text || '').replace(/\//g, ' '))
      .split('-')
      .filter((w) => w && !CONNECTIVES.has(w)),
  );
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * The curated page that already covers this keyword, or null.
 *
 * Reads SeoLivePage. Returns the page itself so the caller can tell the
 * operator which page to open rather than only that something exists.
 *
 * @returns {Promise<{path:string, title?:string}|null>}
 */
async function findCuratedCoverage(keyword) {
  const wanted = significantTokens(keyword);
  if (!wanted.size) return null;

  const pages = await SeoLivePage.find({}).select('path title').lean();
  for (const page of pages) {
    // A guide URL is an article, not a curated page; the article guard owns
    // that case and reports it with the right source.
    if (String(page.path || '').startsWith('/guides/')) continue;
    if (sameSet(wanted, significantTokens(page.path))) return page;
  }
  return null;
}

/**
 * A curated page already covers this keyword, so no generation ran.
 *
 * Carries the page, so the Studio can offer "open it" instead of leaving the
 * operator to guess which page was meant.
 */
class KeywordCoveredError extends Error {
  constructor(page, keyword) {
    super(
      `An existing public page already covers this keyword: "${page.title || page.path}" (${page.path}). `
      + 'Use that page rather than creating another SEO guide for the same topic.',
    );
    this.name = 'KeywordCoveredError';
    this.page = page;
    this.keyword = keyword;
  }
}

module.exports = {
  CONNECTIVES,
  significantTokens,
  findCuratedCoverage,
  KeywordCoveredError,
};
