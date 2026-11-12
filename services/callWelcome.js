'use strict';
/**
 * services/callWelcome.js
 * ============================================================
 * Sends the approved Utility template "savelife_pickup" (static text, no
 * header, no variables, one quick-reply "Send Location") to a caller, so
 * they can share their pickup on WhatsApp. What happens after the tap is
 * services/waWelcomeLocation.js — not here (it matches "Send Location").
 *
 *   onIncomingCall()  callController.incoming, for a customer's call
 *                     (CallLog.callbackEligible). Never awaited there; off
 *                     unless WA_CALL_WELCOME_ENABLED=true.
 *   send()            the same send — also POST /api/calls/:id/send-welcome
 *                     (an operator's button), which works whatever the flag.
 *
 * At most ONE per number per IST calendar day (models/WhatsAppWelcomeSend;
 * its unique (phone, istDate) index is the lock). A failed send may be
 * retried the same day; a sent one is not repeated until the next IST day.
 *
 * Template: WA_WELCOME_TEMPLATE_NAME (default savelife_pickup), language
 * WA_WELCOME_TEMPLATE_LANG (default en — must be the approved template's
 * exact code). WA_WELCOME_IMAGE_URL only for a template WITH an image
 * header: unset/empty -> the template is sent with no components at all
 * (savelife_pickup has no header and no body variables); set -> it must be
 * a public https JPG/PNG and goes in as the header image.
 * Never throws.
 * ============================================================
 */
const WhatsAppWelcomeSend = require('../models/WhatsAppWelcomeSend');
const whatsapp = require('./whatsappService');
const { normalisePhone } = require('../utils/phone');
const { IST_OFFSET_MS } = require('../utils/leadFollowUp');

const SENDING_STALE_MS = 2 * 60 * 1000; // a 'sending' claim older than this crashed mid-send

const autoEnabled = () => process.env.WA_CALL_WELCOME_ENABLED === 'true';
const templateName = () => (process.env.WA_WELCOME_TEMPLATE_NAME || '').trim() || 'savelife_pickup';
const templateLang = () => (process.env.WA_WELCOME_TEMPLATE_LANG || '').trim() || 'en';
const imageUrl = () => (process.env.WA_WELCOME_IMAGE_URL || '').trim();

const isMobile = (ten) => /^[6-9]\d{9}$/.test(ten);

// 'YYYY-MM-DD' of the India calendar day at `now`.
function istDate(now = Date.now()) {
  return new Date(new Date(now).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Meta's error code -> a reason staff can act on.
function explain(code, message) {
  const name = templateName();
  const lang = templateLang();
  switch (Number(code)) {
    case 132001:
      return { reason: 'template_not_approved', message: `WhatsApp has no approved template "${name}" in language "${lang}" — it may still be in review, or WA_WELCOME_TEMPLATE_LANG is not the template's exact language code.` };
    case 132000: case 132012: case 131008: case 131009: case 131053:
      return { reason: 'template_rejected', message: imageUrl()
        ? `WhatsApp rejected the template's header image or parameters — check WA_WELCOME_IMAGE_URL is a public JPG/PNG, and leave it empty for a template with no image header (${message || 'no detail'}).`
        : `WhatsApp rejected the template's parameters — "${name}" was sent with none, so the approved template may expect a header or variables (${message || 'no detail'}).` };
    case 131026:
      return { reason: 'not_on_whatsapp', message: 'This number cannot receive WhatsApp messages (not on WhatsApp, or an old app version).' };
    case 131049:
      return { reason: 'marketing_limit', message: 'WhatsApp held this marketing message back (its per-customer marketing limit). Try again tomorrow.' };
    case 131050:
      return { reason: 'opted_out', message: 'This customer has stopped marketing messages from SaveLife on WhatsApp.' };
    case 130429: case 131056: case 80007:
      return { reason: 'rate_limited', message: 'WhatsApp rate limit reached — try again in a few minutes.' };
    case 190: case 10: case 200:
      return { reason: 'auth', message: 'WhatsApp rejected our access token (WA_TOKEN) — it may have expired.' };
    default:
      return { reason: 'whatsapp_error', message: `WhatsApp refused the message${code != null ? ` (code ${code})` : ''}: ${message || 'no detail'}` };
  }
}

// The day's row for this number, held for this send — or why not.
async function claim(ten, day, set) {
  try {
    return { doc: await WhatsAppWelcomeSend.create({ phone: ten, istDate: day, status: 'sending', ...set }) };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const existing = await WhatsAppWelcomeSend.findOne({ phone: ten, istDate: day });
  if (!existing) return { busy: true };
  if (existing.status === 'sent') return { already: existing };
  if (existing.status === 'sending' && Date.now() - new Date(existing.updatedAt).getTime() < SENDING_STALE_MS) return { busy: true };
  // failed (or a crashed send): retake it — only if nobody else just did.
  const doc = await WhatsAppWelcomeSend.findOneAndUpdate(
    { _id: existing._id, status: existing.status, updatedAt: existing.updatedAt },
    { $set: { status: 'sending', ...set }, $inc: { attempts: 1 }, $unset: { error: 1 } },
    { new: true },
  );
  return doc ? { doc } : { busy: true };
}

/**
 * Returns { status, ... }:
 *   sent                 { sentAt, wamid }
 *   already_sent_today   { sentAt }
 *   in_progress          another send for this number is in flight right now
 *   not_mobile           no Indian mobile number to send to
 *   failed               { reason, message, code? }
 */
async function send({ phone, source, callLog, sentBy } = {}) {
  try {
    const ten = normalisePhone(phone);
    if (!isMobile(ten)) return { status: 'not_mobile', message: 'No Indian mobile number on this call.' };
    // No image configured -> no components at all (savelife_pickup: no
    // header, no body variables, a static quick-reply that takes nothing).
    const link = imageUrl();
    if (link && !/^https:\/\/\S+$/i.test(link)) {
      return { status: 'failed', reason: 'image_url_invalid', message: 'WA_WELCOME_IMAGE_URL must be a public https image, or empty for a template with no image header.' };
    }
    const components = link ? [{ type: 'header', parameters: [{ type: 'image', image: { link } }] }] : undefined;

    const day = istDate();
    const c = await claim(ten, day, { source, ...(callLog ? { callLog } : {}), ...(sentBy ? { sentBy } : {}) });
    if (c.already) return { status: 'already_sent_today', sentAt: c.already.sentAt || null };
    if (c.busy) return { status: 'in_progress', message: 'A welcome message to this number is being sent right now.' };

    const r = await whatsapp.sendTemplateResult(`91${ten}`, templateName(), templateLang(), components);
    if (r.ok) {
      const sentAt = new Date();
      const wamid = r.data?.messages?.[0]?.id;
      await WhatsAppWelcomeSend.updateOne({ _id: c.doc._id }, { $set: { status: 'sent', sentAt, ...(wamid ? { wamid } : {}) } });
      console.info(`[callWelcome] accepted (${source})`, { wamid: wamid ?? null });
      return { status: 'sent', sentAt, ...(wamid ? { wamid } : {}) };
    }
    const why = explain(r.error?.code, r.error?.message);
    await WhatsAppWelcomeSend.updateOne({ _id: c.doc._id }, { $set: { status: 'failed', error: { code: r.error?.code ?? undefined, ...why } } });
    console.warn(`[callWelcome] not sent (${source}): ${why.reason}`, { code: r.error?.code ?? null });
    return { status: 'failed', code: r.error?.code ?? null, ...why };
  } catch (err) {
    console.error('[callWelcome] send failed:', err.message);
    return { status: 'failed', reason: 'server_error', message: err.message };
  }
}

// A customer's incoming call: the welcome, once a day, if switched on.
async function onIncomingCall(phone, callLog) {
  if (!autoEnabled()) return { status: 'disabled' };
  return send({ phone, source: 'incoming_call', callLog });
}

module.exports = { send, onIncomingCall, autoEnabled, istDate, explain, SENDING_STALE_MS };
