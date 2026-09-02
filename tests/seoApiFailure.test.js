/**
 * tests/seoApiFailure.test.js
 * ============================================================
 * What the operator is told when the failure is Anthropic's, not the
 * article's.
 *
 * An exhausted balance, an expired key and a rate limit are three different
 * problems with three different answers, and none of them is "look at your
 * draft". The property under test is that each keeps its own status and the
 * API's own wording all the way out to the caller — and that a call which
 * failed wrote nothing to the article on its way.
 *
 * The SDK is replaced at the module boundary, so no request can leave this
 * process even if a key happens to be in the environment. The generator
 * itself is real: callClaude's error handling is the thing being tested.
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

// The name must start with "mock": jest hoists jest.mock() above the file and
// only mock-prefixed bindings may be referenced from inside the factory.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: mockCreate } })));

const SeoArticle = require('../models/SeoArticle');
const { toClaudeApiError, ClaudeApiError, repairArticle } = require('../services/seoGenerator');

beforeEach(() => {
  // getClient() throws without this. The value never reaches a network call,
  // because the transport above is a stub.
  process.env.ANTHROPIC_API_KEY = 'not-a-credential-the-sdk-is-mocked';
});
afterEach(() => {
  jest.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

/** How the SDK reports an exhausted balance: a 400, with the reason in text. */
const creditError = () => Object.assign(new Error('400 invalid_request_error'), {
  status: 400,
  error: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
});

// ============================================================
describe('A. every API failure maps to something the operator can act on', () => {
  // Object rows, not arrays: with positional %s the Error itself lands in the
  // test name and prints a stack trace where the label should be.
  test.each([
    { label: 'exhausted balance', err: creditError(), code: 'billing', status: 402 },
    { label: 'expired key', err: Object.assign(new Error('401'), { status: 401 }), code: 'auth', status: 401 },
    { label: 'rate limit', err: Object.assign(new Error('429'), { status: 429 }), code: 'rate_limit', status: 429 },
    { label: 'overloaded', err: Object.assign(new Error('529'), { status: 529 }), code: 'overloaded', status: 503 },
    { label: 'upstream 500', err: Object.assign(new Error('500'), { status: 500 }), code: 'upstream', status: 503 },
    { label: 'no status at all', err: new Error('getaddrinfo ENOTFOUND api.anthropic.com'), code: 'upstream', status: 503 },
  ])('$label -> code $code, status $status', ({ err, code, status }) => {
    const mapped = toClaudeApiError(err);
    expect(mapped).toBeInstanceOf(ClaudeApiError);
    expect(mapped.code).toBe(code);
    expect(mapped.status).toBe(status);
    expect(mapped.message.length).toBeGreaterThan(20);
  });

  test('the billing message names the actual problem and where to fix it', () => {
    const m = toClaudeApiError(creditError()).message;
    expect(m).toMatch(/credit balance is too low/i);
    expect(m).toMatch(/console\.anthropic\.com\/settings\/billing/);
    expect(m).toMatch(/[Nn]othing was written/);
  });

  test('a transient failure is marked retryable and a billing stop is not', () => {
    expect(toClaudeApiError(Object.assign(new Error('429'), { status: 429 })).retryable).toBe(true);
    expect(toClaudeApiError(Object.assign(new Error('529'), { status: 529 })).retryable).toBe(true);
    expect(toClaudeApiError(creditError()).retryable).toBe(false);
  });

  test('no mapped message can leak a key, a header or the request body', () => {
    const nasty = Object.assign(new Error('boom'), {
      status: 400,
      error: { error: { type: 'invalid_request_error', message: 'bad request' } },
      request: { headers: { 'x-api-key': 'sk-ant-SHOULD-NEVER-APPEAR' } },
    });
    const m = toClaudeApiError(nasty).message;
    expect(m).not.toMatch(/sk-ant/);
    expect(m).not.toMatch(/x-api-key/i);
  });

  // callClaude passes an already-mapped error straight through, so this path
  // should not arise. It is asserted anyway because the failure would be
  // silent: a billing stop degrading into "upstream" still returns a 503 and
  // still looks plausible, while telling the operator the wrong thing to do.
  test('re-mapping a mapped error keeps it a billing stop', () => {
    const twice = toClaudeApiError(toClaudeApiError(creditError()));
    expect(twice.code).toBe('billing');
    expect(twice.status).toBe(402);
  });
});

// ============================================================
describe('B. the failure reaches the caller through callClaude', () => {
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

  test('a repair against an exhausted balance throws ClaudeApiError, not a raw SDK error', async () => {
    mockCreate.mockRejectedValue(creditError());
    const doc = hydrate();

    await expect(repairArticle(doc)).rejects.toMatchObject({
      name: 'ClaudeApiError',
      code: 'billing',
      status: 402,
    });
  });

  test('the article is untouched and unsaved when the call fails', async () => {
    mockCreate.mockRejectedValue(creditError());
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
    mockCreate.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    const doc = hydrate();
    await expect(repairArticle(doc)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(doc.checks.passed).toBe(false);
  });
});
