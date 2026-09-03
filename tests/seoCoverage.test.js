/**
 * tests/seoCoverage.test.js
 * ============================================================
 * The pre-generation coverage guard: is this keyword already answered by a
 * page the site has?
 *
 * The duplicate-keyword guard next door asks whether an ARTICLE exists. It
 * cannot see the 38 hand-written pages that predate the generator, so "freezer
 * box in Bangalore" was generated twice, approved twice, and 404s both times —
 * lib/guides.js reserves any slug the curated registry owns.
 *
 * The property under test is a narrow one and it cuts both ways: a keyword
 * whose SIGNIFICANT WORDS are exactly a curated page's must be blocked, and a
 * keyword that merely shares words with one must not be. A guard that blocks
 * too much is worse than none, because the operator gets no draft to look at
 * and no way to see why.
 * ============================================================
 */
'use strict';

// The page index. Real paths from the live sitemap, so the fixtures are the
// data the guard actually runs against in production.
const LIVE_PAGES = [
  { path: '/freezer-box-bangalore', title: 'Freezer Box in Bangalore | Mortuary Freezer Box on Rent 24/7' },
  { path: '/ambulance-service-bangalore', title: 'Ambulance Service in Bangalore | 24/7 Emergency' },
  { path: '/bls-ambulance-bangalore', title: 'BLS Ambulance in Bangalore | Basic Life Support' },
  { path: '/air-ambulance-bangalore', title: 'Air Ambulance in Bangalore' },
  { path: '/ambulance-whitefield', title: '24/7 Ambulance Service in Whitefield, Bangalore' },
  { path: '/ambulance-marathahalli', title: '24/7 Ambulance Service in Marathahalli, Bangalore' },
  { path: '/dead-body-transport-bangalore', title: 'Dead Body Transport in Bangalore' },
  { path: '/patient-transfer-bangalore', title: 'Patient Transfer Ambulance in Bangalore' },
  { path: '/funeral-services/freezer-box-bengaluru', title: 'Freezer Box on Rent in Bengaluru' },
  { path: '/about', title: 'About SaveLife Health Services' },
];

// Must be "mock"-prefixed: jest hoists jest.mock() above the file and only
// mock-prefixed bindings may be referenced from inside a factory.
let mockPages = LIVE_PAGES;
jest.mock('../models/SeoLivePage', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => mockPages }) })),
}));

// The SDK is replaced wholesale, so any Claude call is visible as a call here.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockCreate } })));
jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({ business: {}, livePages: [], hash: 'h' }),
}));

const {
  findCuratedCoverage, significantTokens, KeywordCoveredError, CONNECTIVES,
} = require('../services/seoCoverage');
const SeoArticle = require('../models/SeoArticle');
const { buildFactSheet } = require('../services/seoFacts');
const { generateDraft } = require('../services/seoGenerator');

beforeEach(() => { mockPages = LIVE_PAGES; });

// ============================================================
describe('A. the freezer-box case that started this', () => {
  test('"freezer box in bangalore" is blocked by the curated page', async () => {
    const hit = await findCuratedCoverage('freezer box in bangalore');
    expect(hit).not.toBeNull();
    expect(hit.path).toBe('/freezer-box-bangalore');
  });

  test('the error carries the page, so the Studio can link to it', () => {
    const err = new KeywordCoveredError({ path: '/freezer-box-bangalore', title: 'Freezer Box in Bangalore' }, 'freezer box in bangalore');
    expect(err.name).toBe('KeywordCoveredError');
    expect(err.page.path).toBe('/freezer-box-bangalore');
    expect(err.message).toMatch(/already covers this keyword/i);
    expect(err.message).toMatch(/freezer-box-bangalore/);
  });
});

// ============================================================
describe('D. normalisation — case, spacing and punctuation', () => {
  test.each([
    ['freezer box in bangalore'],
    ['Freezer Box In Bangalore'],
    ['FREEZER BOX IN BANGALORE'],
    ['  freezer   box   in   bangalore  '],
    ['Freezer-Box-in-Bangalore'],
    ['freezer box, bangalore'],
    ['Freezer Box for Bangalore'],
  ])('%s resolves to the same page', async (keyword) => {
    const hit = await findCuratedCoverage(keyword);
    expect(hit?.path).toBe('/freezer-box-bangalore');
  });

  test('the same significant-word set is produced regardless of connectives', () => {
    const a = significantTokens('freezer box in bangalore');
    const b = significantTokens('Freezer Box Bangalore');
    expect([...a].sort()).toEqual([...b].sort());
  });

  test('only connectives are stripped — nothing meaningful is', () => {
    for (const meaningful of ['ambulance', 'service', 'freezer', 'box', 'bangalore', 'whitefield', 'bls']) {
      expect(CONNECTIVES.has(meaningful)).toBe(false);
    }
  });
});

// ============================================================
describe('C/E. genuinely new keywords are NOT blocked', () => {
  test.each([
    // Every one of these shares words with a curated page. None is the same topic.
    ['ambulance service near Whitefield Bangalore'],
    ['ambulance service near Electronic City Bangalore'],
    ['ambulance service near Marathahalli Bangalore'],
    ['ambulance for dialysis patient transport Bangalore'],
    ['hospital transfer ambulance Bangalore'],
    ['bls ambulance booking bengaluru'],
    ['ambulance service near Hebbal Bangalore'],
    ['freezer box rental hyderabad'],
    ['ambulance cost bangalore'],
    ['neonatal ambulance mysore'],
  ])('%s is allowed', async (keyword) => {
    expect(await findCuratedCoverage(keyword)).toBeNull();
  });

  test('E. sharing the generic words "ambulance" and "bangalore" is never enough on its own', async () => {
    // /ambulance-service-bangalore exists. These all contain both words.
    for (const k of ['ambulance bangalore airport', 'private ambulance bangalore', 'ambulance bangalore to mysore']) {
      expect(await findCuratedCoverage(k)).toBeNull();
    }
  });

  test('an extra significant word makes it a different topic', async () => {
    expect((await findCuratedCoverage('bls ambulance bangalore'))?.path).toBe('/bls-ambulance-bangalore');
    // ...but adding "booking" changes the set, so it is no longer that page.
    expect(await findCuratedCoverage('bls ambulance booking bangalore')).toBeNull();
  });

  test('an empty or junk keyword is allowed rather than matching something', async () => {
    expect(await findCuratedCoverage('')).toBeNull();
    expect(await findCuratedCoverage('   ')).toBeNull();
    expect(await findCuratedCoverage(null)).toBeNull();
    expect(await findCuratedCoverage('in the of and')).toBeNull(); // connectives only
  });
});

// ============================================================
describe('other curated pages are matched too — not just freezer box', () => {
  test.each([
    ['ambulance service bangalore', '/ambulance-service-bangalore'],
    ['air ambulance in bangalore', '/air-ambulance-bangalore'],
    ['dead body transport bangalore', '/dead-body-transport-bangalore'],
    ['patient transfer bangalore', '/patient-transfer-bangalore'],
    ['ambulance whitefield', '/ambulance-whitefield'],
  ])('%s -> %s', async (keyword, path) => {
    expect((await findCuratedCoverage(keyword))?.path).toBe(path);
  });

  test('a nested path is matched on its own significant words', async () => {
    // /funeral-services/freezer-box-bengaluru — bengaluru, not bangalore.
    const hit = await findCuratedCoverage('funeral services freezer box bengaluru');
    expect(hit?.path).toBe('/funeral-services/freezer-box-bengaluru');
  });

  test('a guide URL in the index is skipped — that is the article guard\'s job', async () => {
    mockPages = [{ path: '/guides/hospital-transfer-ambulance-bangalore', title: 'Hospital Transfer' }];
    expect(await findCuratedCoverage('hospital transfer ambulance bangalore')).toBeNull();
  });

  test('an empty page index blocks nothing', async () => {
    mockPages = [];
    expect(await findCuratedCoverage('freezer box in bangalore')).toBeNull();
  });
});

// ============================================================
describe('F. nothing is spent when the keyword is covered', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
    // No existing ARTICLE for the keyword, so only the coverage guard can stop it.
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue({ select: () => ({ lean: async () => null }) });
    jest.spyOn(SeoArticle, 'create').mockResolvedValue({});
  });
  afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); delete process.env.ANTHROPIC_API_KEY; });

  test('a covered keyword throws KeywordCoveredError and calls Claude ZERO times', async () => {
    await expect(generateDraft({ keyword: 'Freezer Box in Bangalore' }, {}))
      .rejects.toMatchObject({ name: 'KeywordCoveredError' });

    expect(mockCreate).not.toHaveBeenCalled();       // no Anthropic call
    expect(buildFactSheet).not.toHaveBeenCalled();   // not even the fact sheet
    expect(SeoArticle.create).not.toHaveBeenCalled(); // and no draft row
  });

  test('the thrown error names the page the operator should open instead', async () => {
    await expect(generateDraft({ keyword: 'freezer box bangalore' }, {}))
      .rejects.toMatchObject({ page: { path: '/freezer-box-bangalore' } });
  });
});
