'use strict';
/**
 * GET /api/leads?status=… — the Leads Dashboard filter. The status reaches
 * the database query; no status (or "all") returns every lead as before;
 * an unknown status is refused rather than silently returning everything.
 */

const mockFind = jest.fn();
jest.mock('../models', () => ({
  Lead: {
    find: (...a) => mockFind(...a),
    schema: { path: () => ({ enumValues: ['new', 'contacted', 'converted', 'lost', 'spam'] }) },
  },
}));

const router = require('../routes/leads');

const handler = router.stack.find((l) => l.route?.path === '/' && l.route.methods.get).route.stack.at(-1).handle;
const run = async (query) => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  await handler({ query }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

beforeEach(() => {
  mockFind.mockReset();
  mockFind.mockReturnValue({ sort: async () => [{ _id: 'l1' }] });
});

describe('GET /api/leads status filter', () => {
  it.each(['new', 'contacted', 'converted', 'lost'])('?status=%s queries only that status', async (status) => {
    const res = await run({ status });
    expect(res.statusCode).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ status });
  });

  it.each([{}, { status: 'all' }, { status: '' }])('no status / all returns every lead (%j)', async (query) => {
    await run(query);
    expect(mockFind).toHaveBeenCalledWith({});
  });

  it('refuses an unknown status instead of returning everything', async () => {
    const res = await run({ status: 'Lost; drop' });
    expect(res.statusCode).toBe(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('a query object cannot be smuggled in as the status', async () => {
    const res = await run({ status: { $ne: 'new' } });
    expect(res.statusCode).toBe(400);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
