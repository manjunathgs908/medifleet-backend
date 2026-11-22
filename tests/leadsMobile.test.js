'use strict';
/**
 * tests/leadsMobile.test.js
 * ============================================================
 * The two small additions the mobile CRM needs (controllers/leadController.js):
 *
 *   A. GET /api/leads/summary gains counts.new (status "new"), every
 *      existing count unchanged
 *   B. GET /api/leads/:id — one lead, decorated like a list row, masked
 *      (no raw number for a telecaller), plus customerRef; 404s
 *   C. both sit behind the router's protect + authorize(owner, telecaller)
 *
 * Models are mocked: no database, no network.
 * ============================================================
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-leads-mobile-secret';

const mockCount = jest.fn();
const mockFindById = jest.fn();
jest.mock('../models', () => ({
  Lead: {
    countDocuments: (...a) => mockCount(...a),
    findById: (...a) => mockFindById(...a),
    find: jest.fn(),
    schema: { path: () => ({ enumValues: ['new', 'contacted', 'converted', 'lost', 'spam'] }) },
  },
  User: { find: () => ({ select: () => ({ lean: async () => [{ _id: 'u1', name: 'Asha' }] }) }) },
}));
jest.mock('../models/CallbackTask', () => ({ find: () => ({ select: () => ({ lean: async () => [] }) }) }));

const router = require('../routes/leads');
const { protect, OPERATIONS } = require('../middleware/auth');
const { phoneFromRef } = require('../utils/customerPhone');

const LEAD_ID = '64b0000000000000000000a1';
const handlerFor = (path) => router.stack.find((l) => l.route?.path === path && l.route.methods.get).route.stack.at(-1).handle;
const run = async (handler, req) => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  await handler({ query: {}, params: {}, user: { _id: 'u9', role: 'telecaller' }, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

// What the Lead toJSON gives a telecaller: masked, no `phone`.
const leadDoc = (over = {}) => ({
  _id: LEAD_ID, patientName: 'Ravi', phone: '9986844442', status: 'contacted',
  assignedTo: 'u1', nextFollowUpAt: new Date(Date.now() - 60000), history: [], followUpNotes: [],
  ...over,
  toJSON() {
    const { toJSON, phone, ...rest } = this;
    return { ...rest, phoneMasked: '••••••4442', rev: 0 };
  },
});

beforeEach(() => {
  mockCount.mockReset();
  mockFindById.mockReset();
});

describe('A. GET /api/leads/summary', () => {
  test('adds counts.new; the four existing counts are unchanged', async () => {
    mockCount.mockImplementation(async (filter) => {
      if (filter.status === 'new') return 7;
      if (filter.assignedTo === 'u9') return 4;          // mine
      if (filter.$or) return 3;                          // unassigned
      if (filter.nextFollowUpAt?.$gte) return 2;         // due today
      return 5;                                          // overdue
    });
    const res = await run(handlerFor('/summary'), {});
    expect(res.body).toEqual({ success: true, counts: { unassigned: 3, dueToday: 2, overdue: 5, mine: 4, new: 7 } });
    expect(mockCount).toHaveBeenCalledWith({ status: 'new' });
  });
});

describe('B. GET /api/leads/:id', () => {
  test('one lead, decorated like a list row, masked, with a customerRef that decodes to its number', async () => {
    mockFindById.mockResolvedValue(leadDoc());
    const res = await run(handlerFor('/:id'), { params: { id: LEAD_ID } });
    expect(res.statusCode).toBe(200);
    const { lead } = res.body;
    expect(lead).toMatchObject({ _id: LEAD_ID, patientName: 'Ravi', phoneMasked: '••••••4442', followUp: 'overdue', openCallback: null, assignedToName: 'Asha' });
    expect(lead).not.toHaveProperty('phone');                        // telecaller: never the raw number
    expect(JSON.stringify(res.body)).not.toContain('9986844442');
    expect(lead.customerRef).toMatch(/^c_/);
    expect(phoneFromRef(lead.customerRef)).toBe('9986844442');       // opaque, but the server can resolve it
  });

  test('unknown or malformed id: 404, no lookup for a malformed one', async () => {
    mockFindById.mockResolvedValue(null);
    expect((await run(handlerFor('/:id'), { params: { id: LEAD_ID } })).statusCode).toBe(404);
    const bad = await run(handlerFor('/:id'), { params: { id: 'nope' } });
    expect(bad.statusCode).toBe(404);
    expect(mockFindById).toHaveBeenCalledTimes(1);
  });

  test('a lead with no usable number still loads, customerRef null', async () => {
    mockFindById.mockResolvedValue(leadDoc({ phone: '' }));
    const res = await run(handlerFor('/:id'), { params: { id: LEAD_ID } });
    expect(res.body.lead.customerRef).toBeNull();
  });
});

describe('C. auth', () => {
  test('every leads route, the new one included, runs behind protect + authorize(owner, telecaller)', () => {
    const guards = router.stack.filter((l) => !l.route).map((l) => l.handle);
    expect(guards[0]).toBe(protect);
    expect(OPERATIONS).toEqual(['owner', 'telecaller']);
    const idRoute = router.stack.findIndex((l) => l.route?.path === '/:id' && l.route.methods.get);
    const guardIdx = router.stack.findIndex((l) => l.handle === protect);
    expect(idRoute).toBeGreaterThan(guardIdx);
  });

  test('/summary and /assignees are declared before /:id, so neither is read as an id', () => {
    const idx = (p) => router.stack.findIndex((l) => l.route?.path === p && l.route.methods.get);
    expect(idx('/summary')).toBeLessThan(idx('/:id'));
    expect(idx('/assignees')).toBeLessThan(idx('/:id'));
  });

  test('the authorize guard refuses a driver', () => {
    const authorizeLayer = router.stack.filter((l) => !l.route)[1].handle;
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const next = jest.fn();
    authorizeLayer({ user: { role: 'driver' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
