/**
 * tests/seoAutoRepair.test.js
 * ============================================================
 * The automatic repair -> recheck loop.
 *
 * Two properties matter more than the happy path. First, the loop must stop
 * at exactly the failures a rewrite cannot honestly fix — a duplicate slug, a
 * cannibalisation score, a published price — because "fixing" any of those
 * means overruling a decision somebody has to make. Second, it must never
 * arrive at approval: the best outcome it can produce is a clean article
 * sitting exactly where it was, waiting for a person.
 *
 * repairArticle and recheckArticle are mocked at the module boundary. They
 * have their own suites; what is under test here is the orchestration —
 * what it chooses to attempt, when it refuses, and what it records.
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
const {
  autoRepairArticle, classifyFailures, AutoRepairBusyError, MAX_AUTO_REPAIR_ATTEMPTS,
} = require('../services/seoAutoRepair');

const CLEAN_CHECKS = {
  passed: false,
  unverifiedClaims: [],
  pricingClaims: [], schemaErrors: [], duplicateSlug: false,
  similarityScore: 0.05, livePageSimilarity: 0.03,
  wordCount: 900, titleLength: 57, metaLength: 154,
};

const blocking = (claim) => ({ claim, severity: 'unsupported', action: 'rewrite' });

const makeDoc = (checks = {}, over = {}) => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'k', slug: 's', title: 'y'.repeat(57), metaDescription: 'x'.repeat(154),
    h1: 'h', content: 'c', status: 'draft', corrections: [],
    checks: { ...CLEAN_CHECKS, ...checks },
    generation: {},
    ...over,
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

/** Stand in for the atomic lock claim. */
const mockClaim = (doc) => jest.spyOn(SeoArticle, 'findOneAndUpdate').mockResolvedValue(doc);

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

// ── classification ───────────────────────────────────────────
describe('E/F/G. only genuinely repairable failures are attempted', () => {
  test.each([
    ['duplicate slug', { duplicateSlug: true }, /duplicate slug/i],
    ['draft cannibalisation', { similarityScore: 0.8 }, /similarity/i],
    ['live-page cannibalisation', { livePageSimilarity: 0.7 }, /cannibalisation/i],
    ['fixed pricing', { pricingClaims: ['₹1,200'] }, /price/i],
    ['schema errors', { schemaErrors: ['bad node'] }, /schema/i],
    ['short article', { wordCount: 400 }, /words/i],
  ])('%s is never auto-repaired', (_label, checks, pattern) => {
    const { repairable, blocked } = classifyFailures({ ...CLEAN_CHECKS, ...checks });
    expect(blocked.join(' ')).toMatch(pattern);
    expect(repairable).toEqual([]);
  });

  test.each([
    ['blocking claims', { unverifiedClaims: [blocking('x'), blocking('y')] }, /2 blocking claim/],
    ['short meta', { metaLength: 146 }, /meta 146/],
    ['long title', { titleLength: 71 }, /title 71/],
  ])('%s IS repairable', (_label, checks, pattern) => {
    const { repairable, blocked } = classifyFailures({ ...CLEAN_CHECKS, ...checks });
    expect(repairable.join(' ')).toMatch(pattern);
    expect(blocked).toEqual([]);
  });

  test('a phrasing-only claim is not a reason to repair', () => {
    const { repairable } = classifyFailures({
      ...CLEAN_CHECKS,
      unverifiedClaims: [{ claim: 'wording', severity: 'phrasing', action: 'rewrite' }],
    });
    expect(repairable).toEqual([]);
  });

  test('a blocked failure wins even when something repairable is also present', async () => {
    const doc = makeDoc({ duplicateSlug: true, unverifiedClaims: [blocking('x')] });
    mockClaim(doc);

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.stoppedReason).toMatch(/needs human review/i);
    expect(repairArticle).not.toHaveBeenCalled();
  });
});

// ── the loop ─────────────────────────────────────────────────
describe('A. a passing article is left alone', () => {
  test('no repair, no recheck, no change', async () => {
    const doc = makeDoc({ passed: true });
    mockClaim(doc);

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(0);
    expect(r.stoppedReason).toBe('already-passing');
    expect(repairArticle).not.toHaveBeenCalled();
    expect(recheckArticle).not.toHaveBeenCalled();
  });
});

describe('B. one repair is enough', () => {
  test('repair -> recheck -> PASS', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [], article: a }; });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.stoppedReason).toBeNull();
    expect(repairArticle).toHaveBeenCalledTimes(1);
    expect(recheckArticle).toHaveBeenCalledTimes(1);
  });
});

describe('C. the second attempt succeeds', () => {
  test('repair -> fail -> repair -> PASS', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle
      .mockImplementationOnce(async (a) => { a.checks.passed = false; return { passed: false, failedChecks: ['1 blocking claim(s)'], article: a }; })
      .mockImplementationOnce(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [], article: a }; });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(repairArticle).toHaveBeenCalledTimes(2);
  });
});

describe('D. two failures and it stops', () => {
  test('never exceeds the cap, and says why it stopped', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = false; return { passed: false, failedChecks: ['1 blocking claim(s)'], article: a }; });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(MAX_AUTO_REPAIR_ATTEMPTS);
    expect(r.attempts).toBe(2);
    expect(r.stoppedReason).toMatch(/max-attempts/);
    expect(repairArticle).toHaveBeenCalledTimes(2);
  });

  test('a repair that changes nothing stops the loop immediately', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: false, repairedFields: [] });

    const r = await autoRepairArticle(doc._id);

    expect(r.attempts).toBe(1);
    expect(r.stoppedReason).toMatch(/no changes/i);
    expect(recheckArticle).not.toHaveBeenCalled();
  });
});

describe('G. pricing stays blocked through the loop', () => {
  // CONTRACT CHANGE. This used to assert that the loop simply stopped, which
  // left the priced text saved on the article — the reviewer was handed a page
  // carrying fares that the repair had just put there. A repair that
  // introduces a price is now UNDONE: the article goes back to the text it
  // started with, and the remaining attempt is spent from that clean state.
  test('a price appearing after a repair is reverted, not left on the article', async () => {
    const ORIGINAL = 'the original body, with no price in it';
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] }, { content: ORIGINAL });
    mockClaim(doc);
    // The repair rewrites the body and the recheck then finds a price in it.
    repairArticle.mockImplementation(async (a) => {
      a.content = 'a rewritten body quoting ₹1,500';
      return { repaired: true, repairedFields: ['content'] };
    });
    recheckArticle.mockImplementation(async (a) => {
      a.checks.passed = false;
      a.checks.pricingClaims = ['₹1,500'];
      a.checks.unverifiedClaims = [];
      return { passed: false, failedChecks: ['1 fixed price(s)'], article: a };
    });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(false);
    // The whole point: the priced rewrite is gone.
    expect(doc.content).toBe(ORIGINAL);
    expect(doc.checks.pricingClaims).toEqual([]);
    expect(r.stoppedReason).toMatch(/price/i);
    expect(r.timeline.join(' ')).toMatch(/REVERTED/);
    // Never approved, never published, whatever the repair did.
    expect(doc.status).toBe('draft');
    expect(doc.checks.passed).toBe(false);
  });

  test('the cap still holds when every attempt has to be reverted', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] }, { content: 'clean body' });
    mockClaim(doc);
    repairArticle.mockImplementation(async (a) => { a.content = 'body with ₹1,500'; return { repaired: true, repairedFields: ['content'] }; });
    recheckArticle.mockImplementation(async (a) => {
      a.checks.passed = false;
      a.checks.pricingClaims = ['₹1,500'];
      return { passed: false, failedChecks: ['1 fixed price(s)'], article: a };
    });

    const r = await autoRepairArticle(doc._id);

    expect(r.attempts).toBe(MAX_AUTO_REPAIR_ATTEMPTS);
    expect(repairArticle).toHaveBeenCalledTimes(MAX_AUTO_REPAIR_ATTEMPTS);
    expect(doc.content).toBe('clean body');
    expect(r.stoppedReason).toMatch(/undone/i);
  });
});

describe('H/I. the loop never approves and never publishes', () => {
  test.each([['draft'], ['in_review']])('a PASS from %s leaves the status alone', async (status) => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] }, { status });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, failedChecks: [], article: a }; });

    const r = await autoRepairArticle(doc._id);

    expect(r.passed).toBe(true);
    expect(doc.status).toBe(status);
    expect(doc.status).not.toBe('approved');
    expect(doc.status).not.toBe('published');
    expect(doc.publishedAt).toBeUndefined();
  });

  test('the loop writes no status field at all', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = true; return { passed: true, article: a, failedChecks: [] }; });

    await autoRepairArticle(doc._id);

    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'seoAutoRepair.js'), 'utf8');
    expect(src).not.toMatch(/\.status\s*=/);
    expect(src).not.toMatch(/publishedAt/);
  });
});

describe('J. two loops cannot run on one article', () => {
  test('a claim that returns nothing means somebody else holds it', async () => {
    jest.spyOn(SeoArticle, 'findOneAndUpdate').mockResolvedValue(null);
    await expect(autoRepairArticle(new mongoose.Types.ObjectId())).rejects.toThrow(AutoRepairBusyError);
    expect(repairArticle).not.toHaveBeenCalled();
  });

  test('the lock is claimed with a conditional update, not a read-then-write', async () => {
    const doc = makeDoc({ passed: true });
    const spy = mockClaim(doc);
    await autoRepairArticle(doc._id);
    const [filter, update] = spy.mock.calls[0];
    expect(filter['generation.autoRepair.running']).toEqual({ $ne: true });
    expect(update.$set['generation.autoRepair.running']).toBe(true);
  });

  test('the lock is released even when a step throws', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockRejectedValue(new Error('Claude exploded'));

    await expect(autoRepairArticle(doc._id)).rejects.toThrow('Claude exploded');
    expect(doc.generation.autoRepair.running).toBe(false);
    expect(doc.generation.autoRepair.stoppedReason).toMatch(/error: Claude exploded/);
  });
});

describe('K. provenance', () => {
  test('the attempt number is handed to repairArticle for corrections[]', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = false; return { passed: false, failedChecks: ['x'], article: a }; });

    await autoRepairArticle(doc._id);

    expect(repairArticle).toHaveBeenNthCalledWith(1, doc, { attempt: 1, automatic: true });
    expect(repairArticle).toHaveBeenNthCalledWith(2, doc, { attempt: 2, automatic: true });
  });

  test('attempts, stoppedReason and a readable timeline are recorded', async () => {
    const doc = makeDoc({ unverifiedClaims: [blocking('x')] });
    mockClaim(doc);
    repairArticle.mockResolvedValue({ repaired: true, repairedFields: ['content'] });
    recheckArticle.mockImplementation(async (a) => { a.checks.passed = false; return { passed: false, failedChecks: ['still bad'], article: a }; });

    const r = await autoRepairArticle(doc._id);

    expect(doc.generation.autoRepair.attempts).toBe(2);
    expect(doc.generation.autoRepair.stoppedReason).toMatch(/max-attempts/);
    expect(doc.generation.autoRepair.running).toBe(false);
    expect(r.timeline.join(' ')).toMatch(/attempt 1\/2/);
    expect(r.timeline.join(' ')).toMatch(/recheck failed/);
  });
});

describe('L. approved articles are unaffected', () => {
  test('an approved, passing article is a no-op', async () => {
    const doc = makeDoc({ passed: true }, { status: 'approved' });
    mockClaim(doc);

    const r = await autoRepairArticle(doc._id);

    expect(r.attempts).toBe(0);
    expect(doc.status).toBe('approved');
    expect(doc.checks.passed).toBe(true);
    expect(repairArticle).not.toHaveBeenCalled();
  });

  test('the approval gate in setStatus is untouched by any of this', async () => {
    const ctrl = require('../controllers/seoController');
    const doc = makeDoc({ passed: false }, { status: 'in_review' });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };

    await ctrl.setStatus({ params: { id: String(doc._id) }, body: { status: 'approved' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(doc.status).toBe('in_review');
  });
});
