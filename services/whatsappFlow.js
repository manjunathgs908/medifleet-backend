/**
 * services/whatsappFlow.js
 * ============================================================
 * The real WhatsApp booking state machine. One WhatsAppSession per phone
 * drives every reply; session.step says what input is expected next.
 * English/Hindi/Kannada/Telugu throughout, via whatsappStrings.t().
 *
 * State machine (session.step):
 *   AWAITING_LANGUAGE → AWAITING_SERVICE → AWAITING_SUBTYPE (only for
 *   services that have sub-types) → AWAITING_PICKUP → AWAITING_DROP →
 *   AWAITING_CONFIRM → (Trip created, session deleted)
 *
 * Money rule: the fare shown to the customer and saved on the Trip always
 * comes from fareCalculator.compute() against live Pricing, using the
 * same Google-Directions-verified distance createTrip uses
 * (verifyRoadDistanceKm) -- never a client-typed or Haversine distance,
 * never a hardcoded rate.
 * ============================================================
 */
'use strict';

const WhatsAppSession = require('../models/WhatsAppSession');
const WhatsAppLead = require('../models/WhatsAppLead');
const { Trip } = require('../models');
const { t } = require('./whatsappStrings');
const catalog = require('./whatsappServiceCatalog');
const fareCalculator = require('../utils/fareCalculator');
const { verifyRoadDistanceKm } = require('../controllers/tripController');
const whatsapp = require('./whatsappService');

// Mirrors tripController.js's own GST_RATE (module-private there, not
// exported -- this is the one other place a fare gets computed, so it
// needs the same constant, not a shared export it didn't ask for).
const GST_RATE = 5;

const LANGUAGES = [
  { id: 'lang_en', code: 'en', title: 'English' },
  { id: 'lang_hi', code: 'hi', title: 'हिन्दी' },
  { id: 'lang_kn', code: 'kn', title: 'ಕನ್ನಡ' },
  { id: 'lang_te', code: 'te', title: 'తెలుగు' },
];

const GREETING_RE = /^\s*(hi|hello|hey|start|menu)\s*$/i;

// ============================================================
// Inbound message parsing -- WhatsApp's webhook posts one shape per type;
// this normalizes all of them to { from, text, replyId, location }.
// ============================================================
function parseMessage(message) {
  const from = message.from;

  if (message.type === 'text') {
    return { from, text: message.text?.body?.trim() || '', replyId: null, location: null };
  }

  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    if (!reply) {
      // Logged, not guessed -- a live test found a real reply/button tap
      // that produced neither button_reply nor list_reply, and diagnosing
      // it further needs the actual shape Meta sent, not another
      // assumption. Cheap and safe to leave in permanently.
      console.warn('[whatsappFlow] interactive message with neither button_reply nor list_reply:', JSON.stringify(message.interactive));
    }
    return { from, text: reply?.title || '', replyId: reply?.id || null, location: null };
  }

  // Quick-reply buttons attached to a TEMPLATE message (sendTemplate) echo
  // back as their own top-level type: 'button', not 'interactive' -- a
  // documented, separate Meta message shape (message.button = {text,
  // payload}). Not used by sendButtons' interactive messages today, but
  // handled here in case a client ever degrades an interactive reply to
  // this shape, or a template gets used for confirm/cancel later.
  if (message.type === 'button') {
    return { from, text: message.button?.text || '', replyId: message.button?.payload || null, location: null };
  }

  if (message.type === 'location') {
    const loc = message.location || {};
    return {
      from,
      text: '',
      replyId: null,
      location: {
        lat    : loc.latitude,
        lng    : loc.longitude,
        address: loc.address || loc.name || null,
      },
    };
  }

  return { from, text: '', replyId: null, location: null };
}

// ============================================================
// Session helpers -- every write sets updatedAt itself (see
// WhatsAppSession.js's own comment: the TTL measures time-since-this-field,
// not time-since-creation, and nothing refreshes it automatically).
// ============================================================
async function loadSession(phone) {
  return WhatsAppSession.findOne({ phone });
}

async function saveSession(session, patch) {
  // session.set() (not Object.assign) -- patch keys like
  // 'draftBooking.serviceType' are dotted nested-path strings, which
  // Mongoose's set() resolves into the subdocument correctly; a plain
  // property assignment would instead create a literal
  // "draftBooking.serviceType" key on the document and silently leave
  // draftBooking.serviceType itself untouched.
  session.set(patch);
  session.set('updatedAt', new Date());
  await session.save();
  return session;
}

async function startFreshSession(phone) {
  await WhatsAppSession.deleteOne({ phone }); // drop any stale session before creating a clean one
  return WhatsAppSession.create({ phone, step: 'AWAITING_LANGUAGE', updatedAt: new Date() });
}

async function endSession(phone) {
  await WhatsAppSession.deleteOne({ phone });
}

// ============================================================
// Outbound prompt senders -- one per step, so each branch below is just
// "validate input, mutate session, call the matching sendX*".
// ============================================================
async function sendLanguagePrompt(phone) {
  // 4 options, and sendButtons hard-caps at 3 (WhatsApp's own reply-button
  // limit) -- a list is the only interactive widget that fits all 4.
  await whatsapp.sendList(phone, 'Please choose your language / भाषा चुनें / ಭಾಷೆ ಆಯ್ಕೆಮಾಡಿ / భాష ఎంచుకోండి:', 'Select', [
    { title: 'Language', rows: LANGUAGES.map((l) => ({ id: l.id, title: l.title })) },
  ]);
}

async function sendServicePrompt(phone, lang) {
  const rows = catalog.getServiceList().map((svc) => ({ id: svc.id, title: svc.label[lang] || svc.label.en }));
  await whatsapp.sendList(phone, t(lang, 'chooseService'), 'Select', [{ title: 'Services', rows }]);
}

async function sendSubTypePrompt(phone, lang, service) {
  const rows = service.subTypes.map((sub) => ({ id: sub.id, title: sub.label[lang] || sub.label.en }));
  await whatsapp.sendList(phone, t(lang, 'chooseSubType'), 'Select', [{ title: service.label[lang] || service.label.en, rows }]);
}

async function sendPickupPrompt(phone, lang) {
  await whatsapp.sendText(phone, t(lang, 'askPickup'));
}

async function sendDropPrompt(phone, lang) {
  await whatsapp.sendText(phone, t(lang, 'askDrop'));
}

async function sendConfirmPrompt(phone, lang, draft) {
  const summary = t(lang, 'bookingSummary', {
    service : draft.serviceLabel,
    pickup  : draft.pickup.address || `${draft.pickup.lat}, ${draft.pickup.lng}`,
    drop    : draft.drop.address || `${draft.drop.lat}, ${draft.drop.lng}`,
    distance: draft.distanceKm.toFixed(1),
    fare    : draft.fareEstimate,
  });
  await whatsapp.sendText(phone, summary);
  await whatsapp.sendButtons(phone, t(lang, 'confirmPrompt'), [
    { id: 'confirm_yes', title: 'Confirm' },
    { id: 'confirm_no', title: 'Cancel' },
  ]);
}

// A location step (pickup/drop) accepts either a shared pin (lat/lng, from
// message.location) or typed text (stored as address only -- no coords).
// Geocoding free-text addresses isn't built yet (confirmed absent
// repo-wide), so a text-only location can't get a fare; AWAITING_DROP
// checks for missing coords and re-prompts for a shared pin instead of
// guessing coordinates.
function resolveLocationInput(parsed) {
  if (parsed.location) {
    return { address: parsed.location.address, lat: parsed.location.lat, lng: parsed.location.lng };
  }
  if (parsed.text) {
    return { address: parsed.text, lat: null, lng: null };
  }
  return null;
}

async function logLead(phone, service) {
  console.log(`[whatsappLead] phone=${phone} service=${service}`);
  try {
    await WhatsAppLead.create({ phone, service });
  } catch (err) {
    // A failed lead write must never break the customer-facing flow --
    // the console.log above is the fallback record if this ever throws.
    console.error('[whatsappFlow] WhatsAppLead.create failed:', err.message);
  }
}

// ============================================================
// Step handlers -- each takes (session, parsed) and returns nothing;
// they send whatever reply is appropriate and/or advance session.step.
// ============================================================

async function handleAwaitingLanguage(session, parsed) {
  const match = LANGUAGES.find((l) => l.id === parsed.replyId);
  if (!match) {
    await sendLanguagePrompt(session.phone);
    return;
  }
  await saveSession(session, { language: match.code, step: 'AWAITING_SERVICE' });
  await sendServicePrompt(session.phone, match.code);
}

async function handleAwaitingService(session, parsed) {
  const lang = session.language;
  const service = catalog.getService(parsed.replyId);
  if (!service) {
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendServicePrompt(session.phone, lang);
    return;
  }

  if (service.subTypes.length > 0) {
    await saveSession(session, { step: 'AWAITING_SUBTYPE', 'draftBooking.serviceType': service.id });
    await sendSubTypePrompt(session.phone, lang, service);
    return;
  }

  if (!service.bookable) {
    await whatsapp.sendText(session.phone, t(lang, 'leadCaptured'));
    await logLead(session.phone, service.label.en);
    await endSession(session.phone);
    return;
  }

  // No sub-types but bookable directly (none of today's 9 services hit
  // this, but the catalog is data-driven -- a future service with a
  // top-level backendCode and no sub-types must still work).
  await saveSession(session, {
    step: 'AWAITING_PICKUP',
    'draftBooking.serviceType': service.backendCode,
    serviceLabel: service.label[lang] || service.label.en,
  });
  await sendPickupPrompt(session.phone, lang);
}

async function handleAwaitingSubType(session, parsed) {
  const lang = session.language;
  const serviceId = session.draftBooking?.serviceType; // holds the parent service id while awaiting sub-type
  const service = catalog.getService(serviceId);
  const backendCode = catalog.resolveBackendCode(serviceId, parsed.replyId);

  if (!service) {
    // Session got into an inconsistent state (shouldn't happen) -- restart
    // at service selection rather than crash on a null service.
    await saveSession(session, { step: 'AWAITING_SERVICE' });
    await sendServicePrompt(session.phone, lang);
    return;
  }

  if (!backendCode) {
    const subType = service.subTypes.find((s) => s.id === parsed.replyId);
    if (subType) {
      // Valid row, but not bookable (kept for catalog completeness/future
      // pricing) -- lead-capture, not a re-prompt.
      await whatsapp.sendText(session.phone, t(lang, 'leadCaptured'));
      await logLead(session.phone, `${service.label.en} / ${subType.label.en}`);
      await endSession(session.phone);
      return;
    }
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendSubTypePrompt(session.phone, lang, service);
    return;
  }

  const subType = service.subTypes.find((s) => s.id === parsed.replyId);
  await saveSession(session, {
    step: 'AWAITING_PICKUP',
    'draftBooking.serviceType': backendCode,
    serviceLabel: subType.label[lang] || subType.label.en,
  });
  await sendPickupPrompt(session.phone, lang);
}

async function handleAwaitingPickup(session, parsed) {
  const lang = session.language;
  const pickup = resolveLocationInput(parsed);
  if (!pickup) {
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendPickupPrompt(session.phone, lang);
    return;
  }

  await saveSession(session, { step: 'AWAITING_DROP', 'draftBooking.pickup': pickup });
  await sendDropPrompt(session.phone, lang);
}

async function handleAwaitingDrop(session, parsed) {
  const lang = session.language;
  const drop = resolveLocationInput(parsed);
  if (!drop) {
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendDropPrompt(session.phone, lang);
    return;
  }

  await saveSession(session, { 'draftBooking.drop': drop });

  const pickup = session.draftBooking.pickup;
  const hasCoords = Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)
    && Number.isFinite(drop.lat) && Number.isFinite(drop.lng);

  if (!hasCoords) {
    // Don't fake coordinates or guess a distance -- ask for a shared pin
    // for whichever location(s) came in as typed text, stay on this step.
    await whatsapp.sendText(session.phone, t(lang, 'askDrop'));
    return;
  }

  const distanceKm = await verifyRoadDistanceKm(pickup.lat, pickup.lng, drop.lat, drop.lng);
  if (distanceKm == null) {
    // Google Directions unreachable/failed -- no Haversine fallback (money
    // rule). Re-prompt rather than silently under/over-charging.
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    return;
  }

  let fare;
  try {
    fare = await fareCalculator.compute({
      selectedType: session.draftBooking.serviceType,
      distanceKm,
      acEnabled: false,
      gstRate: GST_RATE,
    });
  } catch (err) {
    // No active Pricing doc for this serviceType -- shouldn't happen for a
    // catalog entry marked bookable, but fall back to lead-capture instead
    // of showing a fake/zero fare if it ever does.
    console.error('[whatsappFlow] fareCalculator.compute failed:', err.message);
    await whatsapp.sendText(session.phone, t(lang, 'leadCaptured'));
    await logLead(session.phone, session.serviceLabel || session.draftBooking.serviceType);
    await endSession(session.phone);
    return;
  }

  const draft = await saveSession(session, {
    step: 'AWAITING_CONFIRM',
    'draftBooking.distanceKm'  : fare.distanceKm,
    'draftBooking.fareEstimate': fare.grandTotal,
  });

  await sendConfirmPrompt(session.phone, lang, {
    serviceLabel: draft.serviceLabel,
    pickup      : draft.draftBooking.pickup,
    drop        : draft.draftBooking.drop,
    distanceKm  : fare.distanceKm,
    fareEstimate: fare.grandTotal,
  });
}

async function handleAwaitingConfirm(session, parsed) {
  const lang = session.language;

  // Primary path: the button's id, echoed back exactly as sent (see
  // sendConfirmPrompt below -- ids are literally 'confirm_yes'/'confirm_no').
  // Fallback: match on the button's TITLE text ('Confirm'/'Cancel',
  // hardcoded English in sendConfirmPrompt regardless of session language)
  // when replyId is absent -- covers a WhatsApp client that degrades an
  // interactive button tap to a plain text reply instead of a structured
  // button_reply, and also just lets a customer type confirm/cancel.
  const normalizedText = parsed.text?.trim().toLowerCase();
  const isConfirm = parsed.replyId === 'confirm_yes' || (!parsed.replyId && normalizedText === 'confirm');
  const isCancel  = parsed.replyId === 'confirm_no'  || (!parsed.replyId && normalizedText === 'cancel');

  if (isCancel) {
    await whatsapp.sendText(session.phone, t(lang, 'cancelled'));
    await endSession(session.phone);
    return;
  }

  if (!isConfirm) {
    console.warn('[whatsappFlow] AWAITING_CONFIRM got unrecognized reply:', JSON.stringify({ replyId: parsed.replyId, text: parsed.text }));
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendConfirmPrompt(session.phone, lang, {
      serviceLabel: session.serviceLabel,
      pickup      : session.draftBooking.pickup,
      drop        : session.draftBooking.drop,
      distanceKm  : session.draftBooking.distanceKm,
      fareEstimate: session.draftBooking.fareEstimate,
    });
    return;
  }

  const draft = session.draftBooking;

  // Re-derive the fare breakdown server-side at confirm time rather than
  // trusting the fareEstimate/distanceKm stashed on the session -- those
  // are for display only; baseFare/additionalCharges (required by the Trip
  // schema, or used for the estimate snapshot) were never saved separately.
  let fare;
  try {
    fare = await fareCalculator.compute({
      selectedType: draft.serviceType,
      distanceKm  : draft.distanceKm,
      acEnabled   : false,
      gstRate     : GST_RATE,
    });
  } catch (err) {
    console.error('[whatsappFlow] confirm-time fare recompute failed:', err.message);
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    return;
  }

  try {
    const trip = await Trip.create({
      patientName : 'WhatsApp Customer',
      patientPhone: session.phone,
      pickup      : { address: draft.pickup.address, lat: draft.pickup.lat, lng: draft.pickup.lng },
      dropAddress : draft.drop.address,
      dropLat     : draft.drop.lat,
      dropLng     : draft.drop.lng,
      selectedType: draft.serviceType,
      tripType    : 'one_way',
      scheduleType: 'now',
      acEnabled   : false,
      baseFare    : fare.baseFare,
      distanceKm  : fare.distanceKm,
      additionalCharges  : fare.additionalCharges,
      estimatedDistanceKm: fare.distanceKm,
      estimatedFare       : fare.grandTotal,
      status      : 'booked',
      bookingSource    : 'whatsapp',
      whatsappLanguage : lang,
    });

    await whatsapp.sendText(session.phone, t(lang, 'bookingConfirmed', { bookingId: trip.tripNumber || trip._id }));
    await endSession(session.phone);
  } catch (err) {
    console.error('[whatsappFlow] Trip.create failed:', err.message);
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    // Session stays as-is -- confirm_yes can be retried without redoing the whole flow.
  }
}

const STEP_HANDLERS = {
  AWAITING_LANGUAGE: handleAwaitingLanguage,
  AWAITING_SERVICE : handleAwaitingService,
  AWAITING_SUBTYPE : handleAwaitingSubType,
  AWAITING_PICKUP  : handleAwaitingPickup,
  AWAITING_DROP    : handleAwaitingDrop,
  AWAITING_CONFIRM : handleAwaitingConfirm,
};

// ============================================================
// @desc  Entry point -- called once per deduped inbound message by
//        routes/whatsappRoutes.js. Never throws (the route already
//        catches, but every step handler above is wrapped again here as a
//        second line of defense so one bad message can't wedge a session).
// ============================================================
async function handleMessage(message) {
  const parsed = parseMessage(message);
  if (!parsed.from) return;

  try {
    let session = await loadSession(parsed.from);

    if (!session || GREETING_RE.test(parsed.text)) {
      session = await startFreshSession(parsed.from);
      await sendLanguagePrompt(parsed.from);
      return;
    }

    const handler = STEP_HANDLERS[session.step];
    if (!handler) {
      // Unknown/corrupt step -- restart cleanly rather than getting stuck.
      session = await startFreshSession(parsed.from);
      await sendLanguagePrompt(parsed.from);
      return;
    }

    await handler(session, parsed);
  } catch (err) {
    console.error('[whatsappFlow] handleMessage failed:', err.message);
  }
}

module.exports = { handleMessage };
