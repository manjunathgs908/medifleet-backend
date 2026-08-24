/**
 * tests/seoArticle.test.js
 * ============================================================
 * The model in isolation. Nothing here connects to MongoDB: every case
 * either builds a document or hydrates one from a raw object, which is
 * exactly where the bugs being guarded against actually live.
 *
 * Two of them:
 *
 *   1. The JSON-LD used to be stored in a path called `schema`. That is a
 *      reserved name on a Mongoose document, so the path shadowed
 *      Document.prototype.schema and any property access on a hydrated
 *      document threw. It is now `jsonLd`, and documents written before the
 *      rename are normalised as they load.
 *   2. checks.unverifiedClaims used to hold plain strings, before claims
 *      carried a severity and a suggested action.
 *
 * Both old shapes are still sitting in the collection, so both are tested.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');
const gen = require('../services/seoGenerator');

const base = () => ({
  _id: new mongoose.Types.ObjectId(),
  keyword: 'ambulance service near whitefield bangalore',
  slug: 'ambulance-service-whitefield',
  title: 'Ambulance Service in Whitefield, Bangalore | SaveLife 24x7',
  metaDescription: 'x'.repeat(154),
  h1: 'Ambulance service in Whitefield',
  content: 'body',
  status: 'draft',
});

const JSONLD = [{ '@type': 'Article', headline: 'Whitefield' }, { '@type': 'FAQPage' }];

// Runs the post-query hooks the model actually registers, rather than calling
// the compatibility function directly — so a hook that stops being registered
// fails the test instead of quietly passing it.
const runQueryHook = (name, arg) =>
  new Promise((resolve, reject) => {
    SeoArticle.schema.s.hooks.execPost(name, null, [arg], (err) => (err ? reject(err) : resolve(arg)));
  });

describe('reserved `schema` path', () => {
  test('the JSON-LD path is jsonLd, and nothing is called schema', () => {
    expect(SeoArticle.schema.path('jsonLd')).toBeDefined();
    expect(SeoArticle.schema.path('schema')).toBeUndefined();
  });

  test('property access on a hydrated document does not throw', () => {
    // The original symptom was "Cannot read properties of undefined (reading
    // Symbol(mongoose#Document#scope))" on the first property read. This is
    // the regression test for update and setStatus.
    const doc = SeoArticle.hydrate({ ...base(), jsonLd: JSONLD });
    expect(() => doc.keyword).not.toThrow();
    expect(doc.status).toBe('draft');
    expect(doc.jsonLd).toHaveLength(2);
  });

  test('a legacy document storing JSON-LD under schema still reads', () => {
    const doc = SeoArticle.hydrate({ ...base(), schema: JSONLD });
    expect(doc.jsonLd).toEqual(JSONLD);
  });

  test('a stale schema key never clobbers a real jsonLd value', () => {
    const stale = [{ '@type': 'Thing', headline: 'stale' }];
    const doc = SeoArticle.hydrate({ ...base(), jsonLd: JSONLD, schema: stale });
    expect(doc.jsonLd).toEqual(JSONLD);
  });

  test('reading a legacy document does not mark jsonLd modified', () => {
    // If it did, saving a legacy document would write a second copy of the
    // JSON-LD while the original key stayed behind.
    const doc = SeoArticle.hydrate({ ...base(), schema: JSONLD });
    expect(doc.isModified('jsonLd')).toBe(false);
    expect(doc.modifiedPaths()).toEqual([]);
  });

  test('toJSON mirrors jsonLd back to schema for existing API consumers', () => {
    const out = SeoArticle.hydrate({ ...base(), jsonLd: JSONLD }).toJSON();
    expect(out.jsonLd).toEqual(JSONLD);
    expect(out.schema).toEqual(JSONLD);
  });

  test('lean reads carry both keys, legacy or not', async () => {
    const legacy = await runQueryHook('findOne', { ...base(), schema: JSONLD });
    expect(legacy.jsonLd).toEqual(JSONLD);
    expect(legacy.schema).toEqual(JSONLD);

    const modern = await runQueryHook('findOne', { ...base(), jsonLd: JSONLD });
    expect(modern.jsonLd).toEqual(JSONLD);
    expect(modern.schema).toEqual(JSONLD);
  });

  test('a lean list is normalised row by row', async () => {
    const rows = await runQueryHook('find', [
      { ...base(), schema: JSONLD },
      { ...base(), jsonLd: JSONLD },
      { ...base() }, // projected away, as the list route does
    ]);
    expect(rows[0].jsonLd).toEqual(JSONLD);
    expect(rows[1].schema).toEqual(JSONLD);
    expect(rows[2].jsonLd).toBeUndefined();
    expect(rows[2].schema).toBeUndefined();
  });

  test('hydrated documents are left alone by the lean hook', async () => {
    const doc = SeoArticle.hydrate({ ...base(), jsonLd: JSONLD });
    await runQueryHook('findOne', doc);
    expect(doc.modifiedPaths()).toEqual([]);
  });

  test('normaliseLegacy tolerates null and non-objects', () => {
    expect(SeoArticle.normaliseLegacy(null)).toBeNull();
    expect(SeoArticle.normaliseLegacy('nope')).toBe('nope');
  });
});

describe('claim severities', () => {
  test('a structured claim validates', () => {
    const d = new SeoArticle({ ...base(), checks: { unverifiedClaims: [{ claim: 'x', severity: 'fabricated', action: 'remove' }] } });
    expect(d.validateSync()).toBeUndefined();
  });

  test('an unknown severity is rejected', () => {
    const d = new SeoArticle({ ...base(), checks: { unverifiedClaims: [{ claim: 'x', severity: 'nope', action: 'remove' }] } });
    expect(d.validateSync()).toBeDefined();
  });

  test('an unknown action is rejected', () => {
    const d = new SeoArticle({ ...base(), checks: { unverifiedClaims: [{ claim: 'x', severity: 'phrasing', action: 'nuke' }] } });
    expect(d.validateSync()).toBeDefined();
  });

  test('severity and action default to the conservative reading', () => {
    const d = new SeoArticle({ ...base(), checks: { unverifiedClaims: [{ claim: 'x' }] } });
    expect(d.checks.unverifiedClaims[0].severity).toBe('unsupported');
    expect(d.checks.unverifiedClaims[0].action).toBe('rewrite');
  });

  test('legacy string claims normalise on read, with no migration', () => {
    const d = SeoArticle.hydrate({ ...base(), checks: { unverifiedClaims: ['an old plain-string claim'] } });
    expect(d.checks.unverifiedClaims[0].claim).toBe('an old plain-string claim');
    expect(d.checks.unverifiedClaims[0].severity).toBe('unsupported');
    expect(d.checks.unverifiedClaims[0].action).toBe('rewrite');
  });

  test('a legacy document can carry both old shapes at once', () => {
    const d = SeoArticle.hydrate({ ...base(), schema: JSONLD, checks: { unverifiedClaims: ['old claim'] } });
    expect(d.jsonLd).toEqual(JSONLD);
    expect(d.checks.unverifiedClaims[0].severity).toBe('unsupported');
  });
});

describe('quality gate fields', () => {
  test('droppedLinks persist, with href required', () => {
    const d = new SeoArticle({ ...base(), checks: { droppedLinks: [{ href: '/nope', label: 'Invented', reason: 'r' }] } });
    expect(d.validateSync()).toBeUndefined();
    expect(d.checks.droppedLinks[0].href).toBe('/nope');
  });

  test('a droppedLink without an href is rejected', () => {
    const d = new SeoArticle({ ...base(), checks: { droppedLinks: [{ label: 'no href' }] } });
    expect(d.validateSync()).toBeDefined();
  });

  test('titleLength and metaLength are stored as numbers', () => {
    const d = new SeoArticle({ ...base(), checks: { titleLength: 57, metaLength: 154 } });
    expect(d.checks.titleLength).toBe(57);
    expect(d.checks.metaLength).toBe(154);
  });

  test('the length constants are the ranges the gate enforces', () => {
    expect([gen.TITLE_MIN, gen.TITLE_MAX, gen.META_MIN, gen.META_MAX]).toEqual([55, 60, 150, 160]);
  });

  test('similarity: identical text scores 1, unrelated text scores below the block', () => {
    const a = gen.shingle('ambulance service near whitefield bangalore around the clock dispatch');
    const b = gen.shingle('ambulance service near whitefield bangalore around the clock dispatch');
    const c = gen.shingle('freezer box rental delivered to the home with setup and collection');
    expect(gen.jaccard(a, b)).toBe(1);
    expect(gen.jaccard(a, c)).toBeLessThan(gen.SIMILARITY_BLOCK);
  });
});
