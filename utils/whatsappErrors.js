'use strict';

// ============================================================
// utils/whatsappErrors.js — Meta's WhatsApp Cloud API errors in plain words.
// ============================================================
// A send can be rejected for many reasons besides an unapproved template —
// wrong language code, variable count, an expired token, a number not on
// WhatsApp, a rate limit, a billing problem. The CRM shows the operator
// the actual reason, with Meta's code, instead of guessing.
//
// retryLater: the same send may succeed later without anyone changing
// anything (rate limits, temporary errors). Otherwise a resend will fail
// the same way until the cause is fixed.
// ============================================================

const CODES = {
  132001: { text: (t) => `Template "${t.name}" does not exist in language "${t.language}" (or is not approved under that exact name and language). Check it in WhatsApp Manager → Message templates.` },
  132000: { text: (t) => `Template "${t.name}" expects a different number of variables than the ${t.params} we send.` },
  132005: { text: () => 'The template text with the link filled in is too long.' },
  132007: { text: () => 'The template content breaks WhatsApp policy.' },
  132012: { text: () => 'A template variable is in the wrong format for this template.' },
  132015: { text: (t) => `Template "${t.name}" is paused by WhatsApp (low quality). Edit or wait for it to be reactivated in WhatsApp Manager.` },
  132016: { text: (t) => `Template "${t.name}" is disabled by WhatsApp.` },
  131026: { text: () => 'Message undeliverable — the number may not be on WhatsApp, or the customer has not accepted WhatsApp\'s latest terms.' },
  131030: { text: () => 'This number is not in the allowed recipients list — the WhatsApp number is still in test mode.' },
  131031: { text: () => 'The WhatsApp Business account is locked or restricted.' },
  131042: { text: () => 'Payment issue on the WhatsApp Business account (no valid payment method or a billing problem).' },
  131045: { text: () => 'The sending phone number is not registered with WhatsApp Cloud API.' },
  131049: { text: () => 'WhatsApp chose not to deliver this message (per-customer limit to protect engagement).', retryLater: true },
  131056: { text: () => 'Too many messages to this customer in a short time.', retryLater: true },
  131048: { text: () => 'Spam rate limit reached on this WhatsApp number.', retryLater: true },
  130429: { text: () => 'WhatsApp throughput limit reached.', retryLater: true },
  131000: { text: () => 'WhatsApp had an internal error.', retryLater: true },
  131016: { text: () => 'WhatsApp service temporarily unavailable.', retryLater: true },
  133010: { text: () => 'The sending phone number is not registered on WhatsApp.' },
  368:    { text: () => 'The WhatsApp account is temporarily blocked for a policy violation.' },
  190:    { text: () => 'The server\'s WhatsApp access token has expired or is invalid — WA_TOKEN must be renewed.' },
  10:     { text: () => 'The server\'s WhatsApp token lacks permission for this number.' },
  200:    { text: () => 'The server\'s WhatsApp token lacks permission for this number.' },
};

// One line for the operator. `template` = { name, language, params }.
function explainSendFailure(outcome, error, template = {}) {
  if (outcome === 'unknown') {
    return {
      text: 'No answer from WhatsApp (timed out) — the message may or may not have reached the customer. Ask them, or share the link by hand, before resending.',
      retryLater: true,
    };
  }
  const known = CODES[Number(error?.code)];
  const metaSays = [error?.title, error?.details || error?.message].filter(Boolean).join(': ');
  if (known) {
    return { text: `${known.text(template)}${error?.code != null ? ` (WhatsApp error ${error.code})` : ''}`, retryLater: !!known.retryLater };
  }
  return {
    text: `WhatsApp rejected the message${error?.code != null ? ` (error ${error.code})` : ''}${metaSays ? `: ${metaSays}` : '.'}`,
    retryLater: Number(error?.httpStatus) >= 500,
  };
}

module.exports = { explainSendFailure };
