/**
 * services/seoPricingGuard.js
 * ============================================================
 * Finds published prices in a generated article.
 *
 * Why this exists, when the fact checker already runs: the checker asks "does
 * the fact sheet support this claim". For a price it does — buildFactSheet()
 * reads live figures out of MongoDB and hands them over as VERIFIED PRICING,
 * so a generated ₹1,200 is genuinely supported at the moment it is written
 * and the checker correctly says nothing.
 *
 * The failure is not fabrication, it is staleness. Fares move with distance,
 * vehicle, AC, time of day and diesel-linked rules, so a figure that was true
 * when the article was generated keeps asserting itself on a public page long
 * after it stopped being true. No claim-verification gate can catch that,
 * because nothing about the claim was ever unverified.
 *
 * So this gate does not ask whether a price is correct. It blocks the page
 * from carrying one at all, and the article says instead:
 *
 *   "The final fare is calculated using the applicable current pricing rules
 *    and shown before booking confirmation."
 *
 * Fails closed: anything that looks like a price blocks approval, and a
 * reviewer removes it. The cost of a false positive is one edit. The cost of
 * a false negative is a public medical page quoting a fare that is wrong.
 * ============================================================
 */
'use strict';

// The wording an article uses instead of a figure. Exported so the writer
// prompt, the correction script and the tests all quote the same sentence.
const APPROVED_FARE_WORDING =
  'The final fare is calculated using the applicable current pricing rules and shown before booking confirmation.';

// Things that contain digits and are not prices. Removed BEFORE the price
// patterns run, so a phone number or a URL can never be reported as a fare.
//
// Order matters: tel: links go before the bare-phone rule, because the rule
// below would otherwise leave the "tel:" prefix stranded.
const NOT_PRICES = [
  /https?:\/\/\S+/gi,          // absolute URLs
  /\]\([^)]*\)/g,              // markdown link targets — [label](/path-2)
  /tel:\+?[\d\s().-]+/gi,      // tel: hrefs
  /\+\d{1,3}[\s-]?\d[\d\s-]{6,}\d/g, // international phone numbers, +91 99868 44442
  /\b\d{5}\s\d{5}\b/g,         // the phoneDisplay() format, 99868 44442
  /\b\d{6}\b/g,                // PIN codes — 560040
];

// What a published price looks like. Deliberately narrow: a currency marker
// attached to a number, or a number attached to a per-distance unit. A bare
// number is not a price and is not matched — "4-6 FAQs" and "24/7" have to
// survive.
const PRICE_PATTERNS = [
  // ₹1,200 · Rs 1200 · Rs. 1,500 · INR 1200 · 1200 rupees
  { name: 'currency amount', re: /(?:₹|\bRs\.?|\bINR\b)\s*\d[\d,]*(?:\.\d+)?/gi },
  { name: 'currency amount', re: /\b\d[\d,]*(?:\.\d+)?\s*(?:rupees|rs\b|inr\b)/gi },
  // 3/km · 1200 per km · 3 per kilometre
  { name: 'per-distance rate', re: /\b\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:km|kms|kilometre|kilometer)s?\b/gi },
  // per-hour / per-day rates are fares too
  { name: 'per-time rate', re: /(?:₹|\bRs\.?|\bINR\b)\s*\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:hr|hour|day|night|trip)s?\b/gi },
  // The same rate written WITHOUT a currency marker: "1200 per trip",
  // "2500 minimum". The per-km rule above already worked bare; these two units
  // did not, so a fare could be published simply by omitting the ₹.
  //
  // Three digits minimum, and that threshold is the whole safety of it. A fare
  // is never "2", whereas "2 per trip" is far more likely to be a count of
  // attendants or cylinders — so the bare form is only read as money once the
  // number is too large to be a count. The currency-marked patterns above are
  // untouched and still match from a single digit.
  { name: 'bare per-unit rate', re: /\b\d{3}[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:trip|booking|hour|hr|day|night|patient|person)s?\b/gi },
  { name: 'bare minimum figure', re: /\b\d{3}[\d,]*(?:\.\d+)?\s*minimum\b/gi },
];

/** Strip the legitimate digit-bearing things before looking for prices. */
function scrub(text) {
  let out = String(text || '');
  for (const re of NOT_PRICES) out = out.replace(re, ' ');
  return out;
}

/**
 * Every price-looking phrase in one string.
 * @returns {string[]} the offending phrases, verbatim, deduped.
 */
function findPricesIn(text) {
  const clean = scrub(text);
  const hits = new Set();
  for (const { re } of PRICE_PATTERNS) {
    // Fresh lastIndex each call: these are /g regexes held at module scope.
    re.lastIndex = 0;
    for (const m of clean.matchAll(re)) hits.add(m[0].trim());
  }
  return [...hits];
}

/**
 * Scan a whole article — every field a reader sees.
 *
 * Checks title, meta, h1, body and both halves of every FAQ. A price in an
 * FAQ answer is as public as one in the body, and the meta description is
 * what shows in the search result.
 *
 * @returns {string[]} offending phrases, deduped, empty when clean.
 */
function findPricingClaims(article) {
  const parts = [
    article?.title,
    article?.metaDescription,
    article?.h1,
    article?.content,
    ...(article?.faqs || []).flatMap((f) => [f?.q, f?.a]),
  ];
  const hits = new Set();
  for (const part of parts) for (const hit of findPricesIn(part)) hits.add(hit);
  return [...hits];
}

/**
 * A copy of the fact sheet with every figure removed, for the writer.
 *
 * The writer cannot publish a number it was never shown. This is the
 * structural half of the protection; findPricingClaims() is the half that
 * fails closed if a number arrives anyway.
 *
 * The checker still receives the real sheet: it needs the true figures to
 * judge everything else, and a price that slips through is caught by the gate
 * rather than by the checker.
 */
function redactPricing(facts) {
  const sheet = JSON.parse(JSON.stringify(facts || {}));

  sheet.bookableServices = (sheet.bookableServices || []).map((s) => ({
    code: s.code,
    label: s.label,
    vehicle: s.vehicle,
    acAvailable: s.acAvailable,
    fareModel: s.fareModel,
    fareWording: APPROVED_FARE_WORDING,
  }));

  if (sheet.freezer) {
    sheet.freezer = {
      note: sheet.freezer.note,
      fareWording: APPROVED_FARE_WORDING,
      durations: (sheet.freezer.durations || []).map((d) => ({
        city: d.city, box: d.box, label: d.label,
        embalmingIncluded: d.embalmingIncluded,
      })),
      floorCharges: (sheet.freezer.floorCharges || []).map((f) => ({
        city: f.city, box: f.box, floor: f.floor,
      })),
    };
  }

  sheet.pricingPolicy = {
    rule: 'You have deliberately not been given any fare figure. Fares vary with distance, vehicle, air conditioning, time of day and other rules in force at the time of booking, so any number printed on a page goes out of date.',
    instead: APPROVED_FARE_WORDING,
    forbidden: 'Never write a rupee amount, a per-kilometre rate, or any other fare figure — not as an example, not as "from", not as "starting at", not as a range.',
  };

  return sheet;
}

module.exports = {
  APPROVED_FARE_WORDING,
  findPricesIn,
  findPricingClaims,
  redactPricing,
};
