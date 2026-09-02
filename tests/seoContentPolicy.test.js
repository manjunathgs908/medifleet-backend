/**
 * tests/seoContentPolicy.test.js
 * ============================================================
 * The global content rule: A PUBLIC SEO ARTICLE CARRIES NO EXACT PRICE.
 *
 * Not per-keyword, not per-service, not just the article that happened to be
 * reported. This suite exists to prove the rule is stated once and reaches
 * every path that writes article text, and that the guard behind it still
 * catches a figure in any field and any currency form — while leaving ordinary
 * numbers alone, which is the failure mode a blunt "strip the digits" rule
 * would have.
 *
 * Detection here is exercised through seoPricingGuard, unchanged. This suite
 * asserts the POLICY; the guard is what enforces it.
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { NO_EXACT_PRICING_RULE, pricingRemovalInstruction } = require('../services/seoContentPolicy');
const { findPricingClaims, findPricesIn, APPROVED_FARE_WORDING } = require('../services/seoPricingGuard');

const GENERATOR_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'seoGenerator.js'), 'utf8');

/** An article shaped like the real thing, priced only where a test says so. */
const article = (over = {}) => ({
  title: 'Ambulance Service Near Whitefield, Bangalore | 24x7 Dispatch',
  metaDescription: 'x'.repeat(154),
  h1: 'Ambulance near Whitefield',
  content: 'Call dispatch and describe the patient. The vehicle is chosen from that.',
  faqs: [{ q: 'What does it cost?', a: 'It depends on the vehicle and the road distance travelled.' }],
  ...over,
});

// ============================================================
describe('A/B. an article is judged on whether it carries a figure at all', () => {
  test('A. a generated article containing ₹1,200 fails the pricing rule', () => {
    const hits = findPricingClaims(article({ content: 'A BLS trip is ₹1,200 for the first 10 km.' }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain('₹1,200');
  });

  test('B. a generated article with no figure passes', () => {
    const clean = article({
      content: `What a trip costs depends on the vehicle, the road distance travelled and the timing. ${APPROVED_FARE_WORDING}`,
    });
    expect(findPricingClaims(clean)).toEqual([]);
  });
});

// ============================================================
describe('E/F/G. every field a reader can see is covered', () => {
  test.each([
    { field: 'title', doc: article({ title: 'Ambulance from ₹1,200 in Whitefield Bangalore Book Now' }) },
    { field: 'metaDescription', doc: article({ metaDescription: 'Book an ambulance near Whitefield. BLS from ₹1,200, ALS from ₹2,500. Call now.' }) },
    { field: 'h1', doc: article({ h1: 'Ambulance from Rs 1,200' }) },
    { field: 'content', doc: article({ content: 'Body shifting is ₹1,000 in the Eeco.' }) },
    { field: 'FAQ question', doc: article({ faqs: [{ q: 'Is it ₹1,200?', a: 'It depends on the trip.' }] }) },
    { field: 'FAQ answer', doc: article({ faqs: [{ q: 'What does it cost?', a: 'Minimum ₹1,200 for a BLS Eeco.' }] }) },
  ])('a price in the $field is caught', ({ doc }) => {
    expect(findPricingClaims(doc).length).toBeGreaterThan(0);
  });

  test('G. structured data is scanned as text, so a price in JSON-LD is caught', () => {
    const jsonLd = [
      { '@type': 'Article', description: 'BLS from ₹1,200 near Whitefield.' },
      { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', acceptedAnswer: { text: 'ALS is ₹2,500.' } }] },
    ];
    const hits = findPricesIn(JSON.stringify(jsonLd));
    expect(hits).toEqual(expect.arrayContaining(['₹1,200', '₹2,500']));
  });

  test('G2. structured data rebuilt from clean text carries nothing', () => {
    const jsonLd = [
      { '@type': 'Article', description: `Fares vary by vehicle and distance. ${APPROVED_FARE_WORDING}` },
      { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', acceptedAnswer: { text: 'It depends on the trip. Ask dispatch.' } }] },
    ];
    expect(findPricesIn(JSON.stringify(jsonLd))).toEqual([]);
  });
});

// ============================================================
describe('H. every article inherits the rule, whatever the keyword', () => {
  // The rule is a constant interpolated into the two system prompts, which are
  // keyword-independent. That is what makes it global rather than something
  // remembered per article.
  test('the rule is stated once, in one module', () => {
    expect(NO_EXACT_PRICING_RULE).toMatch(/NEVER write an exact money figure/);
    expect(NO_EXACT_PRICING_RULE).toContain(APPROVED_FARE_WORDING);
  });

  test('both writing prompts interpolate that same constant', () => {
    // Once in WRITER_SYSTEM, once in REPAIR_SYSTEM. Generation and repair
    // cannot drift apart on the policy because there is only one copy of it.
    const uses = GENERATOR_SRC.split('${NO_EXACT_PRICING_RULE}').length - 1;
    expect(uses).toBe(2);
  });

  test('the writer prompt no longer shows the model how to format a rupee amount', () => {
    // It used to say: "British-Indian English. Rupee amounts as ₹1,200." —
    // a worked example of the exact thing the policy forbids.
    expect(GENERATOR_SRC).not.toMatch(/Rupee amounts as/);
  });

  test('the repair prompt no longer tells the model to preserve existing pricing', () => {
    // That instruction predated the policy and directly contradicted it.
    expect(GENERATOR_SRC).not.toMatch(/NEVER delete or alter pricing wording/);
  });

  test.each([
    ['ambulance service near Electronic City Bangalore', 'A BLS run to Electronic City starts at ₹1,200.'],
    ['ambulance service near Whitefield Bangalore', 'Whitefield pickups are ₹1,500 minimum.'],
    ['BLS ambulance Bangalore', 'BLS is Rs 1,200 for the first 10 km.'],
    ['ALS ambulance Bangalore', 'ALS costs INR 2500 per trip.'],
    ['hospital transfer ambulance Bangalore', 'Transfers are billed at ₹3/km.'],
    ['dialysis patient transport Bangalore', 'Each dialysis run is 1200 per trip.'],
    ['freezer box Bangalore', 'The normal box is ₹2,500 for 12 hours.'],
    ['body shifting Bangalore', 'Body shifting starts from ₹1,000.'],
  ])('%s: a priced draft is caught regardless of service', (keyword, content) => {
    expect(findPricingClaims(article({ keyword, content })).length).toBeGreaterThan(0);
  });
});

// ============================================================
describe('I. every currency form is detected', () => {
  test.each([
    ['₹1,200', 'A BLS trip is ₹1,200.'],
    ['Rs 1,200', 'A BLS trip is Rs 1,200.'],
    ['Rs. 1,200', 'A BLS trip is Rs. 1,200.'],
    ['INR 1200', 'A BLS trip is INR 1200.'],
    ['1200 rupees', 'A BLS trip is 1200 rupees.'],
    ['₹3/km', 'Air conditioning is ₹3/km on top.'],
    ['3 per km', 'Air conditioning is 3 per km on top.'],
    ['₹6,000 upward', 'The 48-hour slab is ₹6,000 upward.'],
  ])('%s is detected', (_label, text) => {
    expect(findPricesIn(text).length).toBeGreaterThan(0);
  });
});

// ============================================================
describe('J. ordinary numbers are left alone', () => {
  // The failure mode a blunt digit-stripping rule would have. Each of these is
  // a number a useful ambulance page genuinely needs.
  test.each([
    ['24/7 availability', 'Dispatch is staffed 24/7, every day of the year.'],
    ['a word count', 'This guide runs to about 950 words.'],
    ['a display phone number', 'Call 99868 44442 at any hour.'],
    ['an international phone number', 'Call +91 99868 44442 or WhatsApp +91 88840 92777.'],
    ['a tel: link', 'Call us on [our line](tel:+919986844442).'],
    ['a PIN code', 'The Whitefield office is in 560066.'],
    ['road distances', 'Whitefield to Manipal is roughly 12 km by road.'],
    ['floor numbers', 'A stretcher carry from the 4th floor is a different job.'],
    ['a date', 'Updated on 2 September 2026.'],
    ['equipment specifications', 'The NICU unit carries a transport incubator and 2 oxygen cylinders.'],
    ['a slab count', 'There are 4-6 FAQs on each page.'],
    ['hours in a duration', 'A freezer box may be needed for 24 hours or longer.'],
  ])('%s is not a price', (_label, text) => {
    expect(findPricesIn(text)).toEqual([]);
  });

  test('the approved fare wording itself is not a price', () => {
    expect(findPricesIn(APPROVED_FARE_WORDING)).toEqual([]);
  });
});

// ============================================================
describe('K. the removal instruction quotes what has to go', () => {
  test('the offending phrases are named, so the edit stays local', () => {
    const instr = pricingRemovalInstruction(['₹1,200', '₹2,500', '3 per km']);
    expect(instr).toMatch(/₹1,200/);
    expect(instr).toMatch(/₹2,500/);
    expect(instr).toMatch(/3 per km/);
    expect(instr).toMatch(/REMOVE THE PUBLISHED PRICING/);
  });

  test('it forbids substituting a different figure', () => {
    const instr = pricingRemovalInstruction(['₹1,200']);
    expect(instr).toMatch(/do NOT substitute a different figure/i);
  });

  test('it tells the model to keep the explanation, not just delete', () => {
    const instr = pricingRemovalInstruction(['₹1,200']);
    expect(instr).toMatch(/road distance|vehicle/i);
    expect(instr).toMatch(/confirmed before booking/i);
  });

  test('it still works when the caller has no phrase list', () => {
    expect(pricingRemovalInstruction()).toMatch(/must all be gone/i);
  });
});
