/**
 * tests/seoPricingGuard.test.js
 * ============================================================
 * The pricing gate, and specifically the line it draws.
 *
 * A published fare has to be blocked; a phone number, a PIN code, a URL with
 * digits in it and "24/7" have to survive. Both halves matter equally — a
 * gate that flags every number would be turned off within a week, and a gate
 * that misses "Rs. 1500" is not a gate.
 * ============================================================
 */
'use strict';

const {
  findPricesIn,
  findPricingClaims,
  redactPricing,
  APPROVED_FARE_WORDING,
} = require('../services/seoPricingGuard');

describe('prices are detected', () => {
  const PRICES = [
    ['rupee symbol with comma', '₹1,200'],
    ['rupee symbol, second figure', '₹1,500'],
    ['per-km with symbol', '₹3/km'],
    ['Rs with a space', 'Rs 1200'],
    ['Rs with a full stop', 'Rs. 1500'],
    ['bare per-km rate', '1200 per km'],
    ['INR prefix', 'INR 900'],
    ['trailing rupees', '1200 rupees'],
    ['per kilometre spelled out', '3 per kilometre'],
    ['decimal fare', '₹1,250.50'],
    ['in a sentence', 'The minimum fare is ₹1,200 for the Eeco.'],
    ['inside a markdown table', '| BLS Ambulance | Maruti Eeco | ₹1,200 |'],
    ['per-hour rate', 'standby is ₹500 per hour'],
  ];

  test.each(PRICES)('%s: %s is flagged', (_label, text) => {
    expect(findPricesIn(text).length).toBeGreaterThan(0);
  });
});

describe('legitimate numbers are not prices', () => {
  const CLEAN = [
    ['international phone number', 'Call +91 99868 44442 and dispatch will answer.'],
    ['phoneDisplay format', 'Our number is 99868 44442.'],
    ['tel: href', '<a href="tel:+919986844442">Call now</a>'],
    ['WhatsApp number', 'https://wa.me/918884092777'],
    ['PIN code in an address', 'Govindraj Nagar, Bengaluru 560040'],
    ['URL containing digits', 'See https://www.savelife.health/guides/page-1200 for more.'],
    ['markdown link to a numbered path', 'Read [the guide](/ambulance-service-bangalore-24) next.'],
    ['round-the-clock', 'We operate 24/7, every day of the year.'],
    ['a count of FAQs', 'This page answers 4-6 common questions.'],
    ['a year', 'Operating since 2019.'],
    ['a distance with no rate', 'The hospital is 12 km away.'],
    ['the approved wording itself', APPROVED_FARE_WORDING],
  ];

  test.each(CLEAN)('%s is clean: %s', (_label, text) => {
    expect(findPricesIn(text)).toEqual([]);
  });
});

describe('a whole article is scanned, not just the body', () => {
  const clean = {
    title: 'BLS Ambulance Booking in Bengaluru',
    metaDescription: 'Book a BLS ambulance in Bengaluru. Call +91 99868 44442.',
    h1: 'BLS ambulance booking',
    content: 'The fare depends on distance. ' + APPROVED_FARE_WORDING,
    faqs: [{ q: 'How fast?', a: 'Call and dispatch will tell you honestly.' }],
  };

  test('a clean article has nothing to report', () => {
    expect(findPricingClaims(clean)).toEqual([]);
  });

  test.each([
    ['title', { title: 'BLS ambulance from ₹1,200' }],
    ['metaDescription', { metaDescription: 'BLS ambulance in Bengaluru from Rs 1200.' }],
    ['h1', { h1: 'BLS ambulance — ₹1,500' }],
    ['content', { content: 'The minimum fare is ₹1,200.' }],
  ])('a price in %s is caught', (_field, override) => {
    expect(findPricingClaims({ ...clean, ...override }).length).toBeGreaterThan(0);
  });

  test('a price in an FAQ answer is caught — an FAQ is as public as the body', () => {
    const article = { ...clean, faqs: [{ q: 'What is the fare?', a: 'It starts at ₹1,200.' }] };
    expect(findPricingClaims(article).length).toBeGreaterThan(0);
  });

  test('a price in an FAQ question is caught too', () => {
    const article = { ...clean, faqs: [{ q: 'Is it really ₹1,500?', a: 'Call to confirm.' }] };
    expect(findPricingClaims(article).length).toBeGreaterThan(0);
  });

  test('the real BLS article, as published, is caught on every figure', () => {
    const asPublished = {
      ...clean,
      content: [
        '| Booking | Vehicle | Minimum fare |',
        '| BLS Ambulance | Maruti Eeco | ₹1,200 |',
        '| BLS Ambulance | Tempo Traveller | ₹1,500 |',
        'Air conditioning adds ₹3 per kilometre.',
      ].join('\n'),
      faqs: [
        { q: 'What is the minimum fare?', a: '₹1,200 for the Eeco and ₹1,500 for the Tempo Traveller.' },
        { q: 'Is air conditioning extra?', a: 'AC is charged at ₹3 per kilometre.' },
      ],
    };
    const hits = findPricingClaims(asPublished);
    expect(hits).toEqual(expect.arrayContaining(['₹1,200', '₹1,500']));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  test('missing and empty fields do not throw', () => {
    expect(findPricingClaims({})).toEqual([]);
    expect(findPricingClaims({ content: null, faqs: null })).toEqual([]);
    expect(findPricingClaims(null)).toEqual([]);
  });
});

describe('the writer is shown no figures at all', () => {
  const facts = {
    business: { name: 'SaveLife', website: 'https://www.savelife.health' },
    bookableServices: [
      { code: 'bls', label: 'BLS Ambulance', vehicle: 'Maruti Eeco', minimumFare: 1200, acAvailable: true, acPerKm: 3, fareModel: 'Distance-based.' },
      { code: 'bls_tempo', label: 'BLS Ambulance', vehicle: 'Tempo Traveller', minimumFare: 1500, acAvailable: true, acPerKm: 3, fareModel: 'Distance-based.' },
    ],
    freezer: {
      note: 'Quoted from these figures.',
      durations: [{ city: 'Bengaluru', box: 'b1', label: '24 hours', price: 3500, discountPercentage: 10 }],
      floorCharges: [{ city: 'Bengaluru', box: 'b1', floor: 'Ground', charge: 0 }],
    },
  };

  test('no fare figure survives redaction', () => {
    const redacted = JSON.stringify(redactPricing(facts));
    expect(redacted).not.toMatch(/1200|1500|3500/);
    expect(redacted).not.toMatch(/minimumFare|acPerKm|discountPercentage/);
  });

  test('the non-price facts the writer still needs are kept', () => {
    const r = redactPricing(facts);
    expect(r.bookableServices[0].vehicle).toBe('Maruti Eeco');
    expect(r.bookableServices[0].acAvailable).toBe(true);
    expect(r.freezer.durations[0].label).toBe('24 hours');
    expect(r.business.name).toBe('SaveLife');
  });

  test('it is told what to write instead', () => {
    const r = redactPricing(facts);
    expect(r.pricingPolicy.instead).toBe(APPROVED_FARE_WORDING);
    expect(r.pricingPolicy.forbidden).toMatch(/never write a rupee amount/i);
  });

  test('redaction does not mutate the caller’s sheet', () => {
    const copy = JSON.parse(JSON.stringify(facts));
    redactPricing(facts);
    expect(facts).toEqual(copy);
  });

  test('an empty or missing sheet does not throw', () => {
    expect(() => redactPricing(undefined)).not.toThrow();
    expect(() => redactPricing({})).not.toThrow();
  });
});
