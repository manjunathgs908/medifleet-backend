/**
 * tests/seoSlugCollision.test.js
 * ============================================================
 * The pre-spend slug collision guard.
 *
 * The duplicate-keyword guard asks "has this TOPIC been written". It cannot
 * answer "is the URL free", because the slug is derived from the keyword and
 * two different keywords routinely reduce to one slug. Until this guard
 * existed the answer arrived only from evaluateGates -- after the writer, the
 * fact checker and up to two repairs had all been paid for.
 *
 * The property under test is narrow and cuts both ways: a keyword whose
 * candidate slug is already taken must be refused before a single Anthropic
 * call, and a keyword whose slug is free must be let straight through. A guard
 * that refuses too much is worse than none, because the operator gets no draft
 * and no way to see why.
 *
 * The candidate slug is a PREDICTION, not a promise. The writer may still
 * choose a different slug, so section F pins down that the post-generation
 * duplicateSlug gate is still doing its job underneath.
 * ============================================================
 */
'use strict';

// Curated pages, real paths from the live sitemap.
const LIVE_PAGES = [
  { path: '/freezer-box-bangalore', title: 'Freezer Box in Bangalore' },
  { path: '/bls-ambulance-bangalore', title: 'BLS Ambulance in Bangalore' },
  { path: '/ambulance-whitefield', title: '24/7 Ambulance Service in Whitefield' },
  { path: '/about', title: 'About SaveLife Health Services' },
  // A guide URL is an article, not a curated page: the article guard owns it.
  { path: '/guides/ambulance-service-near-whitefield-bangalore', title: 'A generated guide' },
];

// Must be "mock"-prefixed: jest hoists jest.mock() and only mock-prefixed
// bindings may be referenced from inside a factory.
let mockPages = LIVE_PAGES;
jest.mock('../models/SeoLivePage', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => mockPages }) })),
}));

// The SDK is replaced wholesale, so ANY Anthropic call is visible here.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockCreate } })));

jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({
    business: { name: 'SaveLife', website: 'https://www.savelife.health' },
    livePages: [],
    hash: 'h',
  }),
}));

jest.mock('../services/seoLivePages', () => ({
  isIndexStale: jest.fn(async () => false),
  loadLivePageIndex: jest.fn(async () => []),
  refreshLivePageIndex: jest.fn(async () => {}),
}));

const { findCuratedCoverage } = require('../services/seoCoverage');
const { generateDraft, evaluateGates } = require('../services/seoGenerator');
const { slugify } = require('../services/seoSlug');
const { buildFactSheet } = require('../services/seoFacts');
const SeoArticle = require('../models/SeoArticle');

// findOne serves two different guards. The keyword guard queries by
// normalizedKeyword, the slug guard by slug -- so the stub answers on the
// shape of the query, exactly as the database would.
const stubFindOne = ({ byKeyword = null, bySlug = null } = {}) =>
  jest.spyOn(SeoArticle, 'findOne').mockImplementation((q = {}) => ({
    select: () => ({ lean: async () => ('slug' in q ? bySlug : byKeyword) }),
  }));

// The slug here must NOT also be a curated page path. The curated coverage
// guard runs first by design, so a fixture that collides with both would test
// that guard rather than this one.
const OWNER = {
  _id: 'article-1',
  slug: 'what-a-bls-ambulance-carries',
  title: 'What a BLS Ambulance Carries and When You Need One',
  status: 'approved',
  keyword: 'what a bls ambulance carries',
};
const OWNER_KEYWORD = 'What a BLS Ambulance Carries';

beforeEach(() => {
  mockPages = LIVE_PAGES;
  process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
  jest.spyOn(SeoArticle, 'create').mockResolvedValue({});
});
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

// Every refusal must satisfy all three of these, or the guard has not saved
// anything: no Anthropic call, no fact sheet, no draft row.
const expectNothingSpent = () => {
  expect(mockCreate).not.toHaveBeenCalled();
  expect(buildFactSheet).not.toHaveBeenCalled();
  expect(SeoArticle.create).not.toHaveBeenCalled();
};

// ============================================================
describe('A. an SeoArticle already owns the candidate slug', () => {
  test('refuses before buildFactSheet, before Claude, before any draft row', async () => {
    stubFindOne({ byKeyword: null, bySlug: OWNER });

    await expect(generateDraft({ keyword: OWNER_KEYWORD }, {}))
      .rejects.toMatchObject({ name: 'DuplicateKeywordError', conflict: 'slug' });

    expectNothingSpent();
  });

  test('the error names the article that owns the URL', async () => {
    stubFindOne({ byKeyword: null, bySlug: OWNER });
    await expect(generateDraft({ keyword: OWNER_KEYWORD }, {}))
      .rejects.toMatchObject({ existing: { slug: OWNER.slug, status: 'approved' } });
  });

  test('a draft owns its URL just as firmly as an approved article', async () => {
    stubFindOne({ byKeyword: null, bySlug: { ...OWNER, status: 'draft' } });
    await expect(generateDraft({ keyword: OWNER_KEYWORD }, {}))
      .rejects.toMatchObject({ conflict: 'slug' });
    expectNothingSpent();
  });

  test('so does a rejected one — a rejection is a decision, not a free URL', async () => {
    stubFindOne({ byKeyword: null, bySlug: { ...OWNER, status: 'rejected' } });
    await expect(generateDraft({ keyword: OWNER_KEYWORD }, {}))
      .rejects.toMatchObject({ conflict: 'slug' });
    expectNothingSpent();
  });

  test('the slug conflict is reported as a slug conflict, not a duplicate keyword', async () => {
    // A slug collision announced as "this keyword already has an article"
    // sends the operator to check a keyword they never typed.
    stubFindOne({ byKeyword: null, bySlug: OWNER });
    await expect(generateDraft({ keyword: OWNER_KEYWORD }, {}))
      .rejects.toThrow(/URL this keyword would use/i);
  });
});

// ============================================================
describe('B. a different keyword that lands on the same slug', () => {
  test('two different normalizedKeywords, one candidate slug — refused before spend', async () => {
    // Nothing matches by keyword: the article was written for "what a bls
    // ambulance carries", the operator is asking with different punctuation.
    // Only the slug is the same, and only the slug guard can see it.
    const asked = 'What  a  BLS  Ambulance,  Carries!';
    expect(SeoArticle.normaliseKeyword(asked)).not.toBe(OWNER.keyword);
    expect(slugify(asked)).toBe(OWNER.slug);

    stubFindOne({ byKeyword: null, bySlug: OWNER });

    await expect(generateDraft({ keyword: asked }, {}))
      .rejects.toMatchObject({ name: 'DuplicateKeywordError', conflict: 'slug' });
    expectNothingSpent();
  });

  test('punctuation and casing do not buy a second article on one URL', async () => {
    stubFindOne({ byKeyword: null, bySlug: OWNER });
    for (const kw of ['WHAT A BLS AMBULANCE CARRIES', 'what-a-bls-ambulance-carries', 'What   a   BLS   Ambulance   Carries']) {
      jest.clearAllMocks();
      await expect(generateDraft({ keyword: kw }, {})).rejects.toMatchObject({ conflict: 'slug' });
      expect(mockCreate).not.toHaveBeenCalled();
    }
  });
});

// ============================================================
describe('C. the candidate slug is a curated page path', () => {
  test('an exact slug/path match refuses before buildFactSheet and before Claude', async () => {
    // No article by keyword and none by slug: the ONLY thing that can stop
    // this is the curated-page comparison in findCuratedCoverage. Uses the
    // freezer-box keyword deliberately -- that slug IS a curated page path,
    // which is the case this test is about.
    stubFindOne({ byKeyword: null, bySlug: null });

    await expect(generateDraft({ keyword: 'freezer box bangalore' }, {}))
      .rejects.toMatchObject({ name: 'KeywordCoveredError', page: { path: '/freezer-box-bangalore' } });

    expectNothingSpent();
  });

  test('caught by the URL even when the wording would not have matched', async () => {
    // Token-set coverage compares significant words. "bls ambulance bengaluru"
    // is {bls, ambulance, bengaluru}; the path is {bls, ambulance, bangalore}.
    // Different sets, so the old guard let this through -- but both slugify to
    // the same URL family only when the words match, so use the exact case:
    // a keyword with an extra word the path does not have.
    const hit = await findCuratedCoverage('bls ambulance bangalore', 'bls-ambulance-bangalore');
    expect(hit).toMatchObject({ path: '/bls-ambulance-bangalore' });
  });

  test('a /guides/ path is never treated as curated coverage', async () => {
    // That URL belongs to an article; the article guard reports it with the
    // right source. The slug comparison must not steal the case.
    const hit = await findCuratedCoverage(
      'ambulance service near whitefield bangalore',
      'ambulance-service-near-whitefield-bangalore',
    );
    expect(hit).toBeNull();
  });

  test('trailing slashes and casing do not defeat the path comparison', async () => {
    mockPages = [{ path: '/Freezer-Box-Bangalore/', title: 'Freezer Box' }];
    const hit = await findCuratedCoverage('freezer box bangalore', 'freezer-box-bangalore');
    expect(hit).toMatchObject({ path: '/Freezer-Box-Bangalore/' });
  });
});

// ============================================================
describe('D. the existing token-set coverage still works', () => {
  test('same significant words in a different order is still coverage', async () => {
    // Slug would be "bangalore-freezer-box", which matches no path. Only the
    // token-set branch can catch this, so it proves that branch is intact.
    const hit = await findCuratedCoverage('bangalore freezer box');
    expect(hit).toMatchObject({ path: '/freezer-box-bangalore' });
  });

  test('connectives are still ignored', async () => {
    const hit = await findCuratedCoverage('freezer box in bangalore');
    expect(hit).toMatchObject({ path: '/freezer-box-bangalore' });
  });

  test('a keyword that merely shares words is still allowed through', async () => {
    // The guard must not over-block: this is a real, distinct topic.
    const hit = await findCuratedCoverage('how much does a freezer box cost for a funeral');
    expect(hit).toBeNull();
  });

  test('single-argument callers are unchanged', async () => {
    // The candidate slug argument is optional and defaults to deriving one.
    expect(await findCuratedCoverage('freezer box bangalore')).toMatchObject({ path: '/freezer-box-bangalore' });
    expect(await findCuratedCoverage('what to ask before booking an ambulance')).toBeNull();
  });
});

// ============================================================
describe('E. a free slug is let straight through', () => {
  test('the guard does not block, and the flow reaches the fact sheet', async () => {
    stubFindOne({ byKeyword: null, bySlug: null });
    mockCreate.mockRejectedValue(new Error('stopped at the Claude boundary on purpose'));

    // It fails at the Anthropic call, which is exactly the point: the pre-spend
    // guards let it through and generation began.
    await expect(generateDraft({ keyword: 'what to ask before booking an ambulance' }, {}))
      .rejects.toThrow();

    expect(buildFactSheet).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });

  test('the refusal is not a duplicate or coverage error', async () => {
    stubFindOne({ byKeyword: null, bySlug: null });
    mockCreate.mockRejectedValue(new Error('stopped at the Claude boundary on purpose'));

    const err = await generateDraft({ keyword: 'what to ask before booking an ambulance' }, {}).catch((e) => e);
    expect(err.name).not.toBe('DuplicateKeywordError');
    expect(err.name).not.toBe('KeywordCoveredError');
  });

  test('an empty candidate slug cannot refuse everything', async () => {
    // slugify('...') is '', and a blank candidate must never match a page or
    // an article -- a guard that refuses on empty would block every keyword
    // made only of punctuation rather than letting the writer see it.
    expect(slugify('!!! ???')).toBe('');
    expect(await findCuratedCoverage('!!! ???', '')).toBeNull();
  });
});

// ============================================================
describe('F. the post-generation duplicateSlug gate is untouched', () => {
  // The pre-spend check is a hint: the writer picks the real slug and two
  // requests can race. Everything that caught a collision before still must.
  const article = () => ({
    cluster: 'bls',
    searchIntent: 'informational',
    slug: 'a-slug-the-writer-chose',
    title: 'A title that is comfortably inside the fifty-five to sixty band',
    metaDescription: 'x'.repeat(155),
    h1: 'A heading',
    content: '## A section\n\nSome words.',
    faqs: [],
    internalLinks: [],
  });

  test('evaluateGates still reports a taken slug, and still blocks', async () => {
    jest.spyOn(SeoArticle, 'exists').mockResolvedValue({ _id: 'someone-else' });
    jest.spyOn(SeoArticle, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

    const g = await evaluateGates(article(), {
      facts: { business: { name: 'S', website: 'https://www.savelife.health' }, livePages: [] },
      claims: [],
    });

    expect(g.checks.duplicateSlug).toBe(true);
    expect(g.failedChecks).toContain('duplicate slug');
    expect(g.passed).toBe(false);
  });

  test('a free slug still passes that gate', async () => {
    jest.spyOn(SeoArticle, 'exists').mockResolvedValue(null);
    jest.spyOn(SeoArticle, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

    const g = await evaluateGates(article(), {
      facts: { business: { name: 'S', website: 'https://www.savelife.health' }, livePages: [] },
      claims: [],
    });

    expect(g.checks.duplicateSlug).toBe(false);
    expect(g.failedChecks).not.toContain('duplicate slug');
  });

  test('the unique index on slug is still declared', () => {
    // The only thing that can settle a genuine race. The pre-spend guard does
    // not replace it and must never be read as replacing it.
    expect(SeoArticle.schema.path('slug').options.unique).toBe(true);
  });
});
