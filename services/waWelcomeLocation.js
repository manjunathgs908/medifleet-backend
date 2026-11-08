'use strict';
/**
 * services/waWelcomeLocation.js
 * ============================================================
 * One-tap pickup location from the "savelife_welcome" WhatsApp template.
 *
 *   1. The customer taps the template's quick-reply "📍 Send Location /
 *      ಕಳುಹಿಸಿ" (inbound type 'button'). We send WhatsApp's one-tap
 *      location request (whatsappService.sendLocationRequest, the same
 *      bilingual text as the call flow's locationRequests.ASK_TEXT) and
 *      record a LocationRequest { source: 'whatsapp_welcome' }.
 *   2. They share a pin (or type an address, resolved through the bot's
 *      own Places search; several matches are never guessed). We record it,
 *      create/update a WhatsAppLead (source 'whatsapp') carrying the pickup
 *      (the CRM rings for it; the Dispatch form pre-fills from lead.pickup),
 *      fill the pickup into a live call capture for the same number exactly
 *      as call-capture does (locationRequests.applyToTargets), and ask
 *      "is this the pickup point?" with Yes / Change buttons.
 *   3. Another pin or a typed address replaces the pickup (asked again);
 *      Yes confirms it and tells them our team will call.
 *
 * Only these messages are taken: the tap, and messages from a number whose
 * welcome request is still open (sent / received, not confirmed, under
 * PENDING_MS old). "hi" / "menu" closes it and goes to the bot, as does
 * everything from everyone else — the existing menu flow is untouched.
 * Never creates a Trip and never quotes a fare (the operator books from
 * the Dispatch form). On unless WA_WELCOME_LOCATION_ENABLED=false.
 * Never throws: on any error the message goes to the bot as before.
 * ============================================================
 */
const LocationRequest = require('../models/LocationRequest');
const WhatsAppLead = require('../models/WhatsAppLead');
const CallLog = require('../models/CallLog');
const whatsapp = require('./whatsappService');
const locationRequests = require('./locationRequests');
const bookingPush = require('./bookingPush');
const { normalisePhone } = require('../utils/phone');

const SOURCE = 'whatsapp_welcome';
const CALL_SOURCES = ['incoming_call', 'ai_caller'];
const PENDING_MS = locationRequests.PENDING_MS;    // 2 h, same as a call's request
const LEAD_REUSE_MS = 24 * 60 * 60 * 1000;          // one open lead per number per day
const CALL_MATCH_MS = 2 * 60 * 60 * 1000;           // a call this recent gets the pin too
const LEAD_SERVICE = 'Ambulance - pickup shared on WhatsApp';

const YES_ID = 'wa_welcome_yes';
const CHANGE_ID = 'wa_welcome_change';

const enabled = () => process.env.WA_WELCOME_LOCATION_ENABLED !== 'false';

// The template's quick-reply, matched loosely: title or payload containing
// "Send Location" (any case; space, _ or - between, e.g. SEND_LOCATION) or
// the Kannada "ಕಳುಹಿಸಿ".
const TAP_RE = /send[\s_-]*location|ಕಳುಹಿಸಿ/i;
// Same as whatsappFlow's: these restart the bot's menu.
const GREETING_RE = /^\s*(hi|hello|hey|start|menu)\s*$/i;
const YES_RE = /^\s*(yes|y|yeah|yep|ok|okay|haan|han|ha|correct|confirm|confirmed|ಹೌದು|ಹೂಂ|ಹೂ|ಸರಿ|हाँ|हां|हा|ठीक|అవును|సరే|✅|👍)[\s.!]*$/i;
const CHANGE_RE = /^\s*(change|change location|different|different location|another|another location|no|wrong|ಬೇರೆ|ಬದಲಿಸಿ|ಇಲ್ಲ|नहीं|बदलो|వేరే|కాదు)[\s.!]*$/i;

const ASK_TEXT = locationRequests.ASK_TEXT;
const confirmText = (address) =>
  `📍 ಲೊಕೇಶನ್ ಸಿಕ್ಕಿದೆ: ${address}\n`
  + 'ಇದೇ ಪಿಕಪ್ ಸ್ಥಳವೇ? ✅ "ಹೌದು" ಎಂದು ಉತ್ತರಿಸಿ, ಅಥವಾ ರೋಗಿ ಬೇರೆ ಕಡೆ ಇದ್ದರೆ ಬೇರೆ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ / ವಿಳಾಸ ಟೈಪ್ ಮಾಡಿ.\n\n'
  + `📍 Location received: ${address}\n`
  + 'Is this the pickup point? ✅ Reply Yes, OR send a different location / type the address if the patient is somewhere else.';
const CONFIRM_BUTTONS = [
  { id: YES_ID, title: '✅ Yes / ಹೌದು' },
  { id: CHANGE_ID, title: '📍 Change / ಬದಲಿಸಿ' },
];
const DONE_TEXT = '✅ ಧನ್ಯವಾದಗಳು! ಪಿಕಪ್ ಸ್ಥಳ ಖಚಿತವಾಗಿದೆ. ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ಕರೆ ಮಾಡಿ ಡ್ರಾಪ್ ಸ್ಥಳ ಮತ್ತು ದರವನ್ನು ಖಚಿತಪಡಿಸುತ್ತದೆ.\n'
  + '✅ Thank you! Pickup confirmed. Our team will call you shortly to confirm the drop and the fare.';
const multipleText = (q) => `"${q}" ಹೆಸರಿನಲ್ಲಿ ಹಲವು ಸ್ಥಳಗಳಿವೆ. ದಯವಿಟ್ಟು ಏರಿಯಾ ಅಥವಾ ಹತ್ತಿರದ ಲ್ಯಾಂಡ್‌ಮಾರ್ಕ್ ಸೇರಿಸಿ, ಅಥವಾ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ.\n`
  + `We found more than one place for "${q}". Please add the area or a nearby landmark, or share the location pin.`;
const notFoundText = (q) => `"${q}" ಸ್ಥಳ ಸಿಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಏರಿಯಾ ಮತ್ತು ಹತ್ತಿರದ ಲ್ಯಾಂಡ್‌ಮಾರ್ಕ್ ಟೈಪ್ ಮಾಡಿ, ಅಥವಾ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ.\n`
  + `We could not find "${q}". Please type the area and a nearby landmark, or share the location pin.`;
const NUDGE_TEXT = 'ದಯವಿಟ್ಟು ಪಿಕಪ್ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ, ಅಥವಾ ವಿಳಾಸ ಟೈಪ್ ಮಾಡಿ.\nPlease share the pickup location pin, or type the address.';

// The tap, from a template quick-reply (type 'button') or, defensively, an
// interactive reply carrying the same title.
function isSendLocationTap(message) {
  if (message?.type === 'button') {
    return TAP_RE.test(message.button?.text || '') || TAP_RE.test(message.button?.payload || '');
  }
  if (message?.type === 'interactive') {
    const r = message.interactive?.button_reply || message.interactive?.list_reply;
    return !!r && (TAP_RE.test(r.title || '') || TAP_RE.test(r.id || ''));
  }
  return false;
}

// { kind: 'location'|'text'|'reply'|'other', text, replyId, location }
function parse(message) {
  if (message.type === 'location') return { kind: 'location', location: message.location || {} };
  if (message.type === 'text') return { kind: 'text', text: (message.text?.body || '').trim() };
  if (message.type === 'interactive') {
    const r = message.interactive?.button_reply || message.interactive?.list_reply;
    return { kind: 'reply', text: (r?.title || '').trim(), replyId: r?.id || null };
  }
  if (message.type === 'button') return { kind: 'reply', text: (message.button?.text || '').trim(), replyId: message.button?.payload || null };
  return { kind: 'other' };
}

const placeLabel = (p) => {
  const name = (p.name || '').trim();
  const address = (p.address || '').trim();
  if (name && address && !address.toLowerCase().includes(name.toLowerCase())) return `${name}, ${address}`;
  return address || name;
};

async function openRequest(ten) {
  return LocationRequest.findOne({
    phone: ten, source: SOURCE, status: { $in: ['sent', 'received'] }, confirmedAt: null,
    sentAt: { $gte: new Date(Date.now() - PENDING_MS) },
  }).sort({ sentAt: -1 });
}

// 1. The tap: the one-tap location request. A request already open is
// reused (its pickup, if any, stays until a new one comes).
async function startRequest(message, ten) {
  const sent = await whatsapp.sendLocationRequest(message.from, ASK_TEXT);
  const now = new Date();
  const open = await openRequest(ten);
  if (open) {
    await LocationRequest.updateOne({ _id: open._id }, { $set: { sentAt: now, via: 'interactive' } });
  } else {
    await LocationRequest.create({
      phone: ten, source: SOURCE, via: 'interactive',
      status: sent ? 'sent' : 'failed', sentAt: now,
      ...(sent ? {} : { error: 'WhatsApp refused the location request (see [whatsappService] in the logs)' }),
    });
  }
  if (!sent) console.warn('[waWelcomeLocation] location request not sent');
  return true;
}

// The lead the CRM calls back from: one open welcome lead per number per
// day, its pickup replaced by each new pin / address. Rings once, on create.
async function upsertLead(req, from, pickup) {
  const now = new Date();
  let leadId = req.whatsappLead || null;
  if (!leadId) {
    const existing = await WhatsAppLead.findOne({
      phone: from, service: LEAD_SERVICE, status: { $ne: 'closed' },
      createdAt: { $gte: new Date(now - LEAD_REUSE_MS) },
    }).sort({ createdAt: -1 });
    leadId = existing?._id || null;
  }
  if (leadId) {
    await WhatsAppLead.updateOne({ _id: leadId }, { $set: { pickup: { ...pickup, at: now } } });
    return leadId;
  }
  const lead = await WhatsAppLead.create({ phone: from, service: LEAD_SERVICE, source: 'whatsapp', pickup: { ...pickup, at: now } });
  bookingPush.notifyWhatsAppLead(lead._id);
  return lead._id;
}

// The same fill call-capture gets from a call's own request: the call this
// request was linked to (locationRequests.request found it open), else a
// call's pending request for this number (marked received too), else the
// number's latest call in the last CALL_MATCH_MS.
async function fillCall(req, ten, place) {
  try {
    if (req.callLog || req.aiCall) {
      await locationRequests.applyToTargets({ callLog: req.callLog, aiCall: req.aiCall }, place);
      return;
    }
    const pending = await LocationRequest.findOne({
      phone: ten, source: { $in: CALL_SOURCES }, status: 'sent',
      sentAt: { $gte: new Date(Date.now() - PENDING_MS) },
    }).sort({ sentAt: -1 });
    if (pending) {
      await locationRequests.receive(pending, { lat: place.lat, lng: place.lng }, { resolveAddress: async () => place.label });
      return;
    }
    const log = await CallLog.findOne({ customerPhone: ten, createdAt: { $gte: new Date(Date.now() - CALL_MATCH_MS) } })
      .sort({ createdAt: -1 }).select('_id').lean();
    if (log) await locationRequests.applyToTargets({ callLog: log._id }, place);
  } catch (err) {
    console.error('[waWelcomeLocation] call capture not updated:', err.message);
  }
}

// 2 / 4. A pickup (pin or typed): recorded, lead + call filled, then asked.
async function setPickup(req, message, ten, place, source, typedText) {
  const now = new Date();
  const leadId = await upsertLead(req, message.from, { label: place.label, lat: place.lat, lng: place.lng, source });
  await LocationRequest.updateOne({ _id: req._id }, {
    $set: {
      status: 'received', receivedAt: now, pickupSource: source,
      location: { lat: place.lat, lng: place.lng, address: place.label },
      whatsappLead: leadId,
      ...(typedText ? { typedText } : {}),
    },
  });
  await fillCall(req, ten, place);
  const sent = await whatsapp.sendButtons(message.from, confirmText(place.label), CONFIRM_BUTTONS);
  if (!sent) await whatsapp.sendText(message.from, confirmText(place.label));
  console.info(`[waWelcomeLocation] pickup ${source} for request ${req._id}`);
}

async function onPin(req, message, ten, loc, deps) {
  const lat = Number(loc.latitude ?? loc.lat);
  const lng = Number(loc.longitude ?? loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    await whatsapp.sendText(message.from, NUDGE_TEXT);
    return;
  }
  const resolve = deps.resolveAddress || require('./whatsappFlow').resolveAddressForLocation;
  const label = await resolve(lat, lng, loc.address || loc.name || null);
  await setPickup(req, message, ten, { label, lat, lng }, 'pin');
}

async function onTyped(req, message, ten, text, deps) {
  const search = deps.resolvePlace || require('./whatsappFlow').resolvePlaceFromText;
  const r = await search(text);
  if (r?.status === 'single' && r.place) {
    await setPickup(req, message, ten, { label: placeLabel(r.place), lat: r.place.lat, lng: r.place.lng }, 'typed', text);
  } else if (r?.status === 'multiple') {
    await whatsapp.sendText(message.from, multipleText(text));
  } else {
    await whatsapp.sendText(message.from, notFoundText(text));
  }
}

async function confirm(req, message) {
  const now = new Date();
  await LocationRequest.updateOne({ _id: req._id }, { $set: { confirmedAt: now } });
  if (req.whatsappLead) await WhatsAppLead.updateOne({ _id: req.whatsappLead }, { $set: { 'pickup.confirmedAt': now } });
  await whatsapp.sendText(message.from, DONE_TEXT);
}

// Every inbound message, after locationRequests.onInbound and before the
// bot. true when the message was ours (the bot must not also handle it).
async function onInbound(message, deps = {}) {
  try {
    if (!enabled()) return false;
    const ten = normalisePhone(message?.from);
    if (!locationRequests.isMobile(ten)) return false;

    if (isSendLocationTap(message)) return await startRequest(message, ten);

    const req = await openRequest(ten);
    if (!req) return false;
    const m = parse(message);
    const received = req.status === 'received';

    if (m.kind === 'location') {
      await onPin(req, message, ten, m.location, deps);
      return true;
    }
    if (m.kind === 'text' && GREETING_RE.test(m.text)) {
      await LocationRequest.updateOne({ _id: req._id }, { $set: { status: 'closed' } });
      return false; // the bot's menu, as before
    }
    if (m.replyId === YES_ID || ((m.kind === 'text' || m.kind === 'reply') && YES_RE.test(m.text))) {
      if (received) await confirm(req, message);
      else await whatsapp.sendLocationRequest(message.from, ASK_TEXT);
      return true;
    }
    if (m.replyId === CHANGE_ID || ((m.kind === 'text' || m.kind === 'reply') && CHANGE_RE.test(m.text))) {
      await whatsapp.sendLocationRequest(message.from, ASK_TEXT);
      return true;
    }
    if (m.kind === 'text' && m.text.length >= 3) {
      await onTyped(req, message, ten, m.text, deps);
      return true;
    }
    await whatsapp.sendText(message.from, NUDGE_TEXT);
    return true;
  } catch (err) {
    console.error('[waWelcomeLocation] inbound handling failed:', err.message);
    return false;
  }
}

module.exports = {
  onInbound, isSendLocationTap, enabled,
  LEAD_SERVICE, YES_ID, CHANGE_ID, YES_RE, CHANGE_RE, TAP_RE,
  confirmText, DONE_TEXT,
};
