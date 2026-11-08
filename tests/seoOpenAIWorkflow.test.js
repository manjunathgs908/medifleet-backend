/**
 * tests/seoOpenAIWorkflow.test.js
 * ============================================================
 * The whole SEO Studio workflow on the OpenAI provider (the default):
 *
 *   generate:  fact sheet -> writer -> fact check (flags a claim)
 *              -> automatic repair -> recheck (clean) -> DRAFT saved
 *   review:    a human edit adds an unsupported claim -> recheck fails
 *              -> manual approval is REFUSED while checks fail
 *   auto-repair: repair -> recheck passes -> status untouched
 *              (still needs a human)
 *   approve -> publish, through the real controller
 *
 * Every model call goes through the OpenAI SDK, replaced at the module
 * boundary (no network). The generator, auto-repair loop, gates and
 * controller are real; the database is replaced by spies on SeoArticle.
 * Also asserts the request each call sends: Responses API, model from
 * OPENAI_MODEL, rules in `instructions`, data in `input`, strict JSON schema.
 * ============================================================
 */
'use strict';

jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({
    business: { name: 'SaveLife Health Services', website: 'https://www.savelife.health' },
    livePages: [
      { href: '/dead-body-transport-bangalore', title: 'Dead Body Transport' },
      { href: '/ambulance-service-bangalore', title: 'Ambulance Service' },
      { href: '/contact', title: 'Contact' },
    ],
    hash: 'fact-hash-1',
  }),
}));
// No curated page covers the keyword, and the live-page index is empty and fresh.
jest.mock('../models/SeoLivePage', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
}));
jest.mock('../services/seoLivePages', () => ({
  refreshLivePageIndex: jest.fn(),
  loadLivePageIndex: jest.fn(async () => []),
  isIndexStale: jest.fn(async () => false),
}));

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn(() => ({ responses: { create: mockCreate } })));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockAnthropicCreate } })));

const SeoArticle = require('../models/SeoArticle');
const { generateDraft, recheckArticle } = require('../services/seoGenerator');
const { autoRepairArticle } = require('../services/seoAutoRepair');
const seoCtrl = require('../controllers/seoController');

// ── A believable article: 55-60 title, 150-160 meta, 700+ words, no prices ──
const TITLE = 'Dead Body Transport in Bengaluru: A Guide for Families Today';
const META = 'How dead body transport works in Bengaluru: what to arrange, which papers to keep ready, and how to book a mortuary van with SaveLife Health Services.';
const FAKE_CLAIM = 'Our team will reach you in 8 minutes anywhere in the city.';
const HUMAN_CLAIM = 'We are the number one hearse service in Bangalore.';

const SECTIONS = [
  ['What to do first', 'When someone dies at home, the first call is usually to a doctor who can confirm the death and issue the medical certificate. Keep that certificate with you, because the journey cannot begin without it. If the death happened in a hospital, the ward staff will explain how the body is released and which counter handles the paperwork.'],
  ['Papers to keep ready', 'Families are often asked for the medical certificate of cause of death, a photo identity document of the person who died, and the identity document of the relative arranging the journey. For travel to another state, ask the hospital or the local police station which additional letters they expect, since the requirement depends on where the journey ends.'],
  ['Choosing the right vehicle', 'A mortuary van carries the body on a stretcher with space for one or two relatives. A freezer box keeps the body cool when the family needs time before the funeral, for example while relatives travel from other cities. Tell the dispatcher how far the journey is and how long the wait might be, so the right option can be discussed honestly.'],
  ['Booking the journey', 'Call the dispatch line and share the pickup address, the destination, and the time the family would like to leave. The dispatcher will explain what is available and confirm the details before anything is booked. If plans change, call again rather than waiting, because an early message makes rearranging much easier for everyone involved.'],
  ['On the day', 'The crew will confirm the pickup with the family, check the papers, and help move the body carefully. Relatives can travel in the vehicle where space allows. If the route passes through busy roads, the crew may suggest a different time to leave, and the family is always free to decide what works best for them.'],
  ['Inter-city and inter-state travel', 'Longer journeys need a little more planning. Rest stops, the condition of the body, and the papers required at the destination all matter. Share the full route when you call, and ask the dispatcher to walk you through what to expect along the way so there are no surprises on the road.'],
  ['Religious and cultural needs', 'Many families have rituals that must happen before or during the journey. Mention them when booking so the crew can allow time for prayers, a stop at a place of worship, or a particular way of handling the body. The crew will follow the family wherever it is practical to do so.'],
  ['Questions families often ask', 'Families want to know how long the journey will take, whether a relative can ride along, and what happens if the papers are incomplete. The honest answer to the first question depends on traffic and distance, so the dispatcher will give an estimate on the call rather than a promise written on a web page.'],
  ['Getting help', 'If you are unsure what to do next, call and describe the situation. The person who answers will explain the options in plain language, tell you what they can and cannot arrange, and help you decide calmly. You do not need to have every document ready before you call; start the conversation and the rest can follow.'],
];
const BODY = SECTIONS.map(([h, p]) => `## ${h}\n\n${p} ${p}`).join('\n\n');
const CONTENT_WITH_CLAIM = `${BODY}\n\n${FAKE_CLAIM}`;

const writerReply = {
  cluster: 'dead-body-transport',
  searchIntent: 'transactional',
  slug: 'dead-body-transport-in-bengaluru-guide',
  title: TITLE,
  metaDescription: META,
  h1: 'Dead body transport in Bengaluru',
  content: CONTENT_WITH_CLAIM,
  faqs: [{ q: 'Can a relative travel in the van?', a: 'Usually one or two relatives can travel along; confirm when you call.' }],
  internalLinks: [
    { label: 'Dead body transport', href: '/dead-body-transport-bangalore', reason: 'Service page' },
    { label: 'Ambulance service', href: '/ambulance-service-bangalore', reason: 'Related service' },
    { label: 'Contact', href: '/contact', reason: 'To book' },
  ],
};

// What strict mode returns for a repair that touched only `content`: every
// optional field is present as null. Those nulls must never reach the article.
const repairReply = (content) => ({
  repairedFields: ['content'], content, title: null, metaDescription: null, h1: null, faqs: null,
});

const reply = (obj) => ({
  id: 'resp_test', status: 'completed', output_text: JSON.stringify(obj),
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
  usage: { input_tokens: 1000, output_tokens: 500 },
});

const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const setStatus = async (id, status) => {
  const res = mockRes();
  const next = jest.fn();
  await seoCtrl.setStatus({ params: { id }, body: { status }, user: { _id: '64b0000000000000000000a1' } }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

let draft; // the saved SeoArticle, carried through the workflow
const ENV = { ...process.env };

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'not-a-credential-the-sdk-is-mocked';
  process.env.OPENAI_MODEL = 'gpt-6-astra';
  delete process.env.SEO_AI_PROVIDER;
  delete process.env.SEO_OPENAI_MODEL;
  delete process.env.SEO_OPENAI_MAX_OUTPUT_TOKENS;
  jest.spyOn(console, 'log').mockImplementation(() => {});

  // The database, as the generator and controller use it.
  jest.spyOn(SeoArticle, 'findOne').mockReturnValue({ select: () => ({ lean: async () => null }) });
  jest.spyOn(SeoArticle, 'exists').mockResolvedValue(null);
  jest.spyOn(SeoArticle, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });
  jest.spyOn(SeoArticle, 'create').mockImplementation(async (data) => {
    draft = new SeoArticle(data);
    draft.save = jest.fn(async () => draft);
    return draft;
  });
  jest.spyOn(SeoArticle, 'findById').mockImplementation(async () => draft);
  jest.spyOn(SeoArticle, 'findOneAndUpdate').mockImplementation(async () => {
    draft.generation.autoRepair = { ...(draft.generation.autoRepair?.toObject?.() || {}), running: true };
    return draft;
  });
});
afterAll(() => { process.env = ENV; jest.restoreAllMocks(); });

test('1. generate: writer -> check flags a claim -> automatic repair -> recheck clean -> DRAFT saved', async () => {
  mockCreate
    .mockResolvedValueOnce(reply(writerReply))
    .mockResolvedValueOnce(reply({ unverifiedClaims: [{ claim: FAKE_CLAIM, severity: 'fabricated', action: 'remove' }] }))
    .mockResolvedValueOnce(reply(repairReply(BODY)))
    .mockResolvedValueOnce(reply({ unverifiedClaims: [] }));

  const out = await generateDraft({ keyword: 'Dead body transport in Bengaluru' }, { _id: '64b0000000000000000000a1' });

  expect(mockCreate).toHaveBeenCalledTimes(4);
  expect(mockAnthropicCreate).not.toHaveBeenCalled();
  expect(SeoArticle.create).toHaveBeenCalledTimes(1);
  expect(out).toBe(draft);

  // Saved as a draft that passed every gate -- never published by this.
  expect(draft.status).toBe('draft');
  expect(draft.checks.passed).toBe(true);
  expect(draft.checks.unverifiedClaims).toHaveLength(0);
  // The repair removed the claim and touched nothing else; its nulls were dropped.
  expect(draft.content).not.toContain(FAKE_CLAIM);
  expect(draft.title).toBe(TITLE);
  expect(draft.metaDescription).toBe(META);
  expect(draft.h1).toBe(writerReply.h1);
  expect(draft.faqs).toHaveLength(1);
  expect(draft.slug).toBe('dead-body-transport-in-bengaluru-guide');
  expect(draft.internalLinks.map((l) => l.href)).toEqual(writerReply.internalLinks.map((l) => l.href));
  expect(draft.jsonLd.length).toBeGreaterThanOrEqual(2);

  // Provenance says which API and model wrote it, and what it cost.
  expect(draft.generation.provider).toBe('openai');
  expect(draft.generation.model).toBe('gpt-6-astra');
  expect(draft.generation.effort).toBe('high');
  expect(draft.generation.factSheetHash).toBe('fact-hash-1');
  expect(draft.generation.inputTokens).toBe(4000);
  expect(draft.generation.outputTokens).toBe(2000);
  expect(draft.generation.repairs.length).toBeGreaterThanOrEqual(1);
});

test('2. every call is a Responses API request with the original prompts and a strict schema', () => {
  const calls = mockCreate.mock.calls.map((c) => c[0]);
  expect(calls.map((c) => c.text.format.name)).toEqual(['seo_article', 'seo_fact_check', 'seo_repair', 'seo_fact_check']);

  for (const c of calls) {
    expect(c.model).toBe('gpt-6-astra');
    expect(c.reasoning).toEqual({ effort: 'high' });
    expect(c.store).toBe(false);
    expect(c.text.format.type).toBe('json_schema');
    expect(c.text.format.strict).toBe(true);
    expect(typeof c.instructions).toBe('string');
    expect(typeof c.input).toBe('string');
    expect(c).not.toHaveProperty('messages'); // not the Anthropic shape
  }

  const [writer, check, repair] = calls;
  // The prompts are the existing ones: rules in instructions, data in input.
  expect(writer.instructions).toMatch(/You write SEO landing pages for SaveLife Health Services/);
  expect(writer.input).toMatch(/FACT SHEET/);
  expect(check.instructions).toMatch(/You are fact-checking a draft web page/);
  expect(check.input).toMatch(/ARTICLE:/);
  expect(repair.instructions).toMatch(/It has failed an independent fact check/);
  expect(repair.input).toContain(FAKE_CLAIM);

  // Output budgets: doubled from the old max_tokens because reasoning counts.
  expect(writer.max_output_tokens).toBe(32000);
  expect(check.max_output_tokens).toBe(16000);
  expect(repair.max_output_tokens).toBe(32000);

  // Strict mode: every property required, optional repair fields nullable.
  const rs = repair.text.format.schema;
  expect(rs.additionalProperties).toBe(false);
  expect(rs.required.sort()).toEqual(['content', 'faqs', 'h1', 'metaDescription', 'repairedFields', 'title']);
  expect(rs.properties.title.type).toEqual(['string', 'null']);
  expect(rs.properties.faqs.type).toEqual(['array', 'null']);
  expect(rs.properties.repairedFields.type).toBe('array');
  expect(rs.properties.faqs.items.required).toEqual(['q', 'a']);
  // The article schema was already fully required -- sent unchanged in shape.
  expect(writer.text.format.schema.required).toEqual(expect.arrayContaining(['title', 'content', 'internalLinks']));
});

test('3. a human edit that adds an unsupported claim fails recheck, and approval is refused', async () => {
  draft.content = `${draft.content}\n\n${HUMAN_CLAIM}`;
  draft.status = 'in_review';
  draft.checks.passed = false;

  mockCreate.mockResolvedValueOnce(reply({ unverifiedClaims: [{ claim: HUMAN_CLAIM, severity: 'fabricated', action: 'remove' }] }));
  const rc = await recheckArticle(draft);
  expect(rc.passed).toBe(false);
  expect(draft.checks.passed).toBe(false);
  expect(draft.generation.recheckResult).toBe('failed');

  const refused = await setStatus(String(draft._id), 'approved');
  expect(refused.statusCode).toBe(422);
  expect(refused.body.message).toMatch(/1 unverified claim/);
  expect(draft.status).toBe('in_review');
});

test('4. auto-repair: repair -> recheck passes; status is NOT promoted', async () => {
  mockCreate
    .mockResolvedValueOnce(reply(repairReply(draft.content.replace(`\n\n${HUMAN_CLAIM}`, ''))))
    .mockResolvedValueOnce(reply({ unverifiedClaims: [] }));

  const result = await autoRepairArticle(draft._id);
  expect(result.passed).toBe(true);
  expect(result.attempts).toBe(1);
  expect(draft.content).not.toContain(HUMAN_CLAIM);
  expect(draft.checks.passed).toBe(true);
  expect(draft.status).toBe('in_review'); // approval is still a person's decision
  expect(draft.generation.autoRepair.running).toBe(false);
  expect(draft.generation.autoRepair.phase).toBe('passed');
  expect(draft.corrections.length).toBeGreaterThanOrEqual(1);
});

test('5. manual approval, then publishing, through the controller', async () => {
  const approved = await setStatus(String(draft._id), 'approved');
  expect(approved.statusCode).toBe(200);
  expect(draft.status).toBe('approved');
  expect(String(draft.reviewedBy)).toBe('64b0000000000000000000a1');

  const published = await setStatus(String(draft._id), 'published');
  expect(published.statusCode).toBe(200);
  expect(draft.status).toBe('published');
  expect(draft.publishedAt).toBeInstanceOf(Date);

  // The whole run: 4 generation calls + 1 recheck + 2 auto-repair, all OpenAI.
  expect(mockCreate).toHaveBeenCalledTimes(7);
  expect(mockAnthropicCreate).not.toHaveBeenCalled();
});

test('6. SEO_AI_PROVIDER=anthropic sends the same recheck to Claude instead (rollback switch)', async () => {
  process.env.SEO_AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
  mockAnthropicCreate.mockResolvedValueOnce({
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: JSON.stringify({ unverifiedClaims: [] }) }],
  });
  const before = mockCreate.mock.calls.length;
  try {
    const rc = await recheckArticle(draft);
    expect(rc.passed).toBe(true);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate.mock.calls[0][0].model).toBe(process.env.SEO_CLAUDE_MODEL || 'claude-opus-5');
    expect(mockCreate.mock.calls.length).toBe(before);
  } finally {
    delete process.env.SEO_AI_PROVIDER;
  }
});
