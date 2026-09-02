/**
 * tests/seoSlug.test.js
 * ============================================================
 * Renaming a draft whose slug is taken.
 *
 * A duplicate slug used to stop auto-repair at zero attempts, so an article
 * whose URL happened to be taken could not have its claims, title or meta
 * repaired either. Renaming a DRAFT is bookkeeping — nothing links to it and
 * no ranking depends on it — so the loop now does it and carries on.
 *
 * The two properties that matter: the other article is never touched, and a
 * live URL is never moved.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../services/seoGenerator', () => ({
  repairArticle: jest.fn(),
  recheckArticle: jest.fn(),
  isBlocking: (c) => c.severity !== 'phrasing',
  TITLE_MIN: 55, TITLE_MAX: 60, META_MIN: 150, META_MAX: 160,
}));

const SeoArticle = require('../models/SeoArticle');
const { repairArticle, recheckArticle } = require('../services/seoGenerator');
const { slugify, slugCandidates, findUniqueSlug } = require('../services/seoSlug');
const { autoRepairArticle } = require('../services/seoAutoRepair');

const CLEAN_CHECKS = {
  passed: false, unverifiedClaims: [],
  pricingClaims: [], schemaErrors: [], duplicateSlug: false,
  similarityScore: 0.05, livePageSimilarity: 0.03,
  wordCount: 900, titleLength: 57, metaLength: 154,
};

const makeDoc = (checks = {}, over = {}) => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'ambulance service near Whitefield Bangalore',
    slug: 'ambulance-service-near-whitefield-bangalore',
    location: 'Whitefield', service: 'ambulance',
    title: 'y'.repeat(57), metaDescription: 'x'.repeat(154),
    h1: 'h', content: 'c', status: 'draft', corrections: [],
    checks: { ...CLEAN_CHECKS, ...checks },
    generation: {},
    ...over,
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

const mockClaim = (doc) => jest.spyOn(SeoArticle, 'findOneAndUpdate').mockResolvedValue(doc);

/** `taken` is the set of slugs already used by OTHER articles. */
const mockExists = (taken) => jest.spyOn(SeoArticle, 'exists')
  .mockImplementation(async ({ slug }) => (taken.has(slug) ? { _id: 'someone-else' } : null));

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

// ============================================================
describe('A. slugify', () => {
  test.each([
    ['ambulance service near Whitefield Bangalore', 'ambulance-service-near-whitefield-bangalore'],
    ['Bengalūru Ambulance', 'bengaluru-ambulance'],
    ['  Multiple   Spaces & Symbols!! ', 'multiple-spaces-symbols'],
    ['ALS/BLS — Ambulance', 'als-bls-ambulance'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test('a differentiator the base already contains is not appended again', () => {
    const c = slugCandidates({
      keyword: 'ambulance near whitefield', location: 'Whitefield', service: 'ambulance', title: 'T',
    });
    expect(c).not.toContain('ambulance-near-whitefield-whitefield');
  });
});

// ============================================================
describe('B. a unique slug is generated', () => {
  test('the keyword slug is preferred when it is free', async () => {
    mockExists(new Set());
    const r = await findUniqueSlug(makeDoc());
    expect(r.ok).toBe(true);
    expect(r.slug).toBe('ambulance-service-near-whitefield-bangalore');
  });

  test('a taken slug falls through to a descriptive differentiator, not a number', async () => {
    // A keyword that does NOT already contain the location, so the location is
    // a genuine differentiator. (When the keyword already carries the term,
    // appending it adds length and no meaning, and the next candidate is used
    // instead — covered by the slugCandidates test above.)
    const doc = makeDoc({}, {
      keyword: 'ambulance service bangalore',
      slug: 'ambulance-service-bangalore',
      location: 'Whitefield',
      title: 'Ambulance Service in Bangalore for Whitefield Residents 24x7',
    });
    mockExists(new Set(['ambulance-service-bangalore']));

    const r = await findUniqueSlug(doc);

    expect(r.ok).toBe(true);
    expect(r.slug).toBe('ambulance-service-bangalore-whitefield');
    expect(r.slug).not.toMatch(/-\d+$/); // a real term, not "-2"
  });

  test('multiple collisions resolve deterministically to the same slug every time', async () => {
    const taken = new Set([
      'ambulance-service-near-whitefield-bangalore',
      'ambulance-service-near-whitefield-bangalore-ambulance',
    ]);
    mockExists(taken);
    const a = await findUniqueSlug(makeDoc());
    jest.restoreAllMocks();
    mockExists(taken);
    const b = await findUniqueSlug(makeDoc());

    expect(a.ok).toBe(true);
    expect(a.slug).toBe(b.slug);          // same input, same answer
    expect(taken.has(a.slug)).toBe(false);
  });

  test('when every descriptive candidate is taken it falls back to the lowest free number', async () => {
    const base = 'ambulance-service-near-whitefield-bangalore';
    mockExists(new Set([
      base, `${base}-ambulance`, `${base}-2`, `${base}-3`,
      'y'.repeat(57).toLowerCase(), `${'y'.repeat(57).toLowerCase()}-whitefield`,
    ]));
    const r = await findUniqueSlug(makeDoc());
    expect(r.ok).toBe(true);
    expect(r.slug).toBe(`${base}-4`);
  });
});

// ============================================================
describe('C. it refuses rather than guessing', () => {
  test('an impossible collision fails closed', async () => {
    // Every candidate taken, including all twenty numbered fallbacks.
    mockExists(new Set());
    jest.spyOn(SeoArticle, 'exists').mockResolvedValue({ _id: 'someone-else' });

    const r = await findUniqueSlug(makeDoc());

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already taken|editorial decision/i);
    expect(r.slug).toBeUndefined();
  });

  test.each([['approved'], ['published']])('a %s article is never renamed', async (status) => {
    const spy = jest.spyOn(SeoArticle, 'exists');
    const r = await findUniqueSlug(makeDoc({}, { status }));

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/live|editorial decision/i);
    // It refuses before even looking: a live URL is not a candidate search.
    expect(spy).not.toHaveBeenCalled();
  });

  test('an article with nothing to build a slug from refuses', async () => {
    mockExists(new Set());
    // Nothing at all to work from — not even the current slug.
    const doc = makeDoc({}, { keyword: '', title: '', slug: '', location: '', service: '' });
    const r = await findUniqueSlug(doc);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no keyword, title, service or location/i);
  });

  test('the current slug alone is enough to build numbered candidates from', async () => {
    // Not a refusal: a doc with only a slug can still be renamed "<slug>-2".
    mockExists(new Set(['only-this']));
    const doc = makeDoc({}, { keyword: '', title: '', slug: 'only-this', location: '', service: '' });
    const r = await findUniqueSlug(doc);
    expect(r.ok).toBe(true);
    expect(r.slug).toBe('only-this-2');
  });
});

// ============================================================
describe('D. the other article is never touched', () => {
  test('only `exists` is used to test availability — no write to any other doc', async () => {
    const existsSpy = mockExists(new Set(['ambulance-service-near-whitefield-bangalore']));
    const updateSpy = jest.spyOn(SeoArticle, 'updateOne').mockResolvedValue({});
    const updateManySpy = jest.spyOn(SeoArticle, 'updateMany').mockResolvedValue({});

    await findUniqueSlug(makeDoc());

    expect(existsSpy).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(updateManySpy).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('E. the loop renames and carries on', () => {
  test('a duplicate slug no longer stops the run at 0 attempts', async () => {
    const doc = makeDoc({ duplicateSlug: true, unverifiedClaims: [{ claim: 'x', severity: 'unsupported', action: 'rewrite' }] });
    mockClaim(doc);
    mockExists(new Set(['ambulance-service-near-whitefield-bangalore']));
    // The rename alone does not clear everything: a claim still needs repair.
    // The real recheckArticle rewrites article.checks from the gate, so the
    // mock has to clear duplicateSlug the same way — otherwise the loop would
    // still see a duplicate and block, which is the mock lying, not the code.
    recheckArticle
      .mockImplementationOnce(async (a) => {
        a.checks.duplicateSlug = false;
        return { passed: false, failedChecks: ['1 blocking claim(s)'] };
      })
      .mockImplementationOnce(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [] }; });
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });

    const r = await autoRepairArticle(doc._id);

    expect(doc.slug).not.toBe('ambulance-service-near-whitefield-bangalore');
    expect(r.timeline.join(' ')).toMatch(/renamed to/);
    expect(repairArticle).toHaveBeenCalled();     // it did not stop at 0
    expect(r.attempts).toBeGreaterThan(0);
  });

  test('a rename that clears every gate finishes without spending an attempt', async () => {
    const doc = makeDoc({ duplicateSlug: true });
    mockClaim(doc);
    mockExists(new Set(['ambulance-service-near-whitefield-bangalore']));
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [] }; });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(0);            // renaming is not a repair attempt
    expect(repairArticle).not.toHaveBeenCalled();
    // ...and it still does not approve.
    expect(doc.status).toBe('draft');
  });

  test('the rename is recorded as a correction, with the old slug kept', async () => {
    const doc = makeDoc({ duplicateSlug: true });
    mockClaim(doc);
    mockExists(new Set(['ambulance-service-near-whitefield-bangalore']));
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [] }; });

    await autoRepairArticle(doc._id);

    const last = doc.corrections[doc.corrections.length - 1];
    expect(last.fields).toContain('slug');
    expect(last.previous.slug).toBe('ambulance-service-near-whitefield-bangalore');
    expect(last.reason).toMatch(/already taken/i);
  });

  test('an unrenameable slug still stops the run, fail closed', async () => {
    const doc = makeDoc({ duplicateSlug: true });
    mockClaim(doc);
    jest.spyOn(SeoArticle, 'exists').mockResolvedValue({ _id: 'someone-else' });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.stoppedReason).toMatch(/duplicate slug/i);
    expect(repairArticle).not.toHaveBeenCalled();
    expect(doc.status).toBe('draft');
  });

  test.each([['draft'], ['in_review']])('renaming from %s never approves or publishes', async (status) => {
    const doc = makeDoc({ duplicateSlug: true }, { status });
    mockClaim(doc);
    mockExists(new Set(['ambulance-service-near-whitefield-bangalore']));
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [] }; });

    await autoRepairArticle(doc._id);

    expect(doc.status).toBe(status);
    expect(['approved', 'published']).not.toContain(doc.status);
  });
});
