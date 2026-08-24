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
 * Nothing here publishes. The output is always status:'draft'.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const { validateJsonLd } = require('./seoSchemaValidator');
const { refreshLivePageIndex, loadLivePageIndex, isIndexStale } = require('./seoLivePages');
const { buildFactSheet } = require('./seoFacts');

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

async function callClaude({ system, prompt, schema, maxTokens = 16000 }) {
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
  return { data: JSON.parse(text), usage: res.usage };
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
    factBlock,
  ].filter(Boolean).join('\n');

  const { data: article, usage } = await callClaude({
    system: WRITER_SYSTEM,
    prompt: brief,
    schema: ARTICLE_SCHEMA,
  });

  // ── Fact check, on a clean context ──────────────────────────
  const { data: check } = await callClaude({
    system: CHECKER_SYSTEM,
    prompt: `FACT SHEET:\n${factBlock}\n\nARTICLE:\n${JSON.stringify(
      { title: article.title, metaDescription: article.metaDescription, h1: article.h1, content: article.content, faqs: article.faqs },
      null, 2,
    )}`,
    schema: CHECK_SCHEMA,
    maxTokens: 8000,
  });

  // ── Mechanical checks ───────────────────────────────────────
  const slug = String(article.slug || '').toLowerCase().replace(/^\/+/, '').trim();
  const duplicateSlug = Boolean(await SeoArticle.exists({ slug }));

  const shingles = shingle(`${article.h1} ${article.content}`);
  const existing = await SeoArticle.find({}, 'slug title status searchIntent cluster').select('+shingles').lean();
  let similarityScore = 0;
  let similarTo = null;
  for (const other of existing) {
    const score = jaccard(shingles, other.shingles || []);
    if (score > similarityScore) { similarityScore = score; similarTo = other._id; }
  }

  // ── Against the pages that already rank ─────────────────────
  //
  // The similarity gate above only ever compared drafts to other drafts. The
  // curated pages on savelife.health were invisible to it, so an article
  // reworded from the live Whitefield page passed cleanly -- and publishing it
  // would have put the two into competition for the same query, costing the
  // ranking the site already had. Those pages are protected canonical
  // content; nothing generated may duplicate one.
  //
  // Same fingerprint and the same SIMILARITY_BLOCK as the draft comparison.
  // Two thresholds for one question would mean one of them was wrong.
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
  //
  // Two pages can be worded quite differently and still compete: same cluster,
  // same search intent, same job. Body similarity does not catch that, and no
  // threshold in this project describes it, so this is recorded and shown to
  // the reviewer rather than blocking. Deliberately a plain equality test --
  // inventing a cutoff for "too close in intent" would be a number nobody
  // chose. See docs in the Phase 2 report: the blocking rule is a decision
  // the business has to make, not one the code should assume.
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

  // Links must point at pages that exist. A plausible-looking URL that 404s
  // is worse than no link. Rejects are recorded rather than dropped: a draft
  // that quietly lost three of four links looks like a model that only found
  // one, which sends the reviewer looking in the wrong place.
  const liveHrefs = new Set(facts.livePages.map((p) => p.href));
  const proposedLinks = article.internalLinks || [];
  const internalLinks = proposedLinks.filter((l) => liveHrefs.has(l.href));
  const droppedLinks = proposedLinks
    .filter((l) => !liveHrefs.has(l.href))
    .map((l) => ({ label: l.label, href: l.href, reason: l.reason }));

  const wordCount = normalise(article.content).split(' ').filter(Boolean).length;

  // Length is mechanical, not a matter of judgement, and these are the two
  // fields that silently truncate in search results. Checked here rather than
  // trusted to the writer prompt, because prose guidance does not hold.
  const titleLength = String(article.title || '').length;
  const metaLength = String(article.metaDescription || '').length;
  const titleOk = titleLength >= TITLE_MIN && titleLength <= TITLE_MAX;
  const metaOk = metaLength >= META_MIN && metaLength <= META_MAX;

  // Severity decides what blocks. Anything fabricated or unsupported stops
  // approval; a phrasing note is advisory, because blocking on an adjective
  // teaches reviewers to wave failures through — which costs more than the
  // adjective ever would. A claim with no severity (a legacy row, or a model
  // that omitted it) is treated as unsupported, the conservative reading.
  const unverifiedClaims = (check.unverifiedClaims || []).map((c) =>
    typeof c === 'string'
      ? { claim: c, severity: 'unsupported', action: 'rewrite' }
      : { claim: c.claim, severity: c.severity || 'unsupported', action: c.action || 'rewrite' },
  );
  const blockingClaims = unverifiedClaims.filter((c) => c.severity !== 'phrasing');

  // Structured data is checked here, where the article is assembled, rather
  // than only at render time. The renderer still drops invalid nodes -- that
  // stays the last line of defence -- but a reviewer must not be able to
  // approve a page whose schema was never going to work.
  const jsonLd = buildJsonLd(article, slug, facts);
  const schemaErrors = validateJsonLd(jsonLd);

  const passed =
    blockingClaims.length === 0 &&
    !duplicateSlug &&
    similarityScore < SIMILARITY_BLOCK &&
    livePageSimilarity < SIMILARITY_BLOCK &&
    schemaErrors.length === 0 &&
    wordCount >= MIN_WORDS &&
    internalLinks.length >= 2 &&
    titleOk &&
    metaOk;

  const doc = await SeoArticle.create({
    keyword: String(keyword).trim(),
    cluster: article.cluster,
    searchIntent: article.searchIntent,
    location: location || null,
    service: service || null,
    // A duplicate slug still gets saved — suffixed — so the reviewer can
    // compare the two rather than losing the generation.
    slug: duplicateSlug ? `${slug}-${Date.now().toString(36)}` : slug,
    title: article.title,
    metaDescription: article.metaDescription,
    h1: article.h1,
    content: article.content,
    faqs: article.faqs || [],
    internalLinks,
    jsonLd,
    status: 'draft',
    shingles,
    checks: {
      similarityScore, similarTo, duplicateSlug,
      livePageSimilarity, similarToLivePage, livePagesIndexed,
      intentCollisions,
      schemaErrors,
      unverifiedClaims, droppedLinks,
      titleLength, metaLength,
      wordCount, passed,
    },
    generation: {
      model: MODEL,
      effort: EFFORT,
      factSheetHash: facts.hash,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      generatedAt: new Date(),
    },
    createdBy: user?._id,
  });

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

module.exports = {
  generateDraft, shingle, jaccard,
  SIMILARITY_BLOCK, MIN_WORDS,
  TITLE_MIN, TITLE_MAX, META_MIN, META_MAX,
};
