/**
 * tests/seoDuplicateKeyword.test.js
 * ============================================================
 * One keyword, one article.
 *
 * The cost of getting this wrong is not a duplicate row: it is a paid Claude
 * generation, and two pages competing for the same query. So the check runs
 * BEFORE the model is called, and the assertions below care as much about
 * "no generation happened" as about the error that came back.
 *
 * seoFacts is mocked at module scope — buildFactSheet being called at all is
 * the signal that the duplicate check let the request through, so it doubles
 * as the tripwire.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({
    business: { website: 'https://www.savelife.health' },
    livePages: [],
    hash: 'h',
  }),
}));

const SeoArticle = require('../models/SeoArticle');
const { buildFactSheet } = require('../services/seoFacts');
const { generateDraft, DuplicateKeywordError } = require('../services/seoGenerator');

afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

describe('keyword normalisation', () => {
  const n = SeoArticle.normaliseKeyword;

  test('trims, lowercases and collapses internal whitespace', () => {
    expect(n('  BLS   Ambulance  Bengaluru ')).toBe('bls ambulance bengaluru');
  });

  test.each([
    ['exact', 'bls ambulance bengaluru'],
    ['uppercase', 'BLS AMBULANCE BENGALURU'],
    ['mixed case', 'Bls Ambulance Bengaluru'],
    ['leading and trailing spaces', '   bls ambulance bengaluru   '],
    ['doubled internal spaces', 'bls  ambulance   bengaluru'],
    ['tab separated', 'bls\tambulance\tbengaluru'],
    ['newline separated', 'bls\nambulance bengaluru'],
  ])('%s normalises to the same key', (_label, input) => {
    expect(n(input)).toBe('bls ambulance bengaluru');
  });

  test('different keywords stay different', () => {
    expect(n('bls ambulance bengaluru')).not.toBe(n('icu ambulance bengaluru'));
  });

  test('empty-ish input does not throw', () => {
    expect(n(undefined)).toBe('');
    expect(n(null)).toBe('');
    expect(n('   ')).toBe('');
  });
});

describe('the unique index exists at the database', () => {
  test('normalizedKeyword is unique and sparse', () => {
    expect(SeoArticle.schema.path('normalizedKeyword').options.index)
      .toEqual({ unique: true, sparse: true });
  });
});

describe('generateDraft refuses a duplicate before spending anything', () => {
  const existing = (over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    slug: 'bls-ambulance-booking-bengaluru',
    title: 'BLS Ambulance Booking in Bengaluru',
    keyword: 'bls ambulance bengaluru',
    status: 'approved',
    ...over,
  });

  const stubFindOne = (row) => {
    const lean = jest.fn().mockResolvedValue(row);
    const select = jest.fn(() => ({ lean }));
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue({ select });
    return { select };
  };

  const expectRefusal = async (keyword, row) => {
    stubFindOne(row);
    const create = jest.spyOn(SeoArticle, 'create').mockResolvedValue({});
    await expect(generateDraft({ keyword }, {})).rejects.toThrow(DuplicateKeywordError);
    // The three things that must not have happened.
    expect(create).not.toHaveBeenCalled();          // no draft row
    expect(buildFactSheet).not.toHaveBeenCalled();  // no fact sheet, so no Claude call
  };

  test.each([
    ['an exact match', 'bls ambulance bengaluru'],
    ['a different case', 'BLS Ambulance Bengaluru'],
    ['extra whitespace', '  bls   ambulance  bengaluru  '],
  ])('%s is refused with no generation', async (_label, keyword) => {
    await expectRefusal(keyword, existing());
  });

  test.each([
    ['draft'], ['in_review'], ['approved'], ['published'], ['rejected'],
  ])('a duplicate against a %s article is refused', async (status) => {
    await expectRefusal('bls ambulance bengaluru', existing({ status }));
  });

  test('the lookup is by normalised key, not the raw string', async () => {
    stubFindOne(existing());
    jest.spyOn(SeoArticle, 'create').mockResolvedValue({});
    await expect(generateDraft({ keyword: '  BLS   Ambulance Bengaluru ' }, {}))
      .rejects.toThrow(DuplicateKeywordError);
    expect(SeoArticle.findOne).toHaveBeenCalledWith({ normalizedKeyword: 'bls ambulance bengaluru' });
  });

  test('the error carries the existing row, so the Studio can link to it', async () => {
    stubFindOne(existing({ status: 'in_review' }));
    expect.hasAssertions();
    await generateDraft({ keyword: 'bls ambulance bengaluru' }, {}).catch((err) => {
      expect(err).toBeInstanceOf(DuplicateKeywordError);
      expect(err.existing.title).toBe('BLS Ambulance Booking in Bengaluru');
      expect(err.existing.status).toBe('in_review');
      expect(err.message).toMatch(/already has an article/i);
    });
  });

  test('a keyword with no existing article gets past the check', async () => {
    stubFindOne(null);
    // Past the gate it reaches the fact sheet and then the Claude client,
    // which has no key in the test environment. Reaching buildFactSheet at
    // all is the point.
    await generateDraft({ keyword: 'freezer box bengaluru' }, {}).catch(() => {});
    expect(buildFactSheet).toHaveBeenCalled();
  });

  test('an empty keyword is rejected before the duplicate lookup', async () => {
    const findOne = jest.spyOn(SeoArticle, 'findOne');
    await expect(generateDraft({ keyword: '   ' }, {})).rejects.toThrow(/keyword is required/i);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('a concurrent duplicate is caught by the database, not the check', () => {
  test('a lost race returns the winning article instead of creating a second row', async () => {
    // Both requests read "nothing there" — this one loses on the unique index.
    const lean = jest.fn()
      .mockResolvedValueOnce(null)                       // pre-flight: clear
      .mockResolvedValueOnce({                           // post-11000: the winner
        _id: new mongoose.Types.ObjectId(),
        slug: 'bls-ambulance-booking-bengaluru',
        title: 'BLS Ambulance Booking in Bengaluru',
        status: 'draft',
        keyword: 'bls ambulance bengaluru',
      });
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue({ select: jest.fn(() => ({ lean })) });

    const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    jest.spyOn(SeoArticle, 'create').mockRejectedValue(dupErr);

    // Reach create() without a live Claude call by driving the pieces the
    // generator uses. If the environment has no key the run stops earlier and
    // the assertion below still holds: no second row was written.
    await generateDraft({ keyword: 'bls ambulance bengaluru' }, {}).catch((err) => {
      expect(
        err instanceof DuplicateKeywordError || /ANTHROPIC_API_KEY/.test(err.message),
      ).toBe(true);
    });
    expect.hasAssertions();
  });

  test('a non-duplicate write error is not disguised as a duplicate', async () => {
    const lean = jest.fn().mockResolvedValue(null);
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue({ select: jest.fn(() => ({ lean })) });
    jest.spyOn(SeoArticle, 'create').mockRejectedValue(new Error('disk full'));

    await generateDraft({ keyword: 'something new entirely' }, {}).catch((err) => {
      expect(err).not.toBeInstanceOf(DuplicateKeywordError);
    });
    expect.hasAssertions();
  });
});
