'use strict';
/**
 * services/waChat.js
 * ============================================================
 * Two-way WhatsApp chat in the CRM, on the ONE SaveLife number. Additive:
 * the booking bot (services/whatsappFlow.js) is not changed — it only stops
 * being CALLED for a customer a staff member has taken over.
 *
 * Human takeover — WhatsAppConversation.mode, per customer:
 *   'bot'    (default) every inbound message is logged, then handled
 *            exactly as before (location requests, welcome location, bot)
 *   'human'  every inbound message is logged and NOTHING automated
 *            replies — no bot, no location/welcome automation — until
 *            someone hands the chat back to the bot
 *   Set by "Take over from bot", or by a staff reply; cleared by "Hand back
 *   to bot", or when the owner unassigns the chat (nobody would be
 *   watching it). Any failure to read the mode lets the bot run as before.
 *
 * Staff send (text, ambulance gallery photo, uploaded photo):
 *   owner on any chat; a telecaller only on a chat assigned to them; only
 *   inside WhatsApp's 24-hour window from the customer's last inbound
 *   message (services/waIntro.windowOf) — checked here, on the server.
 *   A row is written first (status 'sending', keyed by the client's
 *   clientMsgId so a double tap sends once), then finalised with
 *   WhatsApp's answer. Photos go through WhatsApp's media store — never a
 *   public URL.
 *
 * Customer numbers: never returned to a telecaller — not as a field, and
 * not inside a message: phone-like digit runs in message text are masked
 * for anyone who is not the CRM owner (utils/phoneViewer).
 * ============================================================
 */
const mongoose = require('mongoose');
const WhatsAppConversation = require('../models/WhatsAppConversation');
const WhatsAppContact = require('../models/WhatsAppContact');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const WaGalleryPhoto = require('../models/WaGalleryPhoto');
const WaChatMedia = require('../models/WaChatMedia');
const whatsapp = require('./whatsappService');
const messageLog = require('./waMessageLog');
const gallery = require('./waGallery');
const { windowOf } = require('./waIntro');
const { normalisePhone } = require('../utils/phone');
const { revealPhones } = require('../utils/phoneViewer');

const TEXT_MAX = 4096;          // WhatsApp's text limit
const CAPTION_MAX = 1024;       // WhatsApp's image caption limit
const IMAGE_MAX_BYTES = 1024 * 1024;
const THREAD_PAGE = 50;

const fail = (status, code, message) => ({ ok: false, status, code, message });
const waTo = (phone10) => `91${phone10}`;
const WINDOW_CLOSED = 'Outside WhatsApp\'s 24-hour window: the customer has not messaged in the last 24 hours, so WhatsApp allows only approved templates. This unlocks when they message again.';

// ── Masking ────────────────────────────────────────────────────────────
// Any run of 10+ digits (spaces, dashes, brackets and a leading + allowed
// between them) — e.g. "98450 12345", "+91-98450-12345". Dots are not
// separators, so dates ("28.11.2026 10:30") and coordinates stay readable.
const PHONE_RUN = /\+?\d(?:[\s()-]*\d){9,}/g;
function maskDigits(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(PHONE_RUN, (run) => `••••••${run.replace(/\D/g, '').slice(-4)}`);
}
const forViewer = (text) => (revealPhones() ? text : maskDigits(text));

// ── Who may act on a chat ──────────────────────────────────────────────
function permission(conv, user) {
  if (user?.role === 'owner') return { ok: true };
  if (conv?.assignedTo && String(conv.assignedTo) === String(user?._id)) return { ok: true };
  if (conv?.assignedTo) return { ok: false, reason: `This chat is assigned to ${conv.assignedToName || 'a colleague'} — only they or the owner can reply or take over.` };
  return { ok: false, reason: 'This chat is not assigned to you. Use "Assign to me" first, then you can reply.' };
}

const modeOf = (conv) => (conv?.mode === 'human' ? 'human' : 'bot');

// The chat's send/takeover buttons as `user` sees them (the server
// enforces the same rules when they are pressed).
function chatActionsFor(conv, user, win) {
  const perm = permission(conv, user);
  const mode = modeOf(conv);
  const reply = !perm.ok ? { enabled: false, reason: perm.reason }
    : !win?.open ? { enabled: false, reason: WINDOW_CLOSED }
      : { enabled: true, reason: null };
  return {
    reply,
    takeover: mode === 'bot' ? (perm.ok ? { enabled: true, reason: null } : { enabled: false, reason: perm.reason }) : { enabled: false, reason: null },
    handback: mode === 'human' ? (perm.ok ? { enabled: true, reason: null } : { enabled: false, reason: perm.reason }) : { enabled: false, reason: null },
  };
}

function modeState(conv) {
  return { value: modeOf(conv), at: conv?.modeAt || null, byName: conv?.modeByName || null };
}

// ── Webhook ────────────────────────────────────────────────────────────
/**
 * Every inbound message, before anything else: log it; then true when this
 * customer is in human mode (the caller must run NO automation for it).
 * Never throws; on any doubt returns false — the bot runs as before.
 */
async function onInbound(message) {
  await messageLog.logInbound(message);
  try {
    if (mongoose.connection.readyState !== 1) return false;
    const ten = normalisePhone(message?.from);
    if (ten.length !== 10) return false;
    const human = await WhatsAppConversation.exists({ phone: ten, mode: 'human' });
    if (!human) return false;
    // The 24-hour window: services/locationRequests.onInbound (skipped
    // now) writes this for every other message.
    await WhatsAppContact.updateOne({ phone: ten }, { $set: { lastInboundAt: new Date() } }, { upsert: true }).catch(() => {});
    return true;
  } catch (err) {
    console.error('[waChat] mode check failed, the bot handles this message:', err.message);
    return false;
  }
}

// ── Takeover / hand back ───────────────────────────────────────────────
async function writeMode(phone10, user, mode, via) {
  const now = new Date();
  const event = { type: mode === 'human' ? 'takeover' : 'handback', at: now, by: user._id, byName: user.name, via };
  const update = { $set: { mode, modeAt: now, modeBy: user._id, modeByName: user.name }, $push: { history: event } };
  if (mode === 'bot') {
    const r = await WhatsAppConversation.updateOne({ phone: phone10, mode: 'human' }, update);
    return r.modifiedCount > 0;
  }
  try {
    // Upsert: the owner may take over a chat nobody was ever assigned.
    const r = await WhatsAppConversation.updateOne({ phone: phone10, mode: { $ne: 'human' } }, update, { upsert: true, setDefaultsOnInsert: true });
    return (r.modifiedCount || r.upsertedCount) > 0;
  } catch (err) {
    if (err?.code === 11000) return false; // already human (or created at the same instant)
    throw err;
  }
}

async function setMode(phone10, user, mode) {
  const conv = await WhatsAppConversation.findOne({ phone: phone10 }).lean();
  const perm = permission(conv, user);
  if (!perm.ok) return fail(403, 'NOT_ASSIGNED', perm.reason);
  if (modeOf(conv) === mode) return { ok: true, changed: false };
  const changed = await writeMode(phone10, user, mode, 'button');
  return { ok: true, changed };
}

// ── Staff send ─────────────────────────────────────────────────────────
function parseImageDataUrl(dataUrl) {
  const m = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return fail(400, 'BAD_IMAGE', 'Send a JPEG or PNG photo.');
  const data = Buffer.from(m[2], 'base64');
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!(m[1] === 'image/jpeg' ? isJpeg : isPng)) return fail(400, 'BAD_IMAGE', 'That file is not a JPEG or PNG photo.');
  if (data.length > IMAGE_MAX_BYTES) return fail(413, 'TOO_LARGE', 'That photo is larger than 1 MB — choose a smaller one.');
  return { ok: true, data, contentType: m[1] };
}

const cleanClientId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

// Permission + window, for any staff send.
async function precheck(phone10, user) {
  const conv = await WhatsAppConversation.findOne({ phone: phone10 }).lean();
  const perm = permission(conv, user);
  if (!perm.ok) return fail(403, 'NOT_ASSIGNED', perm.reason);
  const win = await windowOf(phone10);
  if (!win.open) return fail(409, 'WINDOW_CLOSED', WINDOW_CLOSED);
  return { ok: true, conv };
}

// The 'sending' row — or, for a repeated clientMsgId, the row already made.
async function claimRow(fields) {
  try {
    return { row: await WhatsAppMessage.create(fields) };
  } catch (err) {
    if (err?.code === 11000 && fields.clientMsgId) {
      return { duplicate: await WhatsAppMessage.findOne({ phone: fields.phone, clientMsgId: fields.clientMsgId }).lean() };
    }
    throw err;
  }
}

async function finalise(row, r) {
  const wamid = r.ok ? r.data?.messages?.[0]?.id : null;
  const set = r.ok
    ? { status: 'sent', ...(typeof wamid === 'string' ? { waMessageId: wamid } : {}) }
    : { status: 'failed', error: String(r.error?.message || 'WhatsApp did not send it.').slice(0, 500) };
  try {
    await WhatsAppMessage.updateOne({ _id: row._id, status: 'sending' }, { $set: set });
  } catch (err) {
    // A wamid the log already holds — keep the status, drop the id.
    if (err?.code === 11000) await WhatsAppMessage.updateOne({ _id: row._id, status: 'sending' }, { $set: { status: set.status } });
    else throw err;
  }
}

async function afterStaffSend(phone10, user, conv) {
  if (modeOf(conv) !== 'human') await writeMode(phone10, user, 'human', 'reply');
}

const staffFields = (phone10, user, extra) => ({
  phone: phone10, direction: 'outbound', sender: 'staff', senderName: user.name, senderUser: user._id,
  kind: 'reply', status: 'sending', at: new Date(), ...extra,
});

async function sendText(phone10, user, { text, clientMsgId } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return fail(400, 'EMPTY', 'Type a message first.');
  if (body.length > TEXT_MAX) return fail(400, 'TOO_LONG', `A WhatsApp message can be at most ${TEXT_MAX} characters.`);
  const pre = await precheck(phone10, user);
  if (!pre.ok) return pre;

  const claim = await claimRow(staffFields(phone10, user, { type: 'text', body, clientMsgId: cleanClientId(clientMsgId) }));
  if (claim.duplicate) return { ok: true, duplicate: true, message: claim.duplicate };
  const r = await whatsapp.sendTextResult(waTo(phone10), body, { log: false });
  await finalise(claim.row, r);
  if (!r.ok) return fail(502, 'WHATSAPP', `WhatsApp did not send the message: ${r.error?.message || 'unknown error'}.`);
  await afterStaffSend(phone10, user, pre.conv);
  return { ok: true, message: await WhatsAppMessage.findById(claim.row._id).lean() };
}

/**
 * Either { galleryId } (a preset ambulance type with a photo set) or
 * { dataUrl } (a JPEG/PNG up to 1 MB), plus an optional caption.
 */
async function sendImage(phone10, user, { galleryId, dataUrl, caption, clientMsgId } = {}) {
  if (!!galleryId === !!dataUrl) return fail(400, 'BAD_REQUEST', 'Pick one ambulance photo or upload one photo.');
  const text = typeof caption === 'string' ? caption.trim() : '';
  if (text.length > CAPTION_MAX) return fail(400, 'TOO_LONG', `A photo caption can be at most ${CAPTION_MAX} characters.`);

  let image; let media;
  if (galleryId) {
    const preset = gallery.byId(String(galleryId));
    if (!preset) return fail(400, 'UNKNOWN_PHOTO', 'Unknown ambulance photo.');
    const doc = await WaGalleryPhoto.findOne({ key: preset.id }).select('+photo.data').lean();
    if (!doc?.photo?.bytes || !doc.photo.data) return fail(400, 'NO_PHOTO', `No photo has been added for ${preset.label} yet — the owner adds it in the gallery.`);
    image = { data: Buffer.from(doc.photo.data.buffer || doc.photo.data), contentType: doc.photo.contentType };
    media = { kind: 'gallery', galleryKey: preset.id };
  } else {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed.ok) return parsed;
    image = parsed;
  }

  const pre = await precheck(phone10, user);
  if (!pre.ok) return pre;
  const cid = cleanClientId(clientMsgId);
  if (cid) {
    const dup = await WhatsAppMessage.findOne({ phone: phone10, clientMsgId: cid }).lean();
    if (dup) return { ok: true, duplicate: true, message: dup };
  }
  if (!media) {
    const saved = await WaChatMedia.create({ phone: phone10, data: image.data, contentType: image.contentType, bytes: image.data.length, by: user._id, byName: user.name });
    media = { kind: 'upload', upload: saved._id };
  }

  const claim = await claimRow(staffFields(phone10, user, { type: 'image', body: text || undefined, media, clientMsgId: cid }));
  if (claim.duplicate) return { ok: true, duplicate: true, message: claim.duplicate };
  const up = await whatsapp.uploadMediaResult(image.data, image.contentType);
  if (!up.ok) {
    await finalise(claim.row, up);
    return fail(502, 'WHATSAPP', `WhatsApp did not accept the photo: ${up.error?.message || 'unknown error'}. Nothing was sent.`);
  }
  await WhatsAppMessage.updateOne({ _id: claim.row._id }, { $set: { mediaId: up.data.id } });
  const r = await whatsapp.sendImageResult(waTo(phone10), up.data.id, text || undefined, { log: false });
  await finalise(claim.row, r);
  if (!r.ok) return fail(502, 'WHATSAPP', `WhatsApp did not send the photo: ${r.error?.message || 'unknown error'}.`);
  await afterStaffSend(phone10, user, pre.conv);
  return { ok: true, message: await WhatsAppMessage.findById(claim.row._id).lean() };
}

// ── Thread ─────────────────────────────────────────────────────────────
// One stored message as the CRM shows it — never a number.
function present(m) {
  const preset = m.media?.galleryKey ? gallery.byId(m.media.galleryKey) : null;
  return {
    id: String(m._id),
    direction: m.direction,
    type: m.type,
    body: forViewer(m.body || ''),
    options: m.options?.length ? m.options.map(forViewer) : undefined,
    template: m.template || undefined,
    location: m.location?.lat != null || m.location?.address || m.location?.name
      ? { lat: m.location.lat, lng: m.location.lng, name: forViewer(m.location.name), address: forViewer(m.location.address) } : undefined,
    media: m.media?.kind
      ? { kind: m.media.kind, label: preset?.label, galleryId: preset?.id, uploadId: m.media.upload ? String(m.media.upload) : undefined, userId: m.media.user ? String(m.media.user) : undefined }
      : undefined,
    sender: m.sender,
    senderName: m.sender === 'staff' ? m.senderName : undefined,
    kind: m.kind || undefined,
    status: m.status,
    error: m.status === 'failed' ? forViewer(m.error || 'Not delivered') : undefined,
    at: m.at,
  };
}

/** A page of the thread, oldest first. `before` = the id of the oldest message on screen. */
async function thread(phone10, { before } = {}) {
  const q = { phone: phone10 };
  if (before && mongoose.isValidObjectId(String(before))) {
    const pivot = await WhatsAppMessage.findOne({ _id: String(before), phone: phone10 }).select('at').lean();
    if (pivot) q.$or = [{ at: { $lt: pivot.at } }, { at: pivot.at, _id: { $lt: pivot._id } }];
  }
  const rows = await WhatsAppMessage.find(q).sort({ at: -1, _id: -1 }).limit(THREAD_PAGE + 1).lean();
  const hasMore = rows.length > THREAD_PAGE;
  return { messages: rows.slice(0, THREAD_PAGE).reverse().map(present), hasMore };
}

// Assignment / takeover events and the introduction / handover (shown
// inline in the thread). An intro or handover sent before the message log
// existed has no stored message, so it comes from the conversation.
function events(conv, loggedKinds = new Set()) {
  if (!conv) return [];
  const out = (conv.history || []).map((h) => ({ type: h.type, at: h.at, byName: h.byName, from: h.from, to: h.to, via: h.via }));
  if (conv.intro?.at && !loggedKinds.has('intro')) out.push({ type: 'intro', at: conv.intro.at, byName: conv.intro.byName });
  if (!loggedKinds.has('handover')) for (const h of conv.handovers || []) if (h.at) out.push({ type: 'handover', at: h.at, byName: h.byName });
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

async function loggedKinds(phone10) {
  const kinds = await WhatsAppMessage.distinct('kind', { phone: phone10, kind: { $in: ['intro', 'handover'] } });
  return new Set(kinds);
}

// The newest message, for the conversation list (masked like the thread).
function lastMessagePreview(m) {
  if (!m) return null;
  const label = { image: '📷 Photo', location: '📍 Location', template: '📨 Template message', document: '📄 Document', audio: '🎤 Voice message', video: '🎬 Video', sticker: 'Sticker', contacts: '📇 Contact', reaction: 'Reaction' }[m.type];
  const text = (m.body || '').replace(/\s+/g, ' ').slice(0, 120);
  return { direction: m.direction, sender: m.sender, type: m.type, at: m.at, preview: forViewer(label ? (text ? `${label} · ${text}` : label) : text) };
}

module.exports = {
  onInbound, setMode, writeMode, sendText, sendImage, thread, events, loggedKinds, present, lastMessagePreview,
  chatActionsFor, modeState, permission, maskDigits, parseImageDataUrl,
  TEXT_MAX, CAPTION_MAX, IMAGE_MAX_BYTES, WINDOW_CLOSED,
};
