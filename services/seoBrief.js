/**
 * services/seoBrief.js
 * ============================================================
 * The content brief: what this article is supposed to accomplish, decided
 * before the writer is asked to write it.
 *
 * DETERMINISTIC. No Claude call, no second workflow. Everything here is
 * derived from what the request and the fact sheet already contain — the
 * keyword, the service, the location, the verified business facts and the live
 * page list. Two identical requests produce an identical brief, which is what
 * makes it reviewable: an operator reading it is reading a decision, not a
 * model's improvisation about what the page ought to be.
 *
 * WHY A BRIEF AT ALL
 *
 * The writer used to receive four lines — keyword, "work through this in
 * order", a word floor and a FAQ count — and invent everything else: the H1,
 * the section structure, which secondary phrases to target, what expertise to
 * signal. Those are editorial decisions, and a reviewer had no way to see what
 * had been decided or to disagree with it before the article existed.
 *
 * E-E-A-T WITHOUT INVENTION
 *
 * This is the part that most easily goes wrong. Experience, expertise,
 * authority and trust are usually signalled with exactly the claims this
 * business cannot make: years in operation, fleet size, certifications,
 * hospital tie-ups, response times, awards. So the E-E-A-T section is built
 * from two sources and nothing else:
 *
 *   - facts.business — only the fields actually present. A missing field
 *     produces no requirement rather than a placeholder to fill in.
 *   - facts.forbidden — restated as explicit "do not assert" instructions, so
 *     the writer is told what NOT to reach for when asked to sound credible.
 *
 * Nothing here asserts a fact. It tells the writer which verified facts it may
 * lean on, and names the temptations it must refuse.
 * ============================================================
 */
'use strict';

const { APPROVED_FARE_WORDING } = require('./seoPricingGuard');
const { NO_EXACT_PRICING_RULE } = require('./seoContentPolicy');

/**
 * Search intent, decided by what the searcher's words reveal about the job
 * they are trying to finish. Ordered: the first match wins, and transactional
 * beats commercial because "book an ambulance now" is not price research.
 */
const INTENT_RULES = [
  { intent: 'transactional', re: /\b(book|booking|hire|order|call|near me|now|24x7|24\/7|emergency|urgent|online)\b/i },
  { intent: 'commercial', re: /\b(cost|price|charges?|rate|fee|cheap|compare|best|top|vs)\b/i },
  { intent: 'informational', re: /\b(what|why|how|when|guide|procedure|process|difference|meaning)\b/i },
  { intent: 'navigational', re: /\b(savelife|save life)\b/i },
];

function classifyIntent(keyword) {
  for (const rule of INTENT_RULES) if (rule.re.test(keyword)) return rule.intent;
  // An unqualified "<service> <place>" query is someone looking to arrange the
  // thing, not to read about it.
  return 'transactional';
}

const titleCase = (s) => String(s || '')
  .split(/\s+/)
  .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
  .join(' ')
  .trim();

/**
 * The keyword cluster. Prefers the operator's explicit `service`, then a
 * recognised topic in the keyword, then the location. Never invented.
 */
const CLUSTER_RULES = [
  { cluster: 'freezer-box', re: /\bfreezer\b/i },
  { cluster: 'dead-body-transport', re: /\b(dead body|body shifting|mortuary|funeral|antim|hearse)\b/i },
  { cluster: 'advanced-life-support', re: /\b(als|acls|icu|ventilator|cardiac|critical)\b/i },
  { cluster: 'neonatal', re: /\b(nicu|neonatal|newborn|infant)\b/i },
  { cluster: 'basic-life-support', re: /\bbls\b/i },
  { cluster: 'air-ambulance', re: /\bair ambulance\b/i },
  { cluster: 'train-ambulance', re: /\btrain ambulance\b/i },
  { cluster: 'patient-transfer', re: /\b(transfer|discharge|dialysis|hospital)\b/i },
];

function classifyCluster(keyword, service, location) {
  if (service) return String(service).toLowerCase().trim().replace(/\s+/g, '-');
  for (const rule of CLUSTER_RULES) if (rule.re.test(keyword)) return rule.cluster;
  if (location) return `${String(location).toLowerCase().trim().replace(/\s+/g, '-')}-areas`;
  return 'ambulance-general';
}

/**
 * Secondary keywords: the phrasings a real searcher uses for the same job.
 *
 * Built by recombining words the request already contains — the city's two
 * common spellings, "service"/"ambulance" where absent, and the location on
 * its own. Nothing is pulled from outside the request, so no new topic is
 * smuggled in as a "related" term.
 */
function secondaryKeywords(keyword, service, location) {
  const k = String(keyword).toLowerCase().trim();
  const out = new Set();
  const add = (s) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); if (v && v !== k) out.add(v); };

  // Bengaluru and Bangalore are the same city and both are searched.
  if (/\bbangalore\b/i.test(k)) add(k.replace(/\bbangalore\b/gi, 'bengaluru'));
  if (/\bbengaluru\b/i.test(k)) add(k.replace(/\bbengaluru\b/gi, 'bangalore'));

  if (!/\bservice\b/i.test(k)) add(`${k} service`);
  if (!/\bnear me\b/i.test(k)) add(`${k} near me`);
  if (location && !k.includes(String(location).toLowerCase())) add(`${k} ${location}`);
  if (location) add(`ambulance ${location}`.toLowerCase());

  return [...out].slice(0, 6);
}

/**
 * The section outline.
 *
 * A spine every page of this kind needs, plus sections chosen by intent and
 * cluster. Each heading carries a `purpose`, so a reviewer can see what the
 * section is FOR and tell whether the finished article did it.
 */
function buildOutline({ keyword, location, cluster, intent }) {
  const place = location ? titleCase(location) : 'Bengaluru';
  const outline = [
    { level: 'H2', heading: `What to tell dispatch when you call`, purpose: 'Get the reader to a useful call fast: what to say, in what order, so the right vehicle is sent to the right door.' },
    { level: 'H2', heading: `Which vehicle suits this trip`, purpose: 'Explain the choice between the verified service types in plain terms, without recommending clinically.' },
  ];

  if (cluster === 'freezer-box' || cluster === 'dead-body-transport') {
    outline.push({ level: 'H2', heading: 'How the arrangement works', purpose: 'Describe the practical steps the family goes through, using only what the fact sheet establishes.' });
    outline.push({ level: 'H3', heading: 'Access, floors and lifts', purpose: 'Cover the physical constraints that change the job, since these decide what is possible.' });
  } else {
    outline.push({ level: 'H2', heading: `Getting to and from ${place}`, purpose: 'Ground the page in the actual locality — landmarks and access, not invented coverage claims.' });
  }

  outline.push({ level: 'H2', heading: 'How the fare is worked out', purpose: `Explain the METHOD only — vehicle, road distance, timing, trip requirements. No figure of any kind. Use: "${APPROVED_FARE_WORDING}"` });

  if (intent === 'commercial') {
    outline.push({ level: 'H3', heading: 'What changes the cost', purpose: 'Name the variables a price-comparing reader is actually asking about, still without quoting any amount.' });
  }

  outline.push({ level: 'H2', heading: 'What we do not do', purpose: 'State the limits plainly. A page that admits a boundary is more credible than one that does not, and it prevents an unsupported implied claim.' });
  outline.push({ level: 'H2', heading: 'Frequently asked questions', purpose: 'Answer the questions a real caller asks, each answerable from the fact sheet.' });
  return outline;
}

/** FAQ topics — the questions this intent actually produces. */
function buildFaqTopics({ cluster, intent, location }) {
  const place = location ? titleCase(location) : 'Bengaluru';
  const topics = [
    `How quickly can a vehicle reach ${place}? (answer honestly: no time promise, explain what decides it)`,
    'What does this cost? (method only — no figure, no range, no minimum)',
    'Which vehicle do I need? (describe the verified options, do not advise clinically)',
  ];
  if (cluster === 'freezer-box' || cluster === 'dead-body-transport') {
    topics.push('How long can the arrangement be kept in place? (only what the fact sheet supports)');
    topics.push('Can it be handled on an upper floor without a lift?');
  } else {
    topics.push('Can someone travel with the patient?');
    topics.push('Can I book in advance rather than for right now?');
  }
  if (intent === 'transactional') topics.push('How do I book — call, WhatsApp or online?');
  return topics.slice(0, 6);
}

/**
 * E-E-A-T requirements, built only from verified facts.
 *
 * Each entry either points at a fact the sheet actually carries, or forbids a
 * credibility signal this business cannot support. Nothing is asserted here.
 */
function buildEeat(facts) {
  const b = facts?.business || {};
  const req = [];

  // Experience / trust signals that ARE verified — included only when present.
  if (b.name) req.push(`Write as ${b.name}. Use the business's own name, never a generic "we are a leading provider".`);
  if (b.city) req.push(`Operating city is ${b.city}. Anything outside it is "arranged on request", never an established route or a covered city.`);
  if (b.availability) req.push(`Availability may be stated exactly as: ${b.availability}. Do not upgrade this into a response-time promise.`);
  if (b.callNumber || b.whatsappNumber) {
    req.push(`Give the reader a real way to act: ${[b.callNumber && `call ${b.callNumber}`, b.whatsappNumber && `WhatsApp ${b.whatsappNumber}`].filter(Boolean).join(', ')}.`);
  }
  if (b.address) req.push(`A verifiable business address exists (${b.address}) and may be referenced. Do not invent branches or additional locations.`);

  // Trust comes from candour here, not from credentials.
  req.push('Signal expertise by being specific and operationally accurate — what to say on the call, what changes the job, what the limits are. Specificity is the credibility signal available to this page.');
  req.push('State at least one thing the business does NOT do. A page that admits a limit is more trustworthy than one that claims everything.');

  // The forbidden list, restated as E-E-A-T guidance, because these are
  // precisely the shortcuts a model reaches for when told to sound credible.
  req.push('Do NOT manufacture authority. Specifically: no years in business, no founding date, no experience claim, no fleet or vehicle counts, no staff or crew counts, no doctors or nurses on staff, no certifications, licences, accreditations or ISO numbers, no awards or rankings, no hospital or crematorium partnerships, no reviews, ratings or testimonials, no patient numbers, no statistics or percentages, and no comparative superiority of any kind.');
  req.push('If a credential or capability is not in the fact sheet, it does not exist for the purposes of this page. Say what the reader should do instead of asserting something unverifiable.');

  return req;
}

/** Internal-link requirements, from the live page list the generator already has. */
function buildInternalLinkRequirements(facts) {
  const pages = facts?.livePages || [];
  return [
    `Choose 3-6 internal links, every one of them from the ${pages.length} pages in the LIVE PAGES list. Never invent a URL.`,
    'Each link needs a real reason a reader on THIS page would want that page. A link with no reason is removed by the gate.',
    'At least 2 valid internal links must survive validation or the article cannot be approved.',
  ];
}

/** Verification requirements — the fact-check contract, stated up front. */
function buildVerificationRequirements() {
  return [
    'The FACT SHEET is the complete set of things you know. If a fact is not in it, that fact does not exist and must not be written — not as a hedge, not as an example, not as "typically".',
    'Every claim in the finished article is checked by an independent pass against the same sheet. Anything it cannot establish is flagged as fabricated or unsupported and blocks approval.',
    'Where a reader would expect a figure or a guarantee you do not have, say plainly what they should do and why — an honest instruction beats a confident sentence you cannot support.',
    'No response time, arrival time or ETA of any kind, in any wording.',
  ];
}

/**
 * Build the brief. Pure and synchronous: everything it needs is already
 * resolved by the caller.
 *
 * @param {object} input  { keyword, service, location, notes, facts, minWords }
 * @returns {object} the brief
 */
function buildContentBrief({ keyword, service, location, notes, facts = {}, minWords = 700 }) {
  const primaryKeyword = String(keyword || '').trim();
  const searchIntent = classifyIntent(primaryKeyword);
  const keywordCluster = classifyCluster(primaryKeyword, service, location);

  return {
    primaryKeyword,
    searchIntent,
    keywordCluster,
    recommendedH1: titleCase(primaryKeyword),
    outline: buildOutline({ keyword: primaryKeyword, location, cluster: keywordCluster, intent: searchIntent }),
    secondaryKeywords: secondaryKeywords(primaryKeyword, service, location),
    // A floor, not a target: the gate rejects anything under it, and padding
    // to a number is how unsupported sentences get written.
    targetWordCount: minWords,
    faqTopics: buildFaqTopics({ cluster: keywordCluster, intent: searchIntent, location }),
    eeatRequirements: buildEeat(facts),
    internalLinkRequirements: buildInternalLinkRequirements(facts),
    verificationRequirements: buildVerificationRequirements(),
    pricingPolicy: NO_EXACT_PRICING_RULE,
    editorNotes: notes ? String(notes).trim() : null,
  };
}

/** The brief as the writer receives it. */
function renderBriefForPrompt(brief) {
  const line = (label, value) => `${label}: ${value}`;
  const bullets = (items) => (items || []).map((i) => `- ${i}`).join('\n');

  return [
    'CONTENT BRIEF — this is what the page must accomplish. Follow it.',
    '',
    line('PRIMARY KEYWORD', brief.primaryKeyword),
    line('SEARCH INTENT', brief.searchIntent),
    line('KEYWORD CLUSTER', brief.keywordCluster),
    line('RECOMMENDED H1', brief.recommendedH1),
    line('TARGET WORD COUNT', `at least ${brief.targetWordCount} words of substance`),
    brief.editorNotes ? line('EDITOR NOTES', brief.editorNotes) : null,
    '',
    'SECONDARY KEYWORDS — work these in only where they read naturally. Never repeat one to hit a density:',
    bullets(brief.secondaryKeywords),
    '',
    'OUTLINE — use these as your ## sections, in this order. Adapt the wording, keep the purpose:',
    (brief.outline || []).map((s) => `- [${s.level}] ${s.heading}\n    purpose: ${s.purpose}`).join('\n'),
    '',
    'FAQ PLAN — 4-6 FAQs covering these, phrased as a real person would ask:',
    bullets(brief.faqTopics),
    '',
    'E-E-A-T REQUIREMENTS:',
    bullets(brief.eeatRequirements),
    '',
    'INTERNAL LINKS:',
    bullets(brief.internalLinkRequirements),
    '',
    'VERIFICATION:',
    bullets(brief.verificationRequirements),
    '',
    brief.pricingPolicy,
  ].filter((x) => x !== null).join('\n');
}

module.exports = {
  buildContentBrief,
  renderBriefForPrompt,
  classifyIntent,
  classifyCluster,
  secondaryKeywords,
};
