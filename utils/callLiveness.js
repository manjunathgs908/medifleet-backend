'use strict';

// ============================================================
// utils/callLiveness.js — is a call log's "active" status still true?
// ============================================================
// A CallLog's status is set only from Plivo's own reports (Dial results and
// the hang-up). If the last report never arrives, the stored status can stay
// "ringing" long after the call ended. This never rewrites that status into
// missed/completed — the outcome is unknown — it only tells the CRM whether
// "Ringing" can still be true, so it can say "Status unconfirmed" instead.
// ============================================================

// Statuses that mean "this call is still going".
const ACTIVE_STATUSES = ['ringing', 'initiated', 'agent_answered'];

// No call can still be live after this: every <Dial> has timeLimit 3600s,
// plus at most 15s ringing in the app and 40s on phones, plus slack.
const MAX_LIVE_MS = (3600 + 15 + 40 + 5 * 60) * 1000;

// Younger than this, a call missing from Plivo's live list may simply not
// have shown up there yet.
const PLIVO_CHECK_AFTER_MS = 3 * 60 * 1000;

//   null          — the call has a final status
//   'active'      — may genuinely be ringing / in progress
//   'in_call'     — answered in the app, end not yet reported
//   'unconfirmed' — the call has ended (hang-up received, gone from Plivo's
//                   live calls, or older than any call can be) but its
//                   final outcome never arrived
function liveStateOf(log, { notLiveOnPlivo = false, now = Date.now() } = {}) {
  if (!log || !ACTIVE_STATUSES.includes(log.status)) return null;
  const started = new Date(log.startedAt || log.createdAt || now).getTime();
  if (log.endedAt) return { state: 'unconfirmed', reason: 'hangup_received' };
  if (notLiveOnPlivo) return { state: 'unconfirmed', reason: 'not_live_on_plivo' };
  if (now - started > MAX_LIVE_MS) return { state: 'unconfirmed', reason: 'too_old' };
  return { state: log.answeredAt ? 'in_call' : 'active' };
}

// Plivo has reported the hang-up, or a final outcome is recorded: nothing
// may set the call back to an active state.
const callHasEnded = (log) => !!log.endedAt || !ACTIVE_STATUSES.includes(log.status);

module.exports = { ACTIVE_STATUSES, MAX_LIVE_MS, PLIVO_CHECK_AFTER_MS, liveStateOf, callHasEnded };
