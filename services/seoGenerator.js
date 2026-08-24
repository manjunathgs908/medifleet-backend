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
const { buildFactSheet } = require('./seoFacts');

// Never hard-coded. An unset key is a configuration answer, not a crash.
const MODEL = process.env.SEO_CLAUDE_MODEL || 'claude-opus-5';
const EFFORT = process.env.SEO_CLAUDE_EFFORT || 'high';

// Below this a "unique" page is really a reworded one. Tunable without a
// deploy because the right threshold depends on how close the keyword set is.
const SIMILARITY_BLOCK = Number(process.env.SEO_SIMILARITY_THRESHOLD || 0.55);
const MIN_WORDS = Number(process.env.SEO_MIN_WORDS || 700);

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
    title: { type: 'string', description: 'SEO title, under 60 characters where possible.' },
    metaDescription: { type: 'string', description: 'Meta description, 140-160 characters.' },
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
      description: 'Every sentence or phrase asserting something the fact sheet does not establish. Quote it verbatim. Empty array if the text is clean.',
      items: { type: 'string' },
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

internalLinks: choose 3-6 from the LIVE PAGES list only. Never invent a URL. Each needs a real reason a reader on this page would want that page.`;

const CHECKER_SYSTEM = `You are fact-checking a draft web page for an ambulance and death-care business before a human reviews it.

You are given a FACT SHEET and an ARTICLE. Your only job is to list every claim in the article that the fact sheet does not establish.

Flag: any price, rate or discount not in the sheet; any response or arrival time; fleet size or coverage counts; years of experience; reviews, ratings or testimonials; hospital or crematorium names; partnerships; medical, legal or statutory assertions; licences or certifications; superiority claims; statistics; any service or city not listed.

Do not flag ordinary prose, hedged invitations to call, or descriptions of a service that IS in the sheet. Quote each flagged phrase verbatim so a human can find it. If the article is clean, return an empty array.`;

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
  const existing = await SeoArticle.find({}, 'slug title').select('+shingles').lean();
  let similarityScore = 0;
  let similarTo = null;
  for (const other of existing) {
    const score = jaccard(shingles, other.shingles || []);
    if (score > similarityScore) { similarityScore = score; similarTo = other._id; }
  }

  // Links must point at pages that exist. A plausible-looking URL that 404s
  // is worse than no link.
  const liveHrefs = new Set(facts.livePages.map((p) => p.href));
  const internalLinks = (article.internalLinks || []).filter((l) => liveHrefs.has(l.href));

  const wordCount = normalise(article.content).split(' ').filter(Boolean).length;
  const unverifiedClaims = check.unverifiedClaims || [];

  const passed =
    unverifiedClaims.length === 0 &&
    !duplicateSlug &&
    similarityScore < SIMILARITY_BLOCK &&
    wordCount >= MIN_WORDS &&
    internalLinks.length >= 2;

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
    schema: buildSchema(article, slug, facts),
    status: 'draft',
    shingles,
    checks: { similarityScore, similarTo, duplicateSlug, unverifiedClaims, wordCount, passed },
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
function buildSchema(article, slug, facts) {
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

module.exports = { generateDraft, shingle, jaccard, SIMILARITY_BLOCK, MIN_WORDS };
