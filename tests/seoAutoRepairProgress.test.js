/**
 * tests/seoAutoRepairProgress.test.js
 * ============================================================
 * What the loop writes down while it runs, and how it stops when the API
 * gives out under it.
 *
 * A run is one long request making up to four Claude calls, so the Studio has
 * nothing to show unless the loop records its own progress as it goes. Two
 * properties matter here. First, the phase written must match the step
 * actually in flight — a UI that says "Rechecking" while a repair is running
 * is worse than no UI. Second, `phase` is a progress label and nothing else:
 * it must never be the thing that decides an article passed.
 *
 * repairArticle and recheckArticle are mocked at the module boundary, exactly
 * as in seoAutoRepair.test.js. The orchestration is what is under test.
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
const { autoRepairArticle, classifyFailures, MAX_AUTO_REPAIR_ATTEMPTS } = require('../services/seoAutoRepair');

const CLEAN_CHECKS = {
  passed: false,
  unverifiedClaims: [],
  pricingClaims: [], schemaErrors: [], duplicateSlug: false,
  similarityScore: 0.05, livePageSimilarity: 0.03,
  wordCount: 900, titleLength: 57, metaLength: 154,
};

const blocking = (claim) => ({ claim, severity: 'unsupported', action: 'rewrite' });

/**
 * A document that records every phase it is saved with, so the ORDER of the
 * writes can be asserted rather than just the value left at the end.
 */
const makeDoc = (checks = {}, over = {}) => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'k', slug: 's', title: 'y'.repeat(57), metaDescription: 'x'.repeat(154),
    h1: 'h', content: 'c', status: 'draft', corrections: [],
    checks: { ...CLEAN_CHECKS, ...checks },
    generation: {},
    ...over,
  });
  doc.phaseLog = [];
  doc.save = jest.fn().mockImplementation(function save() {
    doc.phaseLog.push(doc.generation?.autoRepair?.phase ?? null);
    return Promise.resolve(doc);
  });
  return doc;
};

const mockClaim = (doc) => jest.spyOn(SeoArticle, 'findOneAndUpdate').mockResolvedValue(doc);

/** The phases actually written, in order, with consecutive repeats collapsed. */
const phases = (doc) => doc.phaseLog.filter((p, i, a) => p && p !== a[i - 1]);

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

// ============================================================
describe('A. the phase written matches the step actually running', () => {
  test('one successful cycle records detecting -> repairing -> rechecking -> passed', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockImplementation(async () => {
      // Asserted mid-flight: at the moment the repair is running, the phase on
      // the document must say so. Checking only the final value would pass
      // even if every phase were written at the end.
      expect(doc.generation.autoRepair.phase).toBe('repairing');
      return { repaired: true, repairedFields: ['content'] };
    });
    recheckArticle.mockImplementation(async () => {
      expect(doc.generation.autoRepair.phase).toBe('rechecking');
      doc.checks.passed = true;
      return { passed: true, failedChecks: [] };
    });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(phases(doc)).toEqual(['detecting', 'repairing', 'rechecking', 'passed']);
  });

  test('a second cycle repeats the pair before the terminal phase', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle
      .mockResolvedValueOnce({ passed: false, failedChecks: ['still failing'] })
      .mockImplementationOnce(async () => { doc.checks.passed = true; return { passed: true, failedChecks: [] }; });

    await autoRepairArticle(doc._id);

    expect(phases(doc)).toEqual(['detecting', 'repairing', 'rechecking', 'repairing', 'rechecking', 'passed']);
  });

  test('running is true throughout and false once it is over', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockImplementation(async () => {
      expect(doc.generation.autoRepair.running).toBe(true);
      return { repaired: true, repairedFields: ['content'] };
    });
    recheckArticle.mockImplementation(async () => { doc.checks.passed = true; return { passed: true, failedChecks: [] }; });

    await autoRepairArticle(doc._id);

    expect(doc.generation.autoRepair.running).toBe(false);
  });

  test('the cap is recorded next to the count, so the UI need not hardcode it', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockResolvedValue({ passed: false, failedChecks: ['nope'] });

    const r = await autoRepairArticle(doc._id, { maxAttempts: 2 });

    expect(doc.generation.autoRepair.maxAttempts).toBe(2);
    expect(doc.generation.autoRepair.attempts).toBe(2);
    expect(r.attempts).toBe(2);
  });
});

// ============================================================
describe('B. a terminal phase never stands in for a gate result', () => {
  test('exhausting the attempts leaves phase stopped and checks.passed false', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockResolvedValue({ passed: false, failedChecks: ['meta too short'] });

    const r = await autoRepairArticle(doc._id);

    expect(doc.generation.autoRepair.phase).toBe('stopped');
    expect(r.passed).toBe(false);
    expect(doc.checks.passed).toBe(false);
    expect(doc.status).toBe('draft');
    expect(r.stoppedReason).toMatch(/max-attempts/);
  });

  test('phase passed is only ever written when the recheck itself passed', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    // A recheck that reports a pass but never sets checks.passed. The loop
    // must not invent the flag from its own phase.
    recheckArticle.mockResolvedValue({ passed: true, failedChecks: [] });

    await autoRepairArticle(doc._id);

    expect(doc.generation.autoRepair.phase).toBe('passed');
    expect(doc.checks.passed).toBe(false); // untouched by the loop
    expect(doc.status).toBe('draft');      // and still not approved
  });

  test('a blocked failure stops without ever entering a repairing phase', async () => {
    // duplicateSlug, not pricing: pricing is carried now, not blocked.
    const doc = makeDoc({ duplicateSlug: true, unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);

    const r = await autoRepairArticle(doc._id);

    expect(repairArticle).not.toHaveBeenCalled();
    expect(phases(doc)).toEqual(['detecting', 'stopped']);
    expect(r.stoppedReason).toMatch(/needs human review/);
  });
});

// ============================================================
describe('C. the API giving out is a clean stop, not a corrupted article', () => {
  const billing = () => Object.assign(new Error('credit balance'), {
    name: 'ClaudeApiError',
    code: 'billing',
    status: 402,
    message: 'Anthropic rejected the request: Your credit balance is too low. Top up at console.anthropic.com/settings/billing.',
  });

  test('the billing message is recorded verbatim as the reason it stopped', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockRejectedValue(billing());

    await expect(autoRepairArticle(doc._id)).rejects.toMatchObject({ name: 'ClaudeApiError' });

    const auto = doc.generation.autoRepair;
    expect(auto.stoppedReason).toMatch(/Anthropic/);
    expect(auto.stoppedReason).toMatch(/credit balance/);
    expect(auto.stoppedReason).toMatch(/billing/);
  });

  test('the lock is released so the operator can retry once they have topped up', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockRejectedValue(billing());

    await expect(autoRepairArticle(doc._id)).rejects.toThrow();

    expect(doc.generation.autoRepair.running).toBe(false);
    expect(doc.generation.autoRepair.phase).toBe('stopped');
  });

  test('article state is not corrupted: no approval, no passed flag, no status move', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] }, { status: 'in_review' });
    mockClaim(doc);
    repairArticle.mockRejectedValue(billing());

    await expect(autoRepairArticle(doc._id)).rejects.toThrow();

    expect(doc.status).toBe('in_review');
    expect(doc.checks.passed).toBe(false);
    expect(doc.corrections).toHaveLength(0);
  });

  test('a failure during the recheck half is recorded the same way', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockRejectedValue(billing());

    await expect(autoRepairArticle(doc._id)).rejects.toThrow();

    expect(doc.generation.autoRepair.phase).toBe('stopped');
    expect(doc.generation.autoRepair.stoppedReason).toMatch(/Anthropic/);
    expect(doc.checks.passed).toBe(false);
  });

  test('an ordinary crash is still reported as an error, not as a billing stop', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockRejectedValue(new Error('mongo exploded'));

    await expect(autoRepairArticle(doc._id)).rejects.toThrow(/mongo exploded/);

    expect(doc.generation.autoRepair.stoppedReason).toMatch(/^error: mongo exploded/);
    expect(doc.generation.autoRepair.stoppedReason).not.toMatch(/Anthropic/);
  });
});

// ============================================================
describe('D. the pricing guard survives a round trip through the schema', () => {
  // Regression. evaluateGates has always returned checks.pricingClaims, but
  // the field was absent from the schema, so strict mode dropped it on save.
  // Approval was never affected -- `passed` is computed with the price
  // included and does persist -- but classifyFailures reads pricingClaims off
  // a freshly loaded article to decide a priced draft needs a person, and it
  // was reading an empty list every time.
  test('checks.pricingClaims is a declared path, not an ad-hoc property', () => {
    expect(SeoArticle.schema.path('checks.pricingClaims')).toBeDefined();
  });

  test('a price set on a stored article is still there when it is read back', () => {
    const doc = makeDoc({ pricingClaims: ['\u20b91,200', '\u20b91,500'] });
    expect(doc.checks.pricingClaims).toHaveLength(2);
    expect(doc.toObject().checks.pricingClaims).toHaveLength(2);
  });

  // CONTRACT CHANGE. These two used to assert that an article already carrying
  // fares was refused before attempt 1. That is the production bug: an article
  // with eleven fares could not have a single unsupported claim or a broken
  // title fixed, because the loop declined to start. Existing pricing is
  // baseline state \u2014 carried, reported, and left exactly as it is.
  // POLICY CHANGE. A public article carries no exact price at all, so a fare
  // on the page is the defect and removing it is the repair. This has moved
  // twice: `blocked` (stopped the loop before attempt 1), then `carried` (ran,
  // but left the fares on a public page forever), now `repairable`.
  test('classifyFailures treats a price as repairable, and never as blocking', () => {
    const { repairable, blocked } = classifyFailures({
      pricingClaims: ['\u20b91,200'],
      unverifiedClaims: [blocking('a claim')],
      metaLength: 154, titleLength: 57, wordCount: 900,
    });
    expect(repairable.join(' ')).toMatch(/price/i);
    expect(repairable.join(' ')).toMatch(/remove/i);
    expect(blocked).toEqual([]); // never a reason to refuse to start
  });

  test('a genuinely blocked failure still refuses to start', () => {
    const { blocked } = classifyFailures({
      duplicateSlug: true, metaLength: 154, titleLength: 57, wordCount: 900,
    });
    expect(blocked.join(' ')).toMatch(/duplicate slug/i);
  });
});

// ============================================================
describe('E. existing pricing is baseline state, not a preflight failure', () => {
  // The production report: "Ambulance Service Near Whitefield" stopped before
  // attempt 1 with "11 fixed price(s) \u2014 a repair must never produce one".
  const ELEVEN = Array.from({ length: 11 }, (_, i) => `\u20b9${1000 + i * 100}`);

  test('A + G. eleven existing prices do NOT stop the loop before attempt 1', async () => {
    const doc = makeDoc({ pricingClaims: [...ELEVEN], unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockResolvedValue({ passed: false, failedChecks: ['11 fixed price(s)'] });

    const r = await autoRepairArticle(doc._id);

    // The bug was: attempts === 0 and repairArticle never called.
    expect(repairArticle).toHaveBeenCalled();
    expect(r.attempts).toBeGreaterThan(0);
    expect(r.stoppedReason).not.toMatch(/stopped before attempt/i);
    expect(r.timeline.join(' ')).not.toMatch(/stopped before attempt 1/i);
  });

  // POLICY CHANGE. The fares are no longer "carried and reported" — they are
  // what the attempt is sent to remove.
  test('the eleven prices are named as a repair target for the attempt', async () => {
    const doc = makeDoc({ pricingClaims: [...ELEVEN], unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockResolvedValue({ passed: false, failedChecks: ['11 fixed price(s)'] });

    const r = await autoRepairArticle(doc._id);

    expect(r.timeline.join(' ')).toMatch(/11 exact price\(s\) to remove/i);
    expect(repairArticle).toHaveBeenCalled();
    // Whatever it repairs, it never approves.
    expect(doc.status).toBe('draft');
    expect(doc.checks.passed).toBe(false);
  });

  test('the 2-attempt cap still holds on a priced article', async () => {
    const doc = makeDoc({ pricingClaims: [...ELEVEN], unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockResolvedValue({ passed: false, failedChecks: ['11 fixed price(s)'] });

    const r = await autoRepairArticle(doc._id);

    expect(r.attempts).toBe(MAX_AUTO_REPAIR_ATTEMPTS);
    expect(repairArticle).toHaveBeenCalledTimes(MAX_AUTO_REPAIR_ATTEMPTS);
  });

  test('a repair that keeps all eleven prices is not treated as making things worse', async () => {
    const doc = makeDoc({ pricingClaims: [...ELEVEN], unverifiedClaims: [blocking('a claim')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    // Same eleven prices before and after: isWorse must not fire.
    recheckArticle.mockImplementation(async (a) => {
      a.checks.pricingClaims = [...ELEVEN];
      a.checks.unverifiedClaims = [];
      return { passed: false, failedChecks: ['11 fixed price(s)'] };
    });

    const r = await autoRepairArticle(doc._id);

    expect(r.timeline.join(' ')).not.toMatch(/REVERTED/);
  });

  test('a TWELFTH price appearing during the loop still triggers a revert', async () => {
    const doc = makeDoc({ pricingClaims: [...ELEVEN], unverifiedClaims: [blocking('a claim')] }, { content: 'clean' });
    mockClaim(doc);
    repairArticle.mockImplementation(async (a) => { a.content = 'rewritten'; return { repaired: true, repairedFields: ['content'] }; });
    recheckArticle.mockImplementation(async (a) => {
      a.checks.pricingClaims = [...ELEVEN, '\u20b99,999'];
      return { passed: false, failedChecks: ['12 fixed price(s)'] };
    });

    const r = await autoRepairArticle(doc._id);

    expect(r.timeline.join(' ')).toMatch(/REVERTED/);
    expect(doc.content).toBe('clean');
  });
});
