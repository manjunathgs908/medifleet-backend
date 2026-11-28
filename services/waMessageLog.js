'use strict';
/**
 * services/waMessageLog.js
 * ============================================================
 * Writes the two-way WhatsApp message log (models/WhatsAppMessage).
 *
 *   logInbound(message)        the webhook, for every inbound message,
 *                              before anything else handles it
 *   logOutbound(payload, r, m) whatsappService.postMessage, AFTER every
 *                              send (r = the send's result) — the payload
 *                              is only read, never changed
 *   onStatus(report)           the webhook's delivery reports: sent →
 *                              delivered → read (or failed), by wamid
 *
 * Logging must never change or block what the bot does: every function
 * here never throws, is skipped while MongoDB is not connected, and gives
 * up after LOG_TIMEOUT_MS so a slow write cannot hold up the next reply.
 * ============================================================
 */
const { normalisePhone } = require('../utils/phone');

const LOG_TIMEOUT_MS = 3000;
const BODY_MAX = 4096;

let Model = null;
const model = () => Model || (Model = require('../models/WhatsAppMessage'));

function dbReady() {
  try { return require('mongoose').connection.readyState === 1; } catch { return false; }
}

// Runs fn, but never throws and never waits longer than LOG_TIMEOUT_MS.
async function bounded(label, fn) {
  if (!dbReady()) return undefined;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => { timer = setTimeout(resolve, LOG_TIMEOUT_MS); if (timer.unref) timer.unref(); }),
    ]);
  } catch (err) {
    console.error(`[waMessageLog] ${label} not logged:`, err.message);
    return undefined;
  } finally { clearTimeout(timer); }
}

const clip = (s, max = BODY_MAX) => (typeof s === 'string' ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined);
const titles = (arr) => (arr || []).map((x) => clip(x, 100)).filter(Boolean);

// What an outbound Cloud API payload says, for the thread.
function fromPayload(p = {}) {
  switch (p.type) {
    case 'text': return { type: 'text', body: clip(p.text?.body) };
    case 'image': return { type: 'image', body: clip(p.image?.caption), mediaId: p.image?.id };
    case 'document': return { type: 'document', body: clip(p.document?.filename) };
    case 'template': return { type: 'template', template: clip(p.template?.name, 200) };
    case 'interactive': {
      const i = p.interactive || {};
      const body = clip(i.body?.text);
      if (i.type === 'button') return { type: 'interactive', body, options: titles((i.action?.buttons || []).map((b) => b?.reply?.title)) };
      if (i.type === 'list') return { type: 'interactive', body, options: titles((i.action?.sections || []).flatMap((s) => (s?.rows || []).map((r) => r?.title))) };
      if (i.type === 'location_request_message') return { type: 'interactive', body, options: ['📍 Send location'] };
      return { type: 'interactive', body };
    }
    default: return { type: 'other' };
  }
}

// What an inbound webhook message says, for the thread. A shared contact
// card keeps names only — never the numbers in it.
function fromInbound(m = {}) {
  switch (m.type) {
    case 'text': return { type: 'text', body: clip(m.text?.body) };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      return { type: 'interactive', body: clip(r?.title || '') };
    }
    case 'button': return { type: 'interactive', body: clip(m.button?.text || '') };
    case 'location': {
      const l = m.location || {};
      const lat = Number(l.latitude); const lng = Number(l.longitude);
      return {
        type: 'location',
        body: clip([l.name, l.address].filter(Boolean).join(' — ')),
        location: { lat: Number.isFinite(lat) ? lat : undefined, lng: Number.isFinite(lng) ? lng : undefined, name: clip(l.name, 200), address: clip(l.address, 500) },
      };
    }
    case 'image': case 'video': case 'audio': case 'sticker': case 'document': {
      const media = m[m.type] || {};
      return { type: m.type, mediaId: media.id, body: clip(media.caption || media.filename) };
    }
    case 'contacts': return { type: 'contacts', body: clip((m.contacts || []).map((c) => c?.name?.formatted_name).filter(Boolean).join(', ')) };
    case 'reaction': return { type: 'reaction', body: clip(m.reaction?.emoji || '') };
    default: return { type: 'other' };
  }
}

function logInbound(message) {
  return bounded('inbound', async () => {
    const phone = normalisePhone(message?.from);
    if (phone.length !== 10 || typeof message?.id !== 'string') return;
    const ts = Number(message.timestamp);
    await model().updateOne(
      { waMessageId: message.id },
      {
        $setOnInsert: {
          phone, direction: 'inbound', sender: 'customer', status: 'received', at: new Date(),
          ...(Number.isFinite(ts) ? { waTimestamp: new Date(ts * 1000) } : {}),
          ...fromInbound(message),
        },
      },
      { upsert: true },
    );
  });
}

/**
 * payload  the Cloud API payload exactly as sent
 * result   postMessage's { data } or { data: null, error }
 * meta     optional { sender, senderName, senderUser, kind, media } —
 *          a bot reply needs none (sender defaults to 'bot'; templates,
 *          which come from notifications/automation, to 'system')
 */
function logOutbound(payload, result, meta = {}) {
  return bounded('outbound', async () => {
    const phone = normalisePhone(payload?.to);
    if (phone.length !== 10) return;
    const wamid = result?.data?.messages?.[0]?.id;
    await model().create({
      phone, direction: 'outbound', at: new Date(),
      ...fromPayload(payload),
      sender: meta.sender || (payload?.type === 'template' ? 'system' : 'bot'),
      ...(meta.senderName ? { senderName: meta.senderName } : {}),
      ...(meta.senderUser ? { senderUser: meta.senderUser } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(meta.media ? { media: meta.media } : {}),
      ...(typeof wamid === 'string' ? { waMessageId: wamid, status: 'sent' } : { status: 'failed', error: clip(result?.error?.message || 'Not sent', 500) }),
    });
  });
}

// Delivery reports only move a message forward (sent → delivered → read).
const FORWARD = { delivered: ['sending', 'sent'], read: ['sending', 'sent', 'delivered'], failed: ['sending', 'sent'] };
function onStatus(report) {
  return bounded('status', async () => {
    const prev = FORWARD[report?.status];
    if (!prev || typeof report?.id !== 'string') return;
    const err = Array.isArray(report.errors) && report.errors[0];
    await model().updateOne(
      { waMessageId: report.id, status: { $in: prev } },
      { $set: { status: report.status, ...(report.status === 'failed' ? { error: clip(err?.title || err?.message || `WhatsApp error ${err?.code ?? ''}`.trim(), 500) } : {}) } },
    );
  });
}

module.exports = { logInbound, logOutbound, onStatus, fromPayload, fromInbound, LOG_TIMEOUT_MS };
