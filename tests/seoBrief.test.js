/**
 * tests/seoBrief.test.js
 * ============================================================
 * The content brief: what the page must accomplish, decided before the writer
 * is asked to write it.
 *
 * Two properties matter more than the field list. First, it is DETERMINISTIC —
 * no Claude call, and the same request twice produces the same brief. A brief
 * a model improvised is not a brief a reviewer can hold the article to.
 *
 * Second, and this is the one that could do damage: the E-E-A-T section must
 * not manufacture authority. Experience, expertise and trust are normally
 * signalled with exactly the claims this business cannot make — years in
 * operation, fleet size, certifications, hospital tie-ups, response times. So
 * the brief is tested for what it REFUSES as much as for what it contains.
 * ============================================================
 */
'use strict';

const {
  buildContentBrief, renderBriefForPrompt, classifyIntent, classifyCluster, secondaryKeywords,
} = require('../services/seoBrief');
const { APPROVED_FARE_WORDING } = require('../services/seoPricingGuard');

// The verified facts, shaped as buildFactSheet returns them.
const FACTS = {
  business: {
    name: 'SaveLife Health Services',
    callNumber: '+91 99868 44442',
    whatsappNumber: '+91 88840 92777',
    address: '103B, 4th Main Road, Govindraj Nagar, Bengaluru 560040',
    city: 'Bengaluru',
    availability: '24 hours a day, every day (dispatch is staffed round the clock)',
  },
  livePages: [{ href: '/ambulance-whitefield' }, { href: '/book' }, { href: '/services' }],
  forbidden: ['Years in business, founding dates, or experience claims.'],
};

const brief = (over = {}) => buildContentBrief({
  keyword: 'ambulance service near Whitefield Bangalore',
  location: 'Whitefield',
  facts: FACTS,
  minWords: 700,
  ...over,
});

// ============================================================
describe('A. every required field is present', () => {
  const b = brief();

  test.each([
    ['1. primary keyword', 'primaryKeyword'],
    ['2. search intent', 'searchIntent'],
    ['3. keyword cluster', 'keywordCluster'],
    ['4. recommended H1', 'recommendedH1'],
    ['5. outline', 'outline'],
    ['6. secondary keywords', 'secondaryKeywords'],
    ['7. target word count', 'targetWordCount'],
    ['8. FAQ topics', 'faqTopics'],
    ['9. E-E-A-T requirements', 'eeatRequirements'],
    ['10. internal-link requirements', 'internalLinkRequirements'],
    ['11. verification requirements', 'verificationRequirements'],
    ['12. pricing policy', 'pricingPolicy'],
  ])('%s', (_label, field) => {
    const v = b[field];
    expect(v).toBeDefined();
    expect(v).not.toBeNull();
    if (Array.isArray(v)) expect(v.length).toBeGreaterThan(0);
    else if (typeof v === 'string') expect(v.trim().length).toBeGreaterThan(0);
  });

  test('the primary keyword is the one that was asked for', () => {
    expect(b.primaryKeyword).toBe('ambulance service near Whitefield Bangalore');
  });

  test('the recommended H1 is derived from the keyword, not invented', () => {
    expect(b.recommendedH1.toLowerCase()).toContain('ambulance');
    expect(b.recommendedH1.toLowerCase()).toContain('whitefield');
  });

  test('the outline carries H2/H3 levels and a purpose for each section', () => {
    expect(b.outline.length).toBeGreaterThanOrEqual(4);
    for (const s of b.outline) {
      expect(['H2', 'H3']).toContain(s.level);
      expect(s.heading.trim().length).toBeGreaterThan(0);
      expect(s.purpose.trim().length).toBeGreaterThan(0);
    }
    expect(b.outline.some((s) => s.level === 'H2')).toBe(true);
  });

  test('the word count is the gate floor, so a brief can never ask for less than the gate allows', () => {
    expect(b.targetWordCount).toBe(700);
    expect(buildContentBrief({ keyword: 'k', facts: FACTS, minWords: 900 }).targetWordCount).toBe(900);
  });

  test('4-6 FAQ topics, matching what the gate expects', () => {
    expect(b.faqTopics.length).toBeGreaterThanOrEqual(4);
    expect(b.faqTopics.length).toBeLessThanOrEqual(6);
  });
});

// ============================================================
describe('B. it is deterministic — no model decides any of it', () => {
  test('the same request twice produces an identical brief', () => {
    expect(brief()).toEqual(brief());
    expect(JSON.stringify(brief())).toBe(JSON.stringify(brief()));
  });

  test('building a brief is synchronous and needs no API key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => brief()).not.toThrow();
    // Not a promise: nothing here is awaited, so nothing here can call out.
    expect(typeof buildContentBrief({ keyword: 'k', facts: FACTS }).then).toBe('undefined');
  });

  test.each([
    ['book an ambulance bangalore', 'transactional'],
    ['ambulance near me', 'transactional'],
    ['ambulance cost bangalore', 'commercial'],
    ['what is a bls ambulance', 'informational'],
    ['savelife health services', 'navigational'],
    ['ambulance whitefield', 'transactional'],
  ])('intent for %s is %s', (kw, intent) => {
    expect(classifyIntent(kw)).toBe(intent);
  });

  test.each([
    ['freezer box in bangalore', 'freezer-box'],
    ['dead body transport bangalore', 'dead-body-transport'],
    ['icu ambulance bangalore', 'advanced-life-support'],
    ['nicu ambulance bangalore', 'neonatal'],
    ['bls ambulance bangalore', 'basic-life-support'],
  ])('cluster for %s is %s', (kw, cluster) => {
    expect(classifyCluster(kw)).toBe(cluster);
  });

  test('an explicit service from the operator wins over the guess', () => {
    expect(classifyCluster('ambulance bangalore', 'Freezer Box')).toBe('freezer-box');
  });
});

// ============================================================
describe('C. E-E-A-T is grounded, never invented', () => {
  const eeat = brief().eeatRequirements.join(' ');

  test('it leans on facts the sheet actually carries', () => {
    expect(eeat).toContain('SaveLife Health Services');
    expect(eeat).toContain('Bengaluru');
    expect(eeat).toContain('+91 99868 44442');
  });

  test('it explicitly forbids every unverifiable credibility signal', () => {
    for (const forbidden of [
      'years in business', 'fleet', 'certification', 'licence', 'award',
      'hospital', 'review', 'rating', 'testimonial', 'statistic',
    ]) {
      expect(eeat.toLowerCase()).toContain(forbidden);
    }
    expect(eeat.toLowerCase()).toMatch(/do not manufacture authority/);
  });

  test('it names doctors, nurses and staff counts as things not to assert', () => {
    expect(eeat.toLowerCase()).toMatch(/doctors or nurses/);
    expect(eeat.toLowerCase()).toMatch(/staff or crew counts/);
  });

  test('it tells the writer what to do when a fact is missing, rather than to guess', () => {
    expect(eeat).toMatch(/does not exist for the purposes of this page/i);
  });

  test('a fact absent from the sheet produces NO requirement about it', () => {
    // No availability, no address, no numbers on this sheet.
    const bare = buildContentBrief({ keyword: 'ambulance bangalore', facts: { business: { name: 'X' }, livePages: [] } });
    const text = bare.eeatRequirements.join(' ');
    expect(text).not.toMatch(/24 hours a day/);
    expect(text).not.toMatch(/\+91/);
    expect(text).not.toMatch(/verifiable business address/);
    // ...but the prohibitions are unconditional and still there.
    expect(text.toLowerCase()).toContain('do not manufacture authority');
  });

  test('an empty fact sheet does not crash and asserts nothing', () => {
    const empty = buildContentBrief({ keyword: 'ambulance bangalore', facts: {} });
    expect(empty.eeatRequirements.length).toBeGreaterThan(0);
    expect(empty.eeatRequirements.join(' ')).not.toMatch(/undefined|null|\[object/);
  });
});

// ============================================================
describe('D. the pricing prohibition survives into the brief', () => {
  const b = brief();

  test('the brief carries the single global pricing rule, not a copy', () => {
    const { NO_EXACT_PRICING_RULE } = require('../services/seoContentPolicy');
    expect(b.pricingPolicy).toBe(NO_EXACT_PRICING_RULE);
  });

  test('it forbids an exact money figure and gives the approved wording', () => {
    expect(b.pricingPolicy).toMatch(/NEVER write an exact money figure/);
    expect(b.pricingPolicy).toContain(APPROVED_FARE_WORDING);
  });

  test('the fare section of the outline asks for the METHOD, never a number', () => {
    const fare = b.outline.find((s) => /fare/i.test(s.heading));
    expect(fare).toBeDefined();
    expect(fare.purpose).toMatch(/No figure of any kind/i);
    expect(fare.purpose).toContain(APPROVED_FARE_WORDING);
  });

  // The pricing RULE quotes the forms it forbids ("₹1,200", "1200 per trip"),
  // so the guard finds them there by design. What must be clean is everything
  // the brief itself derives — the outline, FAQs, keywords, E-E-A-T — because
  // that is the part a writer could mistake for an instruction to include a
  // figure.
  test('no DERIVED part of the brief contains a price', () => {
    const { findPricesIn } = require('../services/seoPricingGuard');
    const { pricingPolicy, ...derived } = b;
    expect(findPricesIn(JSON.stringify(derived))).toEqual([]);
  });

  test('the only prices anywhere in the brief are the rule\'s own forbidden examples', () => {
    const { findPricesIn } = require('../services/seoPricingGuard');
    const inWhole = findPricesIn(JSON.stringify(b));
    const inPolicy = findPricesIn(b.pricingPolicy);
    expect(inWhole.sort()).toEqual(inPolicy.sort());
  });
});

// ============================================================
describe('E. verification and internal links', () => {
  const b = brief();

  test('verification restates the fact-sheet contract and bans ETAs', () => {
    const v = b.verificationRequirements.join(' ');
    expect(v).toMatch(/complete set of things you know/i);
    expect(v).toMatch(/independent pass/i);
    expect(v.toLowerCase()).toMatch(/no response time, arrival time or eta/);
  });

  test('internal links state the count, the source list and the gate floor', () => {
    const l = b.internalLinkRequirements.join(' ');
    expect(l).toMatch(/3-6/);
    expect(l).toMatch(/LIVE PAGES list/);
    expect(l).toMatch(/Never invent a URL/i);
    expect(l).toMatch(/at least 2 valid internal links/i);
  });

  test('secondary keywords are recombinations of the request, not new topics', () => {
    const s = secondaryKeywords('ambulance service near Whitefield Bangalore', null, 'Whitefield');
    expect(s.length).toBeGreaterThan(0);
    // Bengaluru/Bangalore is the same city, so that swap is legitimate.
    expect(s.some((k) => /bengaluru/i.test(k))).toBe(true);
    // Every term must still be about the thing that was asked for.
    for (const k of s) expect(/ambulance|whitefield/i.test(k)).toBe(true);
  });

  test('the primary keyword is never repeated as a secondary', () => {
    const kw = 'ambulance service near Whitefield Bangalore';
    expect(secondaryKeywords(kw, null, 'Whitefield')).not.toContain(kw.toLowerCase());
  });
});

// ============================================================
describe('F. the rendered brief is what the writer receives', () => {
  const text = renderBriefForPrompt(brief());

  test.each([
    ['PRIMARY KEYWORD'], ['SEARCH INTENT'], ['KEYWORD CLUSTER'], ['RECOMMENDED H1'],
    ['TARGET WORD COUNT'], ['SECONDARY KEYWORDS'], ['OUTLINE'], ['FAQ PLAN'],
    ['E-E-A-T REQUIREMENTS'], ['INTERNAL LINKS'], ['VERIFICATION'],
  ])('the prompt names the %s section', (heading) => {
    expect(text).toContain(heading);
  });

  test('the pricing rule is in the text the writer actually reads', () => {
    expect(text).toMatch(/NEVER write an exact money figure/);
  });

  test('every outline section reaches the prompt with its purpose', () => {
    for (const s of brief().outline) {
      expect(text).toContain(s.heading);
      expect(text).toContain(s.purpose);
    }
  });

  test('editor notes are carried through when given, and absent when not', () => {
    const withNotes = renderBriefForPrompt(brief({ notes: 'Mention lift access.' }));
    expect(withNotes).toMatch(/EDITOR NOTES: Mention lift access\./);
    expect(renderBriefForPrompt(brief())).not.toMatch(/EDITOR NOTES/);
  });

  test('the rendered brief carries no price outside the rule\'s forbidden examples', () => {
    const { findPricesIn } = require('../services/seoPricingGuard');
    // Strip the policy block; what remains is the brief's own instructions.
    const withoutPolicy = text.replace(brief().pricingPolicy, '');
    expect(findPricesIn(withoutPolicy)).toEqual([]);
  });
});
