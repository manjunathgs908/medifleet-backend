'use strict';
/**
 * services/locationRequests.js
 * ============================================================
 * "Please share your pickup location" on WhatsApp (the Cloud API bot,
 * WA_PHONE_NUMBER_ID), and the pin coming back.
 *
 *   request()   sent on an incoming customer call (callController.incoming)
 *               or by the AI telecaller (tools: send_location_request).
 *               Inside WhatsApp's 24-hour window (the number messaged us in
 *               the last 24 h — models/WhatsAppContact) it is the one-tap
 *               "Send location" button; outside it, only the approved
 *               template WA_LOCATION_TEMPLATE may be sent. At most one per
 *               number per DEDUPE_MS (a caller who rings twice gets one).
 *   onInbound() every inbound WhatsApp message (routes/whatsappRoutes.js),
 *               before the bot. A location pin from a number with a
 *               pending request: recorded (reverse-geocoded address, the
 *               same fallback chain as the bot), filled in as the PICKUP of
 *               that call's live capture draft and/or AI call, and thanked.
 *               A tap on the template's quick-reply button: the window is
 *               open now, so the one-tap button follows. Anything else goes
 *               to the bot exactly as before — and a caller already in the
 *               middle of a bot booking keeps the bot's flow (their pin is
 *               recorded for the call AND handed on to the bot).
 *
 * Off unless WA_CALL_LOCATION_ENABLED=true. Never throws; a booked Trip is
 * never changed here (moving a pickup changes the fare) — the pin fills
 * the draft the operator books from, and the AI's quote.
 * ============================================================
 */
const LocationRequest = require('../models/LocationRequest');
const WhatsAppContact = require('../models/WhatsAppContact');
const WhatsAppSession = require('../models/WhatsAppSession');
const AiCall = require('../models/AiCall');
const whatsapp = require('./whatsappService');
const { normalisePhone } = require('../utils/phone');

const PENDING_MS = 2 * 60 * 60 * 1000;   // a pin up to 2 h after the request still counts
const DEDUPE_MS = 30 * 60 * 1000;        // one request per number per 30 min
const WINDOW_MS = 23.5 * 60 * 60 * 1000; // WhatsApp's 24 h window, with a margin

const isMobile = (ten) => /^[6-9]\d{9}$/.test(ten);
const waNumber = (ten) => `91${ten}`;

const enabled = () => process.env.WA_CALL_LOCATION_ENABLED === 'true';
const templateName = () => process.env.WA_LOCATION_TEMPLATE || '';
const templateLang = () => process.env.WA_LOCATION_TEMPLATE_LANG || 'kn';

const ASK_TEXT = 'ಸೇವ್‌ಲೈಫ್ ಆಂಬುಲೆನ್ಸ್: ದಯವಿಟ್ಟು ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ ನಿಮ್ಮ ಪಿಕಪ್ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ.\n'
  + 'SaveLife Ambulance: please tap the button below to send your pickup location.';
const thanksText = (address) => `ಧನ್ಯವಾದಗಳು, ನಿಮ್ಮ ಲೊಕೇಶನ್ ಸಿಕ್ಕಿದೆ.\nThank you, we have your location${address ? `: ${address}` : ''}.`;

// Fill a shared pickup into the call it belongs to.
async function applyToTargets({ callLog, aiCall }, place) {
  if (callLog) {
    try {
      await require('./callCapture/session').applySharedPickup(callLog, place);
    } catch (err) {
      console.error(`[locationRequests] capture not updated for call ${callLog}:`, err.message);
    }
  }
  if (aiCall) {
    await AiCall.updateOne({ _id: aiCall }, { $set: { sharedLocation: { lat: place.lat, lng: place.lng, address: place.label, at: new Date() } } })
      .catch((err) => console.error(`[locationRequests] AI call ${aiCall} not updated:`, err.message));
  }
}

async function windowOpen(ten, now) {
  const c = await WhatsAppContact.findOne({ phone: ten }).lean();
  return !!c && now - new Date(c.lastInboundAt).getTime() < WINDOW_MS;
}

// Returns { status: 'sent' | 'already_sent' | 'already_received' | 'disabled' | 'not_mobile' | 'failed', via?, error? }
async function request({ phone, source, callLog, aiCall } = {}) {
  try {
    if (!enabled()) return { status: 'disabled' };
    const ten = normalisePhone(phone);
    if (!isMobile(ten)) return { status: 'not_mobile' };
    const now = Date.now();
    const link = { ...(callLog ? { callLog } : {}), ...(aiCall ? { aiCall } : {}) };

    // Shared already, minutes ago (e.g. on the call that came first): use it.
    const got = await LocationRequest.findOne({ phone: ten, status: 'received', receivedAt: { $gte: new Date(now - DEDUPE_MS) } }).sort({ receivedAt: -1 });
    if (got?.location?.lat != null) {
      await applyToTargets(link, { label: got.location.address, lat: got.location.lat, lng: got.location.lng });
      return { status: 'already_received' };
    }
    // Asked already: the pin, when it comes, fills this call too.
    const recent = await LocationRequest.findOne({ phone: ten, status: 'sent', sentAt: { $gte: new Date(now - DEDUPE_MS) } }).sort({ sentAt: -1 });
    if (recent) {
      if (Object.keys(link).length) await LocationRequest.updateOne({ _id: recent._id }, { $set: link });
      return { status: 'already_sent', via: recent.via };
    }

    let via;
    let sent = null;
    let error;
    if (await windowOpen(ten, now)) {
      via = 'interactive';
      sent = await whatsapp.sendLocationRequest(waNumber(ten), ASK_TEXT);
    } else if (templateName()) {
      via = 'template';
      sent = await whatsapp.sendTemplate(waNumber(ten), templateName(), templateLang(), []);
    } else {
      error = 'WA_LOCATION_TEMPLATE is not set (needed outside the 24-hour window)';
    }
    if (!sent && !error) error = `WhatsApp refused the ${via === 'template' ? `template "${templateName()}"` : 'location request'} (see [whatsappService] in the logs)`;

    await LocationRequest.create({
      phone: ten, source, ...link, via,
      status: sent ? 'sent' : 'failed',
      sentAt: new Date(now),
      ...(error ? { error } : {}),
    });
    if (!sent) console.warn(`[locationRequests] not sent (${source}): ${error}`);
    return sent ? { status: 'sent', via } : { status: 'failed', error };
  } catch (err) {
    console.error('[locationRequests] request failed:', err.message);
    return { status: 'failed', error: err.message };
  }
}

// The pin: recorded and filled in. Returns the address used.
async function receive(pending, loc, deps = {}) {
  const resolve = deps.resolveAddress || require('./whatsappFlow').resolveAddressForLocation;
  const lat = Number(loc?.latitude ?? loc?.lat);
  const lng = Number(loc?.longitude ?? loc?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const address = await resolve(lat, lng, loc.address || loc.name || null);
  await LocationRequest.updateOne({ _id: pending._id }, { $set: { status: 'received', receivedAt: new Date(), location: { lat, lng, address } } });
  await applyToTargets({ callLog: pending.callLog, aiCall: pending.aiCall }, { label: address, lat, lng });
  console.info(`[locationRequests] pickup received for request ${pending._id} (${pending.source})`);
  return address;
}

// true when the message was ours (the bot must not also handle it).
async function onInbound(message, deps = {}) {
  try {
    const ten = normalisePhone(message?.from);
    if (!isMobile(ten)) return false;
    await WhatsAppContact.updateOne({ phone: ten }, { $set: { lastInboundAt: new Date() } }, { upsert: true }).catch(() => {});
    if (message.type !== 'location' && message.type !== 'button') return false;

    const pending = await LocationRequest.findOne({ phone: ten, status: 'sent', sentAt: { $gte: new Date(Date.now() - PENDING_MS) } }).sort({ sentAt: -1 });
    if (!pending) return false;
    const inBotFlow = !!(await WhatsAppSession.exists({ phone: message.from }));

    if (message.type === 'location') {
      const address = await receive(pending, message.location, deps);
      if (address == null || inBotFlow) return false;
      await whatsapp.sendText(message.from, thanksText(address));
      return true;
    }
    // A tap on the template's button opened the window: now the one-tap request.
    if (pending.via === 'template' && !inBotFlow) {
      const r = await whatsapp.sendLocationRequest(message.from, ASK_TEXT);
      if (r) await LocationRequest.updateOne({ _id: pending._id }, { $set: { via: 'interactive' } });
      return true;
    }
    return false;
  } catch (err) {
    console.error('[locationRequests] inbound handling failed:', err.message);
    return false;
  }
}

module.exports = { request, onInbound, receive, enabled, ASK_TEXT, PENDING_MS, DEDUPE_MS, WINDOW_MS };
