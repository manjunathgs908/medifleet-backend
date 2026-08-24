/**
 * tests/seoPhase2Safety.test.js
 * ============================================================
 * The safety gates that have to hold before article volume goes up:
 *
 *   - a curated live page cannot be duplicated by a generated draft
 *   - an approved article cannot be duplicated either
 *   - invalid JSON-LD blocks approval instead of failing silently at render
 *   - valid JSON-LD passes
 *   - intent collisions are recorded but never block
 *   - the live-page index is built from the site's own sitemap
 *   - a partial fetch failure never deletes protected pages from the index
 *
 * No database and no network: the fingerprint functions are pure, the schema
 * validator is pure, and the index refresh takes its collection and its
 * fetcher from outside.
 * ============================================================
 */
'use strict';

const { shingle, jaccard, SIMILARITY_BLOCK } = require('../services/seoGenerator');
const { validateJsonLd } = require('../services/seoSchemaValidator');
const live = require('../services/seoLivePages');
const SeoLivePage = require('../models/SeoLivePage');
const SeoArticle = require('../models/SeoArticle');

// A realistic curated page: the live Whitefield landing page, shortened.
const WHITEFIELD_LIVE = `
Ambulance service in Whitefield, Bengaluru. SaveLife Health Services runs
ambulances across Whitefield around the clock, from Brookefield and Kundalahalli
through to Varthur Road. Dispatch is staffed 24 hours a day, every day, and the
fare is calculated from the actual road distance rather than quoted as a flat
number. We operate BLS, ALS and ICU ambulances, plus body shifting vehicles for
death-care journeys. Every trip is GPS tracked from assignment to arrival, and
the pickup is confirmed with an OTP so the family knows the right vehicle
arrived. Call dispatch and describe the situation and we will tell you what we
can do and what it costs before anything is booked.
`;

// The failure this whole phase exists to prevent: the same page, reworded for
// a neighbouring keyword.
const WHITEFIELD_REWORDED = `
Ambulance service in Whitefield, Bengaluru. SaveLife Health Services operates
ambulances throughout Whitefield around the clock, from Brookefield and
Kundalahalli through to Varthur Road. Dispatch is staffed 24 hours a day, every
day, and the fare is calculated from the actual road distance rather than quoted
as a flat number. We run BLS, ALS and ICU ambulances, plus body shifting
vehicles for death-care journeys. Every trip is GPS tracked from assignment to
arrival, and the pickup is confirmed with an OTP so the family knows the correct
vehicle arrived. Call dispatch and describe the situation and we will tell you
what we can do and what it costs before anything is booked.
`;

// A genuinely different article in the same business.
const DIFFERENT_TOPIC = `
What to do while you wait for an ambulance. The minutes between the call and
the arrival are not dead time. Keep the phone line open, because dispatch may
ring back for directions. Unlock the gate, switch on an outside light, and send
someone to the street to flag the vehicle down. Move furniture out of any
corridor a stretcher has to pass through. Gather the patient's current
medication, any known allergies, and a discharge summary if there has been a
recent hospital stay. Do not offer food or water to someone who may need
surgery.
`;

describe('a live page cannot be duplicated', () => {
  const livePage = shingle(WHITEFIELD_LIVE);

  test('a reworded copy of a live page scores above the block threshold', () => {
    const score = jaccard(shingle(WHITEFIELD_REWORDED), livePage);
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_BLOCK);
  });

  test('a genuinely different article scores well below it', () => {
    const score = jaccard(shingle(DIFFERENT_TOPIC), livePage);
    expect(score).toBeLessThan(SIMILARITY_BLOCK);
  });

  test('the threshold is the project constant, not a number invented here', () => {
    // Reused from seoGenerator so the live-page gate and the draft gate can
    // never answer the same question differently.
    expect(SIMILARITY_BLOCK).toBe(Number(process.env.SEO_SIMILARITY_THRESHOLD || 0.55));
  });

  test('an empty index scores zero and protects nothing', () => {
    // The generator records livePagesIndexed so a zero here is legible as
    // "the check did not run" rather than "the draft is unique".
    expect(jaccard(shingle(WHITEFIELD_REWORDED), [])).toBe(0);
  });

  test('the model stores a fingerprint per live page', () => {
    expect(SeoLivePage.schema.path('path')).toBeDefined();
    expect(SeoLivePage.schema.path('shingles')).toBeDefined();
    expect(SeoLivePage.schema.path('fetchedAt')).toBeDefined();
  });
});

describe('an approved article cannot be duplicated', () => {
  test('the same body reworded is caught between two articles too', () => {
    const approved = shingle(WHITEFIELD_LIVE);
    const draft = shingle(WHITEFIELD_REWORDED);
    expect(jaccard(draft, approved)).toBeGreaterThanOrEqual(SIMILARITY_BLOCK);
  });

  test('the article model carries the live-page comparison fields', () => {
    for (const p of ['checks.livePageSimilarity', 'checks.similarToLivePage', 'checks.livePagesIndexed']) {
      expect(SeoArticle.schema.path(p)).toBeDefined();
    }
  });
});

describe('intent collisions are recorded, never gated', () => {
  test('a collision validates with no severity and no threshold', () => {
    const d = new SeoArticle({
      keyword: 'k', slug: 's-intent', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      checks: {
        intentCollisions: [
          { source: 'article', ref: 'ambulance-whitefield', cluster: 'bengaluru-areas', searchIntent: 'transactional', titleSimilarity: 0.4 },
        ],
      },
    });
    expect(d.validateSync()).toBeUndefined();
    expect(d.checks.intentCollisions[0].ref).toBe('ambulance-whitefield');
  });

  test('an unknown source is rejected', () => {
    const d = new SeoArticle({
      keyword: 'k', slug: 's-intent-2', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      checks: { intentCollisions: [{ source: 'guesswork', ref: 'x' }] },
    });
    expect(d.validateSync()).toBeDefined();
  });
});

describe('schema validation blocks at the generation gate', () => {
  const VALID = [
    { '@type': 'Article', headline: 'Ambulance service in Whitefield' },
    { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }] },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }] },
  ];

  test('valid JSON-LD produces no errors', () => {
    expect(validateJsonLd(VALID)).toEqual([]);
  });

  test('a node with no @type is an error', () => {
    expect(validateJsonLd([{ headline: 'no type' }])).toEqual([expect.stringContaining('missing @type')]);
  });

  test('an Article with no headline is an error', () => {
    expect(validateJsonLd([{ '@type': 'Article' }])).toEqual([expect.stringContaining('headline')]);
  });

  test('an empty FAQPage is an error, not an empty section', () => {
    expect(validateJsonLd([{ '@type': 'Article', headline: 'x' }, { '@type': 'FAQPage', mainEntity: [] }]))
      .toEqual([expect.stringContaining('empty list')]);
  });

  test('an FAQ question missing its answer is an error', () => {
    const errors = validateJsonLd([
      { '@type': 'Article', headline: 'x' },
      { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] },
    ]);
    expect(errors).toEqual([expect.stringContaining('acceptedAnswer')]);
  });

  test('a malformed BreadcrumbList is an error', () => {
    expect(validateJsonLd([{ '@type': 'Article', headline: 'x' }, { '@type': 'BreadcrumbList', itemListElement: 'nope' }]))
      .toEqual([expect.stringContaining('must be a list')]);
  });

  test('a breadcrumb-only block is an error, because the renderer drops it', () => {
    // The page builds its own breadcrumb from the visible trail, so a stored
    // BreadcrumbList never ships. An article carrying nothing else would
    // publish with no structured data at all.
    expect(validateJsonLd([{ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }] }]))
      .toEqual([expect.stringContaining('no structured data')]);
  });

  test('no JSON-LD at all is an error', () => {
    expect(validateJsonLd([])).toEqual(['no JSON-LD was assembled']);
    expect(validateJsonLd(null)).toEqual(['no JSON-LD was assembled']);
  });

  test('errors are stored on the article and are strings a reviewer can read', () => {
    const d = new SeoArticle({
      keyword: 'k', slug: 's-schema', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      checks: { schemaErrors: validateJsonLd([{ '@type': 'Article' }]) },
    });
    expect(d.validateSync()).toBeUndefined();
    expect(d.checks.schemaErrors[0]).toMatch(/headline/);
  });
});

describe('the live-page index is built from the site, not from a list in this repo', () => {
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://www.savelife.health/</loc></url>
  <url><loc>https://www.savelife.health/ambulance-whitefield</loc></url>
  <url><loc>https://www.savelife.health/icu-ambulance-bangalore</loc></url>
  <url><loc>https://www.savelife.health/guides/a-generated-guide</loc></url>
  <url><loc>https://www.savelife.health/track</loc></url>
</urlset>`;

  const withFetch = (impl) => {
    const original = global.fetch;
    global.fetch = jest.fn(impl);
    return () => { global.fetch = original; };
  };

  test('guides and track are excluded; curated pages are kept', async () => {
    const restore = withFetch(async () => ({ ok: true, text: async () => SITEMAP }));
    try {
      const paths = await live.fetchSitemapPaths('https://www.savelife.health');
      expect(paths).toEqual(['/', '/ambulance-whitefield', '/icu-ambulance-bangalore']);
    } finally { restore(); }
  });

  test('an unreachable sitemap yields nothing rather than throwing', async () => {
    const restore = withFetch(async () => { throw new Error('offline'); });
    try {
      expect(await live.fetchSitemapPaths('https://www.savelife.health')).toEqual([]);
    } finally { restore(); }
  });

  test('a failed refresh leaves the existing index alone', async () => {
    const restore = withFetch(async () => ({ ok: false }));
    const del = jest.spyOn(SeoLivePage, 'deleteMany');
    const write = jest.spyOn(SeoLivePage, 'bulkWrite');
    try {
      const result = await live.refreshLivePageIndex({ base: 'https://x.test', shingle });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('sitemap unavailable');
      // The protected pages must not be deleted because the site was down.
      expect(del).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally { restore(); jest.restoreAllMocks(); }
  });

  test('a partial fetch failure indexes what it got and deletes nothing', async () => {
    const page = (title) =>
      `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${'word '.repeat(200)}</p></body></html>`;

    const restore = withFetch(async (url) => {
      if (url.endsWith('/sitemap.xml')) return { ok: true, text: async () => SITEMAP };
      if (url.endsWith('/icu-ambulance-bangalore')) return { ok: false };   // one page down
      return { ok: true, text: async () => page('A curated page') };
    });
    const write = jest.spyOn(SeoLivePage, 'bulkWrite').mockResolvedValue({});
    const del = jest.spyOn(SeoLivePage, 'deleteMany').mockResolvedValue({ deletedCount: 0 });

    try {
      const result = await live.refreshLivePageIndex({ base: 'https://x.test', shingle });
      expect(result.ok).toBe(true);
      expect(result.indexed).toBe(2);
      expect(result.failed).toBe(1);
      // The crucial part: a page that failed to fetch is not a page that was
      // deleted, and treating it as one would unprotect content that ranks.
      expect(del).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
    } finally { restore(); jest.restoreAllMocks(); }
  });

  test('a page with almost no prose is not indexed', async () => {
    const restore = withFetch(async (url) => {
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, text: async () => `<urlset><url><loc>https://x.test/thin</loc></url></urlset>` };
      }
      return { ok: true, text: async () => '<html><body><h1>Hi</h1><p>Too short.</p></body></html>' };
    });
    try {
      const result = await live.refreshLivePageIndex({ base: 'https://x.test', shingle });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('every page fetch failed');
    } finally { restore(); }
  });

  test('the RSC payload is not fingerprinted', () => {
    // Next embeds a second copy of the whole page inside a <script>.
    // Counting it would double every page's text and inflate every score.
    const html = `<html><body><h1>Real heading</h1><p>Visible prose.</p>
      <script>self.__next_f.push([1,"{\\"headline\\":\\"Real heading\\"}"])</script></body></html>`;
    const text = live.extractText(html);
    expect(text).toContain('Visible prose.');
    expect(text).not.toContain('__next_f');
    expect(text).not.toContain('headline');
  });
});

describe('existing curated pages are unaffected', () => {
  test('nothing in the index changes the article status ladder', () => {
    expect(SeoArticle.schema.path('status').enumValues)
      .toEqual(['draft', 'in_review', 'approved', 'published', 'rejected']);
    expect(SeoArticle.PUBLIC_STATUSES).toEqual(['approved', 'published']);
  });

  test('the live-page collection is separate from the article collection', () => {
    // Live pages are read-only fingerprints of content nobody generated.
    // Mixing them into SeoArticle would put unapproved rows one status field
    // away from being publishable.
    expect(SeoLivePage.collection.collectionName).not.toBe(SeoArticle.collection.collectionName);
  });
});
