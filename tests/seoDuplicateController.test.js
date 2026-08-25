/**
 * tests/seoDuplicateController.test.js
 * ============================================================
 * What the operator sees when a keyword is already taken.
 *
 * Separate file from seoDuplicateKeyword because the controller destructures
 * its imports at load time, so the service has to be mocked before the
 * controller is required — which cannot coexist with the service-level tests
 * that use the real generator.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

// Declared inside the factory: jest hoists jest.mock() above the file, so a
// class defined at module scope is not yet initialised when it runs.
jest.mock('../services/seoGenerator', () => {
  class DuplicateKeywordError extends Error {
    constructor(existing) {
      super(`This keyword already has an article: "${existing.title}" (${existing.status}).`);
      this.name = 'DuplicateKeywordError';
      this.existing = existing;
    }
  }
  return {
    generateDraft: jest.fn(),
    recheckArticle: jest.fn(),
    DuplicateKeywordError,
    SIMILARITY_BLOCK: 0.55,
    MIN_WORDS: 700,
    TITLE_MIN: 55, TITLE_MAX: 60, META_MIN: 150, META_MAX: 160,
  };
});

const ctrl = require('../controllers/seoController');
const { generateDraft, DuplicateKeywordError: Dup } = require('../services/seoGenerator');

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

describe('POST /api/seo/generate with a keyword that already exists', () => {
  const row = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'bls-ambulance-booking-bengaluru',
    title: 'BLS Ambulance Booking in Bengaluru',
    status: 'approved',
    keyword: 'bls ambulance bengaluru',
  };

  test('409, with the existing article attached so the Studio can link to it', async () => {
    generateDraft.mockRejectedValue(new Dup(row));
    const res = mockRes();

    await ctrl.generate({ body: { keyword: 'BLS Ambulance Bengaluru' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.duplicate).toBe(true);
    expect(body.existing).toEqual({
      id: row._id, slug: row.slug, title: row.title, status: row.status, keyword: row.keyword,
    });
  });

  test('the message says plainly that nothing was generated or charged', async () => {
    generateDraft.mockRejectedValue(new Dup(row));
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'bls ambulance bengaluru' }, user: {} }, res, jest.fn());
    const { message } = res.json.mock.calls[0][0];
    expect(message).toMatch(/already has an article/i);
    expect(message).toMatch(/nothing was generated/i);
  });

  test.each([['draft'], ['in_review'], ['approved'], ['published'], ['rejected']])(
    'a clash with a %s article is reported with that status',
    async (status) => {
      generateDraft.mockRejectedValue(new Dup({ ...row, status }));
      const res = mockRes();
      await ctrl.generate({ body: { keyword: 'k' }, user: {} }, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].existing.status).toBe(status);
    },
  );

  test('a missing keyword is still a 400, not a 409', async () => {
    const res = mockRes();
    await ctrl.generate({ body: {}, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  test('a real failure goes to the error handler, not the duplicate path', async () => {
    generateDraft.mockRejectedValue(new Error('mongo exploded'));
    const next = jest.fn();
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'something new' }, user: {} }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  test('a missing API key is still a 503, not a 409', async () => {
    generateDraft.mockRejectedValue(new Error('ANTHROPIC_API_KEY is not set — SEO generation is unavailable.'));
    const res = mockRes();
    await ctrl.generate({ body: { keyword: 'something new' }, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
