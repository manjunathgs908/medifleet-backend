/**
 * tests/seoController.test.js
 * ============================================================
 * The four routes that a document — rather than a lean object — passes
 * through: getById, update, and setStatus in both its approve and its reject
 * direction. These are the routes the reserved `schema` path took out, so
 * every case runs against a document in the PRE-RENAME shape, with the
 * JSON-LD stored under `schema` and claims stored as plain strings.
 *
 * The model is real. Only the database is faked: findById returns a genuinely
 * hydrated document, and save() is stubbed, because what is being tested is
 * what the controller does to the document, not that Mongo can store it.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');
const ctrl = require('../controllers/seoController');

const LEGACY_JSONLD = [{ '@type': 'Article', headline: 'Whitefield' }];

// A document exactly as it was written before either rename.
const legacyRaw = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  keyword: 'ambulance service near whitefield bangalore',
  slug: 'ambulance-service-whitefield',
  title: 'Ambulance Service in Whitefield, Bangalore | SaveLife 24x7',
  metaDescription: 'x'.repeat(154),
  h1: 'Ambulance service in Whitefield',
  content: 'the original body',
  status: 'draft',
  schema: LEGACY_JSONLD, // the old field name
  internalLinks: [
    { label: 'Dead body transport', href: '/services/dead-body-transport' },
    { label: 'Book an ambulance', href: '/book' },
  ],
  checks: {
    unverifiedClaims: [], // strings in the old shape; empty here unless a case says otherwise
    similarityScore: 0.1,
    duplicateSlug: false,
    wordCount: 900,
    titleLength: 57,
    metaLength: 154,
    passed: true,
  },
  ...over,
});

const hydrateLegacy = (over) => {
  const doc = SeoArticle.hydrate(legacyRaw(over));
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const next = jest.fn();

afterEach(() => {
  jest.restoreAllMocks();
  next.mockReset();
});

// Reads the payload from whichever of res.json / res.status().json was used.
const payload = (res) => res.json.mock.calls[0][0];

// What the client actually receives. update and setStatus hand res.json a
// live Mongoose document, and Express serialises it — so toJSON, and the
// legacy `schema` mirror it adds, only run at that point. Asserting on the
// document itself would be asserting on Document.prototype.schema, which is
// the model definition, not the article's JSON-LD.
const sent = (res) => JSON.parse(JSON.stringify(payload(res)));
const statusCode = (res) => (res.status.mock.calls.length ? res.status.mock.calls[0][0] : 200);

describe('GET /api/seo/articles/:id', () => {
  test('a legacy article comes back with both jsonLd and schema', async () => {
    // getById is a lean read, so the value is normalised by the post-findOne
    // hook rather than on hydration. Run the real hook over the raw row.
    const row = legacyRaw();
    await new Promise((resolve, reject) => {
      SeoArticle.schema.s.hooks.execPost('findOne', null, [row], (e) => (e ? reject(e) : resolve()));
    });
    jest.spyOn(SeoArticle, 'findById').mockReturnValue({ lean: () => Promise.resolve(row) });

    const res = mockRes();
    await ctrl.getById({ params: { id: String(row._id) } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payload(res).success).toBe(true);
    expect(payload(res).article.jsonLd).toEqual(LEGACY_JSONLD);
    expect(payload(res).article.schema).toEqual(LEGACY_JSONLD);
  });

  test('a missing article is a 404, not a crash', async () => {
    jest.spyOn(SeoArticle, 'findById').mockReturnValue({ lean: () => Promise.resolve(null) });
    const res = mockRes();
    await ctrl.getById({ params: { id: String(new mongoose.Types.ObjectId()) } }, res, next);
    expect(statusCode(res)).toBe(404);
  });
});

describe('PUT /api/seo/articles/:id', () => {
  test('editing a legacy article applies the patch and keeps its JSON-LD', async () => {
    const doc = hydrateLegacy();
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);

    const res = mockRes();
    await ctrl.update(
      { params: { id: String(doc._id) }, body: { title: 'A new title', reviewNotes: 'checked' } },
      res, next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(doc.save).toHaveBeenCalled();
    expect(doc.title).toBe('A new title');
    expect(doc.reviewNotes).toBe('checked');
    expect(doc.jsonLd).toEqual(LEGACY_JSONLD);
    // The JSON-LD was not rewritten, only read.
    expect(doc.modifiedPaths()).not.toContain('jsonLd');
    expect(sent(res).article.jsonLd).toEqual(LEGACY_JSONLD);
    expect(sent(res).article.schema).toEqual(LEGACY_JSONLD);
  });

  test('rewriting the body of an approved article re-opens it', async () => {
    const doc = hydrateLegacy({ status: 'approved' });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);

    const res = mockRes();
    await ctrl.update(
      { params: { id: String(doc._id) }, body: { content: 'a completely different body' } },
      res, next,
    );

    expect(doc.status).toBe('in_review');
    expect(doc.checks.passed).toBe(false);
  });

  test('a field outside the editable list is ignored', async () => {
    const doc = hydrateLegacy();
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);

    const res = mockRes();
    await ctrl.update(
      { params: { id: String(doc._id) }, body: { slug: 'hijacked', status: 'published' } },
      res, next,
    );

    expect(doc.slug).toBe('ambulance-service-whitefield');
    expect(doc.status).toBe('draft');
  });
});

describe('PUT /api/seo/articles/:id/status', () => {
  const call = async (doc, body) => {
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    const res = mockRes();
    await ctrl.setStatus(
      { params: { id: String(doc._id) }, body, user: { _id: new mongoose.Types.ObjectId() } },
      res, next,
    );
    return res;
  };

  test('approving a legacy article that passed its checks works', async () => {
    const doc = hydrateLegacy();
    const res = await call(doc, { status: 'approved' });

    expect(next).not.toHaveBeenCalled();
    expect(statusCode(res)).toBe(200);
    expect(doc.status).toBe('approved');
    expect(doc.reviewedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });

  test('rejecting works regardless of the checks', async () => {
    const doc = hydrateLegacy({ checks: { ...legacyRaw().checks, passed: false } });
    const res = await call(doc, { status: 'rejected', reviewNotes: 'invented a price' });

    expect(statusCode(res)).toBe(200);
    expect(doc.status).toBe('rejected');
    expect(doc.reviewNotes).toBe('invented a price');
  });

  test('publishing stamps publishedAt', async () => {
    const doc = hydrateLegacy();
    await call(doc, { status: 'published' });
    expect(doc.publishedAt).toBeInstanceOf(Date);
  });

  test('a failed draft is refused, and told exactly which gate it failed', async () => {
    const doc = hydrateLegacy({
      checks: {
        ...legacyRaw().checks,
        passed: false,
        titleLength: 63,
        metaLength: 120,
        wordCount: 400,
        duplicateSlug: true,
        similarityScore: 0.8,
        unverifiedClaims: [{ claim: 'We reach you in 12 minutes.', severity: 'fabricated', action: 'remove' }],
      },
    });
    const res = await call(doc, { status: 'approved' });

    expect(statusCode(res)).toBe(422);
    const msg = payload(res).message;
    expect(msg).toContain('1 unverified claim');
    expect(msg).toContain('duplicate slug');
    expect(msg).toContain('too similar');
    expect(msg).toContain('too short');
    expect(msg).toContain('title is 63 characters');
    expect(msg).toContain('meta description is 120 characters');
    expect(doc.status).toBe('draft');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a phrasing-only note is advisory and is not counted as a blocker', async () => {
    const doc = hydrateLegacy({
      checks: {
        ...legacyRaw().checks,
        passed: false,
        titleLength: 63, // the real, and only, failure
        unverifiedClaims: [{ claim: 'always available', severity: 'phrasing', action: 'rewrite' }],
      },
    });
    const res = await call(doc, { status: 'approved' });

    expect(statusCode(res)).toBe(422);
    expect(payload(res).message).not.toContain('unverified claim');
    expect(payload(res).message).toContain('title is 63 characters');
  });

  test('a legacy string claim still blocks approval', async () => {
    // Normalised to `unsupported` on hydration, which is what it meant before
    // severities existed.
    const doc = hydrateLegacy({
      checks: { ...legacyRaw().checks, passed: false, unverifiedClaims: ['an old plain-string claim'] },
    });
    const res = await call(doc, { status: 'approved' });

    expect(statusCode(res)).toBe(422);
    expect(payload(res).message).toContain('1 unverified claim');
  });

  test('an unknown status is a 400', async () => {
    const doc = hydrateLegacy();
    const res = await call(doc, { status: 'live' });
    expect(statusCode(res)).toBe(400);
  });
});
