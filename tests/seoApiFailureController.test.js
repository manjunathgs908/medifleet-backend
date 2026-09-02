/**
 * tests/seoApiFailureController.test.js
 * ============================================================
 * What the Studio is handed when the Anthropic API is the thing that failed.
 *
 * The operator-facing property: a billing stop must arrive as a billing stop,
 * with the API's own sentence and a status the UI can branch on. A 500 saying
 * "Generation failed" is worse than useless here — it sends somebody to read a
 * draft that is fine, when the answer is to top up the account.
 *
 * Separate file from seoApiFailure because the controller destructures its
 * imports at load time, so both services have to be mocked before it is
 * required — which cannot coexist with the tests that run the real generator.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../services/seoGenerator', () => ({
  generateDraft: jest.fn(),
  recheckArticle: jest.fn(),
  repairArticle: jest.fn(),
  DuplicateKeywordError: class DuplicateKeywordError extends Error {},
  NothingToRepairError: class NothingToRepairError extends Error {},
  SIMILARITY_BLOCK: 0.55, MIN_WORDS: 700,
  TITLE_MIN: 55, TITLE_MAX: 60, META_MIN: 150, META_MAX: 160,
}));

jest.mock('../services/seoAutoRepair', () => ({
  autoRepairArticle: jest.fn(),
  AutoRepairBusyError: class AutoRepairBusyError extends Error {
    constructor() { super('An automatic repair is already running on this article.'); this.name = 'AutoRepairBusyError'; }
  },
}));

const SeoArticle = require('../models/SeoArticle');
const ctrl = require('../controllers/seoController');
// NothingToRepairError comes from the MOCK above, which is the same class
// object the controller holds — so `instanceof` in the controller is a real
// test of the contract rather than an accident of module identity.
const { generateDraft, recheckArticle, repairArticle, NothingToRepairError } = require('../services/seoGenerator');
const { autoRepairArticle, AutoRepairBusyError } = require('../services/seoAutoRepair');

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

/**
 * Exactly the shape seoGenerator's toClaudeApiError produces. Built by hand
 * rather than imported, because the generator is mocked in this file — and
 * because the controller identifies these by NAME, so a literal is a fair
 * test of that contract.
 */
const claudeError = (over = {}) => Object.assign(new Error(over.message || 'boom'), {
  name: 'ClaudeApiError',
  status: 402,
  code: 'billing',
  retryable: false,
  ...over,
});

const BILLING = () => claudeError({
  message: 'Anthropic rejected the request: Your credit balance is too low to access the Anthropic API. Top up at console.anthropic.com/settings/billing and run this again. Nothing was written to the article.',
});

const article = (over = {}) => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'k', slug: 's', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
    status: 'draft', corrections: [], checks: { passed: false }, generation: {},
    ...over,
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

/**
 * The controller reads the article two different ways: `await findById(id)` in
 * recheck/repair, and `await findById(id).select(...)` in autoRepair. A plain
 * mockResolvedValue satisfies only the first — the second throws on .select,
 * and the throw lands in the same catch the test is trying to observe, which
 * makes a routing bug look like a passing assertion. This satisfies both.
 */
const findById = (doc) => jest.spyOn(SeoArticle, 'findById').mockImplementation(() => {
  const p = Promise.resolve(doc);
  p.select = () => Promise.resolve(doc);
  return p;
});

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

// ============================================================
describe('A. a billing stop reaches the operator intact, on every Claude route', () => {
  test('generate', async () => {
    generateDraft.mockRejectedValue(BILLING());
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'bls ambulance' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(402);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.code).toBe('billing');
    expect(body.message).toMatch(/credit balance is too low/i);
    expect(body.message).toMatch(/console\.anthropic\.com\/settings\/billing/);
  });

  test('recheck', async () => {
    findById(article());
    recheckArticle.mockRejectedValue(BILLING());
    const res = mockRes();
    await ctrl.recheck({ params: { id: 'x' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json.mock.calls[0][0].code).toBe('billing');
  });

  test('repair', async () => {
    findById(article());
    repairArticle.mockRejectedValue(BILLING());
    const res = mockRes();
    await ctrl.repair({ params: { id: 'x' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json.mock.calls[0][0].code).toBe('billing');
  });

  test('auto-repair', async () => {
    findById(article());
    autoRepairArticle.mockRejectedValue(BILLING());
    const res = mockRes();
    await ctrl.autoRepair({ params: { id: 'x' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json.mock.calls[0][0].code).toBe('billing');
  });

  test('none of them fall through to the generic error handler', async () => {
    generateDraft.mockRejectedValue(BILLING());
    const next = jest.fn();
    await ctrl.generate({ body: { keyword: 'k' }, user: {} }, mockRes(), next);
    expect(next).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('B. each kind of API failure keeps its own status', () => {
  test.each([
    { label: 'billing', code: 'billing', status: 402 },
    { label: 'expired key', code: 'auth', status: 401 },
    { label: 'rate limit', code: 'rate_limit', status: 429, retryable: true },
    { label: 'overloaded', code: 'overloaded', status: 503, retryable: true },
  ])('$label -> HTTP $status', async ({ code, status, retryable = false }) => {
    generateDraft.mockRejectedValue(claudeError({ code, status, retryable, message: `a ${code} problem` }));
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'k' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(status);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe(code);
    expect(body.retryable).toBe(retryable);
  });
});

// ============================================================
describe('C. the pre-existing failure paths are unchanged', () => {
  test('a missing API key is still a 503', async () => {
    generateDraft.mockRejectedValue(new Error('ANTHROPIC_API_KEY is not set — SEO generation is unavailable.'));
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'k' }, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('a safety refusal is still a 503', async () => {
    generateDraft.mockRejectedValue(new Error('Claude declined this request (unspecified).'));
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'k' }, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('an ordinary crash still goes to the error handler, not to a fake 402', async () => {
    generateDraft.mockRejectedValue(new Error('mongo exploded'));
    const next = jest.fn();
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'k' }, user: {} }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(402);
  });

  test('a second loop on the same article is still a 409, not an API error', async () => {
    findById(article());
    autoRepairArticle.mockRejectedValue(new AutoRepairBusyError());
    const res = mockRes();
    await ctrl.autoRepair({ params: { id: 'x' }, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toMatch(/already running/i);
  });
});

// ============================================================
describe('D. approval stays gated on checks.passed, whatever the loop did', () => {
  test.each([['approved'], ['published']])('%s is refused when checks.passed is false', async (status) => {
    findById(article({ checks: { passed: false }, generation: { autoRepair: { phase: 'passed', attempts: 1 } } }));
    const res = mockRes();
    await ctrl.setStatus({ params: { id: 'x' }, body: { status }, user: {} }, res, jest.fn());

    // A loop that finished with phase 'passed' must not be mistaken for a
    // gate result. checks.passed is the only thing that opens the door.
    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('approval is allowed when checks.passed is true', async () => {
    const doc = article({ checks: { passed: true } });
    findById(doc);
    const res = mockRes();
    await ctrl.setStatus({ params: { id: 'x' }, body: { status: 'approved' }, user: {} }, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(doc.status).toBe('approved');
  });

  test('a failed auto-repair never moves the status by itself', async () => {
    const doc = article();
    findById(doc);
    autoRepairArticle.mockResolvedValue({
      passed: false, attempts: 2,
      stoppedReason: 'max-attempts: still failing after 2 automatic repair(s)',
      timeline: ['attempt 1/2: repairing', 'attempt 2/2: repairing'],
      article: doc,
    });
    const res = mockRes();
    await ctrl.autoRepair({ params: { id: 'x' }, user: {} }, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.passed).toBe(false);
    expect(body.attempts).toBe(2);
    expect(body.stoppedReason).toMatch(/max-attempts/);
    expect(doc.status).toBe('draft');
  });
});

// ============================================================
describe('E. a clean article is an answer on the auto-repair route too', () => {
  // Regression. The loop calls repairArticle whenever classifyFailures found
  // something repairable, but repairArticle refuses outright when there are no
  // blocking claims and the meta is already in range -- which is exactly the
  // case where the only failure left is a title length, something it has no
  // instruction for. That throw used to escape the auto-repair route as a bare
  // 500, while the manual repair route had always answered 422. Same error,
  // same answer, whichever route provoked it.
  test('NothingToRepairError -> 422, and never the generic error handler', async () => {
    const message = 'Nothing to repair: no blocking claims, and the meta description is within its length range. Run Recheck if the article still fails its gates.';
    findById(article());
    autoRepairArticle.mockRejectedValue(new NothingToRepairError(message));
    const next = jest.fn();
    const res = mockRes();

    await ctrl.autoRepair({ params: { id: 'x' }, user: {} }, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.message).toBe(message);
    expect(next).not.toHaveBeenCalled();
  });
});
