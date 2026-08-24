/**
 * tests/seoPublicController.test.js
 * ============================================================
 * The public read API, which is the one part of the SEO system with no
 * authentication in front of it. What matters here is not that it returns
 * articles -- it is that it cannot return the wrong ones.
 *
 * The query is asserted directly rather than through a fake collection: the
 * status filter IS the security boundary, so the test checks the filter that
 * reaches Mongo, not what a stub chose to hand back.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const pub = require('../controllers/seoPublicController');

const ARTICLE = {
  slug: 'ambulance-service-whitefield',
  title: 'Ambulance Service in Whitefield, Bangalore | SaveLife 24x7',
  metaDescription: 'x'.repeat(154),
  h1: 'Ambulance service in Whitefield',
  content: 'body',
  status: 'approved',
  jsonLd: [{ '@type': 'Article' }],
};

// Records the filter and projection the controller actually issued.
function stubQuery(result) {
  const calls = {};
  const chain = {
    select: (f) => { calls.select = f; return chain; },
    sort: (s) => { calls.sort = s; return chain; },
    limit: (n) => { calls.limit = n; return chain; },
    lean: () => Promise.resolve(result),
  };
  return { chain, calls };
}

// The non-empty-string clause the controller applies to every field a page
// is made of. Asserted alongside the status filter rather than ignored: it is
// what keeps the index from listing a guide the detail route would 404.
const RENDERABLE = { $type: 'string', $ne: '' };
const PUBLIC_FILTER = {
  status: { $in: ['approved', 'published'] },
  slug: RENDERABLE,
  title: RENDERABLE,
  h1: RENDERABLE,
  content: RENDERABLE,
};

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.set = jest.fn(() => res);
  return res;
};

const next = jest.fn();
const payload = (res) => res.json.mock.calls[0][0];
const statusCode = (res) => (res.status.mock.calls.length ? res.status.mock.calls[0][0] : 200);

afterEach(() => { jest.restoreAllMocks(); next.mockReset(); });

describe('only approved work is public', () => {
  test('PUBLIC_STATUSES is exactly approved and published', () => {
    expect(SeoArticle.PUBLIC_STATUSES).toEqual(['approved', 'published']);
    // Frozen, so a caller cannot push 'draft' onto it at runtime.
    expect(Object.isFrozen(SeoArticle.PUBLIC_STATUSES)).toBe(true);
  });

  test('the list query filters on status, not the caller', async () => {
    const { chain, calls } = stubQuery([ARTICLE]);
    const find = jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    await pub.list({ query: {} }, mockRes(), next);

    expect(find).toHaveBeenCalledWith(PUBLIC_FILTER);
    expect(calls.select).not.toContain('content');
    expect(calls.select).not.toContain('jsonLd');
  });

  test('a slug lookup carries the status filter into the query', async () => {
    const { chain } = stubQuery(ARTICLE);
    const findOne = jest.spyOn(SeoArticle, 'findOne').mockReturnValue(chain);

    await pub.getBySlug({ params: { slug: 'ambulance-service-whitefield' } }, mockRes(), next);

    expect(findOne).toHaveBeenCalledWith({
      ...PUBLIC_FILTER,
      slug: 'ambulance-service-whitefield',
    });
  });

  test('a draft slug is a 404, and says nothing about the draft existing', async () => {
    // The status filter is in the query, so an unapproved slug simply misses.
    const { chain } = stubQuery(null);
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue(chain);

    const res = mockRes();
    await pub.getBySlug({ params: { slug: 'a-rejected-draft' } }, res, next);

    expect(statusCode(res)).toBe(404);
    expect(payload(res).message).toBe('Not found.');
    expect(payload(res).article).toBeUndefined();
  });

  test('an empty slug is a 404 before any query runs', async () => {
    const findOne = jest.spyOn(SeoArticle, 'findOne');
    const res = mockRes();
    await pub.getBySlug({ params: { slug: '  ' } }, res, next);

    expect(statusCode(res)).toBe(404);
    expect(findOne).not.toHaveBeenCalled();
  });

  test('slugs are lowercased to match how they are stored', async () => {
    const { chain } = stubQuery(ARTICLE);
    const findOne = jest.spyOn(SeoArticle, 'findOne').mockReturnValue(chain);

    await pub.getBySlug({ params: { slug: 'Ambulance-Service-WHITEFIELD' } }, mockRes(), next);

    expect(findOne.mock.calls[0][0].slug).toBe('ambulance-service-whitefield');
  });

  test('the requested slug survives the filter spread', async () => {
    // PUBLIC carries its own `slug` clause. If it is spread after the slug
    // being looked up, it overwrites it and the query returns whichever
    // approved article Mongo happens to reach first — the article at the URL
    // and the article served stop being the same document.
    const { chain } = stubQuery(ARTICLE);
    const findOne = jest.spyOn(SeoArticle, 'findOne').mockReturnValue(chain);

    await pub.getBySlug({ params: { slug: 'some-specific-guide' } }, mockRes(), next);

    expect(findOne.mock.calls[0][0].slug).toBe('some-specific-guide');
    expect(typeof findOne.mock.calls[0][0].slug).toBe('string');
  });

  test('an incomplete article cannot be listed or served', async () => {
    // Both routes apply the same predicate, so the index can never offer a
    // link the detail route answers with 404.
    const { chain: listChain, calls: listCalls } = stubQuery([]);
    jest.spyOn(SeoArticle, 'find').mockReturnValue(listChain);
    await pub.list({ query: {} }, mockRes(), next);

    const { chain: oneChain } = stubQuery(null);
    const findOne = jest.spyOn(SeoArticle, 'findOne').mockReturnValue(oneChain);
    await pub.getBySlug({ params: { slug: 'x' } }, mockRes(), next);

    expect(SeoArticle.find.mock.calls[0][0].content).toEqual(RENDERABLE);
    expect(findOne.mock.calls[0][0].content).toEqual(RENDERABLE);
    expect(listCalls.select).toBeDefined();
  });
});

describe('payload shape', () => {
  test('a guide comes back with everything the page renders', async () => {
    const { chain, calls } = stubQuery(ARTICLE);
    jest.spyOn(SeoArticle, 'findOne').mockReturnValue(chain);

    const res = mockRes();
    await pub.getBySlug({ params: { slug: ARTICLE.slug } }, res, next);

    for (const f of ['slug', 'title', 'metaDescription', 'h1', 'content', 'faqs', 'internalLinks', 'jsonLd']) {
      expect(calls.select).toContain(f);
    }
    // Never public: how it was generated, and the similarity fingerprint.
    expect(calls.select).not.toContain('shingles');
    expect(calls.select).not.toContain('generation');
    expect(calls.select).not.toContain('reviewNotes');
    expect(payload(res).article.slug).toBe(ARTICLE.slug);
  });

  test('responses are cacheable', async () => {
    const { chain } = stubQuery([ARTICLE]);
    jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    const res = mockRes();
    await pub.list({ query: {} }, res, next);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', expect.stringContaining('s-maxage'));
  });

  test('a database failure goes to the error handler, not the client', async () => {
    jest.spyOn(SeoArticle, 'find').mockImplementation(() => { throw new Error('mongo down'); });

    await pub.list({ query: {} }, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].message).toBe('mongo down');
  });

  test('a request with no query object at all still works', async () => {
    // Express always populates req.query, but the controller is called
    // directly from tests and from other code, and a crash here would be a
    // 500 on the public index.
    const { chain } = stubQuery([ARTICLE]);
    jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    await pub.list({}, mockRes(), next);

    expect(next).not.toHaveBeenCalled();
  });
});

describe('reverse links', () => {
  test('linksTo narrows the query to guides pointing at that page', async () => {
    const { chain } = stubQuery([ARTICLE]);
    const find = jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    await pub.list({ query: { linksTo: '/icu-ambulance-bangalore' } }, mockRes(), next);

    expect(find).toHaveBeenCalledWith({
      ...PUBLIC_FILTER,
      'internalLinks.href': '/icu-ambulance-bangalore',
    });
  });

  test('the status filter still applies to a reverse-link query', async () => {
    // A curated page must not be able to surface an unapproved guide by
    // asking for its own path.
    const { chain } = stubQuery([]);
    const find = jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    await pub.list({ query: { linksTo: '/book' } }, mockRes(), next);

    expect(find.mock.calls[0][0].status).toEqual({ $in: ['approved', 'published'] });
  });

  test('a linksTo that is not a site path is rejected', async () => {
    const find = jest.spyOn(SeoArticle, 'find');
    for (const bad of ['not-a-path', 'https://evil.test/x', '/x?y=1', '../etc']) {
      const res = mockRes();
      await pub.list({ query: { linksTo: bad } }, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(find).not.toHaveBeenCalled();
  });

  test('a query operator cannot be smuggled through linksTo', async () => {
    const find = jest.spyOn(SeoArticle, 'find');
    const res = mockRes();
    // Express would parse ?linksTo[$ne]= into an object; String() flattens it
    // and the path pattern rejects what is left.
    await pub.list({ query: { linksTo: { $ne: '' } } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(find).not.toHaveBeenCalled();
  });

  test('no linksTo means the plain index, unfiltered by links', async () => {
    const { chain } = stubQuery([ARTICLE]);
    const find = jest.spyOn(SeoArticle, 'find').mockReturnValue(chain);

    await pub.list({ query: {} }, mockRes(), next);

    expect(find.mock.calls[0][0]['internalLinks.href']).toBeUndefined();
  });
});
