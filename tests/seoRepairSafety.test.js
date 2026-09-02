/**
 * tests/seoRepairSafety.test.js
 * ============================================================
 * What a repair is not allowed to do on its way past.
 *
 * The failure this suite exists for is not "the repair did nothing". It is
 * "the repair fixed the flagged claim and quietly asserted something else" —
 * a rewrite that cleared eleven unsupported claims and came back carrying
 * eleven published fares, with every individual instruction obeyed. That
 * happened on two live articles.
 *
 * Two independent defences are under test. The pure one (seoRepairGuard)
 * compares proposed text against the text it would replace. The structural one
 * is that the repair call is handed the REDACTED fact sheet, so the model is
 * never shown a fare it could copy out.
 *
 * The SDK is replaced at the module boundary; the generator is real.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

// A fact sheet that DOES carry fares, so redaction has something to remove.
jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({
    business: { website: 'https://www.savelife.health' },
    bookableServices: [
      { code: 'BLS', label: 'BLS Ambulance', vehicle: 'Maruti Eeco', baseFare: 1200, slabs: [[10, 1200], [50, 3000]] },
    ],
    livePages: [],
    hash: 'h',
  }),
}));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockCreate } })));

const SeoArticle = require('../models/SeoArticle');
const { repairArticle, TITLE_MIN, TITLE_MAX, META_MIN, META_MAX } = require('../services/seoGenerator');
const {
  validateProposal, newPricesIntroduced, pricesRemoved, newPromisesIntroduced, isWorse,
} = require('../services/seoRepairGuard');

const BANDS = { TITLE_MIN, TITLE_MAX, META_MIN, META_MAX };

const OK_TITLE = 'Ambulance Service Near Whitefield in Bangalore | 24x7 Care'; // 58
const OK_META = 'x'.repeat(154);
const SHORT_TITLE = 'Ambulance Service Near Whitefield, Bangalore Today!'; // 51
const LONG_META = 'y'.repeat(165);

const BODY = 'The original body. Call dispatch and ask what is available. ' + 'filler '.repeat(300);

const hydrate = (over = {}) => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'ambulance service near whitefield bangalore',
    slug: 'ambulance-service-near-whitefield-bangalore',
    title: OK_TITLE, metaDescription: OK_META, h1: 'Ambulance near Whitefield',
    content: BODY, faqs: [], internalLinks: [], status: 'draft', corrections: [],
    checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: [] },
    ...over,
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

const claims = (n) => Array.from({ length: n }, (_, i) => ({
  claim: `Unsupported operational claim number ${i + 1}.`, severity: 'unsupported', action: 'rewrite',
}));

/** Queue one model response per call, in order. */
const respond = (...payloads) => {
  mockCreate.mockReset();
  for (const p of payloads) {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'text', text: JSON.stringify(p) }],
    });
  }
};

const promptOf = (callIndex) => mockCreate.mock.calls[callIndex][0].messages[0].content;

beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked'; });
afterEach(() => { jest.clearAllMocks(); delete process.env.ANTHROPIC_API_KEY; });

// ============================================================
describe('A. the repair is never shown a fare it could copy out', () => {
  test('the repair prompt carries the REDACTED fact sheet, not the real figures', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(1) } });
    respond({ repairedFields: ['content'], content: 'A repaired body with no figures in it.' });

    await repairArticle(doc);

    const prompt = promptOf(0);
    // The mocked sheet contains 1200 and the slab table; neither may reach the
    // model that writes the replacement text.
    expect(prompt).not.toMatch(/1200/);
    expect(prompt).not.toMatch(/baseFare/);
    expect(prompt).not.toMatch(/slabs/);
    // And it is given the approved wording to use instead.
    expect(prompt).toMatch(/fareWording|pricingPolicy/);
  });
});

// ============================================================
describe('B. title and meta are actually repaired, or nothing is saved', () => {
  test('a 51-character title is repaired into the 55-60 band', async () => {
    expect(SHORT_TITLE.length).toBe(51);
    const fixed = 'Ambulance Service Near Whitefield in Bangalore, Booked 24x7';
    expect(fixed.length).toBeGreaterThanOrEqual(TITLE_MIN);
    expect(fixed.length).toBeLessThanOrEqual(TITLE_MAX);

    const doc = hydrate({ title: SHORT_TITLE, checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: [] } });
    respond({ repairedFields: ['title'], title: fixed });

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(true);
    expect(r.titleBefore).toBe(51);
    expect(r.titleFixed).toBe(true);
    expect(doc.title).toBe(fixed);
    expect(doc.title.length).toBeGreaterThanOrEqual(TITLE_MIN);
    expect(doc.title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  test('the title band is stated in the instruction the model receives', async () => {
    const doc = hydrate({ title: SHORT_TITLE, checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: [] } });
    respond({ repairedFields: ['title'], title: 'z'.repeat(57) });
    await repairArticle(doc);
    expect(promptOf(0)).toMatch(/title is currently 51 characters and MUST end up between 55 and 60/);
  });

  test('a 165-character meta is repaired into the 150-160 band', async () => {
    expect(LONG_META.length).toBe(165);
    const fixed = 'm'.repeat(153);
    const doc = hydrate({ metaDescription: LONG_META, checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 165, unverifiedClaims: [] } });
    respond({ repairedFields: ['metaDescription'], metaDescription: fixed });

    const r = await repairArticle(doc);

    expect(r.metaBefore).toBe(165);
    expect(r.metaFixed).toBe(true);
    expect(doc.metaDescription.length).toBe(153);
  });

  test('a title that comes back still too short is rejected, and the original is kept', async () => {
    const doc = hydrate({ title: SHORT_TITLE, checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: [] } });
    // Both the repair and the narrower retry return something still invalid.
    respond(
      { repairedFields: ['title'], title: 'still far too short' },
      { repairedFields: ['title'], title: 'also too short' },
    );

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(false);
    expect(r.rejected).toBe(true);
    expect(doc.title).toBe(SHORT_TITLE);        // rolled back
    expect(doc.save).not.toHaveBeenCalled();     // never written
    expect(mockCreate).toHaveBeenCalledTimes(2); // one retry, then it stops
  });

  test('the retry is told exactly what the rejected attempt did', async () => {
    const doc = hydrate({ title: SHORT_TITLE, checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: [] } });
    respond(
      { repairedFields: ['title'], title: 'too short' },
      { repairedFields: ['title'], title: 'w'.repeat(57) },
    );

    await repairArticle(doc);

    expect(promptOf(1)).toMatch(/PREVIOUS ATTEMPT WAS DISCARDED IN FULL/);
    expect(promptOf(1)).toMatch(/outside 55-60/);
    expect(promptOf(1)).toMatch(/SMALLER edit/);
  });
});

// ============================================================
describe('C. a repair that introduces a price is discarded', () => {
  test('a price in the proposed body is rejected and rolled back', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(3) } });
    respond(
      { repairedFields: ['content'], content: 'A BLS ambulance to Whitefield costs ₹1,200 for the first 10 km.' },
      { repairedFields: ['content'], content: 'A BLS ambulance to Whitefield. Ask dispatch what applies to your trip.' },
    );

    const r = await repairArticle(doc);

    // The second proposal is clean, so the repair succeeds — but the priced
    // one never reached the article.
    expect(r.repaired).toBe(true);
    expect(doc.content).not.toMatch(/1,200/);
    expect(promptOf(1)).toMatch(/introduced 1 price/);
  });

  test('when every proposal carries a price, nothing is written at all', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(2) } });
    respond(
      { repairedFields: ['content'], content: 'Fares start at ₹1,200.' },
      { repairedFields: ['content'], content: 'Rs 1,500 per trip.' },
    );

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(false);
    expect(r.rejected).toBe(true);
    expect(r.rejections.some((x) => x.code === 'new-pricing')).toBe(true);
    expect(doc.content).toBe(BODY);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('D. existing pricing is not deleted to make a gate pass', () => {
  test('a proposal that strips an existing fare is rejected', () => {
    const before = { content: 'Our BLS starts at ₹1,200 today.' };
    const after = { content: 'Our BLS is competitively priced.' };

    const v = validateProposal(before, after, BANDS, {});

    expect(v.ok).toBe(false);
    expect(v.regressions.some((r) => r.code === 'pricing-deleted')).toBe(true);
  });

  test('pricesRemoved reports the exact phrase that disappeared', () => {
    expect(pricesRemoved({ content: 'Rs 1,200 flat' }, { content: 'no figure here' })).toEqual(['Rs 1,200']);
  });
});

// ============================================================
describe('E. a repair that introduces an unsupported assurance is discarded', () => {
  test('promise language added by the repair is caught', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(2) } });
    respond(
      { repairedFields: ['content'], content: 'We will send the nearest ambulance and it will arrive within 10 minutes.' },
      { repairedFields: ['content'], content: 'Share the patient condition when booking so the options can be discussed.' },
    );

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(true);
    expect(doc.content).not.toMatch(/will arrive/i);
    expect(promptOf(1)).toMatch(/unsupported assurance/);
  });

  test('an assurance ALREADY in the article is not held against the repair', () => {
    const before = { content: 'We send the nearest vehicle.' };
    const after = { content: 'We send the nearest vehicle. Ask dispatch what is available.' };
    // "nearest" was already there. Only what a repair ADDS is a regression;
    // re-judging existing text is the fact checker's job, not this one's.
    expect(newPromisesIntroduced(before, after)).toEqual([]);
    expect(validateProposal(before, after, BANDS, {}).ok).toBe(true);
  });
});

// ============================================================
describe('F. the guard itself', () => {
  test('newPricesIntroduced sees a swapped fare, not just a count', () => {
    expect(newPricesIntroduced({ content: '₹1,200' }, { content: '₹1,500' })).toEqual(['₹1,500']);
  });

  test('an empty body is never a valid repair', () => {
    expect(validateProposal({ content: BODY }, { content: '   ' }, BANDS, {}).ok).toBe(false);
  });

  test('a valid field must not be broken by a repair that was not asked about it', () => {
    const v = validateProposal(
      { title: 'z'.repeat(57), content: 'a' },
      { title: 'z'.repeat(20), content: 'a' },
      BANDS, {},
    );
    expect(v.regressions.some((r) => r.code === 'title-broken')).toBe(true);
  });

  test('isWorse flags a rise in blocking claims, prices and schema errors', () => {
    expect(isWorse({ unverifiedClaims: [] }, { unverifiedClaims: [{ severity: 'unsupported' }] }).worse).toBe(true);
    expect(isWorse({ pricingClaims: [] }, { pricingClaims: ['₹1'] }).worse).toBe(true);
    expect(isWorse({ schemaErrors: [] }, { schemaErrors: ['bad'] }).worse).toBe(true);
  });

  test('isWorse ignores a phrasing-only claim, which blocks nothing', () => {
    expect(isWorse({ unverifiedClaims: [] }, { unverifiedClaims: [{ severity: 'phrasing' }] }).worse).toBe(false);
  });

  test('isWorse flags a body gutted by an over-eager repair', () => {
    expect(isWorse({ wordCount: 900 }, { wordCount: 300 }).worse).toBe(true);
    expect(isWorse({ wordCount: 900 }, { wordCount: 850 }).worse).toBe(false);
  });
});

// ============================================================
describe('G. many claims at once', () => {
  test('all eleven blocking claims are handed to the repair in one call', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(11) } });
    respond({ repairedFields: ['content'], content: 'A cautious rewrite that asserts nothing new.' });

    const r = await repairArticle(doc);

    expect(r.claimsTargeted).toBe(11);
    const prompt = promptOf(0);
    for (let i = 1; i <= 11; i++) expect(prompt).toMatch(new RegExp(`Unsupported operational claim number ${i}\\.`));
  });

  test('a repair never sets checks.passed and never moves status', async () => {
    const doc = hydrate({ status: 'in_review', checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(2) } });
    respond({ repairedFields: ['content'], content: 'A cautious rewrite.' });

    await repairArticle(doc);

    expect(doc.checks.passed).toBe(false);
    expect(doc.status).toBe('in_review');
  });
});

// ============================================================
describe('H. prices are compared by value, not by how they were typed', () => {
  // RISK 1. Comparing raw phrases made "Rs 1,200" -> "Rs. 1,200" look like a
  // deletion AND an introduction at once, so a repair that changed nothing
  // about the money on the page was thrown away twice over.
  test.each([
    { label: 'Rs 1,200 -> Rs. 1,200', before: 'BLS from Rs 1,200 today.', after: 'BLS from Rs. 1,200 today.' },
    { label: 'Rs 1,200 -> \u20b91,200', before: 'BLS from Rs 1,200.', after: 'BLS from \u20b91,200.' },
    { label: '\u20b91,200 -> INR 1200', before: 'BLS from \u20b91,200.', after: 'BLS from INR 1200.' },
  ])('$label is the same price, so the proposal is accepted', ({ before, after }) => {
    const v = validateProposal({ content: before }, { content: after }, BANDS, {});
    expect(v.regressions).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test('a genuinely NEW price is still rejected', () => {
    const v = validateProposal({ content: 'no figures here' }, { content: 'BLS from \u20b91,200.' }, BANDS, {});
    expect(v.ok).toBe(false);
    expect(v.regressions.some((r) => r.code === 'new-pricing')).toBe(true);
  });

  test('a genuinely DELETED price is still rejected', () => {
    const v = validateProposal({ content: 'BLS from \u20b91,200.' }, { content: 'BLS is available.' }, BANDS, {});
    expect(v.ok).toBe(false);
    expect(v.regressions.some((r) => r.code === 'pricing-deleted')).toBe(true);
  });

  test('1200 changed to 1500 is rejected on both counts', () => {
    const v = validateProposal({ content: 'BLS from \u20b91,200.' }, { content: 'BLS from \u20b91,500.' }, BANDS, {});
    expect(v.ok).toBe(false);
    const codes = v.regressions.map((r) => r.code);
    expect(codes).toContain('new-pricing');
    expect(codes).toContain('pricing-deleted');
  });

  test('a per-km rate never collapses into a plain amount that shares its digits', () => {
    const v = validateProposal({ content: 'We charge 3 per km.' }, { content: 'We charge \u20b93.' }, BANDS, {});
    expect(v.ok).toBe(false);
  });
});

// ============================================================
describe('I. a safe improvement survives an unmet target', () => {
  // RISK 3. Binning a rewrite that cleared eleven unsupported claims because
  // it failed to lengthen a title left the article carrying the claims AND the
  // bad title — worse on both counts than keeping the safe half and saying
  // plainly what is still wrong.
  test('11 claims fixed but the title still 51 chars: the fix persists, the title stays reported as failing', async () => {
    const doc = hydrate({
      title: SHORT_TITLE,
      checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: claims(11) },
    });
    // The model rewrites the body and never returns a title.
    respond({ repairedFields: ['content'], content: 'A cautious rewrite that asserts nothing new at all.' });

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(true);
    expect(doc.content).toBe('A cautious rewrite that asserts nothing new at all.');
    // ...and the title is neither changed nor pretended to be fixed.
    expect(doc.title).toBe(SHORT_TITLE);
    expect(r.titleFixed).toBe(false);
    expect(r.unmetTargets.map((u) => u.code)).toContain('title-length');
    expect(r.summary).toMatch(/STILL FAILING/);
    expect(r.summary).toMatch(/still outside 55-60/);
    // One call: the proposal was usable, so no retry was needed.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // And none of this approves anything.
    expect(doc.checks.passed).toBe(false);
    expect(doc.status).toBe('draft');
  });

  test('a valid title plus a claim fix is accepted with nothing left unmet', async () => {
    const good = 'Ambulance Service Near Whitefield in Bangalore, Booked 24x7';
    const doc = hydrate({
      title: SHORT_TITLE,
      checks: { passed: false, titleLength: 51, metaLength: 154, unverifiedClaims: claims(3) },
    });
    respond({ repairedFields: ['title', 'content'], title: good, content: 'A cautious rewrite.' });

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(true);
    expect(r.titleFixed).toBe(true);
    expect(r.unmetTargets).toEqual([]);
    expect(r.summary).not.toMatch(/STILL FAILING/);
  });

  test('a new price alongside a claim fix rejects the WHOLE proposal', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(4) } });
    respond(
      { repairedFields: ['content'], content: 'Claims cleared, but a BLS trip is \u20b91,200.' },
      { repairedFields: ['content'], content: 'Claims cleared, and a BLS trip is \u20b91,500.' },
    );

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(false);
    expect(doc.content).toBe(BODY);          // rolled back
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a new promise alongside a claim fix rejects the WHOLE proposal', async () => {
    const doc = hydrate({ checks: { passed: false, titleLength: OK_TITLE.length, metaLength: 154, unverifiedClaims: claims(4) } });
    respond(
      { repairedFields: ['content'], content: 'Claims cleared. We will send the nearest ambulance.' },
      { repairedFields: ['content'], content: 'Claims cleared. We guarantee a vehicle.' },
    );

    const r = await repairArticle(doc);

    expect(r.repaired).toBe(false);
    expect(doc.content).toBe(BODY);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('existing pricing carried through untouched is accepted', () => {
    const before = { content: 'Fare is \u20b91,200. We are the nearest.' };
    const after = { content: 'Fare is \u20b91,200. Ask what is available when you call.' };
    const v = validateProposal(before, after, BANDS, { claims: true });
    expect(v.ok).toBe(true);
    expect(v.improved).toBe(true);
  });

  test('a proposal that regresses nothing but achieves nothing is not worth saving', () => {
    const v = validateProposal({ content: 'same' }, { content: 'same' }, BANDS, { claims: true });
    expect(v.ok).toBe(true);      // safe
    expect(v.improved).toBe(false); // but pointless
  });
});

// ============================================================
describe('J. an article that already carries many prices', () => {
  // The Whitefield case: eleven fares already on the page. The repair must be
  // allowed to run, must leave every one of them alone, and must still be
  // stopped the moment it touches one.
  const ELEVEN = Array.from({ length: 11 }, (_, i) => `\u20b9${1000 + i * 100}`);
  const PRICED_BODY = `Fares on this page: ${ELEVEN.join(', ')}. And some prose about ambulances.`;

  test('B. a proposal that preserves all eleven prices is accepted', () => {
    const before = { content: PRICED_BODY };
    const after = { content: `${PRICED_BODY} Ask dispatch what applies to your trip.` };

    const v = validateProposal(before, after, BANDS, { claims: true });

    expect(v.regressions).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.improved).toBe(true);
  });

  test('F. all eleven reformatted but unchanged in value is accepted', () => {
    // ₹1,000 -> Rs. 1000 -> INR 1,000: three spellings of one fare.
    const reformatted = ELEVEN.map((p) => `Rs. ${p.replace('\u20b9', '').replace(/,/g, '')}`);
    const before = { content: `Fares: ${ELEVEN.join(', ')}.` };
    const after = { content: `Fares: ${reformatted.join(', ')}.` };

    const v = validateProposal(before, after, BANDS, {});

    expect(v.regressions).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test('C. one NEW price on top of the eleven is rejected', () => {
    const before = { content: `Fares: ${ELEVEN.join(', ')}.` };
    const after = { content: `Fares: ${ELEVEN.join(', ')}, \u20b99,999.` };

    const v = validateProposal(before, after, BANDS, { claims: true });

    expect(v.ok).toBe(false);
    expect(v.regressions.some((r) => r.code === 'new-pricing')).toBe(true);
  });

  test('D. one of the eleven deleted is rejected', () => {
    const before = { content: `Fares: ${ELEVEN.join(', ')}.` };
    const after = { content: `Fares: ${ELEVEN.slice(1).join(', ')}.` };

    const v = validateProposal(before, after, BANDS, { claims: true });

    expect(v.ok).toBe(false);
    expect(v.regressions.some((r) => r.code === 'pricing-deleted')).toBe(true);
  });

  test('E. one of the eleven changed in value is rejected on both counts', () => {
    const before = { content: `Fares: ${ELEVEN.join(', ')}.` };
    const after = { content: `Fares: ${['\u20b95,555', ...ELEVEN.slice(1)].join(', ')}.` };

    const v = validateProposal(before, after, BANDS, { claims: true });

    expect(v.ok).toBe(false);
    const codes = v.regressions.map((r) => r.code);
    expect(codes).toContain('new-pricing');
    expect(codes).toContain('pricing-deleted');
  });
});
