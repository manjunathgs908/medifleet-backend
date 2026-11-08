/**
 * tests/seoApiFailure.test.js
 * ============================================================
 * What the operator is told when the failure is the AI provider's, not the
 * article's.
 *
 * An exhausted balance, an expired key and a rate limit are three different
 * problems with three different answers, and none of them is "look at your
 * draft". The property under test is that each keeps its own status and the
 * API's own wording all the way out to the caller — and that a call which
 * failed wrote nothing to the article on its way.
 *
 * OpenAI is the default provider; the Anthropic mapping is kept for the
 * SEO_AI_PROVIDER=anthropic rollback and tested in section C.
 *
 * Both SDKs are replaced at the module boundary, so no request can leave this
 * process even if a key happens to be in the environment. The generator
 * itself is real: callModel's error handling is the thing being tested.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../services/seoFacts', () => ({
  buildFactSheet: jest.fn().mockResolvedValue({
    business: { website: 'https://www.savelife.health' },
    livePages: [],
    hash: 'h',
  }),
}));

// The names must start with "mock": jest hoists jest.mock() above the file and
// only mock-prefixed bindings may be referenced from inside the factory.
const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn(() => ({ responses: { create: mockCreate } })));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockAnthropicCreate } })));

const SeoArticle = require('../models/SeoArticle');
const { toClaudeApiError, ClaudeApiError, repairArticle } = require('../services/seoGenerator');

beforeEach(() => {
  // getOpenAIClient() throws without this. The value never reaches a network
  // call, because the transport above is a stub.
  process.env.OPENAI_API_KEY = 'not-a-credential-the-sdk-is-mocked';
  delete process.env.SEO_AI_PROVIDER;
});
afterEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SEO_AI_PROVIDER;
});

// How the OpenAI SDK reports things (APIError: status, code, type, error).
const apiErr = (status, { code, type, message } = {}) => Object.assign(new Error(`${status} ${message || ''}`), {
  status, code, type, error: { message: message || `status ${status}`, type, code },
});
/** Out of credit: a 429, told apart from a rate limit only by its code. */
const quotaError = () => apiErr(429, {
  code: 'insufficient_quota', type: 'insufficient_quota',
  message: 'You exceeded your current quota, please check your plan and billing details.',
});

// ============================================================
describe('A. every OpenAI failure maps to something the operator can act on', () => {
  // Object rows, not arrays: with positional %s the Error itself lands in the
  // test name and prints a stack trace where the label should be.
  test.each([
    { label: 'out of credit (429 insufficient_quota)', err: quotaError(), code: 'billing', status: 402 },
    { label: 'bad key', err: apiErr(401, { code: 'invalid_api_key', message: 'Incorrect API key provided' }), code: 'auth', status: 401 },
    { label: 'model not available', err: apiErr(404, { code: 'model_not_found', message: 'The model does not exist' }), code: 'auth', status: 401 },
    { label: 'rate limit', err: apiErr(429, { code: 'rate_limit_exceeded', message: 'Rate limit reached' }), code: 'rate_limit', status: 429 },
    { label: 'overloaded', err: apiErr(503, { message: 'The server is overloaded' }), code: 'overloaded', status: 503 },
    { label: 'upstream 500', err: apiErr(500), code: 'upstream', status: 503 },
    { label: 'no status at all', err: new Error('Connection error.'), code: 'upstream', status: 503 },
  ])('$label -> code $code, status $status', ({ err, code, status }) => {
    const mapped = toClaudeApiError(err);
    expect(mapped).toBeInstanceOf(ClaudeApiError);
    expect(mapped.name).toBe('ClaudeApiError'); // what the controller and auto-repair match on
    expect(mapped.code).toBe(code);
    expect(mapped.status).toBe(status);
    expect(mapped.message).toMatch(/OpenAI/);
    expect(mapped.message.length).toBeGreaterThan(20);
  });

  test('out of credit is NOT reported as "wait a minute"', () => {
    const m = toClaudeApiError(quotaError());
    expect(m.code).toBe('billing');
    expect(m.retryable).toBe(false);
    expect(m.message).toMatch(/exceeded your current quota/);
    expect(m.message).toMatch(/platform\.openai\.com\/settings\/organization\/billing/);
    expect(m.message).toMatch(/[Nn]othing was written/);
  });

  test('a bad key names OPENAI_API_KEY; a refused model names OPENAI_MODEL and the model', () => {
    process.env.OPENAI_MODEL = 'gpt-6-astra';
    expect(toClaudeApiError(apiErr(401)).message).toMatch(/OPENAI_API_KEY/);
    const m = toClaudeApiError(apiErr(404, { code: 'model_not_found' })).message;
    expect(m).toMatch(/OPENAI_MODEL/);
    expect(m).toMatch(/gpt-6-astra/);
    delete process.env.OPENAI_MODEL;
  });

  test('a transient failure is marked retryable and a billing stop is not', () => {
    expect(toClaudeApiError(apiErr(429)).retryable).toBe(true);
    expect(toClaudeApiError(apiErr(503)).retryable).toBe(true);
    expect(toClaudeApiError(quotaError()).retryable).toBe(false);
  });

  test('no mapped message can leak a key, a header or the request body', () => {
    const nasty = Object.assign(apiErr(400, { message: 'bad request' }), {
      headers: { authorization: 'Bearer sk-proj-SHOULD-NEVER-APPEAR' },
      request: { headers: { authorization: 'Bearer sk-proj-SHOULD-NEVER-APPEAR' } },
    });
    const m = toClaudeApiError(nasty).message;
    expect(m).not.toMatch(/sk-proj/);
    expect(m).not.toMatch(/authorization|bearer/i);
  });

  test('re-mapping a mapped error keeps it a billing stop', () => {
    const twice = toClaudeApiError(toClaudeApiError(quotaError()));
    expect(twice.code).toBe('billing');
    expect(twice.status).toBe(402);
  });
});

// ============================================================
const hydrate = () => {
  const doc = SeoArticle.hydrate({
    _id: new mongoose.Types.ObjectId(),
    keyword: 'k', slug: 's', title: 'y'.repeat(57), metaDescription: 'x'.repeat(154),
    h1: 'h', content: 'The original text, which must survive a failed call.',
    faqs: [], internalLinks: [], status: 'draft', corrections: [],
    checks: { passed: false, metaLength: 154, unverifiedClaims: [{ claim: 'c', severity: 'unsupported', action: 'rewrite' }] },
  });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
};

describe('B. the failure reaches the caller through callModel (OpenAI)', () => {
  test('a repair against an exhausted quota throws ClaudeApiError, not a raw SDK error', async () => {
    mockCreate.mockRejectedValue(quotaError());
    await expect(repairArticle(hydrate())).rejects.toMatchObject({
      name: 'ClaudeApiError', code: 'billing', status: 402,
    });
  });

  test('the article is untouched and unsaved when the call fails', async () => {
    mockCreate.mockRejectedValue(quotaError());
    const doc = hydrate();
    const before = doc.content;

    await expect(repairArticle(doc)).rejects.toThrow();

    // The whole point of the "nothing was written" promise in the message.
    expect(doc.content).toBe(before);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.corrections).toHaveLength(0);
    expect(doc.status).toBe('draft');
    expect(doc.checks.passed).toBe(false);
  });

  test('a failed call never sets checks.passed', async () => {
    mockCreate.mockRejectedValue(apiErr(429, { code: 'rate_limit_exceeded' }));
    const doc = hydrate();
    await expect(repairArticle(doc)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(doc.checks.passed).toBe(false);
  });

  test('a reply cut off at the output limit is a retryable stop, and writes nothing', async () => {
    mockCreate.mockResolvedValue({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"repairedF' });
    const doc = hydrate();
    await expect(repairArticle(doc)).rejects.toMatchObject({ name: 'ClaudeApiError', code: 'upstream', retryable: true });
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a refusal says "declined this request" (the controller\'s 503 wording) and writes nothing', async () => {
    mockCreate.mockResolvedValue({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I can\'t help with that.' }] }],
      output_text: '',
    });
    const doc = hydrate();
    await expect(repairArticle(doc)).rejects.toThrow(/OpenAI declined this request/);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a missing OPENAI_API_KEY is a clear configuration answer, and no call is made', async () => {
    jest.resetModules();
    delete process.env.OPENAI_API_KEY;
    // eslint-disable-next-line global-require
    const fresh = require('../services/seoGenerator');
    await expect(fresh.repairArticle(hydrate())).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });
});

// ============================================================
describe('C. SEO_AI_PROVIDER=anthropic: the rollback path still maps Anthropic failures', () => {
  beforeEach(() => {
    process.env.SEO_AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
  });

  /** How the Anthropic SDK reports an exhausted balance: a 400, reason in text. */
  const creditError = () => Object.assign(new Error('400 invalid_request_error'), {
    status: 400,
    error: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
  });

  test.each([
    { label: 'exhausted balance', err: creditError(), code: 'billing', status: 402 },
    { label: 'expired key', err: Object.assign(new Error('401'), { status: 401 }), code: 'auth', status: 401 },
    { label: 'rate limit', err: Object.assign(new Error('429'), { status: 429 }), code: 'rate_limit', status: 429 },
    { label: 'overloaded', err: Object.assign(new Error('529'), { status: 529 }), code: 'overloaded', status: 503 },
    { label: 'upstream 500', err: Object.assign(new Error('500'), { status: 500 }), code: 'upstream', status: 503 },
  ])('$label -> code $code, status $status', ({ err, code, status }) => {
    const mapped = toClaudeApiError(err);
    expect(mapped.code).toBe(code);
    expect(mapped.status).toBe(status);
    expect(mapped.message).toMatch(/Anthropic/);
  });

  test('the billing message still points at the Anthropic console', () => {
    expect(toClaudeApiError(creditError()).message).toMatch(/console\.anthropic\.com\/settings\/billing/);
  });

  test('a repair goes to the Anthropic SDK, not OpenAI, and its failure is mapped', async () => {
    mockAnthropicCreate.mockRejectedValue(creditError());
    await expect(repairArticle(hydrate())).rejects.toMatchObject({ name: 'ClaudeApiError', code: 'billing' });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
