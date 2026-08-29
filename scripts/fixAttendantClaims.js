/**
 * scripts/fixAttendantClaims.js
 * ============================================================
 * Remove the false "BLS carries a trained attendant" claim from the articles
 * that assert it, plus the one false "both are air-conditioned" claim.
 *
 *   node scripts/fixAttendantClaims.js --slug=<slug>
 *   node scripts/fixAttendantClaims.js --slug=<slug> --apply
 *
 * DRY RUN BY DEFAULT, same contract as the other correction scripts.
 *
 * THE FACT
 *
 * A BLS ambulance travels with the DRIVER ONLY. The attendant is the optional
 * paid Helper add-on (HELPER_ELIGIBLE_TYPES in savelife-web/lib/config.js),
 * and AC on BLS is the acPerKm add-on. Both were being described as included,
 * which is the shape of claim that turns into a billing dispute: the customer
 * reads "included", the invoice says otherwise, and the page is the evidence.
 *
 * ONE ARTICLE AT A TIME, on purpose
 *
 * Editing an approved article demotes it to in_review, which drops it out of
 * PUBLIC_STATUSES and takes its page off savelife.health until a recheck
 * passes and a human re-approves it. Doing all three at once would take three
 * live pages dark together. --slug is required so each is done, verified and
 * restored before the next begins.
 *
 * WHAT IT WILL NOT DO
 *
 * It does not approve, and it does not leave an edited article approved. The
 * gates have not run against the new text, so nothing here may claim they
 * have. Recheck is a Claude call and cannot run from here — the API key lives
 * only in Render — so re-approval goes through the Studio.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const SeoArticle = require('../models/SeoArticle');
const { findPricingClaims } = require('../services/seoPricingGuard');
const { META_MIN, META_MAX } = require('../services/seoGenerator');

const arg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const APPLY = process.argv.includes('--apply');

// Every edit is an exact-match replacement scoped to one article. Written out
// per article rather than generated, because each page is separately indexed
// and pasting one sentence into all five is what search engines read as
// boilerplate.
const EDITS = {
  'bls-ambulance-booking-bengaluru': {
    meta: {
      find: 'Oxygen-equipped, trained attendant, GPS-tracked.',
      replace: 'Oxygen-equipped, stretcher on board, GPS-tracked.',
    },
    content: [
      {
        find: 'Our BLS ambulances are oxygen-equipped and staffed by a trained attendant, and they run on either a Maruti Eeco or a Tempo Traveller.',
        replace: 'Our BLS ambulances are oxygen-equipped and carry a stretcher, and they run on either a Maruti Eeco or a Tempo Traveller. The vehicle travels with the driver; if you want an attendant with the patient, add one when you book.',
      },
      {
        find: 'Both are oxygen-equipped, staffed by a trained attendant, and GPS-tracked so the vehicle can be followed on its way to you.',
        replace: 'Both are oxygen-equipped, carry a stretcher, and are GPS-tracked so the vehicle can be followed on its way to you. An attendant is an optional add-on rather than part of the fare.',
      },
    ],
    faqs: [],
  },

  'hospital-transfer-ambulance-bangalore': {
    content: [
      {
        find: 'Basic life support, oxygen-equipped, with a trained attendant on board.',
        replace: 'Basic life support, oxygen-equipped, with a stretcher on board and an attendant available as a paid add-on.',
      },
    ],
    faqs: [], // FAQ[3] "how many attendants intend to travel" means the family's
              // own companions and is correct — deliberately untouched.
  },

  'dialysis-patient-transport-bangalore': {
    content: [
      {
        find: 'in an oxygen-equipped ambulance with a trained attendant.',
        replace: 'in an oxygen-equipped ambulance with a stretcher, and an attendant if you add one to the booking.',
      },
      {
        // One line, two false claims: the attendant AND "both are
        // air-conditioned" — AC on BLS is the acPerKm add-on.
        find: 'oxygen-equipped basic life support with a trained attendant, on either a Maruti Eeco or a Tempo Traveller. Both are air-conditioned.',
        replace: 'oxygen-equipped basic life support with a stretcher, on either a Maruti Eeco or a Tempo Traveller. It travels with the driver unless you add an attendant, and air conditioning is a paid add-on rather than standard.',
      },
    ],
    faqs: [
      {
        match: /is a bls ambulance enough/i,
        find: 'ask us for a BLS ambulance with oxygen and a trained attendant.',
        replace: 'ask us for a BLS ambulance with oxygen and a stretcher, adding an attendant if you want one on board.',
      },
    ],
  },

  'bls-ambulance-booking-bengaluru-mt8kq2sw': {
    meta: {
      find: 'Oxygen-equipped Eeco or Tempo Traveller with a trained attendant, fare shown before you confirm.',
      replace: 'Oxygen-equipped Eeco or Tempo Traveller with a stretcher, fare shown before you confirm.',
    },
    content: [
      {
        find: 'If the patient is stable but needs oxygen and a trained attendant during the journey',
        replace: 'If the patient is stable but needs oxygen and a stretcher rather than a car seat',
      },
      {
        find: 'In practice that means an oxygen-equipped ambulance with a trained attendant travelling with the patient, rather than a bare van that only moves a stretcher from point A to point B. It is generally intended for stable patients who need oxygen and a trained attendant during the journey rather than critical-care equipment on board.',
        replace: 'In practice that means an oxygen-equipped ambulance with a proper stretcher, rather than a bare van that only moves one from point A to point B. It is generally intended for stable patients who need oxygen on hand during the journey rather than critical-care equipment on board. An attendant can travel with the patient as a paid add-on.',
      },
      {
        find: '- **Maruti Eeco** — the compact option, oxygen-equipped with a trained attendant on board.',
        replace: '- **Maruti Eeco** — the compact option, oxygen-equipped with a stretcher on board.',
      },
      {
        find: '- **Tempo Traveller** — the larger option, also oxygen-equipped with a trained attendant.',
        replace: '- **Tempo Traveller** — the larger option, also oxygen-equipped and stretcher-fitted.',
      },
    ],
    faqs: [
      {
        match: /enough for my patient/i,
        find: 'BLS suits stable patients who need oxygen and a trained attendant during the journey.',
        replace: 'BLS suits stable patients who need oxygen on hand during the journey, with an attendant available as an optional extra.',
      },
    ],
  },

  'ambulance-service-near-electronic-city-bangalore': {
    content: [
      {
        // Attendant AND a hard-coded minimum fare in one bullet. The figure is
        // not replaced with another figure — it points at the booking page,
        // where the fare is actually calculated.
        find: 'oxygen-equipped basic life support with a trained attendant. Minimum fare ₹1,200.',
        replace: 'oxygen-equipped basic life support with a stretcher; an attendant can be added. The fare is worked out for your route and shown on the [booking page](/book) before you confirm.',
      },
    ],
    faqs: [],
  },
};

(async () => {
  const slug = arg('slug');
  if (!slug) {
    console.error('Usage: node scripts/fixAttendantClaims.js --slug=<slug> [--apply]');
    console.error('Slugs: ' + Object.keys(EDITS).join(', '));
    process.exit(1);
  }
  const plan = EDITS[slug];
  if (!plan) { console.error(`No edits defined for "${slug}".`); process.exit(1); }
  if (!process.env.MONGO_URI) { console.error('MONGO_URI is not set.'); process.exit(1); }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const a = await SeoArticle.findOne({ slug });
    if (!a) { console.error(`No article with slug "${slug}".`); process.exit(1); }

    console.log(`\nArticle : ${a.slug}`);
    console.log(`Status  : ${a.status}   checks.passed: ${a.checks?.passed}`);
    console.log(`Mode    : ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}\n`);

    const changed = [];

    // ── metaDescription ────────────────────────────────────────
    let meta = a.metaDescription;
    if (plan.meta) {
      if (!meta.includes(plan.meta.find)) {
        console.error(`REFUSED: meta text not found:\n  ${plan.meta.find}`);
        process.exit(1);
      }
      meta = meta.replace(plan.meta.find, plan.meta.replace);
      const len = meta.length;
      console.log(`META  ${a.metaDescription.length} -> ${len} chars (gate ${META_MIN}-${META_MAX}) ${len >= META_MIN && len <= META_MAX ? 'OK' : 'OUT OF BAND'}`);
      console.log(`  before: ${a.metaDescription}`);
      console.log(`  after : ${meta}\n`);
      if (len < META_MIN || len > META_MAX) {
        console.error('REFUSED: replacement meta is outside the length gate. Nothing written.');
        process.exit(1);
      }
      changed.push('metaDescription');
    }

    // ── content ────────────────────────────────────────────────
    let content = a.content;
    for (const e of plan.content || []) {
      const n = content.split(e.find).length - 1;
      if (n !== 1) {
        console.error(`REFUSED: content passage matched ${n} times, expected 1:\n  ${e.find.slice(0, 120)}`);
        process.exit(1);
      }
      console.log(`BODY`);
      console.log(`  before: ${e.find}`);
      console.log(`  after : ${e.replace}\n`);
      content = content.replace(e.find, e.replace);
    }
    if ((plan.content || []).length) changed.push('content');

    // ── faqs ───────────────────────────────────────────────────
    const faqs = (a.faqs || []).map((f) => ({ q: f.q, a: f.a }));
    for (const e of plan.faqs || []) {
      const i = faqs.findIndex((f) => e.match.test(f.q || ''));
      if (i < 0) { console.error(`REFUSED: no FAQ matching ${e.match}`); process.exit(1); }
      if (!faqs[i].a.includes(e.find)) {
        console.error(`REFUSED: FAQ[${i}] text not found:\n  ${e.find}`);
        process.exit(1);
      }
      console.log(`FAQ[${i}]  ${faqs[i].q}`);
      console.log(`  before: ${faqs[i].a}`);
      faqs[i] = { q: faqs[i].q, a: faqs[i].a.replace(e.find, e.replace) };
      console.log(`  after : ${faqs[i].a}\n`);
    }
    if ((plan.faqs || []).length) changed.push('faqs');

    // ── verify the corrected article ───────────────────────────
    const candidate = { ...a.toObject(), metaDescription: meta, content, faqs };
    const attendantLeft = [meta, content, ...faqs.map((f) => `${f.q} ${f.a}`)]
      .join('\n').match(/trained attendant/gi) || [];
    const pricesBefore = findPricingClaims(a);
    const pricesAfter = findPricingClaims(candidate);

    console.log('─'.repeat(70));
    console.log(`Fields changed        : ${changed.join(', ')}`);
    console.log(`"trained attendant"   : ${attendantLeft.length} remaining (must be 0)`);
    console.log(`Pricing claims        : ${pricesBefore.length} -> ${pricesAfter.length}`);
    console.log(`Status after          : ${a.status === 'approved' || a.status === 'published' ? 'in_review (demoted)' : a.status + ' (unchanged)'}`);
    console.log(`checks.passed after   : false`);

    if (attendantLeft.length) {
      console.error('\nREFUSED: the claim survives the edit. Nothing written.');
      process.exit(1);
    }

    if (!APPLY) {
      console.log('\nDRY RUN. Nothing written. Re-run with --apply.\n');
      return;
    }

    a.corrections.push({
      at: new Date(),
      reason: 'Removed the false claim that a BLS ambulance carries a trained attendant — it travels with the driver only, and the attendant is the optional paid Helper add-on. Where present, also removed a false "air-conditioned" inclusion and a hard-coded fare.',
      fields: changed,
      previous: {
        title: a.title,
        metaDescription: a.metaDescription,
        content: a.content,
        faqs: (a.faqs || []).map((f) => ({ q: f.q, a: f.a })),
        status: a.status,
      },
    });

    a.metaDescription = meta;
    a.content = content;
    a.faqs = faqs;

    // An approved article loses its approval the moment its text changes: the
    // sign-off was for words that no longer exist. Recheck then re-approve.
    if (a.status === 'approved' || a.status === 'published') a.status = 'in_review';
    a.checks.passed = false;

    await a.save();

    console.log('\nWritten.');
    console.log(`  status        : ${a.status}`);
    console.log(`  checks.passed : ${a.checks.passed}`);
    console.log(`  corrections   : ${a.corrections.length}`);
    console.log(`\nNext: Recheck this article in the SEO Studio, then Approve it if it passes.`);
    console.log(`      Confirm the page is live again before starting the next article.\n`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
