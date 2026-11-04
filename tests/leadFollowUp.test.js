/**
 * tests/leadFollowUp.test.js
 * ============================================================
 * Lead follow-up — the rules that need no database:
 *   - "today" is the India calendar day, whatever the server's zone
 *   - overdue / due later today / upcoming, and only for active leads
 *   - the dashboard views' filters
 *   - a follow-up time without a zone is read as India time
 *   - the lead JSON stays masked for a telecaller, full for the owner
 *   - the old free-form PUT /api/leads/:id no longer writes anything
 * Route permissions are in telecallerAccess.test.js. Assignment, conflicts
 * (rev), counts and history need a real MongoDB and were checked against
 * an isolated in-memory one.
 * ============================================================
 */
'use strict';

const { istDayBounds, followUpStateOf, viewFilter, isActive } = require('../utils/leadFollowUp');
const { parseScheduleDate } = require('../utils/dispatchUrgency');

// 2 Nov 2026 00:00 India time = 1 Nov 2026 18:30 UTC.
const IST_MIDNIGHT = new Date('2026-11-01T18:30:00Z').getTime();
const MIN = 60 * 1000;

describe('India-time day boundaries', () => {
  it('the India day starts at 18:30 UTC the previous evening', () => {
    expect(istDayBounds(IST_MIDNIGHT)).toEqual({ start: new Date(IST_MIDNIGHT), end: new Date(IST_MIDNIGHT + 24 * 60 * MIN) });
    expect(istDayBounds(IST_MIDNIGHT - 1).start).toEqual(new Date(IST_MIDNIGHT - 24 * 60 * MIN));
    expect(istDayBounds(IST_MIDNIGHT - 1).end).toEqual(new Date(IST_MIDNIGHT));
  });

  it('a UTC date change at 05:30 India time is not a new India day', () => {
    const utcMidnight = new Date('2026-11-02T00:00:00Z').getTime(); // 05:30 IST on 2 Nov
    expect(istDayBounds(utcMidnight).start).toEqual(new Date(IST_MIDNIGHT));
  });

  it.each([
    ['11:59 pm India time is still the same day', IST_MIDNIGHT - 1, 'today'],
    ['12:00 am India time is tomorrow', IST_MIDNIGHT, 'upcoming'],
  ])('%s', (_, at, state) => {
    expect(followUpStateOf({ status: 'new', nextFollowUpAt: new Date(at) }, IST_MIDNIGHT - 2 * 60 * MIN)).toBe(state);
  });
});

describe('follow-up state of a lead', () => {
  const now = IST_MIDNIGHT - 6 * 60 * MIN; // 6 pm India time
  it.each([
    ['a passed time is overdue', -1, 'overdue'],
    ['now exactly is due today, not yet overdue', 0, 'today'],
    ['later today', 30, 'today'],
    ['tomorrow', 7 * 60, 'upcoming'],
  ])('%s', (_, offsetMin, state) => {
    expect(followUpStateOf({ status: 'contacted', nextFollowUpAt: new Date(now + offsetMin * MIN) }, now)).toBe(state);
  });

  it.each(['converted', 'lost', 'spam'])('a %s lead never reminds anyone', (status) => {
    expect(isActive(status)).toBe(false);
    expect(followUpStateOf({ status, nextFollowUpAt: new Date(now - 60 * MIN) }, now)).toBe(null);
  });

  it('a lead linked to a booked trip never reminds, whatever its status says', () => {
    expect(followUpStateOf({ status: 'contacted', convertedTrip: 't1', nextFollowUpAt: new Date(now - MIN) }, now)).toBe(null);
  });

  it('a lead with no status (older record) counts as new', () => {
    expect(followUpStateOf({ nextFollowUpAt: new Date(now - MIN) }, now)).toBe('overdue');
  });

  it('no follow-up time, no state', () => {
    expect(followUpStateOf({ status: 'new' }, now)).toBe(null);
  });
});

describe('dashboard views', () => {
  const now = IST_MIDNIGHT - 6 * 60 * MIN;
  const active = { $in: ['new', 'contacted'] };
  it('overdue: active leads whose time has passed', () => {
    expect(viewFilter('overdue', { now })).toEqual({ status: active, convertedTrip: null, nextFollowUpAt: { $lt: new Date(now) } });
  });
  it('due today: from now to India midnight', () => {
    expect(viewFilter('due_today', { now })).toEqual({ status: active, convertedTrip: null, nextFollowUpAt: { $gte: new Date(now), $lt: new Date(IST_MIDNIGHT) } });
  });
  it('unassigned: active leads with nobody on them', () => {
    expect(viewFilter('unassigned', { now })).toEqual({ status: active, convertedTrip: null, $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] });
  });
  it('mine: active leads assigned to the viewer', () => {
    expect(viewFilter('mine', { now, userId: 'u1' })).toEqual({ status: active, convertedTrip: null, assignedTo: 'u1' });
  });
  it('anything else is not a view', () => {
    expect(viewFilter('all')).toBe(null);
    expect(viewFilter({ $ne: 1 })).toBe(null);
  });
});

describe('follow-up times are India time', () => {
  it('a time without a zone is read as India time', () => {
    expect(parseScheduleDate('2026-11-02T00:00')).toEqual(new Date(IST_MIDNIGHT));
  });
  it('a time with a zone is kept exactly', () => {
    expect(parseScheduleDate('2026-11-01T18:30:00.000Z')).toEqual(new Date(IST_MIDNIGHT));
  });
});

describe('lead JSON', () => {
  const { Lead } = require('../models');
  const { runAsViewer } = require('../utils/phoneViewer');
  const PHONE = '9986844442';
  const lead = () => new Lead({
    phone: PHONE,
    status: 'lost',
    lostReason: 'Went with another provider',
    followUpNotes: [{ text: 'Asked to call after 6', at: new Date(), byName: 'Santosh' }],
    history: [{ type: 'assigned', at: new Date(), byName: 'Divya', detail: { to: 'Santosh' } }],
  });

  it('a telecaller sees the masked number only — also in notes and history', () => {
    runAsViewer({ role: 'telecaller' }, () => {
      const json = JSON.stringify(lead().toJSON());
      expect(json).not.toContain(PHONE);
      expect(lead().toJSON().phoneMasked).toBe('••••••4442');
    });
  });

  it('the owner also gets the full number', () => {
    runAsViewer({ role: 'owner' }, () => expect(lead().toJSON().phone).toBe(PHONE));
  });

  it('a lead from before follow-ups existed reads as rev 0 with no follow-up', () => {
    const json = new Lead({ phone: PHONE }).toJSON();
    expect(json.rev).toBe(0);
    expect(json.nextFollowUpAt).toBeUndefined();
    expect(json.lostReason).toBeUndefined();
  });
});

describe('the old PUT /api/leads/:id', () => {
  it('writes nothing and tells an out-of-date screen to reload', () => {
    const { legacyUpdate } = require('../controllers/leadController');
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    legacyUpdate({ params: { id: 'x' }, body: { phone: '9000000000', status: 'lost' } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json.mock.calls[0][0].message).toMatch(/reload/i);
  });
});
