'use strict';
/**
 * tests/mobileQueues.test.js
 * ============================================================
 * Phase 1 queue work for the mobile CRM:
 *   A. GET /api/callbacks — the most urgent tasks are never hidden: with
 *      350 open tasks the oldest overdue ones are included; paged mode
 *      filters (assignee, due) BEFORE paging, pages are stable, totals are
 *      for the whole queue
 *   B. GET /api/callbacks/summary — personal / unassigned counts with the
 *      same due rule and India day as the list
 *   C. GET /api/leads?page= — > 500 leads paged without gaps or repeats,
 *      total on the same filter
 *   D. GET /api/leads/summary — personal / unassigned counts
 *   E. POST /api/leads — validation, duplicates offered (masked), explicit
 *      add-anyway, source/creator/time recorded, concurrent same-number saves
 * No database: models are in-memory fakes.
 * ============================================================
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-mobile-queues-secret';
process.env.CALLBACK_DUE_MINUTES = '15';

const MIN = 60 * 1000;
const mockData = { tasks: [], leads: [], claimLocks: new Map() };

// ── CallbackTask fake ──────────────────────────────────────────
jest.mock('../models/CallbackTask', () => {
  const chain = (rows) => {
    const q = { _rows: rows };
    q.select = () => q; q.populate = () => q; q.sort = () => q; q.limit = () => q;
    q.lean = async () => q._rows.map((r) => ({ ...r }));
    q.then = (res, rej) => Promise.resolve(q._rows.map((r) => { const d = { ...r }; d.toJSON = () => { const { toJSON, customerPhone, ...rest } = d; return { ...rest, customerMasked: '••••••0000' }; }; return d; })).then(res, rej);
    return q;
  };
  const M = {
    find: jest.fn((f) => {
      if (f?._id?.$in) { const ids = f._id.$in.map(String); return chain(mockData.tasks.filter((t) => ids.includes(String(t._id)))); }
      if (f?.state === 'open') return chain(mockData.tasks.filter((t) => t.state === 'open'));
      return chain([]);
    }),
  };
  M.OUTCOMES = []; M.NOTE_REQUIRED = [];
  return M;
});
jest.mock('../models/CallLog', () => {
  const q = { select() { return q; }, sort() { return q; }, lean: async () => [], then: (r) => Promise.resolve([]).then(r) };
  return { find: jest.fn(() => q) };
});
jest.mock('../services/callbackQueue', () => ({ indexReady: async () => true, sweepSoon: async () => {} }));

// ── Lead / LeadClaim fakes ─────────────────────────────────────
jest.mock('../models', () => {
  const sortRows = (rows, sort) => {
    const keys = Object.entries(sort || {});
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = a[k] instanceof Date ? +a[k] : String(a[k]); const bv = b[k] instanceof Date ? +b[k] : String(b[k]);
        if (av < bv) return -dir; if (av > bv) return dir;
      }
      return 0;
    });
  };
  const match = (d, f) => Object.entries(f || {}).every(([k, v]) => {
    if (k === '$and') return v.every((x) => match(d, x));
    if (k === '$or') return v.some((x) => match(d, x));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(d[k] ?? null);
      if ('$exists' in v) return v.$exists ? d[k] !== undefined : d[k] === undefined;
      if ('$regex' in v) return new RegExp(v.$regex).test(d[k] || '');
      if ('$lt' in v || '$gte' in v) return (!('$lt' in v) || d[k] < v.$lt) && (!('$gte' in v) || d[k] >= v.$gte);
    }
    if (v === null) return d[k] == null;
    return String(d[k]) === String(v);
  });
  const toJSON = (d) => () => { const { phone, ...rest } = d; return { ...rest, phoneMasked: `••••••${String(phone).slice(-4)}`, rev: d.rev ?? 0 }; };
  const wrap = (d) => ({ ...d, toJSON: toJSON(d) });
  const findChain = (f) => {
    let rows = mockData.leads.filter((d) => match(d, f));
    const q = {
      sort(s) { rows = sortRows(rows, s); return q; },
      skip(n) { rows = rows.slice(n); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      session() { return q; },
      then(res, rej) { return Promise.resolve(rows.map(wrap)).then(res, rej); },
    };
    return q;
  };
  const Lead = {
    find: jest.fn(findChain),
    countDocuments: jest.fn(async (f) => mockData.leads.filter((d) => match(d, f)).length),
    create: jest.fn(async ([doc]) => { const d = { _id: `n${mockData.leads.length + 1}`, createdAt: new Date(), ...doc }; mockData.leads.push(d); return [wrap(d)]; }),
    // Transactions on one claim key run one after another (what the claim
    // document's write conflict achieves in MongoDB).
    startSession: async () => ({
      withTransaction: async (fn) => {
        const key = 'tx';
        const prev = mockData.claimLocks.get(key) || Promise.resolve();
        let release; const mine = new Promise((r) => { release = r; });
        mockData.claimLocks.set(key, prev.then(() => mine));
        await prev;
        try { await fn(); } finally { release(); }
      },
      endSession: async () => {},
    }),
    schema: { path: () => ({ enumValues: ['new', 'contacted', 'converted', 'lost', 'spam'] }) },
  };
  return { Lead, User: { find: () => ({ select: () => ({ lean: async () => [] }) }) }, Trip: {} };
});
jest.mock('../models/LeadClaim', () => ({ updateOne: jest.fn(async () => ({})) }));

const callbacks = require('../controllers/callbackController');
const leadsRouter = require('../routes/leads');
const { Lead } = require('../models');
const handler = (path, method = 'get') => leadsRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;

const run = async (fn, req) => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  await fn({ query: {}, params: {}, body: {}, user: { _id: 'u1', role: 'telecaller', name: 'Asha' }, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};
const oid = (n) => n.toString(16).padStart(24, '0');

// ── A/B. 350 open callbacks ────────────────────────────────────
function seedTasks() {
  const now = Date.now();
  mockData.tasks = Array.from({ length: 350 }, (_, i) => {
    // i = 0 is the NEWEST missed call; i = 349 the oldest (most overdue).
    const missedAt = new Date(now - (i + 1) * 10 * MIN);
    return {
      _id: oid(i + 1), state: 'open', firstMissedAt: missedAt, lastMissedAt: missedAt, lastQueuedAt: missedAt,
      assignedTo: i % 3 === 0 ? 'u1' : i % 3 === 1 ? null : 'u2', calls: [], customerPhone: '9000000000',
    };
  });
  // A scheduled one, due later today (not overdue).
  mockData.tasks[0].nextCallbackAt = new Date(now + 60 * MIN);
  mockData.tasks[0].scheduledAt = new Date(now - MIN);
}

describe('A. callbacks: most urgent first, never hidden by the old newest-300 cap', () => {
  beforeEach(seedTasks);

  test('default (desktop) list: 300 MOST URGENT incl. the oldest overdue; counts for all 350; truncated 50', async () => {
    const r = await run(callbacks.list, { query: {} });
    const ids = r.body.tasks.map((t) => String(t._id));
    expect(ids).toHaveLength(300);
    expect(ids[0]).toBe(oid(350));                 // the oldest missed call comes first
    expect(ids).toContain(oid(350));
    expect(r.body.counts).toEqual({ open: 350, overdue: 349 });
    expect(r.body.truncated).toBe(50);
  });

  test('paged: stable pages, no repeats or gaps across the whole queue, accurate total', async () => {
    const seen = [];
    for (let page = 1; page <= 8; page += 1) {
      const r = await run(callbacks.list, { query: { page: String(page), limit: '50' } });
      expect(r.body.page).toMatchObject({ page, limit: 50, total: 350, pages: 7 });
      seen.push(...r.body.tasks.map((t) => String(t._id)));
      if (!r.body.page.hasMore) break;
    }
    expect(seen).toHaveLength(350);
    expect(new Set(seen).size).toBe(350);
  });

  test('filters are applied BEFORE paging: assignee=me&due=overdue counts only mine, oldest first', async () => {
    const r = await run(callbacks.list, { query: { assignee: 'me', due: 'overdue', limit: '10' } });
    const mineOverdue = mockData.tasks.filter((t, i) => t.assignedTo === 'u1' && i !== 0).length;
    expect(r.body.page.total).toBe(mineOverdue);
    expect(r.body.tasks.every((t) => String(t.assignedTo) === 'u1' && t.due.overdue)).toBe(true);
    const due = r.body.tasks.map((t) => +new Date(t.due.dueAt));
    expect(due).toEqual([...due].sort((a, b) => a - b));
    expect(r.body.totals.open).toBe(350);              // totals independent of the filter/page
  });

  test('assignee=unassigned and due=today work; unknown filters are refused', async () => {
    const u = await run(callbacks.list, { query: { assignee: 'unassigned', limit: '100' } });
    expect(u.body.tasks.every((t) => !t.assignedTo)).toBe(true);
    const today = await run(callbacks.list, { query: { due: 'today' } });
    expect(today.body.tasks.map((t) => String(t._id))).toEqual([oid(1)]);
    expect((await run(callbacks.list, { query: { due: 'soon' } })).statusCode).toBe(400);
    expect((await run(callbacks.list, { query: { assignee: { $ne: 1 } } })).statusCode).toBe(400);
  });
});

describe('B. callbacks summary: personal and unassigned counts (same rule as the list)', () => {
  beforeEach(seedTasks);
  test('mine / unassigned overdue and due-today agree with the paged list totals', async () => {
    const s = (await run(callbacks.summary, {})).body;
    const mineList = (await run(callbacks.list, { query: { assignee: 'me', due: 'overdue', limit: '1' } })).body.page.total;
    const unList = (await run(callbacks.list, { query: { assignee: 'unassigned', due: 'overdue', limit: '1' } })).body.page.total;
    expect(s).toMatchObject({ open: 350, overdue: 349, mineOverdue: mineList, unassignedOverdue: unList, mineDueToday: 1 });
    expect(s.mine).toBe(mockData.tasks.filter((t) => t.assignedTo === 'u1').length);
  });
  test('a different user gets their own personal counts', async () => {
    const s = (await run(callbacks.summary, { user: { _id: 'u2', role: 'telecaller' } })).body;
    expect(s.mine).toBe(mockData.tasks.filter((t) => t.assignedTo === 'u2').length);
  });
});

// ── C/D. 620 leads ─────────────────────────────────────────────
function seedLeads() {
  const now = Date.now();
  mockData.leads = Array.from({ length: 620 }, (_, i) => ({
    _id: oid(1000 + i), patientName: `L${i}`, phone: `90000${String(i).padStart(5, '0')}`, status: 'contacted',
    convertedTrip: null, assignedTo: i % 2 ? 'u1' : null, nextFollowUpAt: new Date(now - (i + 1) * MIN), createdAt: new Date(now - i * MIN), rev: 0,
  }));
}

describe('C. leads: more than 500 paged without gaps or repeats', () => {
  beforeEach(seedLeads);
  test('?view=overdue&page= covers all 620, oldest first, total from the same filter', async () => {
    const seen = [];
    for (let page = 1; page <= 10; page += 1) {
      const r = await run(handler('/'), { query: { view: 'overdue', page: String(page), limit: '100' } });
      expect(r.body.page.total).toBe(620);
      seen.push(...r.body.leads.map((l) => l._id));
      if (!r.body.page.hasMore) break;
    }
    expect(seen).toHaveLength(620);
    expect(new Set(seen).size).toBe(620);
    expect(seen[0]).toBe(oid(1000 + 619)); // the most overdue first
  });
  test('assignedTo filter applies before paging; without page the old response shape (500 cap) is unchanged', async () => {
    const r = await run(handler('/'), { query: { view: 'overdue', assignedTo: '000000000000000000000000', page: '1' } });
    expect(r.body.page.total).toBe(0);
    const legacy = await run(handler('/'), { query: { view: 'overdue' } });
    expect(legacy.body.page).toBeUndefined();
    expect(Lead.find).toHaveBeenCalled();
  });
});

describe('C2. leads: assignedTo=none combines with a view (My Work "Unassigned")', () => {
  beforeEach(seedLeads);
  test('view=overdue&assignedTo=none returns only unassigned overdue leads; total matches the summary', async () => {
    const r = await run(handler('/'), { query: { view: 'overdue', assignedTo: 'none', page: '1', limit: '100' } });
    expect(r.body.page.total).toBe(310);
    expect(r.body.leads.every((l) => l.assignedTo == null)).toBe(true);
    const s = (await run(handler('/summary'), {})).body.counts;
    expect(r.body.page.total).toBe(s.unassignedOverdue);
  });
});

describe('D. leads summary: personal and unassigned counts', () => {
  beforeEach(seedLeads);
  test('mineOverdue / unassignedOverdue match the list for the same filters', async () => {
    const s = (await run(handler('/summary'), {})).body.counts;
    expect(s.mineOverdue).toBe(310);
    expect(s.unassignedOverdue).toBe(310);
    expect(s.overdue).toBe(620);
    expect(s.mineDueToday).toBe(0);
  });
});

// ── E. POST /api/leads ─────────────────────────────────────────
describe('E. create a lead by hand', () => {
  beforeEach(() => { mockData.leads = [{ _id: 'e1', patientName: 'Old', phone: '9986844442', status: 'lost', createdAt: new Date() }]; });
  const create = (body, user) => run(handler('/', 'post'), { body, ...(user ? { user } : {}) });

  test('validation: name, 10-digit Indian mobile, manual sources only', async () => {
    expect((await create({ phone: '9876543210' })).body.code).toBe('NAME_REQUIRED');
    expect((await create({ patientName: 'A', phone: '12345' })).body.code).toBe('PHONE_INVALID');
    expect((await create({ patientName: 'A', phone: '9876543210', source: 'facebook_ad' })).body.code).toBe('SOURCE_INVALID');
  });

  test('records source, creator and time; status new; masked in the response; assign-to-me optional', async () => {
    const r = await create({ patientName: 'Kavya', phone: '+91 98765 43210', source: 'walk_in', assignToMe: true });
    expect(r.statusCode).toBe(201);
    const saved = mockData.leads.at(-1);
    expect(saved).toMatchObject({ phone: '9876543210', source: 'walk_in', status: 'new', createdBy: 'u1', createdByName: 'Asha', assignedTo: 'u1' });
    expect(saved.history.map((h) => h.type)).toEqual(['created', 'assigned']);
    expect(saved.receivedAt).toBeInstanceOf(Date);
    expect(r.body.lead.phone).toBeUndefined();
    expect(r.body.lead.phoneMasked).toBe('••••••3210');
  });

  test('a number already on a lead: 409 DUPLICATE with the existing lead (masked) — nothing created or merged', async () => {
    const before = mockData.leads.length;
    const r = await create({ patientName: 'New', phone: '9986844442' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('DUPLICATE');
    expect(r.body.duplicates[0]).toMatchObject({ _id: 'e1', phoneMasked: '••••••4442' });
    expect(JSON.stringify(r.body)).not.toContain('9986844442');
    expect(mockData.leads.length).toBe(before);
    expect(mockData.leads[0].patientName).toBe('Old');
  });

  test('add anyway (confirmDuplicate) creates a separate lead; the old one is untouched', async () => {
    const r = await create({ patientName: 'New', phone: '9986844442', confirmDuplicate: true });
    expect(r.statusCode).toBe(201);
    expect(mockData.leads.filter((l) => l.phone === '9986844442')).toHaveLength(2);
  });

  test('two people saving the same new number at the same moment: one lead, the other is offered it', async () => {
    const [a, b] = await Promise.all([create({ patientName: 'X', phone: '9123456780' }), create({ patientName: 'Y', phone: '9123456780' })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(mockData.leads.filter((l) => l.phone === '9123456780')).toHaveLength(1);
  });
});
