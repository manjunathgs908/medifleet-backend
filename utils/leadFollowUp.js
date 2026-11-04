'use strict';
/**
 * utils/leadFollowUp.js
 * ============================================================
 * When a lead's follow-up is due, in India time. "Today" is the India
 * calendar day (IST is UTC+05:30 all year, no daylight saving), whatever
 * the server's or the browser's own time zone.
 *
 *   overdue — the follow-up time has passed
 *   today   — later today (India time)
 *   upcoming — after today
 *
 * Only active leads (new / contacted, not linked to a booked trip) are
 * followed up; converted, lost and spam leads never show as due or
 * overdue, though their follow-up history stays on the lead.
 * ============================================================
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES = ['new', 'contacted'];
const isActive = (status) => ACTIVE_STATUSES.includes(status || 'new');

// [start, end) of the India calendar day that contains `now`.
function istDayBounds(now = Date.now()) {
  const t = new Date(now).getTime();
  const start = Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

function followUpStateOf(lead, now = Date.now()) {
  if (!lead || !isActive(lead.status) || lead.convertedTrip || !lead.nextFollowUpAt) return null;
  const at = new Date(lead.nextFollowUpAt).getTime();
  if (Number.isNaN(at)) return null;
  const t = new Date(now).getTime();
  if (at < t) return 'overdue';
  return at < istDayBounds(t).end.getTime() ? 'today' : 'upcoming';
}

// Mongo filters for the dashboard's views. `userId` is the viewer, for "mine".
const unassigned = { $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] };
function viewFilter(view, { now = Date.now(), userId } = {}) {
  // (A lead linked to a booked trip is never active, whatever its status says.)
  const active = { status: { $in: ACTIVE_STATUSES }, convertedTrip: null };
  const t = new Date(now);
  switch (view) {
    case 'unassigned': return { ...active, ...unassigned };
    case 'overdue'   : return { ...active, nextFollowUpAt: { $lt: t } };
    case 'due_today' : return { ...active, nextFollowUpAt: { $gte: t, $lt: istDayBounds(t).end } };
    case 'mine'      : return { ...active, assignedTo: userId };
    default          : return null;
  }
}
const VIEWS = ['unassigned', 'due_today', 'overdue', 'mine'];

module.exports = { IST_OFFSET_MS, ACTIVE_STATUSES, isActive, istDayBounds, followUpStateOf, viewFilter, VIEWS };
