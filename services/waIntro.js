'use strict';
/**
 * services/waIntro.js
 * ============================================================
 * Team inbox on the ONE SaveLife WhatsApp number: who owns a chat, and the
 * optional introduction card / handover message a telecaller can send.
 * Never part of the bot (services/whatsappFlow.js) and never required for
 * a booking — help comes first; the introduction is a courtesy.
 *
 * WhatsApp's 24-hour rule: a free-form message (image or text) may only be
 * sent within 24 hours of the customer's LAST INBOUND message
 * (WhatsAppContact.lastInboundAt, written by the webhook on every inbound
 * message). Outside it, nothing here sends — no template trick, no retry
 * later. A one-minute safety margin is kept before the window closes.
 *
 * Introduction (once per chat, ever):
 *   only the chat's assignee; only with their consent, a photo, a display
 *   name and at least one language (StaffProfile); only inside the window;
 *   claimed atomically before calling WhatsApp (two taps / two devices
 *   send once); recorded with WhatsApp's message id; never resent — later
 *   assignees send the short handover message instead.
 * Handover (once per new assignee):
 *   only when the chat was reassigned to you from someone else; consent
 *   (it shares your name), inside the window.
 * The customer's chat keeps SaveLife's logo as the sender; the photo is an
 * image message inside the chat. The photo goes to WhatsApp's media store,
 * never to a public URL.
 * ============================================================
 */
const WhatsAppConversation = require('../models/WhatsAppConversation');
const WhatsAppContact = require('../models/WhatsAppContact');
const StaffProfile = require('../models/StaffProfile');
const whatsapp = require('./whatsappService');

const WINDOW_MS = 24 * 3600 * 1000;
const WINDOW_MARGIN_MS = 60 * 1000;
const SENDING_STALE_MS = 2 * 60 * 1000;

// Language names as the caption writes them (Kannada script), and for the CRM.
const LANGUAGE_KN = { kn: 'ಕನ್ನಡ', hi: 'ಹಿಂದಿ', en: 'English', ta: 'ತಮಿಳು', te: 'ತೆಲುಗು', ml: 'ಮಲಯಾಳಂ', mr: 'ಮರಾಠಿ' };
const LANGUAGE_EN = { kn: 'Kannada', hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', mr: 'Marathi' };
const TITLE_KN = { sahayaki: 'ಸಹಾಯಕಿ', sahayaka: 'ಸಹಾಯಕ' };

// "ಕನ್ನಡ, ಹಿಂದಿ ಅಥವಾ English"
function languageList(codes) {
  const names = (codes || []).map((c) => LANGUAGE_KN[c]).filter(Boolean);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ಅಥವಾ ${names[names.length - 1]}`;
}

function introCaption({ displayName, title, languages }) {
  return [
    'ನಮಸ್ಕಾರ 🙏',
    `ನಾನು ${displayName} — SaveLife Booking ${TITLE_KN[title] || TITLE_KN.sahayaki}.`,
    `ನಿಮ್ಮ ambulance ವ್ಯವಸ್ಥೆಗೆ ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ. ${languageList(languages)} ನಲ್ಲಿ ಮಾತನಾಡಬಹುದು.`,
  ].join('\n');
}

const handoverText = (newName) => `ಇನ್ನು ಮುಂದೆ ನನ್ನ ಸಹೋದ್ಯೋಗಿ ${newName} ನಿಮಗೆ ಸಹಾಯ ಮಾಡುತ್ತಾರೆ. ನೀವು ಕೊಟ್ಟ ವಿವರಗಳು ಅವರಿಗೆ ಲಭ್ಯವಿವೆ.`;

// The 24-hour customer-service window from the last inbound message time.
function windowFrom(lastInboundAt, now = Date.now()) {
  const last = lastInboundAt ? new Date(lastInboundAt).getTime() : null;
  if (!Number.isFinite(last)) return { open: false, lastInboundAt: null, closesAt: null };
  const closesAt = last + WINDOW_MS;
  return { open: now < closesAt - WINDOW_MARGIN_MS, lastInboundAt: new Date(last), closesAt: new Date(closesAt) };
}
// …for a 10-digit number.
async function windowOf(phone10, now = Date.now()) {
  const c = await WhatsAppContact.findOne({ phone: phone10 }).select('lastInboundAt').lean();
  return windowFrom(c?.lastInboundAt, now);
}

// What a profile still lacks before it can be used with customers.
function profileGaps(p) {
  const gaps = [];
  if (!p?.consent?.given) gaps.push('consent');
  if (!p?.photo?.bytes) gaps.push('photo');
  if (!String(p?.displayName || '').trim()) gaps.push('name');
  if (!(p?.languages || []).length) gaps.push('languages');
  return gaps;
}
const GAP_TEXT = {
  consent: 'agree to share your photo and name with customers',
  photo: 'add a professional photo',
  name: 'set your display name',
  languages: 'pick the languages you speak',
};
const gapsMessage = (gaps) => `In My profile, ${gaps.map((g) => GAP_TEXT[g]).join(', ')} first.`;

const fail = (status, code, message) => ({ ok: false, status, code, message });
const waTo = (phone10) => `91${phone10}`;

// The buttons for one chat, as the given user sees them (the server
// enforces the same rules when they are pressed).
function actionsFor(conv, user, profile, win) {
  const mine = !!conv?.assignedTo && String(conv.assignedTo) === String(user._id);
  const gaps = profileGaps(profile);
  const closed = 'Outside WhatsApp\'s 24-hour window: the customer has not messaged in the last 24 hours, so WhatsApp allows only approved templates. This unlocks when they message again.';
  const intro = (() => {
    if (conv?.intro?.at) return { state: 'sent', enabled: false, reason: `Introduction already sent${conv.intro.byName ? ` by ${conv.intro.byName}` : ''}.` };
    if (!mine) return { state: 'not_mine', enabled: false, reason: 'Only the person this chat is assigned to can introduce themselves.' };
    if (gaps.length) return { state: 'profile', enabled: false, reason: gapsMessage(gaps) };
    if (!win.open) return { state: 'window_closed', enabled: false, reason: closed };
    return { state: 'ready', enabled: true, reason: null };
  })();
  const from = conv?.handoverFrom;
  const sentByMe = (conv?.handovers || []).find((h) => h.at && String(h.by) === String(user._id) && conv.assignedAt && new Date(h.at) >= new Date(conv.assignedAt));
  const handover = (() => {
    if (!mine || !from?.user || String(from.user) === String(user._id)) return { state: 'none', enabled: false, reason: null };
    if (sentByMe) return { state: 'sent', enabled: false, reason: 'Handover message already sent.', at: sentByMe.at };
    if (!profile?.consent?.given || !String(profile?.displayName || '').trim()) return { state: 'profile', enabled: false, reason: gapsMessage(profileGaps(profile).filter((g) => g === 'consent' || g === 'name')) };
    if (!win.open) return { state: 'window_closed', enabled: false, reason: closed };
    return { state: 'ready', enabled: true, reason: null, fromName: from.name };
  })();
  return { mine, intro, handover };
}

async function sendIntro(phone10, user, { now = Date.now() } = {}) {
  const conv = await WhatsAppConversation.findOne({ phone: phone10 }).lean();
  if (!conv || String(conv.assignedTo || '') !== String(user._id)) return fail(403, 'NOT_ASSIGNED', 'Only the person this chat is assigned to can introduce themselves.');
  if (conv.intro?.at) return fail(409, 'ALREADY_SENT', `Introduction already sent${conv.intro.byName ? ` by ${conv.intro.byName}` : ''}.`);
  const profile = await StaffProfile.findOne({ user: user._id }).select('+photo.data').lean();
  const gaps = profileGaps(profile);
  if (gaps.length) return fail(400, 'PROFILE_INCOMPLETE', gapsMessage(gaps));
  const win = await windowOf(phone10, now);
  if (!win.open) return fail(409, 'WINDOW_CLOSED', 'Outside WhatsApp\'s 24-hour window — the introduction can be sent after the customer messages again.');

  // Claim: still mine, never sent, no other send in flight.
  const claimed = await WhatsAppConversation.findOneAndUpdate(
    {
      phone: phone10, assignedTo: user._id, 'intro.at': null,
      $or: [{ 'intro.sendingAt': null }, { 'intro.sendingAt': { $lt: new Date(now - SENDING_STALE_MS) } }],
    },
    { $set: { 'intro.sendingAt': new Date(now), 'intro.sendingBy': user._id } },
    { new: true },
  );
  if (!claimed) return fail(409, 'IN_PROGRESS', 'The introduction is being sent or was just sent — refresh the chat.');

  const release = () => WhatsAppConversation.updateOne({ phone: phone10, 'intro.sendingBy': user._id, 'intro.at': null }, { $unset: { 'intro.sendingAt': 1, 'intro.sendingBy': 1 } });
  const caption = introCaption(profile);
  const media = await whatsapp.uploadMediaResult(Buffer.from(profile.photo.data.buffer || profile.photo.data), profile.photo.contentType);
  if (!media.ok) { await release(); return fail(502, 'WHATSAPP', `WhatsApp did not accept the photo: ${media.error?.message || 'unknown error'}. Nothing was sent.`); }
  const sentMsg = await whatsapp.sendImageResult(waTo(phone10), media.data.id, caption,
    { sender: 'staff', senderName: user.name, senderUser: user._id, kind: 'intro', media: { kind: 'profile', user: user._id } }); // message log tag
  if (!sentMsg.ok) { await release(); return fail(502, 'WHATSAPP', `WhatsApp did not send the introduction: ${sentMsg.error?.message || 'unknown error'}.`); }
  const wamid = sentMsg.data?.messages?.[0]?.id || null;
  const byName = profile.displayName || user.name;
  await WhatsAppConversation.updateOne(
    { phone: phone10 },
    { $set: { 'intro.at': new Date(now), 'intro.by': user._id, 'intro.byName': byName, 'intro.wamid': wamid }, $unset: { 'intro.sendingAt': 1, 'intro.sendingBy': 1 } },
  );
  return { ok: true, caption, wamid, byName };
}

async function sendHandover(phone10, user, { now = Date.now() } = {}) {
  const conv = await WhatsAppConversation.findOne({ phone: phone10 }).lean();
  if (!conv || String(conv.assignedTo || '') !== String(user._id)) return fail(403, 'NOT_ASSIGNED', 'Only the person this chat is assigned to can send the handover message.');
  const profile = await StaffProfile.findOne({ user: user._id }).lean();
  const win = await windowOf(phone10, now);
  const a = actionsFor(conv, user, profile, win).handover;
  if (!a.enabled) return fail(a.state === 'window_closed' ? 409 : a.state === 'sent' ? 409 : 400, `HANDOVER_${a.state.toUpperCase()}`, a.reason || 'A handover message is for a chat reassigned to you from a colleague.');

  // Claim one handover per assignment.
  const claimed = await WhatsAppConversation.findOneAndUpdate(
    {
      phone: phone10, assignedTo: user._id, assignedAt: conv.assignedAt,
      handovers: { $not: { $elemMatch: { by: user._id, $or: [{ at: { $gte: conv.assignedAt } }, { sendingAt: { $gte: new Date(now - SENDING_STALE_MS) } }] } } },
    },
    { $push: { handovers: { by: user._id, byName: profile.displayName, sendingAt: new Date(now) } } },
    { new: true },
  );
  if (!claimed) return fail(409, 'IN_PROGRESS', 'The handover message is being sent or was just sent — refresh the chat.');
  const text = handoverText(profile.displayName);
  const r = await whatsapp.sendTextResult(waTo(phone10), text, { sender: 'staff', senderName: user.name, senderUser: user._id, kind: 'handover' }); // message log tag
  if (!r.ok) {
    await WhatsAppConversation.updateOne({ phone: phone10 }, { $pull: { handovers: { by: user._id, sendingAt: new Date(now), at: null } } });
    return fail(502, 'WHATSAPP', `WhatsApp did not send the handover message: ${r.error?.message || 'unknown error'}.`);
  }
  await WhatsAppConversation.updateOne(
    { phone: phone10 },
    { $set: { 'handovers.$[h].at': new Date(now), 'handovers.$[h].wamid': r.data?.messages?.[0]?.id || null }, $unset: { 'handovers.$[h].sendingAt': 1 } },
    { arrayFilters: [{ 'h.by': user._id, 'h.sendingAt': new Date(now) }] },
  );
  return { ok: true, text };
}

module.exports = {
  WINDOW_MS, WINDOW_MARGIN_MS, LANGUAGE_KN, LANGUAGE_EN,
  languageList, introCaption, handoverText, windowFrom, windowOf, profileGaps, actionsFor, sendIntro, sendHandover,
};
