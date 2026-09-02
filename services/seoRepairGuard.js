/**
 * services/seoRepairGuard.js
 * ============================================================
 * Judge a PROPOSED repair before it is allowed to become the article.
 *
 * A repair is a model rewriting a live medical page to remove claims it could
 * not support. The failure mode that matters is not "the repair did nothing" —
 * it is "the repair fixed the flagged claim and quietly asserted something
 * else". A rewrite that trades eleven unsupported claims for eleven published
 * fares has made the page worse while every individual instruction was obeyed.
 *
 * So nothing here asks whether the repair is good. It asks one question:
 *
 *     is the proposed text worse than the text it would replace?
 *
 * WHAT THIS IS NOT
 *
 * It is not a second pricing gate. Detection is delegated wholesale to
 * seoPricingGuard.findPricesIn — the same function the real gate uses, called
 * read-only. This module never decides what a price is, never relaxes that
 * definition, and cannot let a price through: the gate still runs afterwards
 * and still blocks approval. What this adds is the ability to catch a price
 * BEFORE it is saved, so the article is never written into a state a human
 * then has to clean up.
 *
 * Pure and I/O-free by design, so the whole thing is testable without a
 * database, a model call or a fact sheet. The length bands are parameters
 * rather than imports, which also keeps it free of a cycle with seoGenerator.
 * ============================================================
 */
'use strict';

const { findPricesIn } = require('./seoPricingGuard');

// Language that promises an operational fact. None of it is verifiable from a
// fact sheet, all of it is the kind of thing a family acts on in an emergency,
// and a repair asked to "reword until it stops asserting the unsupported
// thing" reaches for exactly these phrases.
//
// Matched only when a repair ADDS one. An article that already said it is a
// question for the fact checker, not for this module — the job here is to stop
// a repair from widening what the page asserts, never to re-judge what was
// already there.
const PROMISE_PATTERNS = [
  { name: 'proximity claim', re: /\b(nearest|closest|nearby ambulance)\b/gi },
  { name: 'speed claim', re: /\b(fastest|quickest|immediately dispatch|instant(?:ly)? dispatch)\b/gi },
  { name: 'arrival promise', re: /\b(will arrive|will reach|arrives within|reach(?:es)? you within|within \d+\s*(?:min|minute))/gi },
  { name: 'dispatch promise', re: /\b(we will send|will be sent|we will provide|will be provided|we guarantee|guaranteed)\b/gi },
  { name: 'staffing promise', re: /\b(24\s*[x\/]\s*7\s+staffed|always staffed|fully staffed|staff on standby|always available)\b/gi },
  { name: 'coverage promise', re: /\b(cover(?:s|ing)? (?:all|every) (?:area|locality|part)|available (?:in|across) (?:all|every))\b/gi },
];

/** Every field a reader sees, as one string. Mirrors findPricingClaims's view. */
function articleText(article) {
  return [
    article?.title,
    article?.metaDescription,
    article?.h1,
    article?.content,
    ...(article?.faqs || []).flatMap((f) => [f?.q, f?.a]),
  ].filter(Boolean).join('\n');
}

/** Promise-language hits in one string, deduped and lower-cased for comparison. */
function findPromisesIn(text) {
  const hits = new Map();
  for (const { name, re } of PROMISE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(text || '').matchAll(re)) {
      hits.set(m[0].trim().toLowerCase(), name);
    }
  }
  return hits;
}

/**
 * The identity of a price, independent of how it was typed.
 *
 * "Rs 1,200", "Rs. 1,200", "₹1,200" and "INR 1200" are one fare written four
 * ways. Comparing the raw phrases made a cosmetic reformat look like a
 * deletion AND an introduction at the same time, which rejected repairs that
 * had changed nothing about the money on the page.
 *
 * The unit is part of the identity, so "₹3" and "3 per km" never collapse into
 * each other — those are different assertions that happen to share a digit.
 *
 * This narrows nothing. Detection is still entirely seoPricingGuard's: only
 * phrases that IT reported as prices ever reach this function, and every
 * distinct value it reports is still a distinct key.
 */
function priceKey(phrase) {
  const s = String(phrase || '');
  const kind = /\b(?:km|kms|kilometre|kilometer)/i.test(s) ? 'per-km'
    : /\b(?:hr|hour|day|night|trip)/i.test(s) ? 'per-time'
    : 'amount';
  // The first number in the phrase, commas stripped. Matched rather than
  // filtered, so the full stop in "Rs." cannot be read as a decimal point.
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  return `${kind}:${Number(m[0].replace(/,/g, ''))}`;
}

/** value-keyed index of every price in an article: key -> the phrase seen. */
function priceIndex(article) {
  const out = new Map();
  for (const phrase of findPricesIn(articleText(article))) {
    const k = priceKey(phrase);
    // A phrase the guard flagged but that carries no parsable number keeps its
    // own identity rather than being silently dropped.
    out.set(k ?? `raw:${phrase}`, phrase);
  }
  return out;
}

/**
 * Prices in `after` that were not in `before`.
 *
 * Compared by value, not by formatting, so "Rs 1,200" -> "Rs. 1,200" is not a
 * new price. A genuinely different figure still is: 1200 -> 1500 introduces
 * 1500 and removes 1200, and both halves are reported.
 */
function newPricesIntroduced(before, after) {
  const had = priceIndex(before);
  const out = [];
  for (const [k, phrase] of priceIndex(after)) if (!had.has(k)) out.push(phrase);
  return out;
}

/**
 * Prices in `before` that are gone from `after`.
 *
 * Deleting a fare makes the pricing gate happier, which is exactly why a
 * repair must not do it as a side effect. Removing published fares is a
 * deliberate editorial correction with its own script and its own audit trail
 * (scripts/correctArticlePricing.js); it is not something a claim repair gets
 * to do quietly on the way past.
 *
 * Value-keyed for the same reason as above: re-typing a fare is not deleting
 * it, but dropping it — or changing what it says — still is.
 */
function pricesRemoved(before, after) {
  const nowHas = priceIndex(after);
  const out = [];
  for (const [k, phrase] of priceIndex(before)) if (!nowHas.has(k)) out.push(phrase);
  return out;
}

/** Promise language in `after` that was not in `before`. */
function newPromisesIntroduced(before, after) {
  const had = findPromisesIn(articleText(before));
  const now = findPromisesIn(articleText(after));
  const added = [];
  for (const [phrase, kind] of now) if (!had.has(phrase)) added.push({ phrase, kind });
  return added;
}

const len = (s) => String(s || '').length;

/**
 * Is this proposed article safe to save in place of the previous one?
 *
 * @param {object} before   the article as it stands now
 * @param {object} after    the article as the model proposes it
 * @param {object} bands    { TITLE_MIN, TITLE_MAX, META_MIN, META_MAX }
 * @param {object} targets  which gates this repair was asked to fix —
 *                          { title:bool, meta:bool }. A field that was NOT a
 *                          target is held to "must not get worse"; a field
 *                          that WAS a target must actually land in its band,
 *                          because saving an invalid title on the grounds that
 *                          it is no worse than the last invalid title is how
 *                          an attempt gets spent for nothing.
 *
 * THREE ANSWERS, NOT ONE
 *
 * `regressions` are disqualifying: new pricing, deleted pricing, a new
 * assurance, an emptied body, or a field that was valid and no longer is.
 * Any of these and the proposal is discarded whole.
 *
 * `unmet` is different in kind. A target that did not reach its band is a job
 * left unfinished, not damage done — and discarding the whole proposal for it
 * threw away good work: a rewrite that cleared eleven unsupported claims but
 * did not return a title was binned, leaving the article with the eleven
 * claims AND the bad title. Unmet targets are therefore reported, not
 * punished, and the caller keeps the safe part while saying plainly what is
 * still failing.
 *
 * `improved` says whether anything was actually gained. A proposal that
 * regresses nothing but achieves nothing is not worth saving.
 *
 * @returns {{ ok:boolean, improved:boolean, regressions:Array, unmet:Array,
 *             improvements:string[] }}
 *          ok = safe to save. improved = worth saving. A caller should
 *          require BOTH.
 */
function validateProposal(before, after, bands, targets = {}) {
  const { TITLE_MIN, TITLE_MAX, META_MIN, META_MAX } = bands;
  const regressions = [];
  const unmet = [];

  const addedPrices = newPricesIntroduced(before, after);
  if (addedPrices.length) {
    regressions.push({
      code: 'new-pricing',
      detail: `the repair introduced ${addedPrices.length} price(s) that were not there before: ${addedPrices.join(', ')}`,
    });
  }

  const droppedPrices = pricesRemoved(before, after);
  if (droppedPrices.length) {
    regressions.push({
      code: 'pricing-deleted',
      detail: `the repair deleted existing pricing text (${droppedPrices.join(', ')}); removing published fares is a separate editorial decision, not a side effect of a claim repair`,
    });
  }

  const addedPromises = newPromisesIntroduced(before, after);
  if (addedPromises.length) {
    regressions.push({
      code: 'new-promise',
      detail: `the repair introduced unsupported assurance(s): ${addedPromises.map((p) => `"${p.phrase}" (${p.kind})`).join(', ')}`,
    });
  }

  // ── Lengths ──────────────────────────────────────────────
  const tBefore = len(before?.title);
  const tAfter = len(after?.title);
  const tOkBefore = tBefore >= TITLE_MIN && tBefore <= TITLE_MAX;
  const tOkAfter = tAfter >= TITLE_MIN && tAfter <= TITLE_MAX;
  if (targets.title && !tOkAfter) {
    // Unfinished, not damaging. Reported so the caller can keep the rest of
    // the repair and still say the title is failing.
    unmet.push({
      code: 'title-length',
      field: 'title',
      detail: `the title was asked for and came back ${tAfter} characters, still outside ${TITLE_MIN}-${TITLE_MAX}`,
    });
  } else if (!targets.title && tOkBefore && !tOkAfter) {
    regressions.push({
      code: 'title-broken',
      detail: `the title was valid at ${tBefore} characters and the repair moved it to ${tAfter}`,
    });
  }

  const mBefore = len(before?.metaDescription);
  const mAfter = len(after?.metaDescription);
  const mOkBefore = mBefore >= META_MIN && mBefore <= META_MAX;
  const mOkAfter = mAfter >= META_MIN && mAfter <= META_MAX;
  if (targets.meta && !mOkAfter) {
    unmet.push({
      code: 'meta-length',
      field: 'metaDescription',
      detail: `the meta description was asked for and came back ${mAfter} characters, still outside ${META_MIN}-${META_MAX}`,
    });
  } else if (!targets.meta && mOkBefore && !mOkAfter) {
    regressions.push({
      code: 'meta-broken',
      detail: `the meta description was valid at ${mBefore} characters and the repair moved it to ${mAfter}`,
    });
  }

  // An empty body is not a repair. Guards against a model returning "" for a
  // field it decided to delete wholesale.
  if (after && 'content' in after && !String(after.content || '').trim()) {
    regressions.push({ code: 'empty-content', detail: 'the repair returned an empty article body' });
  }

  // ── Was anything actually gained? ────────────────────────
  // Only counted against a target that was ASKED for. A rewrite nobody
  // requested is not an improvement, it is drift.
  const improvements = [];
  if (targets.title && tOkAfter && !tOkBefore) improvements.push('the title is now inside its band');
  if (targets.meta && mOkAfter && !mOkBefore) improvements.push('the meta description is now inside its band');
  if (targets.claims) {
    const bodyChanged = String(before?.content || '') !== String(after?.content || '');
    const faqsChanged = JSON.stringify(before?.faqs || []) !== JSON.stringify(after?.faqs || []);
    // Whether the claims are genuinely gone is the fact checker's call, not
    // this one's — the recheck stays authoritative. What can be said here is
    // that the text carrying them was rewritten, which is what was asked for.
    if (bodyChanged || faqsChanged) improvements.push('the text carrying the flagged claims was rewritten');
  }

  return {
    ok: regressions.length === 0,
    improved: improvements.length > 0,
    regressions,
    unmet,
    improvements,
  };
}

/**
 * Did the gates get worse after a recheck?
 *
 * The pre-save check above is cheap and deterministic but blind to anything
 * only a real fact check can see. This is the second look, run on the recheck
 * result: if the article now fails something it did not fail before, the
 * attempt is reverted rather than left standing.
 *
 * Counts, not identities: the checker does not return stable claim ids, and a
 * repair that swaps one unsupported claim for another has not improved
 * anything even though every individual string changed.
 */
function isWorse(before = {}, after = {}) {
  const reasons = [];
  const blocking = (c) => (c || []).filter((x) => (x?.severity || 'unsupported') !== 'phrasing').length;

  const claimsBefore = blocking(before.unverifiedClaims);
  const claimsAfter = blocking(after.unverifiedClaims);
  if (claimsAfter > claimsBefore) {
    reasons.push(`blocking claims rose from ${claimsBefore} to ${claimsAfter}`);
  }

  const priceBefore = (before.pricingClaims || []).length;
  const priceAfter = (after.pricingClaims || []).length;
  if (priceAfter > priceBefore) {
    reasons.push(`the recheck found ${priceAfter} published price(s) where there were ${priceBefore}`);
  }

  const schemaBefore = (before.schemaErrors || []).length;
  const schemaAfter = (after.schemaErrors || []).length;
  if (schemaAfter > schemaBefore) {
    reasons.push(`schema errors rose from ${schemaBefore} to ${schemaAfter}`);
  }

  // A body that fell under the floor is a repair that deleted too much.
  if ((after.wordCount ?? 0) < (before.wordCount ?? 0) * 0.6) {
    reasons.push(`the body lost more than 40% of its words (${before.wordCount} -> ${after.wordCount})`);
  }

  return { worse: reasons.length > 0, reasons };
}

module.exports = {
  PROMISE_PATTERNS,
  priceKey,
  priceIndex,
  articleText,
  findPromisesIn,
  newPricesIntroduced,
  pricesRemoved,
  newPromisesIntroduced,
  validateProposal,
  isWorse,
};
