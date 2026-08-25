/**
 * scripts/correctArticlePricing.js
 * ============================================================
 * Strip published fares out of an article that already carries them, as a
 * recorded correction rather than a silent overwrite.
 *
 *   node scripts/correctArticlePricing.js --slug=bls-ambulance-booking-bengaluru
 *   node scripts/correctArticlePricing.js --slug=... --apply
 *
 * DRY RUN BY DEFAULT. Without --apply it prints exactly what would change and
 * writes nothing — the same contract as scripts/migrateSeoJsonLd.js.
 *
 * What --apply does:
 *   - keeps the previous title/content/faqs in `corrections[]`, so what the
 *     page said while it was approved is still answerable
 *   - rewrites only the pricing section and the FAQs that quote a figure
 *   - moves the article to in_review and sets checks.passed false
 *
 * What it deliberately does NOT do:
 *   - it does not approve, and it cannot: the article goes back through
 *     recheck and a human pressing Approve
 *   - it does not delete the article or create a second one
 *   - it does not write a correction whose replacement text would still trip
 *     the pricing gate. It refuses and says so, so a bad correction cannot
 *     be recorded in the first place.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');
const { findPricingClaims, APPROVED_FARE_WORDING } = require('../services/seoPricingGuard');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const APPLY = process.argv.includes('--apply');

// The replacement pricing section. No figure, and no "from" or "starting at"
// either — a floor is still a published price.
const PRICING_SECTION = [
  '## The two BLS vehicles',
  '',
  'BLS ambulances run on either a Maruti Eeco or a Tempo Traveller. Both are oxygen-equipped, staffed by a trained attendant, and GPS-tracked so the vehicle can be followed on its way to you.',
  '',
  'What a trip costs depends on the distance actually travelled, the vehicle, whether you need air conditioning, the time of day, and the other pricing rules in force when you book. ' + APPROVED_FARE_WORDING,
  '',
  'If you would rather hear it from a person before you commit, ring dispatch and ask.',
].join('\n');

// Matched on the question rather than the index, so the script is not tied to
// the order the FAQs happen to be stored in.
const FAQ_REWRITES = [
  {
    match: /minimum fare|how much|what does it cost/i,
    q: 'How much does a BLS ambulance cost in Bengaluru?',
    a: 'It depends on the distance of your trip, the vehicle, air conditioning, the time of day and the pricing rules in force when you book, so no fixed figure on this page would stay accurate. '
      + APPROVED_FARE_WORDING
      + ' Dispatch can also talk it through with you on the call.',
  },
  {
    match: /air conditioning|\bac\b/i,
    q: 'Is air conditioning extra?',
    a: 'Air conditioning is available on both BLS vehicles. Any charge that applies is part of the fare worked out for your trip. '
      + APPROVED_FARE_WORDING
      + ' Tell dispatch when you book if you want it.',
  },
];

/** Replace the pricing section — its heading through to the next H2. */
function rewriteBody(content) {
  const lines = String(content || '').split('\n');
  const start = lines.findIndex((l) => /^##\s+.*(cost|price|fare|vehicles)/i.test(l));
  if (start < 0) return { content, replaced: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const out = [...lines.slice(0, start), ...PRICING_SECTION.split('\n'), '', ...lines.slice(end)];
  return { content: out.join('\n').replace(/\n{3,}/g, '\n\n'), replaced: true };
}

function rewriteFaqs(faqs) {
  let changed = 0;
  const out = (faqs || []).map((f) => {
    // Only touch an FAQ that actually quotes a figure. A pricing-adjacent
    // question that never had a number in it is left exactly as approved.
    if (!findPricingClaims({ content: `${f.q} ${f.a}` }).length) return f;
    const hit = FAQ_REWRITES.find((r) => r.match.test(f.q || ''));
    if (!hit) return f;
    changed++;
    return { q: hit.q, a: hit.a };
  });
  return { faqs: out, changed };
}

(async () => {
  const slug = arg('slug');
  if (!slug) {
    console.error('Usage: node scripts/correctArticlePricing.js --slug=<slug> [--apply]');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Nothing was attempted.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const article = await SeoArticle.findOne({ slug });
    if (!article) {
      console.error(`No article with slug "${slug}".`);
      process.exit(1);
    }

    const before = findPricingClaims(article);
    console.log(`\nArticle : ${article.slug}`);
    console.log(`Status  : ${article.status}`);
    console.log(`Prices  : ${before.length ? before.join(', ') : 'none'}`);
    if (!before.length) {
      console.log('\nAlready clean. Nothing to correct.');
      return;
    }

    const previous = {
      title: article.title,
      content: article.content,
      faqs: (article.faqs || []).map((f) => ({ q: f.q, a: f.a })),
      status: article.status,
    };

    const body = rewriteBody(article.content);
    const faq = rewriteFaqs(article.faqs);

    const candidate = { ...article.toObject(), content: body.content, faqs: faq.faqs };
    const after = findPricingClaims(candidate);

    console.log(`\nWould rewrite : body ${body.replaced ? 'yes' : 'NO SECTION FOUND'}, ${faq.changed} FAQ(s)`);
    console.log(`Prices after  : ${after.length ? after.join(', ') : 'none'}`);

    // Fail closed: never record a "correction" that still trips the gate.
    if (after.length) {
      console.error('\nREFUSED: the corrected text still contains a price. Nothing written.');
      process.exit(1);
    }
    if (!body.replaced) {
      console.error('\nREFUSED: no pricing section found to replace. Correct it by hand in the Studio.');
      process.exit(1);
    }

    if (!APPLY) {
      console.log('\n--- replacement pricing section ---');
      console.log(PRICING_SECTION);
      console.log('\nDRY RUN. Nothing written. Re-run with --apply to record the correction.');
      return;
    }

    article.content = body.content;
    article.faqs = faq.faqs;
    article.corrections.push({
      at: new Date(),
      reason: 'Removed published fares: pricing is dynamic and a fixed figure on a live page goes stale.',
      fields: ['content', 'faqs'],
      previous,
    });
    // Back into review. It cannot be approved until a recheck passes, and the
    // pricing gate is now one of the checks that recheck runs.
    article.status = 'in_review';
    article.checks.passed = false;
    await article.save();

    console.log('\nCorrection recorded.');
    console.log(`  status        : ${article.status}`);
    console.log(`  checks.passed : ${article.checks.passed}`);
    console.log(`  corrections   : ${article.corrections.length}`);
    console.log(`\nNext: POST /api/seo/articles/${article._id}/recheck, then Approve in the Studio.`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
