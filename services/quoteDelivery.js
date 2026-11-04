'use strict';

// ============================================================
// services/quoteDelivery.js — the WhatsApp message that carries a quote link.
// ============================================================
// Kept apart from the quote's own status (sent/viewed/confirmed is about
// the LINK). For the message:
//   our send     → accepted (Meta took it — NOT delivered), rejected (Meta
//                  said no: the reason is stored), or unknown (no answer —
//                  it may or may not have gone out)
//   Meta webhook → sent → delivered → read, or failed
//
// Sending is one-at-a-time per quote (whatsappSendingAt is claimed
// atomically), so a double click or two operators can never send twice.
// A resend is only ever an explicit operator action (POST
// /api/quotes/:id/resend-whatsapp), never automatic.
// ============================================================

const Quote = require('../models/Quote');
const whatsappNotifications = require('./whatsappNotifications');

// A resend is allowed only when the last message did not go out, or when
// nobody knows (unknown — and then only with the operator's confirmation).
const RESENDABLE = ['rejected', 'unknown', 'failed'];
// A send still "in flight" this long ago was interrupted (server restart).
const STALE_SEND_MS = 2 * 60 * 1000;

// Webhook statuses only ever move forward: from each, the statuses it may
// replace. A late "sent" never overwrites "read"; "failed" never
// overwrites a delivery Meta already reported.
const MAY_REPLACE = {
  sent     : ['accepted', 'unknown'],
  delivered: ['accepted', 'unknown', 'sent'],
  read     : ['accepted', 'unknown', 'sent', 'delivered'],
  failed   : ['accepted', 'unknown', 'sent'],
};

// For quotes from before whatsappStatus existed.
function messageStatusOf(quote) {
  if (quote.whatsappStatus) return quote.whatsappStatus;
  if (quote.whatsappSent) return 'accepted';
  return quote.whatsappError ? 'unknown' : null; // old failures didn't record why
}

// Sends the quote's link once. `allowFrom` limits which message states a
// (re)send may start from; null = the first send of a new quote.
// Returns { ok, result } or { ok: false, reason: 'busy' | 'not_allowed' }.
async function sendQuoteLink(quote, url, { allowFrom = null } = {}) {
  const now = new Date();
  const notSending = { $or: [{ whatsappSendingAt: null }, { whatsappSendingAt: { $lt: new Date(now - STALE_SEND_MS) } }] };
  const allowed = allowFrom
    ? { $or: [{ whatsappStatus: { $in: allowFrom } }, { whatsappStatus: null, whatsappSent: { $ne: true } }] }
    : {};
  const claimed = await Quote.findOneAndUpdate(
    { _id: quote._id, $and: [notSending, allowed] },
    { $set: { whatsappSendingAt: now }, $inc: { whatsappAttempts: 1 } },
    { new: true },
  );
  if (!claimed) {
    const current = await Quote.findById(quote._id).select('whatsappSendingAt whatsappStatus whatsappSent whatsappError').lean();
    const busy = current?.whatsappSendingAt && current.whatsappSendingAt > new Date(now - STALE_SEND_MS);
    return { ok: false, reason: busy ? 'busy' : 'not_allowed', status: current ? messageStatusOf(current) : null };
  }

  let result;
  try {
    result = await whatsappNotifications.notifyQuoteLink(quote.phone, url);
  } catch (err) {
    result = { outcome: 'unknown', skipped: true, reason: `Send could not be completed: ${err.message}` };
  }
  const outcome = result?.outcome || (result?.skipped ? 'unknown' : 'accepted');
  const accepted = outcome === 'accepted';

  const set = {
    whatsappStatus       : accepted ? 'accepted' : outcome,
    whatsappSent         : accepted,
    whatsappLastAttemptAt: now,
    whatsappStatusAt     : new Date(),
  };
  const unset = { whatsappSendingAt: 1 };
  if (accepted) {
    const id = result.messageId || result.messages?.[0]?.id;
    if (id) set.whatsappMessageId = id;
    unset.whatsappError = 1;
    unset.whatsappErrorCode = 1;
    unset.whatsappRetryLater = 1;
  } else {
    set.whatsappError = result?.reason || 'WhatsApp did not accept the message.';
    if (result?.error?.code != null) set.whatsappErrorCode = String(result.error.code);
    else unset.whatsappErrorCode = 1;
    set.whatsappRetryLater = !!result?.retryLater;
  }
  await Quote.updateOne({ _id: quote._id }, { $set: set, $unset: unset });
  // What was written, so the caller can answer without re-reading.
  return { ok: true, result: { ...result, outcome }, fields: { set, unset: Object.keys(unset) } };
}

// One status from Meta's webhook (value.statuses[]). Applies only to a
// quote's own message, only forward, as one conditional update. Never
// throws (the webhook must keep processing).
async function applyWhatsAppStatus(status) {
  try {
    const next = String(status?.status || '');
    if (!status?.id || !MAY_REPLACE[next]) return false;
    const set = { whatsappStatus: next, whatsappStatusAt: new Date() };
    if (next === 'failed') {
      const e = status.errors?.[0] || {};
      set.whatsappSent = false;
      set.whatsappError = `Not delivered: ${[e.title, e.error_data?.details || e.message].filter(Boolean).join(' — ') || 'WhatsApp reported a failure'}${e.code != null ? ` (WhatsApp error ${e.code})` : ''}`;
      if (e.code != null) set.whatsappErrorCode = String(e.code);
    }
    const r = await Quote.updateOne(
      { whatsappMessageId: status.id, whatsappStatus: { $in: MAY_REPLACE[next] } },
      { $set: set },
    );
    return r?.modifiedCount > 0;
  } catch (err) {
    console.error('[quoteDelivery] status update failed:', err.message);
    return false;
  }
}

module.exports = { sendQuoteLink, applyWhatsAppStatus, messageStatusOf, RESENDABLE };
