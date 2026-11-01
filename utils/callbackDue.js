'use strict';

// ============================================================
// utils/callbackDue.js — when a missed-call callback is due.
// ============================================================
// An OPERATIONAL reminder for the CRM desk, shown only inside the CRM (a
// badge and an "Overdue" label) — never a call, message or notification.
//
//   CALLBACK_DUE_MINUTES     (default 15) how long after a missed call the
//                            callback counts as overdue, unless someone has
//                            scheduled a callback time instead.
//   CALLBACK_SETTLE_SECONDS  (default 60) how long a call must have been
//                            over before it is queued: Plivo's reports for
//                            one call can arrive seconds apart, and an early
//                            hang-up's "missed" may still become "completed".
//
// Due time of an open task:
//   - scheduled callback time, if one was set after the latest missed call;
//   - if a missed call joined the task AFTER it was scheduled (the person
//     scheduling could not have known of it), the sooner of the scheduled
//     time and that miss + threshold;
//   - otherwise the first missed call + threshold.
// ============================================================

const warned = new Set();
function numberFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= min && v <= max) return v;
  if (!warned.has(`${name}=${raw}`)) {
    warned.add(`${name}=${raw}`);
    console.warn(`[callbackDue] ${name}="${raw}" is not a number between ${min} and ${max}; using ${fallback}.`);
  }
  return fallback;
}

const dueMinutes = () => numberFromEnv('CALLBACK_DUE_MINUTES', 15, 1, 24 * 60);
const settleSeconds = () => numberFromEnv('CALLBACK_SETTLE_SECONDS', 60, 0, 30 * 60);

const ms = (d) => (d ? new Date(d).getTime() : null);

// { dueAt, overdue, minutes } for an open task; null once resolved.
function dueStateOf(task, { now = Date.now(), minutes = dueMinutes() } = {}) {
  if (!task || task.state !== 'open') return null;
  const T = minutes * 60 * 1000;
  const first = ms(task.firstMissedAt);
  const last = ms(task.lastMissedAt) ?? first;
  const next = ms(task.nextCallbackAt);
  const scheduledAt = ms(task.scheduledAt);
  const queuedAt = ms(task.lastQueuedAt) ?? last;
  let dueAt;
  if (next != null) {
    dueAt = scheduledAt != null && last != null && queuedAt > scheduledAt ? Math.min(next, last + T) : next;
  } else {
    dueAt = (first ?? now) + T;
  }
  return { dueAt: new Date(dueAt), overdue: now > dueAt, minutes };
}

module.exports = { dueMinutes, settleSeconds, dueStateOf };
