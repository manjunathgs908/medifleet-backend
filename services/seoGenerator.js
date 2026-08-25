/**
 * services/seoGenerator.js
 * ============================================================
 * Keyword -> cluster -> intent -> brief -> draft -> checks -> DRAFT row.
 *
 * One Claude call produces the whole article as a validated JSON object
 * (structured outputs, so there is no parsing to get wrong), and a second
 * pass fact-checks the result against the same fact sheet. Two passes
 * because a model asked to write and to police itself in one breath does
 * neither well -- the checker gets only the fact sheet and the finished
 * text, with no memory of wanting to write it.
 *
 * When the checker raises blocking claims, a third kind of call repairs
 * only those claims and the checker runs again, up to
 * MAX_FACT_REPAIR_ATTEMPTS times. A repair may narrow what the page
 * asserts, never widen it: it gets the fact sheet and the flagged quotes
 * with their severity and action, and returns only the fields it touched.
 * Phrasing notes never trigger a repair -- they do not block approval, so
 * paying a call to reword one would buy nothing. What survives the last
 * attempt stays flagged for a human: the loop can fix an article, never
 * pass one.
 *
 * Nothing here publishes. The output is always status:'draft'.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const { validateJsonLd } = require('./seoSchemaValidator');
const { refreshLivePageIndex, loadLivePageIndex, isIndexStale } = require('./seoLivePages');
const { buildFactSheet } = require('./seoFacts');
const { findPricingClaims, redactPricing, APPROVED_FARE_WORDING } = require('./seoPricingGuard');

// Never hard-coded. An unset key is a configuration answer, not a crash.
const MODEL = process.env.SEO_CLAUDE_MODEL || 'claude-opus-5';
const EFFORT = process.env.SEO_CLAUDE_EFFORT || 'high';

// Below this a "unique" page is really a reworded one. Tunable without a
// deploy because the right threshold depends on how close the keyword set is.
const SIMILARITY_BLOCK = Number(process.env.SEO_SIMILARITY_THRESHOLD || 0.55);
const MIN_WORDS = Number(process.env.SEO_MIN_WORDS || 700);

// Search-result truncation points. Ranges, not preferences: a title or meta
// outside these blocks approval, so the writer schema states the same numbers.
const TITLE_MIN = Number(process.env.SEO_TITLE_MIN || 55);
const TITLE_MAX = Number(process.env.SEO_TITLE_MAX || 60);
const META_MIN  = Number(process.env.SEO_META_MIN  || 150);
const META_MAX  = Number(process.env.SEO_META_MAX  || 160);

// How many times a failed fact check may be repaired before the draft is
// saved with its blocking claims outstanding. Two gives the shape:
//   generate -> check -> repair -> check -> repair -> check
// which is three chances to come back clean. What survives two passes is
// normally a claim the fact sheet genuinely cannot support, and the answer
// to that is a reviewer, not a fourth prompt.
const MAX_FACT_REPAIR_ATTEMPTS = Number(process.env.SEO_MAX_FACT_REPAIR_ATTEMPTS || 2);

// The SEO Studio aborts the request at this point (medifleet-frontend
// src/api/client.js -> seoApi.generate). Declared here so the budget below is
// derived from it rather than drifting away from it silently.
const CLIENT_TIMEOUT_MS = Number(process.env.SEO_CLIENT_TIMEOUT_MS || 300000);

// Stop starting new work this long before the client gives up, leaving room
// for the live-page index refresh, the similarity sweep and the write. If the
// client aborts, the server still finishes and still saves the draft -- but
// the operator sees a failure, cannot find the article, and generates again,
// paying for the whole thing twice.
const BUDGET_MARGIN_MS = Number(process.env.SEO_BUDGET_MARGIN_MS || 45000);
const GENERATION_BUDGET_MS = CLIENT_TIMEOUT_MS - BUDGET_MARGIN_MS;

// The only fields the checker is shown, and therefore the only fields a
// flagged claim can live in. Repair is restricted to exactly this set, which
// is what makes "the slug, internal links and JSON-LD are preserved" a
// property of the code rather than a promise in a prompt.
const CHECKABLE_FIELDS = ['title', 'metaDescription', 'h1', 'content', 'faqs'];

// Severity decides what blocks approval. A phrasing note is advisory, so it
// is never worth a repair call: the gate does not care about it and a
// reviewer can fix an adjective faster than a model can.
const isBlocking = (c) => c.severity !== 'phrasing';

// The checker may return a bare string (a legacy row, or a model that dropped
// the object shape) or an object missing its severity. Both read as
// 'unsupported', the conservative choice, and both are normalised here so the
// repair loop and the gate see one shape. This mirrors what Phase 2 does
// before computing blockingClaims -- hoisted into a function so the loop can
// apply it on every attempt rather than only the last.
const normaliseClaims = (raw) => (raw || []).map((c) =>
  typeof c === 'string'
    ? { claim: c, severity: 'unsupported', action: 'rewrite' }
    : { claim: c.claim, severity: c.severity || 'unsupported', action: c.action || 'rewrite' },
);

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — SEO generation is unavailable.');
  }
  if (!client) {
    // Required here, not at module load. This file is reachable from
    // server.js via routes/seo.js, so a missing or broken SDK package at the
    // top level would take the whole dispatch API down on boot -- booking,
    // tracking and all -- to break a feature nobody is using yet. Deferring
    // it confines that failure to this one endpoint.
    // eslint-disable-next-line global-require
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

/**
 * Thrown before any Claude call when the keyword already has an article.
 * Carries the existing row so the Studio can link to it instead of just
 * saying no.
 */
class DuplicateKeywordError extends Error {
  constructor(existing) {
    super(`This keyword already has an article: "${existing.title}" (${existing.status}).`);
    this.name = 'DuplicateKeywordError';
    this.existing = existing;
  }
}

// ── Similarity ────────────────────────────────────────────────
// Word trigrams over normalised text, compared by Jaccard. Deliberately
// simple: it catches the failure that actually happens (the same article
// reworded for a neighbouring keyword) without an embedding service, and a
// reviewer can understand why something was flagged.
const normalise = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function shingle(text, n = 3) {
  const words = normalise(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return [...out];
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const x of a) if (setB.has(x)) shared++;
  return shared / (a.length + b.length - shared);
}

// ── Structured output schemas ─────────────────────────────────
const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cluster', 'searchIntent', 'slug', 'title', 'metaDescription', 'h1', 'content', 'faqs', 'internalLinks'],
  properties: {
    cluster: { type: 'string', description: 'Short keyword-cluster name this page belongs to, e.g. "dead-body-transport" or "bengaluru-areas".' },
    searchIntent: { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] },
    slug: { type: 'string', description: 'URL slug, lowercase, hyphenated, no leading slash.' },
    // Hard ranges, not preferences. These are also checked mechanically after
    // generation — a title outside the range blocks approval — so a soft
    // "where possible" here just produced drafts that failed the gate.
    title: { type: 'string', description: 'SEO title. MUST be between 55 and 60 characters inclusive. Count the characters before returning.' },
    metaDescription: { type: 'string', description: 'Meta description. MUST be between 150 and 160 characters inclusive. Count the characters before returning.' },
    h1: { type: 'string' },
    content: { type: 'string', description: 'The article body in Markdown. Use ## for sections. No H1 — that is the h1 field.' },
    faqs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['q', 'a'],
        properties: { q: { type: 'string' }, a: { type: 'string' } },
      },
    },
    internalLinks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'href', 'reason'],
        properties: { label: { type: 'string' }, href: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unverifiedClaims'],
  properties: {
    unverifiedClaims: {
      type: 'array',
      description: 'Every sentence or phrase asserting something the fact sheet does not establish. Empty array if the text is clean.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'severity', 'action'],
        properties: {
          claim: { type: 'string', description: 'The offending phrase, quoted verbatim from the article so a human can find it.' },
          severity: {
            type: 'string',
            enum: ['fabricated', 'unsupported', 'phrasing'],
            description: 'fabricated = an invented business fact (a price, a time, a partnership, a count). unsupported = a claim about the business, a service or a location that the fact sheet does not establish. phrasing = wording only; the underlying fact is fine.',
          },
          action: {
            type: 'string',
            enum: ['source', 'remove', 'rewrite'],
            description: 'source = the real figure exists in the fact sheet and should replace this. remove = delete the sentence; nothing supports it. rewrite = reword so it stops asserting.',
          },
        },
      },
    },
  },
};

// Every content field is optional and the model returns only what it
// touched: an untouched field is absent from the response, so it cannot be
// silently reworded. repairedFields is the manifest, and anything outside
// CHECKABLE_FIELDS is ignored when the result is merged.
const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repairedFields'],
  properties: {
    repairedFields: {
      type: 'array',
      description: 'Exactly the fields you rewrote. Omit any field you did not change.',
      items: { type: 'string', enum: ['title', 'metaDescription', 'h1', 'content', 'faqs'] },
    },
    title: { type: 'string' },
    metaDescription: { type: 'string' },
    h1: { type: 'string' },
    content: { type: 'string', description: 'The full repaired body in Markdown, if and only if you changed it.' },
    faqs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['q', 'a'],
        properties: { q: { type: 'string' }, a: { type: 'string' } },
      },
    },
  },
};

const WRITER_SYSTEM = `You write SEO landing pages for SaveLife Health Services, an ambulance and death-care operator in Bengaluru, India.

This is a YMYL site: people read it during a medical emergency or a death in the family. Getting a fact wrong here costs someone something real.

ABSOLUTE RULE: the FACT SHEET in the user message is the complete set of things you know about this business. If a fact is not in it, that fact does not exist and you must not write it — not as a hedge, not as an example, not as "typically". Where a reader would expect a figure you do not have, say plainly that they should call, and say why.

Write like a person who knows the subject and respects the reader:
- Answer the search intent in the first paragraph. Someone who searched this is not browsing.
- Concrete and specific over reassuring and vague. "Call and we will tell you honestly, based on where the nearest available unit is" beats "we pride ourselves on rapid response".
- Vary sentence length. No stacked adjectives. Never repeat the keyword to hit a density — write it the number of times a human would.
- Do not open with "In today's world" or close with "In conclusion".
- Say what you cannot do. A page that admits a limit is more useful, and more credible, than one that does not.
- British-Indian English. Rupee amounts as ₹1,200.
- The title MUST be 55-60 characters and the meta description MUST be 150-160. Count them. A draft outside these ranges is rejected automatically.

internalLinks: choose 3-6 from the LIVE PAGES list only. Never invent a URL. Each needs a real reason a reader on this page would want that page.`;

const CHECKER_SYSTEM = `You are fact-checking a draft web page for an ambulance and death-care business before a human reviews it.

You are given a FACT SHEET and an ARTICLE. List every claim the fact sheet does not establish, and classify each one.

ALWAYS FLAG, and always as "fabricated" — these are invented business facts and none of them is ever acceptable:
- Any price, rate, fee or discount not in the sheet's pricing sections
- Any response time, arrival time, ETA or "reach you in N minutes"
- Fleet size, vehicle counts, staff counts, or number of cities
- Years in business, founding dates, experience claims
- Reviews, ratings, testimonials, "trusted by N families"
- Hospital or crematorium names, partnerships, tie-ups, empanelment
- Licences, accreditations, certifications, ISO numbers, regulatory approval
- Statistics, percentages, survey figures
- Awards, rankings, "number one", "best in Bangalore", or any comparative superiority claim

FLAG as "unsupported" — plausible but not established:
- A service, city or area not in the sheet's services or coverage
- A capability, inclusion or guarantee the sheet does not state
- Medical or clinical assertions, including anything about treatment or outcomes
- Legal or statutory assertions: what a law requires, what document is mandatory, how a permit or certificate is obtained
- Any statement about how the business operates that the sheet does not cover

FLAG as "phrasing" — ONLY when the underlying fact is established and the wording is the sole problem: an overclaiming adjective, a vague intensifier, an absolute like "always" or "never" where the sheet supports the general case.

Choose the action a reviewer should take:
- "source"  — the correct figure or fact IS in the sheet; it should replace what is written
- "remove"  — nothing supports it; the sentence should go
- "rewrite" — the substance is fine; it needs rewording so it stops asserting

DO NOT FLAG:
- Anything stated in approvedDescriptions. That is human-written, already-published copy from the live site; restating, rephrasing or expanding it is legitimate. It does NOT license a number, time or comparison — judge those by the rules above wherever they appear.
- Ordinary prose, hedged invitations to call, or generic descriptions of a service that the sheet establishes
- The business's own contact details, address or availability as given in the sheet

When you are unsure whether something is unsupported or merely phrasing, choose unsupported. This is a YMYL page; "probably fine" is not a standard. Quote each claim verbatim. If the article is clean, return an empty array.`;

const REPAIR_SYSTEM = `You are correcting a draft web page for an ambulance and death-care business in Bengaluru, India. It has failed an independent fact check.

You are given the FACT SHEET, the ARTICLE, and the exact claims the checker could not verify. Each claim carries a severity and a suggested action.

Never invent a fact to satisfy the checker. If a claim cannot be verified from the supplied fact sheet or approved source, remove it, soften it into a clearly non-factual recommendation, or replace it with a statement supported by the supplied facts.

This is a YMYL page: someone reads it during a medical emergency or a death in the family. A confident sentence you cannot support is worse than an admission that they should call and ask.

The action on each claim tells you what the checker thinks it needs:
- source  = the real figure IS in the fact sheet. Replace the invented one with it.
- remove  = nothing supports this. Delete the sentence.
- rewrite = reword until it stops asserting the unsupported thing.

How to repair:
- Fix ONLY the flagged claims. Every other sentence must survive unchanged.
- Return ONLY the fields you actually rewrote, and list them in repairedFields. Omit every field you did not touch.
- Make the smallest edit that removes the unsupported assertion. Usually that is deleting a clause, or replacing a specific figure with an honest invitation to call.
- Where the fact cannot be verified, use cautious wording: say what the reader should do, not what is true. "Ask what is available when you call" is supportable. "We keep a vehicle stationed in your area" is not, unless the sheet says so.
- Do not add new claims, figures, place names, services or guarantees while repairing. A repair may only narrow what the page asserts, never widen it.
- Do not pad to replace lost length, and do not touch the title or meta description unless a flagged claim is inside one. Both are length-checked downstream and rewriting them for style will fail the page.
- Keep the existing voice, British-Indian English, Markdown structure and heading order.`;

async function callClaude({ system, prompt, schema, maxTokens = 16000 }) {
  const startedAt = Date.now();
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  });

  // A safety decline is a 200 with stop_reason 'refusal' — content would be
  // empty and JSON.parse would throw something unhelpful.
  if (res.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request (${res.stop_details?.category || 'unspecified'}).`);
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { data: JSON.parse(text), usage: res.usage, ms: Date.now() - startedAt };
}

/**
 * The independent fact check. Always a clean context: the checker sees the
 * fact sheet and the finished text, never the conversation that produced
 * them, and never the claims it raised last time. A checker shown its own
 * previous verdict grades its own homework.
 *
 * Returns claims already normalised to { claim, severity, action }.
 */
async function runFactCheck(article, factBlock, spend) {
  const view = {};
  for (const k of CHECKABLE_FIELDS) view[k] = article[k];

  const { data, usage, ms } = await callClaude({
    system: CHECKER_SYSTEM,
    prompt: `FACT SHEET:\n${factBlock}\n\nARTICLE:\n${JSON.stringify(view, null, 2)}`,
    schema: CHECK_SCHEMA,
    maxTokens: 8000,
  });
  spend(usage, ms);
  return normaliseClaims(data.unverifiedClaims);
}

/**
 * Rewrite only the flagged claims, in place.
 *
 * Mutates `article` and returns the fields actually replaced. Fields the
 * model does not return are never touched, so anything outside
 * CHECKABLE_FIELDS -- slug, internalLinks, cluster, searchIntent -- is
 * unreachable from here. The JSON-LD is built from the repaired article
 * afterwards and validated by the existing gate, so structured data can
 * never describe text a repair edited out.
 */
async function repairClaims(article, claims, factBlock, spend) {
  const prompt = [
    'FACT SHEET — the complete set of things you know:',
    factBlock,
    '',
    'CLAIMS THE CHECKER COULD NOT VERIFY:',
    ...claims.map((c, i) => `${i + 1}. [${c.severity} / ${c.action}] ${c.claim}`),
    '',
    'ARTICLE (repair only the claims above):',
    JSON.stringify(
      CHECKABLE_FIELDS.reduce((o, k) => { o[k] = article[k]; return o; }, {}),
      null,
      2,
    ),
  ].join('\n');

  const { data, usage, ms } = await callClaude({
    system: REPAIR_SYSTEM,
    prompt,
    schema: REPAIR_SCHEMA,
  });
  spend(usage, ms);

  const changed = [];
  for (const field of data.repairedFields || []) {
    // A field outside the checkable set cannot hold a flagged claim, so a
    // request to rewrite one is ignored rather than obeyed.
    if (!CHECKABLE_FIELDS.includes(field)) continue;
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    article[field] = value;
    changed.push(field);
  }
  return changed;
}

/**
 * Every quality gate, in one place.
 *
 * Extracted from generateDraft so the recheck endpoint runs the SAME rules
 * over an edited article rather than a second implementation of them. The
 * logic below is unchanged from Phase 2 — it has only moved.
 *
 * @param {object} article  { slug, title, metaDescription, h1, content, faqs,
 *                            internalLinks, cluster, searchIntent } — a plain
 *                            generator result or a hydrated SeoArticle; both
 *                            carry the same field names.
 * @param {object} opts
 *   facts      the fact sheet the article is judged against
 *   claims     normalised [{ claim, severity, action }] from runFactCheck
 *   excludeId  an article to leave out of the duplicate-slug, similarity and
 *              intent-collision comparisons. Null when generating (the row
 *              does not exist yet); the article's own _id when rechecking,
 *              because an article compared against itself is a duplicate of
 *              itself and would fail every time.
 *
 * @returns { slug, shingles, jsonLd, internalLinks, checks, passed, failedChecks }
 */
async function evaluateGates(article, { facts, claims, excludeId = null }) {
  const notSelf = excludeId ? { _id: { $ne: excludeId } } : {};

  const slug = String(article.slug || '').toLowerCase().replace(/^\/+/, '').trim();
  const duplicateSlug = Boolean(await SeoArticle.exists({ slug, ...notSelf }));

  const shingles = shingle(`${article.h1} ${article.content}`);
  const existing = await SeoArticle.find(notSelf, 'slug title status searchIntent cluster').select('+shingles').lean();
  let similarityScore = 0;
  let similarTo = null;
  for (const other of existing) {
    const score = jaccard(shingles, other.shingles || []);
    if (score > similarityScore) { similarityScore = score; similarTo = other._id; }
  }

  // ── Against the pages that already rank ─────────────────────
  // Curated pages on savelife.health are protected canonical content;
  // nothing generated may duplicate one. Same fingerprint and the same
  // SIMILARITY_BLOCK as the draft comparison above.
  if (await isIndexStale()) {
    await refreshLivePageIndex({ base: facts.business.website, shingle });
  }
  const livePages = await loadLivePageIndex();

  let livePageSimilarity = 0;
  let similarToLivePage = null;
  for (const page of livePages) {
    const score = jaccard(shingles, page.shingles || []);
    if (score > livePageSimilarity) { livePageSimilarity = score; similarToLivePage = page.path; }
  }
  const livePagesIndexed = livePages.length;

  // ── Intent collisions ───────────────────────────────────────
  // Recorded and shown to the reviewer, never gated: "too close in intent"
  // is a judgement the business has to make, not a threshold this code
  // should invent.
  const intentCollisions = existing
    .filter((other) =>
      other.status !== 'rejected' &&
      other.cluster &&
      article.cluster &&
      other.cluster === article.cluster &&
      other.searchIntent === article.searchIntent)
    .map((other) => ({
      source: 'article',
      ref: other.slug,
      cluster: other.cluster,
      searchIntent: other.searchIntent,
      titleSimilarity: jaccard(shingle(article.title, 2), shingle(other.title || '', 2)),
    }));

  // Links must point at pages that exist. Rejects are recorded rather than
  // dropped silently.
  const liveHrefs = new Set(facts.livePages.map((pg) => pg.href));
  const proposedLinks = article.internalLinks || [];
  const internalLinks = proposedLinks.filter((l) => liveHrefs.has(l.href));
  const droppedLinks = proposedLinks
    .filter((l) => !liveHrefs.has(l.href))
    .map((l) => ({ label: l.label, href: l.href, reason: l.reason }));

  const wordCount = normalise(article.content).split(' ').filter(Boolean).length;

  const titleLength = String(article.title || '').length;
  const metaLength = String(article.metaDescription || '').length;
  const titleOk = titleLength >= TITLE_MIN && titleLength <= TITLE_MAX;
  const metaOk = metaLength >= META_MIN && metaLength <= META_MAX;

  // Severity decides what blocks: fabricated and unsupported stop approval,
  // phrasing is advisory.
  const unverifiedClaims = claims || [];
  const blockingClaims = unverifiedClaims.filter(isBlocking);

  // Structured data checked where the article is assembled, not only at
  // render time. A reviewer must not be able to approve a page whose schema
  // was never going to work.
  const jsonLd = buildJsonLd(article, slug, facts);
  const schemaErrors = validateJsonLd(jsonLd);

  // Published fares. Not a claim-verification problem — the fact sheet
  // genuinely supports the figure when it is written — but a figure on a
  // public page outlives the rules that produced it. See seoPricingGuard.js.
  const pricingClaims = findPricingClaims(article);

  const passed =
    blockingClaims.length === 0 &&
    pricingClaims.length === 0 &&
    !duplicateSlug &&
    similarityScore < SIMILARITY_BLOCK &&
    livePageSimilarity < SIMILARITY_BLOCK &&
    schemaErrors.length === 0 &&
    wordCount >= MIN_WORDS &&
    internalLinks.length >= 2 &&
    titleOk &&
    metaOk;

  // One entry per failing term, enumerated from the same nine conditions as
  // `passed` above. If a gate is added there it must be added here too, or
  // both the log and the recheck response will under-report the reason.
  const failedChecks = [];
  if (blockingClaims.length) failedChecks.push(`${blockingClaims.length} blocking claim(s)`);
  if (pricingClaims.length) failedChecks.push(`${pricingClaims.length} fixed price(s): ${pricingClaims.join(', ')} — use: "${APPROVED_FARE_WORDING}"`);
  if (duplicateSlug) failedChecks.push('duplicate slug');
  if (similarityScore >= SIMILARITY_BLOCK) failedChecks.push(`draft similarity ${similarityScore.toFixed(2)} >= ${SIMILARITY_BLOCK}`);
  if (livePageSimilarity >= SIMILARITY_BLOCK) failedChecks.push(`live-page similarity ${livePageSimilarity.toFixed(2)} >= ${SIMILARITY_BLOCK} (${similarToLivePage || 'unknown page'})`);
  if (schemaErrors.length) failedChecks.push(`${schemaErrors.length} schema error(s)`);
  if (wordCount < MIN_WORDS) failedChecks.push(`${wordCount} words < ${MIN_WORDS}`);
  if (internalLinks.length < 2) failedChecks.push(`${internalLinks.length} valid internal link(s) < 2`);
  if (!titleOk) failedChecks.push(`title ${titleLength} chars, want ${TITLE_MIN}-${TITLE_MAX}`);
  if (!metaOk) failedChecks.push(`meta ${metaLength} chars, want ${META_MIN}-${META_MAX}`);

  return {
    slug,
    shingles,
    jsonLd,
    internalLinks,
    passed,
    failedChecks,
    checks: {
      similarityScore, similarTo, duplicateSlug,
      livePageSimilarity, similarToLivePage, livePagesIndexed,
      intentCollisions,
      schemaErrors,
      pricingClaims,
      unverifiedClaims, droppedLinks,
      titleLength, metaLength,
      wordCount, passed,
    },
  };
}

/**
 * Generate one draft. Never publishes, never overwrites.
 *
 * @param {object} input  { keyword, service?, location?, notes? }
 * @param {object} user   the requesting CRM user (for createdBy)
 */
async function generateDraft(input, user) {
  const { keyword, service, location, notes } = input;
  if (!keyword || !String(keyword).trim()) throw new Error('A keyword is required.');

  // ── Duplicate keyword: refuse BEFORE spending anything ──────
  //
  // Every status counts, rejected included. A rejected article is a decision
  // somebody made about this keyword; generating a fresh one behind their
  // back is how a rejection gets quietly overturned. The reviewer is told
  // what exists and decides.
  const normalizedKeyword = SeoArticle.normaliseKeyword(keyword);
  const existing = await SeoArticle.findOne({ normalizedKeyword })
    .select('_id slug title status keyword')
    .lean();
  if (existing) {
    console.log(`[SEO] duplicate keyword "${normalizedKeyword}" — existing ${existing.status} article ${existing._id}, no generation run`);
    throw new DuplicateKeywordError(existing);
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  // Totals across every call this generation makes, and the slowest single
  // call so far -- which is what the time budget projects the next repair
  // pass from, rather than a guessed constant that would be wrong on the
  // first slow day.
  const totals = { input: 0, output: 0 };
  let slowestCallMs = 0;
  const spend = (usage, ms) => {
    totals.input += usage?.input_tokens || 0;
    totals.output += usage?.output_tokens || 0;
    if (ms > slowestCallMs) slowestCallMs = ms;
  };

  console.log(`[SEO] generation started — keyword="${String(keyword).trim()}" model=${MODEL} effort=${EFFORT}`);

  const facts = await buildFactSheet();
  const factBlock = JSON.stringify(facts, null, 2);

  const brief = [
    `TARGET KEYWORD: ${keyword}`,
    service ? `SERVICE: ${service}` : null,
    location ? `LOCATION: ${location}` : null,
    notes ? `EDITOR NOTES: ${notes}` : null,
    '',
    'Work through this in order, then return the JSON object:',
    '1. Which keyword cluster does this belong to?',
    '2. What is the searcher actually trying to do — informational, commercial, transactional or navigational?',
    '3. What must this page answer for that person to stop searching?',
    `4. Write the page. At least ${MIN_WORDS} words of substance, 4-6 FAQs a real person would ask.`,
    '',
    'FACT SHEET — the complete set of things you know:',
    // Redacted: the writer is shown no fare figure at all, so it cannot
    // publish one. The checker below still receives the real sheet — it
    // needs true figures to judge everything else, and a price that arrives
    // anyway is stopped by the pricing gate rather than by the checker.
    JSON.stringify(redactPricing(facts), null, 2),
  ].filter(Boolean).join('\n');

  const { data: article, usage, ms: writerMs } = await callClaude({
    system: WRITER_SYSTEM,
    prompt: brief,
    schema: ARTICLE_SCHEMA,
  });
  spend(usage, writerMs);

  // ── Fact check, then bounded repair ─────────────────────────
  //
  //   generate -> check -> [repair -> check] x MAX_FACT_REPAIR_ATTEMPTS
  //
  // Only BLOCKING claims drive the loop. A phrasing note never stopped
  // approval, so spending a Claude call on one would be paying to change an
  // adjective. Those survive untouched into checks.unverifiedClaims for the
  // reviewer to read.
  //
  // The loop stops on the first clean check, on the attempt cap, or on the
  // time budget -- whichever comes first. It never stops by lowering the bar:
  // a draft still carrying blocking claims is saved as a draft with
  // checks.passed false, exactly as before, and seoController.js refuses to
  // approve it until a human has dealt with it.
  console.log('[SEO] fact-check attempt 1');
  let claims = await runFactCheck(article, factBlock, spend);
  let factCheckAttempts = 1;
  const repairs = [];
  let repairStoppedReason = null;

  while (claims.filter(isBlocking).length) {
    const claimsBefore = claims.filter(isBlocking).length;
    console.log(`[SEO] fact-check failed: ${claimsBefore} blocking claim(s) of ${claims.length} flagged`);

    if (repairs.length >= MAX_FACT_REPAIR_ATTEMPTS) {
      repairStoppedReason = 'max-attempts';
      console.log(`[SEO] repair cap reached (${MAX_FACT_REPAIR_ATTEMPTS}) — ${claimsBefore} blocking claim(s) remain, leaving for human review`);
      break;
    }

    // A repair pass costs a repair call plus another check. If that would run
    // past the budget, stop and save what we have: a draft the operator can
    // see beats a request the Studio abandoned.
    const projectedMs = slowestCallMs * 2;
    if (elapsed() + projectedMs > GENERATION_BUDGET_MS) {
      repairStoppedReason = 'time-budget';
      console.log(
        `[SEO] time budget reached at ${Math.round(elapsed() / 1000)}s `
        + `(projected +${Math.round(projectedMs / 1000)}s, budget ${Math.round(GENERATION_BUDGET_MS / 1000)}s) `
        + `— ${claimsBefore} blocking claim(s) remain, leaving for human review`,
      );
      break;
    }

    const attempt = repairs.length + 1;
    console.log(`[SEO] repair attempt ${attempt} — rewriting ${claimsBefore} blocking claim(s)`);
    // Only the blocking set is sent. Handing over phrasing notes as well
    // would invite the model to restyle prose nobody asked it to touch.
    const repairedFields = await repairClaims(article, claims.filter(isBlocking), factBlock, spend);

    factCheckAttempts += 1;
    console.log(`[SEO] fact-check attempt ${factCheckAttempts}`);
    claims = await runFactCheck(article, factBlock, spend);
    const claimsAfter = claims.filter(isBlocking).length;

    repairs.push({ attempt, claimsBefore, claimsAfter, repairedFields, at: new Date() });
    console.log(
      claimsAfter === 0
        ? `[SEO] repair successful — 0 blocking claims remain (touched: ${repairedFields.join(', ') || 'nothing'})`
        : `[SEO] repair partial — ${claimsAfter} blocking claim(s) remain (touched: ${repairedFields.join(', ') || 'nothing'})`,
    );
  }

  // ── Quality gate ────────────────────────────────────────────
  //
  // Every gate lives in evaluateGates() so POST /articles/:id/recheck can run
  // the identical rules over an edited article. Nothing is re-implemented
  // there: a gate added, tightened or removed changes in exactly one place,
  // and the two callers cannot drift into disagreeing about what "passed"
  // means.
  const gate = await evaluateGates(article, { facts, claims });
  const { slug, shingles, jsonLd, internalLinks, checks, passed, failedChecks } = gate;

  console.log(passed
    ? '[SEO] final quality gate: PASS'
    : `[SEO] final quality gate: FAIL — ${failedChecks.join('; ')}`);
  console.log(
    `[SEO] saved as status=draft — human approval required. `
    + `checks=${factCheckAttempts} repairs=${repairs.length} `
    + `elapsed=${Math.round(elapsed() / 1000)}s`,
  );

  let doc;
  try {
    doc = await SeoArticle.create({
    keyword: String(keyword).trim(),
    normalizedKeyword,
    cluster: article.cluster,
    searchIntent: article.searchIntent,
    location: location || null,
    service: service || null,
    // A duplicate slug still gets saved — suffixed — so the reviewer can
    // compare the two rather than losing the generation.
    slug: checks.duplicateSlug ? `${slug}-${Date.now().toString(36)}` : slug,
    title: article.title,
    metaDescription: article.metaDescription,
    h1: article.h1,
    content: article.content,
    faqs: article.faqs || [],
    internalLinks,
    jsonLd,
    status: 'draft',
    shingles,
    checks,
    generation: {
      model: MODEL,
      effort: EFFORT,
      factSheetHash: facts.hash,
      // Every call, not just the writer: a repaired draft costs up to five.
      inputTokens: totals.input,
      outputTokens: totals.output,
      generatedAt: new Date(),
      durationMs: elapsed(),
      factCheckAttempts,
      repairs,
      repairStoppedReason,
    },
    createdBy: user?._id,
    });
  } catch (err) {
    // 11000 is the unique index on normalizedKeyword. Two operators clicked
    // together, both pre-flight checks read "nothing there", and the database
    // is the only thing that can arbitrate. The loser gets the same answer
    // the pre-flight check would have given — the work is already paid for,
    // but a second row is not created.
    if (err?.code === 11000) {
      const winner = await SeoArticle.findOne({ normalizedKeyword })
        .select('_id slug title status keyword')
        .lean();
      console.log(`[SEO] duplicate keyword "${normalizedKeyword}" lost the race — returning existing ${winner?._id}`);
      if (winner) throw new DuplicateKeywordError(winner);
    }
    throw err;
  }

  return doc;
}

// JSON-LD assembled from the article itself, so schema can never describe
// something the page does not show. FAQPage only when there are visible FAQs.
function buildJsonLd(article, slug, facts) {
  const url = `${facts.business.website}/${slug}`;
  const blocks = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: article.h1,
      description: article.metaDescription,
      url,
      inLanguage: 'en-IN',
      publisher: { '@type': 'Organization', name: facts.business.name, url: facts.business.website },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: facts.business.website },
        { '@type': 'ListItem', position: 2, name: article.h1, item: url },
      ],
    },
  ];

  if (article.faqs?.length) {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: article.faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return blocks;
}

/**
 * Re-run every quality gate over an article a human has edited.
 *
 * The problem this solves: editing the body of an approved article demotes it
 * to in_review and sets checks.passed false, because the approval was granted
 * for text that no longer exists. Before this existed, nothing could ever set
 * checks.passed true again -- only generateDraft did -- so a single typo fix
 * locked an article out of approval permanently and the only way back was to
 * regenerate it and lose the edit.
 *
 * What it deliberately does NOT do:
 *   - It does not repair claims. The text is a person's edit; rewriting it
 *     under them would be a surprise, and the repair loop exists to fix a
 *     model's output, not a human's. Blocking claims come back as failures
 *     for the editor to deal with.
 *   - It does not approve. A clean recheck sets checks.passed true and leaves
 *     status at in_review; a human still has to press Approve. The gate says
 *     "this MAY be approved", never "this IS approved".
 *
 * Mutates and saves the document. Returns { passed, failedChecks, article }.
 */
async function recheckArticle(article) {
  const startedAt = Date.now();
  const totals = { input: 0, output: 0 };
  const spend = (usage) => {
    totals.input += usage?.input_tokens || 0;
    totals.output += usage?.output_tokens || 0;
  };

  console.log(`[SEO] recheck started — slug="${article.slug}" status=${article.status}`);

  const facts = await buildFactSheet();
  const factBlock = JSON.stringify(facts, null, 2);

  // The same independent checker, on the same clean context, over the edited
  // text. No repair pass: see the note above.
  const claims = await runFactCheck(article, factBlock, spend);
  console.log(`[SEO] recheck fact-check: ${claims.filter(isBlocking).length} blocking claim(s) of ${claims.length} flagged`);

  // excludeId is what stops the article colliding with itself on the
  // duplicate-slug and similarity gates.
  const gate = await evaluateGates(article, { facts, claims, excludeId: article._id });

  article.checks = gate.checks;
  article.jsonLd = gate.jsonLd;
  article.internalLinks = gate.internalLinks;
  article.shingles = gate.shingles;

  // Provenance is added to, never replaced: the original generation record is
  // how you find every other page produced the same way.
  article.generation = article.generation || {};
  article.generation.recheckedAt = new Date();
  article.generation.recheckResult = gate.passed ? 'passed' : 'failed';
  article.generation.failedChecks = gate.failedChecks;

  // Status is not touched. An edited article is already in_review, and a
  // clean recheck does not promote it -- that is a human's decision.
  await article.save();

  console.log(gate.passed
    ? `[SEO] recheck: PASS — checks.passed=true, status=${article.status} (Approve still required)`
    : `[SEO] recheck: FAIL — ${gate.failedChecks.join('; ')}`);
  console.log(`[SEO] recheck finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  return { passed: gate.passed, failedChecks: gate.failedChecks, article };
}

module.exports = {
  generateDraft, shingle, jaccard,
  SIMILARITY_BLOCK, MIN_WORDS,
  TITLE_MIN, TITLE_MAX, META_MIN, META_MAX,
  MAX_FACT_REPAIR_ATTEMPTS, GENERATION_BUDGET_MS,
  evaluateGates, recheckArticle,
  DuplicateKeywordError,
};
