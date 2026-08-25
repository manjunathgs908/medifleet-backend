/**
 * tests/seoRecheck.test.js
 * ============================================================
 * POST /api/seo/articles/:id/recheck — the way back for an article a human
 * has edited.
 *
 * The property under test is not "recheck runs". It is that recheck can only
 * ever unlock approval, never grant it: a clean recheck sets checks.passed
 * true and leaves status exactly where it was, and a human still has to press
 * Approve afterwards. Every case here is a way that could go wrong.
 *
 * The service is mocked at the module boundary. What the gates decide is
 * tested by seoPhase2Safety; what the controller does with that decision is
 * tested here.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');

jest.mock('../services/seoGenerator', () => ({
  generateDraft: jest.fn(),
  recheckArticle: jest.fn(),
  SIMILARITY_BLOCK: 0.55,
  MIN_WORDS: 700,
  TITLE_MIN: 55, TITLE_MAX: 60, META_MIN: 150, META_MAX: 160,
}));

const { recheckArticle } = require('../services/seoGenerator');
const ctrl = require('../controllers/seoController');

const raw = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  keyword: 'bls ambulance booking bengaluru',
  slug: 'bls-ambulance-booking-bengaluru',
  title: 'x'.repeat(57),
  metaDescription: 'x'.repeat(154),
  h1: 'BLS ambulance booking in Bengaluru',
  content: 'the edited body',
  status: 'in_review',
  checks: { passed: false, unverifiedClaims: [], wordCount: 900 },
  ...over,
});

const hydrate = (over) => {
  const doc = SeoArticle.hydrate(raw(over));
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

// clearAllMocks as well as restore: recheckArticle is a jest.mock() factory
// mock, which restoreAllMocks does not reset, so call counts would leak
// between tests and "was not called" would be meaningless.
afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

describe('POST /articles/:id/recheck', () => {
  test('a clean recheck sets checks.passed true but does NOT approve', async () => {
    const doc = hydrate({ status: 'in_review' });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    recheckArticle.mockImplementation(async (a) => {
      a.checks.passed = true;               // what the real service does
      return { passed: true, failedChecks: [], article: a };
    });

    const res = mockRes();
    await ctrl.recheck({ params: { id: String(doc._id) }, user: {} }, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.passed).toBe(true);
    expect(body.failedChecks).toEqual([]);
    // The whole point: still in review, still needs a human.
    expect(doc.status).toBe('in_review');
    expect(body.message).toMatch(/press Approve/i);
  });

  test('a failed recheck returns the exact failed checks and stays unapproved', async () => {
    const doc = hydrate({ status: 'in_review' });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    const failures = ['2 blocking claim(s)', '412 words < 700'];
    recheckArticle.mockImplementation(async (a) => {
      a.checks.passed = false;
      return { passed: false, failedChecks: failures, article: a };
    });

    const res = mockRes();
    await ctrl.recheck({ params: { id: String(doc._id) }, user: {} }, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.passed).toBe(false);
    expect(body.failedChecks).toEqual(failures);
    expect(body.message).toContain('2 blocking claim(s)');
    expect(doc.checks.passed).toBe(false);
    expect(doc.status).toBe('in_review');
  });

  test('recheck never promotes status by itself, whatever it started as', async () => {
    for (const status of ['draft', 'in_review']) {
      const doc = hydrate({ status });
      jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
      recheckArticle.mockImplementation(async (a) => {
        a.checks.passed = true;
        return { passed: true, failedChecks: [], article: a };
      });

      await ctrl.recheck({ params: { id: String(doc._id) }, user: {} }, mockRes(), jest.fn());
      expect(doc.status).toBe(status);
      expect(doc.status).not.toBe('approved');
      expect(doc.status).not.toBe('published');
    }
  });

  test('a rejected article cannot be rechecked back into contention', async () => {
    const doc = hydrate({ status: 'rejected' });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);

    const res = mockRes();
    await ctrl.recheck({ params: { id: String(doc._id) }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(recheckArticle).not.toHaveBeenCalled();
    expect(doc.status).toBe('rejected');
  });

  test('unknown id is a 404, not a crash', async () => {
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(null);
    const res = mockRes();
    await ctrl.recheck({ params: { id: String(new mongoose.Types.ObjectId()) }, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('a missing API key is a 503 with an operator-facing message, not a stack trace', async () => {
    const doc = hydrate();
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    recheckArticle.mockRejectedValue(new Error('ANTHROPIC_API_KEY is not set — SEO generation is unavailable.'));

    const res = mockRes();
    const next = jest.fn();
    await ctrl.recheck({ params: { id: String(doc._id) }, user: {} }, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the edit -> recheck -> approve ladder', () => {
  test('editing an approved article demotes it and clears passed', async () => {
    const doc = hydrate({ status: 'approved', checks: { passed: true, unverifiedClaims: [] } });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);

    await ctrl.update(
      { params: { id: String(doc._id) }, body: { content: 'a human rewrote the pricing section' } },
      mockRes(), jest.fn(),
    );

    expect(doc.status).toBe('in_review');
    expect(doc.checks.passed).toBe(false);
  });

  test('approve is refused while checks.passed is false, and allowed once it is true', async () => {
    const blocked = hydrate({ status: 'in_review', checks: { passed: false, unverifiedClaims: [] } });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(blocked);
    const res1 = mockRes();
    await ctrl.setStatus({ params: { id: String(blocked._id) }, body: { status: 'approved' }, user: {} }, res1, jest.fn());
    expect(res1.status).toHaveBeenCalledWith(422);
    expect(blocked.status).toBe('in_review');

    // ...and after a clean recheck has flipped the flag, the same call works.
    const cleared = hydrate({ status: 'in_review', checks: { passed: true, unverifiedClaims: [] } });
    SeoArticle.findById.mockResolvedValue(cleared);
    const res2 = mockRes();
    await ctrl.setStatus({ params: { id: String(cleared._id) }, body: { status: 'approved' }, user: {} }, res2, jest.fn());
    expect(res2.status).not.toHaveBeenCalledWith(422);
    expect(cleared.status).toBe('approved');
  });
});
