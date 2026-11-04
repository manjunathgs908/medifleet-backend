'use strict';

// ============================================================
// utils/dispatchUrgency.js — how urgent each active booking is.
// ============================================================
// Read-only classification for the dispatch board and the Dashboard (both
// from GET /api/trips/live, so their counts always agree). It NEVER changes
// a trip: an overdue booking stays booked, visible and counted until an
// operator assigns a crew or cancels it with a reason.
//
// Thresholds — no business setting existed, so these are proposed defaults,
// overridable without a code change:
//   DISPATCH_UNASSIGNED_OVERDUE_MINUTES (15): an immediate ("Right Now")
//     booking still without a crew this long after it was made is overdue;
//     a scheduled one, this long after its pickup time.
//   DISPATCH_SCHEDULED_DUE_SOON_MINUTES (60): a scheduled booking without a
//     crew is "due soon" from this long before its pickup time.
// ============================================================

// A positive number of minutes up to `max`; anything else (unset, 0,
// negative, text, absurdly large) falls back to the default, with one
// warning per bad value so a typo in Render is visible in the logs.
const warned = new Set();
const minutesFromEnv = (name, fallback, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0 && v <= max) return v;
  if (!warned.has(`${name}=${raw}`)) {
    warned.add(`${name}=${raw}`);
    console.warn(`[dispatchUrgency] ${name}="${raw}" is not a number of minutes between 1 and ${max}; using ${fallback}.`);
  }
  return fallback;
};
const thresholds = () => ({
  overdueMinutes: minutesFromEnv('DISPATCH_UNASSIGNED_OVERDUE_MINUTES', 15, 24 * 60),
  dueSoonMinutes: minutesFromEnv('DISPATCH_SCHEDULED_DUE_SOON_MINUTES', 60, 7 * 24 * 60),
});

const ACTIVE = ['booked', 'dispatched', 'en_route'];

// A crew has the trip: a driver AND the ambulance they are on (or, on trips
// from before the Ambulance system, a vehicle). Own fleet and partners alike
// — partner ambulances carry their own assigned driver. A trip can be
// 'dispatched' with no driver (an on-shift ambulance with nobody assigned
// to it), and a declined trip goes back to 'booked' with both cleared, so
// status alone never means "crew assigned".
const hasCrew = (trip) => !!trip?.driver && !!(trip.ambulance || trip.vehicle);

//   overdue_unassigned  — no crew, and the pickup was wanted long enough ago
//   awaiting_assignment — no crew yet, still within the threshold
//   scheduled_due_soon  — scheduled, no crew, pickup soon (or just past)
//   scheduled_upcoming  — scheduled, no crew, pickup later
//   assigned            — a crew has it (dispatched / en route)
function dispatchStateOf(trip, now = Date.now()) {
  if (!trip || !ACTIVE.includes(trip.status)) return null;
  const { overdueMinutes, dueSoonMinutes } = thresholds();
  const created = new Date(trip.createdAt || now).getTime();
  const scheduled = trip.scheduleType === 'later' && trip.scheduleDate && !Number.isNaN(new Date(trip.scheduleDate).getTime());
  // When the customer wants the ambulance: now-bookings at booking time.
  const pickupAt = scheduled ? new Date(trip.scheduleDate).getTime() : created;
  const minutesToPickup = Math.round((pickupAt - now) / 60000);
  const out = {
    ageMinutes   : Math.max(0, Math.round((now - created) / 60000)),
    pickupAt     : new Date(pickupAt),
    scheduled    : !!scheduled,
    minutesToPickup,
    overdueMinutes: null,
  };
  if (hasCrew(trip)) return { ...out, state: 'assigned' };
  const late = -minutesToPickup; // minutes since the pickup was wanted
  if (late >= overdueMinutes) return { ...out, state: 'overdue_unassigned', overdueMinutes: late };
  if (!scheduled) return { ...out, state: 'awaiting_assignment' };
  if (minutesToPickup <= dueSoonMinutes) return { ...out, state: 'scheduled_due_soon' };
  return { ...out, state: 'scheduled_upcoming' };
}

// Board counts. `active` is every booked/dispatched/en-route trip — overdue
// ones included — exactly as before; the rest break it down.
function countDispatchStates(states) {
  const c = { active: states.length, overdue: 0, awaitingAssignment: 0, scheduledDueSoon: 0, scheduledUpcoming: 0, assigned: 0 };
  for (const s of states) {
    if (s?.state === 'overdue_unassigned') c.overdue += 1;
    else if (s?.state === 'awaiting_assignment') c.awaitingAssignment += 1;
    else if (s?.state === 'scheduled_due_soon') c.scheduledDueSoon += 1;
    else if (s?.state === 'scheduled_upcoming') c.scheduledUpcoming += 1;
    else if (s?.state === 'assigned') c.assigned += 1;
  }
  return c;
}

// A scheduled pickup time as sent by a booking form. The website and the
// CRM send a browser <input type="datetime-local"> value, e.g.
// "2026-11-01T15:30" — no timezone. new Date() alone would read that in the
// SERVER's timezone (UTC on Render: 5h30m late). SaveLife operates in India,
// so a value without a timezone is India time (+05:30). A value that says
// its timezone (the app sends ...Z) is kept exactly. Returns undefined for
// anything that isn't a valid time.
const NAIVE_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
function parseScheduleDate(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const text = typeof value === 'string' ? value.trim() : value;
  const d = typeof text === 'string' && NAIVE_LOCAL.test(text) ? new Date(`${text}+05:30`) : new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { dispatchStateOf, countDispatchStates, thresholds, hasCrew, parseScheduleDate, ACTIVE };
