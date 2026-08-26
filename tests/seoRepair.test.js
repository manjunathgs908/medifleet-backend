/**
 * tests/seoRepair.test.js
 * ============================================================
 * POST /api/seo/articles/:id/repair — rewriting what the checker already
 * flagged.
 *
 * The property under test is restraint. Repair may change the text; it may
 * not decide the text is now good. So every case here watches two things at
 * once: that the intended edit happened, and that status and checks.passed
 * did not quietly move with it.
 *
 * callClaude is mocked at the module boundary, so repairArticle's own logic —
 * what it selects to repair, what it records, what it refuses — runs for real
 * against a hydrated document. What the model returns is the fixture.
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
const { repairArticle, NothingToRepairError } = require('../services/seoGenerator');

// The article's own body is irrelevant to these tests; what matters is the
// claim set and the meta length it arrives with.
const IN_BAND_META = 'x'.repeat(154);
const SHORT_META = 'Ambulance for dialysis patient transport in Bangalore — trips to and from each session, one-off or booked in advance. Call SaveLife 24/7, any day.'; // 146

const raw = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  keyword: 'ambulance for dialysis patient transport bangalore',
  slug: 'dialysis-patient-transport-bangalore',
  title: 'y'.repeat(57),
  metaDescription: IN_BAND_META,
  h1: 'Dialysis patient transport',
  content: 'The Eeco is easier through narrow lanes. Most families use BLS. ' + 'filler '.repeat(400),
  faqs: [{ q: 'Q1', a: 'A1' }],
  internalLinks: [{ label: 'Book', href: '/book' }, { label: 'BLS', href: '/bls-ambulance-bangalore' }],
  status: 'draft',
  corrections: [],
  checks: { passed: false, unverifiedClaims: [], metaLength: 154, wordCount: 900 },
  ...over,
});

const hydrate = (over) => {
  const doc = SeoArticle.hydrate(raw(over));
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

const blocking = (claim, action = 'rewrite') => ({ claim, severity: 'unsupported', action });

// The whole SDK is replaced, so no request can leave this process even if a
// key happens to be present in the environment. getClient() constructs it
// lazily and caches the instance; this stands in for that instance.
//
// The name must start with "mock" — jest hoists jest.mock() above the file,
// and only mock-prefixed bindings may be referenced from inside the factory.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockCreate } })));

beforeEach(() => {
  // getClient() throws without this; the value is never sent anywhere,
  // because the transport above is a stub.
  process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
});
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

const createSpy = mockCreate;

/** Force what the single repair call returns. */
const respond = (payload) => {
  mockCreate.mockResolvedValue({
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
};

describe('A. repair rewrites an unsupported claim', () => {
  test('the rewritten field lands on the article', async () => {
    const doc = hydrate({
      checks: { passed: false, metaLength: 154, unverifiedClaims: [blocking('The Eeco is easier through narrow lanes.')] },
    });
    respond({ repairedFields: ['content'], content: 'Ask dispatch which vehicle suits the pickup.' });

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(true);
    expect(r.repairedFields).toEqual(['content']);
    expect(doc.content).toBe('Ask dispatch which vehicle suits the pickup.');
    expect(r.claimsTargeted).toBe(1);
  });

  test('the claims are read from the article, not hardcoded anywhere', async () => {
    const doc = hydrate({
      checks: { passed: false, metaLength: 154, unverifiedClaims: [blocking('A totally unrelated invented claim about kittens.')] },
    });
    respond({ repairedFields: ['content'], content: 'repaired' });

    await repairArticle(doc);

    const prompt = createSpy.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('A totally unrelated invented claim about kittens.');
  });
});

describe('B. repair deletes a claim it cannot safely reword', () => {
  test('an action:remove claim is passed through, and the deletion is applied', async () => {
    const doc = hydrate({
      checks: {
        passed: false, metaLength: 154,
        unverifiedClaims: [blocking('We have no arrangement with any particular dialysis centre.', 'remove')],
      },
    });
    respond({ repairedFields: ['content'], content: 'Sentence gone.' });

    await repairArticle(doc);

    const prompt = createSpy.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('[unsupported / remove]');
    expect(doc.content).toBe('Sentence gone.');
  });
});

describe('C. repair fixes a short meta description', () => {
  test('a 146-character meta is sent for repair with the exact range', async () => {
    const doc = hydrate({ metaDescription: SHORT_META, checks: { passed: false, metaLength: 146, unverifiedClaims: [] } });
    const fixed = 'z'.repeat(155);
    respond({ repairedFields: ['metaDescription'], metaDescription: fixed });

    const r = await repairArticle(doc);

    expect(SHORT_META.length).toBe(146);
    const prompt = createSpy.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/146 characters and MUST end up between 150 and 160/);
    expect(doc.metaDescription).toBe(fixed);
    expect(r.metaBefore).toBe(146);
    expect(r.metaAfter).toBe(155);
    expect(r.metaFixed).toBe(true);
  });

  test('a meta still out of range afterwards is reported as NOT fixed', async () => {
    const doc = hydrate({ metaDescription: SHORT_META, checks: { passed: false, metaLength: 146, unverifiedClaims: [] } });
    respond({ repairedFields: ['metaDescription'], metaDescription: 'still short' });

    const r = await repairArticle(doc);

    expect(r.metaFixed).toBe(false);
    expect(r.summary).toMatch(/STILL outside/);
  });
});

describe('D. repair does not introduce fixed pricing', () => {
  test('the repair instruction forbids introducing a price', async () => {
    const doc = hydrate({ metaDescription: SHORT_META, checks: { passed: false, metaLength: 146, unverifiedClaims: [] } });
    respond({ repairedFields: ['metaDescription'], metaDescription: 'z'.repeat(152) });

    await repairArticle(doc);

    const prompt = createSpy.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/do not introduce a price/i);
  });

  test('the pricing gate is untouched by repair — it still sees any price that arrives', () => {
    const { findPricingClaims } = require('../services/seoPricingGuard');
    expect(findPricingClaims({ content: 'BLS from ₹1,200' }).length).toBeGreaterThan(0);
  });
});

describe('E. repair records corrections provenance', () => {
  test('previous content, faqs, meta and status are all preserved', async () => {
    const doc = hydrate({
      checks: { passed: false, metaLength: 154, unverifiedClaims: [blocking('claim')] },
    });
    const beforeContent = doc.content;
    const beforeMeta = doc.metaDescription;
    respond({ repairedFields: ['content'], content: 'new body' });

    await repairArticle(doc);

    expect(doc.corrections).toHaveLength(1);
    const c = doc.corrections[0];
    expect(c.fields).toEqual(['content']);
    expect(c.previous.content).toBe(beforeContent);
    expect(c.previous.metaDescription).toBe(beforeMeta);
    expect(c.previous.status).toBe('draft');
    expect(c.previous.faqs).toEqual([{ q: 'Q1', a: 'A1' }]);
    expect(c.reason).toMatch(/blocking claim/i);
  });

  test('a repair that changed nothing records no correction and does not save', async () => {
    const doc = hydrate({ checks: { passed: false, metaLength: 154, unverifiedClaims: [blocking('claim')] } });
    respond({ repairedFields: [] });

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(false);
    expect(r.summary).toMatch(/No changes/i);
    expect(doc.corrections).toHaveLength(0);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('F/G/H. repair does not move the article along the ladder', () => {
  test.each([['draft'], ['in_review'], ['approved']])('status %s is unchanged by a repair', async (status) => {
    const doc = hydrate({ status, checks: { passed: true, metaLength: 154, unverifiedClaims: [blocking('claim')] } });
    respond({ repairedFields: ['content'], content: 'repaired' });

    await repairArticle(doc);

    expect(doc.status).toBe(status);
    expect(doc.status).not.toBe('published');
  });

  test('checks.passed is forced false after a repair', async () => {
    const doc = hydrate({ checks: { passed: true, metaLength: 154, unverifiedClaims: [blocking('claim')] } });
    respond({ repairedFields: ['content'], content: 'repaired' });

    await repairArticle(doc);

    expect(doc.checks.passed).toBe(false);
  });

  test('publishedAt is never set', async () => {
    const doc = hydrate({ checks: { passed: false, metaLength: 154, unverifiedClaims: [blocking('claim')] } });
    respond({ repairedFields: ['content'], content: 'repaired' });
    await repairArticle(doc);
    expect(doc.publishedAt).toBeUndefined();
  });
});

describe('I. authorization', () => {
  test('the repair route sits behind the router-level owner guard', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'seo.js'), 'utf8');
    const guard = src.indexOf("router.use(protect, authorize('owner'))");
    const route = src.indexOf("/articles/:id/repair");
    expect(guard).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(guard); // declared after the guard, so covered by it
  });

  test('it is rate-limited on the same bucket as generate', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'seo.js'), 'utf8');
    expect(src).toMatch(/router\.post\('\/articles\/:id\/repair',\s*generateLimiter/);
  });
});

describe('J. a second repair is safe', () => {
  test('repairing a clean article is refused rather than spending a call', async () => {
    const doc = hydrate({ checks: { passed: true, metaLength: 154, unverifiedClaims: [] } });

    await expect(repairArticle(doc)).rejects.toThrow(NothingToRepairError);
    expect(createSpy).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('phrasing-only claims are not repairable — they never blocked anything', async () => {
    const doc = hydrate({
      checks: { passed: false, metaLength: 154, unverifiedClaims: [{ claim: 'wording', severity: 'phrasing', action: 'rewrite' }] },
    });

    await expect(repairArticle(doc)).rejects.toThrow(NothingToRepairError);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('K. existing approved behaviour is unchanged', () => {
  test('an approved, passing article has nothing repairable', async () => {
    const doc = hydrate({ status: 'approved', checks: { passed: true, metaLength: 153, unverifiedClaims: [] } });
    await expect(repairArticle(doc)).rejects.toThrow(NothingToRepairError);
    expect(doc.status).toBe('approved');
    expect(doc.checks.passed).toBe(true);
  });

  test('the approval gate in setStatus is untouched', async () => {
    const ctrl = require('../controllers/seoController');
    const doc = hydrate({ status: 'in_review', checks: { passed: false, unverifiedClaims: [] } });
    jest.spyOn(SeoArticle, 'findById').mockResolvedValue(doc);
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };

    await ctrl.setStatus({ params: { id: String(doc._id) }, body: { status: 'approved' }, user: {} }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(doc.status).toBe('in_review');
  });
});
