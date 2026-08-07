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
 * AWAITING_PICKUP/AWAITING_DROP each have a side-branch:
 *   typed text with 2+ Google Places matches -> AWAITING_PICKUP_CHOICE /
 *   AWAITING_DROP_CHOICE (customer taps one from a list) -> back onto the
 *   main path. A shared location pin, or typed text with exactly one
 *   match, skips the side-branch entirely.
 *
 * Money rule: the fare shown to the customer and saved on the Trip always
 * comes from fareCalculator.compute() against live Pricing, using the
 * same Google-Directions-verified distance createTrip uses
 * (verifyRoadDistanceKm) -- never a client-typed or Haversine distance,
 * never a hardcoded rate. Pickup/drop coordinates are likewise never
 * fabricated -- typed text either resolves through Places to a real
 * coordinate (single match or a disambiguated choice) or the customer is
 * re-prompted for a shared pin; nothing is guessed.
 * ============================================================
 */
'use strict';

const axios = require('axios');
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

// Same GOOGLE_MAPS_API_KEY env var and OK_STATUSES/timeout convention as
// controllers/placesController.js -- a direct axios call rather than an
// internal HTTP round-trip through that controller's own routes, mirroring
// how tripController.js's verifyRoadDistanceKm calls Directions directly.
const PLACES_TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_OK_STATUSES = ['OK', 'ZERO_RESULTS'];
// Central Bengaluru + a ~50km radius -- every customer-facing booking
// flow in this codebase is Bengaluru-only today, so this bias (not a
// hard filter -- Text Search can still return outside it) plus
// region:'in' is enough to keep "Manipal Hospital"-style ambiguous
// queries resolving to the right city.
const BENGALURU_LAT = 12.9716;
const BENGALURU_LNG = 77.5946;
const BENGALURU_BIAS_RADIUS_M = 50000;
const MAX_PLACE_OPTIONS = 10; // WhatsApp interactive list row cap

// ============================================================
// Inbound message parsing -- WhatsApp's webhook posts one shape per type;
// this normalizes all of them to { from, text, replyId, location }.
// ============================================================
function parseMessage(message) {
  const from = message.from;
  let result;

  if (message.type === 'text') {
    // Some WhatsApp clients/flows echo a tapped interactive button back
    // as a plain quoted TEXT reply (message.context pointing at the
    // message being replied to) instead of a structured button_reply --
    // this branch alone can't tell the difference from a genuinely typed
    // message, so it just reports what's here; the AWAITING_CONFIRM text
    // fallback is what actually catches this shape by matching the body
    // against 'confirm'/'cancel'.
    result = { from, text: message.text?.body?.trim() || '', replyId: null, location: null };
  } else if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    if (!reply) {
      // Logged, not guessed -- a live test found a real reply/button tap
      // that produced neither button_reply nor list_reply, and diagnosing
      // it further needs the actual shape Meta sent, not another
      // assumption. Cheap and safe to leave in permanently.
      console.warn('[whatsappFlow] interactive message with neither button_reply nor list_reply:', JSON.stringify(message.interactive));
    }
    result = { from, text: reply?.title || '', replyId: reply?.id || null, location: null };
  } else if (message.type === 'button') {
    // Quick-reply buttons attached to a TEMPLATE message (sendTemplate)
    // echo back as their own top-level type: 'button', not 'interactive'
    // -- a documented, separate Meta message shape (message.button =
    // {text, payload}). Not used by sendButtons' interactive messages
    // today, but handled here in case a client ever degrades an
    // interactive reply to this shape, or a template gets used for
    // confirm/cancel later.
    result = { from, text: message.button?.text || '', replyId: message.button?.payload || null, location: null };
  } else if (message.type === 'location') {
    const loc = message.location || {};
    result = {
      from,
      text: '',
      replyId: null,
      location: {
        lat    : loc.latitude,
        lng    : loc.longitude,
        address: loc.address || loc.name || null,
      },
    };
  } else {
    result = { from, text: '', replyId: null, location: null };
  }

  // TEMPORARY -- remove once the AWAITING_CONFIRM button_reply mismatch
  // is confirmed fixed live.
  console.log('[whatsappDebug] parsed:', JSON.stringify({
    type: message.type,
    hasContext: !!message.context,
    textBody: result.text,
    interactiveId: result.replyId,
    location: result.location,
  }));

  return result;
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

// One-tap "Send Location" button -- askPickup/askDrop's existing copy
// already covers both options ("send your location, or type the
// address"), so no new string needed, just a different transport. The
// customer's tap arrives back as a normal type:'location' message,
// same as always sharing a pin ad-hoc.
async function sendPickupPrompt(phone, lang) {
  await whatsapp.sendLocationRequest(phone, t(lang, 'askPickup'));
}

async function sendDropPrompt(phone, lang) {
  await whatsapp.sendLocationRequest(phone, t(lang, 'askDrop'));
}

async function sendConfirmPrompt(phone, lang, draft) {
  // pickup.address/drop.address are resolved (Meta's own address, a
  // reverse-geocode, or a last-resort coordinate string) at the pickup/
  // drop step itself -- see resolveAddressForLocation -- so both are
  // guaranteed non-empty by the time this runs, never bare lat/lng here.
  const summary = t(lang, 'bookingSummary', {
    service : draft.serviceLabel,
    pickup  : draft.pickup.address,
    drop    : draft.drop.address,
    distance: draft.distanceKm.toFixed(1),
    fare    : draft.fareEstimate,
  });
  await whatsapp.sendText(phone, summary);
  await whatsapp.sendButtons(phone, t(lang, 'confirmPrompt'), [
    { id: 'confirm_yes', title: 'Confirm' },
    { id: 'confirm_no', title: 'Cancel' },
  ]);
}

// Row id carries the index into draftBooking.placeOptions (place_0,
// place_1, ...) -- resolved back in handleAwaitingPickupChoice/
// handleAwaitingDropChoice. sendList already hard-truncates title (24)
// and description (72) defensively, so no manual truncation needed here.
async function sendDisambiguationList(phone, lang, places) {
  const rows = places.map((p, i) => ({ id: `place_${i}`, title: p.name, description: p.address }));
  await whatsapp.sendList(phone, t(lang, 'chooseLocationFromList'), 'Select', [{ title: 'Places', rows }]);
}

// Resolves typed free text (pickup/drop) against Google Places Text
// Search, biased to Bengaluru. Returns:
//   { status: 'none' }                -- no match; caller must re-prompt
//                                         for a shared pin, never fabricate
//                                         coordinates from the raw text.
//   { status: 'single', place }       -- exactly one match; safe to use
//                                         directly (place: {name,address,lat,lng}).
//   { status: 'multiple', places }    -- 2+ matches (e.g. "Manipal
//                                         Hospital" has 10+ Bengaluru
//                                         branches) -- caller must show a
//                                         disambiguation list, NEVER
//                                         silently pick the first result.
async function resolvePlaceFromText(query) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[whatsappFlow] GOOGLE_MAPS_API_KEY not set -- cannot resolve a typed address.');
    return { status: 'none' };
  }

  try {
    const { data } = await axios.get(PLACES_TEXTSEARCH_URL, {
      params : {
        query,
        key     : apiKey,
        location: `${BENGALURU_LAT},${BENGALURU_LNG}`,
        radius  : BENGALURU_BIAS_RADIUS_M,
        region  : 'in',
      },
      timeout: 5000,
    });

    if (!PLACES_OK_STATUSES.includes(data.status)) {
      console.error('[whatsappFlow] Places Text Search failed:', data.status, data.error_message);
      return { status: 'none' };
    }

    const places = (data.results || [])
      .map((r) => ({
        name   : r.name,
        address: r.formatted_address,
        lat    : r.geometry?.location?.lat,
        lng    : r.geometry?.location?.lng,
      }))
      // A result missing real coordinates is useless here and must never
      // be offered -- filtered out rather than passed through as-is.
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    if (places.length === 0) return { status: 'none' };
    if (places.length === 1) return { status: 'single', place: places[0] };
    return { status: 'multiple', places: places.slice(0, MAX_PLACE_OPTIONS) };
  } catch (err) {
    console.error('[whatsappFlow] Places Text Search request error:', err.message);
    return { status: 'none' };
  }
}

// Same GOOGLE_MAPS_API_KEY/timeout/OK_STATUSES convention as
// resolvePlaceFromText above and placesController.js's own reverse
// handler -- returns a formatted address string, or null if Google has
// nothing (missing key, request failure, no result). Never throws.
async function reverseGeocode(lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[whatsappFlow] GOOGLE_MAPS_API_KEY not set -- cannot reverse-geocode.');
    return null;
  }

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params : { latlng: `${lat},${lng}`, key: apiKey },
      timeout: 5000,
    });

    if (!PLACES_OK_STATUSES.includes(data.status)) {
      console.error('[whatsappFlow] Reverse geocode failed:', data.status, data.error_message);
      return null;
    }

    return (data.results || [])[0]?.formatted_address || null;
  } catch (err) {
    console.error('[whatsappFlow] Reverse geocode request error:', err.message);
    return null;
  }
}

// A shared location pin's address is only sometimes present (Meta's own
// payload sometimes includes name/address, sometimes just bare lat/lng --
// confirmed live: the pickup pin in the reported failure had neither).
// Trip.create requires pickup.address to be non-empty, so this NEVER
// returns a falsy value -- resolution order: Meta's own address/name,
// then a reverse-geocoded address, then a last-resort coordinate string
// that is at minimum a valid (if unfriendly) string.
async function resolveAddressForLocation(lat, lng, metaAddress) {
  if (metaAddress) return metaAddress;
  const geocoded = await reverseGeocode(lat, lng);
  if (geocoded) return geocoded;
  return `Lat: ${lat}, Lng: ${lng}`;
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

// Shared tail once a pickup location is fully resolved (real coordinates,
// from a shared pin, a single strong Places match, or a chosen
// disambiguation result) -- advances to AWAITING_DROP either way.
async function advanceFromPickup(session, lang, pickup) {
  await saveSession(session, {
    step: 'AWAITING_DROP',
    'draftBooking.pickup': pickup,
    'draftBooking.placeOptions': [],
  });
  await sendDropPrompt(session.phone, lang);
}

async function handleAwaitingPickup(session, parsed) {
  const lang = session.language;

  if (parsed.location) {
    const address = await resolveAddressForLocation(parsed.location.lat, parsed.location.lng, parsed.location.address);
    await advanceFromPickup(session, lang, { address, lat: parsed.location.lat, lng: parsed.location.lng });
    return;
  }

  if (parsed.text) {
    const result = await resolvePlaceFromText(parsed.text);

    if (result.status === 'none') {
      await whatsapp.sendText(session.phone, t(lang, 'placeNotFound'));
      await sendPickupPrompt(session.phone, lang);
      return;
    }

    if (result.status === 'single') {
      const p = result.place;
      await whatsapp.sendText(session.phone, t(lang, 'placeConfirmed', { place: `${p.name}, ${p.address}` }));
      await advanceFromPickup(session, lang, { address: `${p.name}, ${p.address}`, lat: p.lat, lng: p.lng });
      return;
    }

    // Multiple matches (e.g. "Manipal Hospital" has 10+ Bengaluru
    // branches) -- never silently pick one.
    await saveSession(session, { step: 'AWAITING_PICKUP_CHOICE', 'draftBooking.placeOptions': result.places });
    await sendDisambiguationList(session.phone, lang, result.places);
    return;
  }

  await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
  await sendPickupPrompt(session.phone, lang);
}

async function handleAwaitingPickupChoice(session, parsed) {
  const lang = session.language;
  const options = session.draftBooking?.placeOptions || [];
  const idx = Number(parsed.replyId?.match(/^place_(\d+)$/)?.[1]);
  const chosen = Number.isInteger(idx) ? options[idx] : undefined;

  if (!chosen) {
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendDisambiguationList(session.phone, lang, options);
    return;
  }

  await advanceFromPickup(session, lang, { address: `${chosen.name}, ${chosen.address}`, lat: chosen.lat, lng: chosen.lng });
}

// Shared tail once a drop location is fully resolved -- computes the
// Google-Directions-verified distance and fare, then moves to
// AWAITING_CONFIRM. Money rule: never fabricate coordinates or a
// distance -- the hasCoords guard is defensive (every caller already
// carries real coordinates by construction) but kept rather than assumed.
async function advanceFromDrop(session, lang, drop) {
  const pickup = session.draftBooking.pickup;
  const hasCoords = Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)
    && Number.isFinite(drop.lat) && Number.isFinite(drop.lng);

  if (!hasCoords) {
    await saveSession(session, { 'draftBooking.drop': drop });
    await whatsapp.sendText(session.phone, t(lang, 'placeNotFound'));
    await sendDropPrompt(session.phone, lang);
    return;
  }

  const distanceKm = await verifyRoadDistanceKm(pickup.lat, pickup.lng, drop.lat, drop.lng);
  if (distanceKm == null) {
    // Google Directions unreachable/failed -- no Haversine fallback (money
    // rule). Re-prompt rather than silently under/over-charging.
    await saveSession(session, { 'draftBooking.drop': drop });
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
    'draftBooking.drop': drop,
    'draftBooking.distanceKm'  : fare.distanceKm,
    'draftBooking.fareEstimate': fare.grandTotal,
    'draftBooking.placeOptions': [],
  });

  await sendConfirmPrompt(session.phone, lang, {
    serviceLabel: draft.serviceLabel,
    pickup      : draft.draftBooking.pickup,
    drop        : draft.draftBooking.drop,
    distanceKm  : fare.distanceKm,
    fareEstimate: fare.grandTotal,
  });
}

async function handleAwaitingDrop(session, parsed) {
  const lang = session.language;

  if (parsed.location) {
    const address = await resolveAddressForLocation(parsed.location.lat, parsed.location.lng, parsed.location.address);
    await advanceFromDrop(session, lang, { address, lat: parsed.location.lat, lng: parsed.location.lng });
    return;
  }

  if (parsed.text) {
    const result = await resolvePlaceFromText(parsed.text);

    if (result.status === 'none') {
      await whatsapp.sendText(session.phone, t(lang, 'placeNotFound'));
      await sendDropPrompt(session.phone, lang);
      return;
    }

    if (result.status === 'single') {
      const p = result.place;
      await whatsapp.sendText(session.phone, t(lang, 'placeConfirmed', { place: `${p.name}, ${p.address}` }));
      await advanceFromDrop(session, lang, { address: `${p.name}, ${p.address}`, lat: p.lat, lng: p.lng });
      return;
    }

    await saveSession(session, { step: 'AWAITING_DROP_CHOICE', 'draftBooking.placeOptions': result.places });
    await sendDisambiguationList(session.phone, lang, result.places);
    return;
  }

  await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
  await sendDropPrompt(session.phone, lang);
}

async function handleAwaitingDropChoice(session, parsed) {
  const lang = session.language;
  const options = session.draftBooking?.placeOptions || [];
  const idx = Number(parsed.replyId?.match(/^place_(\d+)$/)?.[1]);
  const chosen = Number.isInteger(idx) ? options[idx] : undefined;

  if (!chosen) {
    await whatsapp.sendText(session.phone, t(lang, 'invalidInput'));
    await sendDisambiguationList(session.phone, lang, options);
    return;
  }

  await advanceFromDrop(session, lang, { address: `${chosen.name}, ${chosen.address}`, lat: chosen.lat, lng: chosen.lng });
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

  // TEMPORARY -- remove once the AWAITING_CONFIRM button_reply mismatch
  // is confirmed fixed live.
  console.log('[whatsappDebug] AWAITING_CONFIRM comparing:', JSON.stringify({
    replyId: parsed.replyId,
    rawText: parsed.text,
    normalizedText,
    expectedIds: ['confirm_yes', 'confirm_no'],
    expectedFallbackText: ['confirm', 'cancel'],
    isConfirm,
    isCancel,
  }));

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
    // A creation failure isn't "didn't understand you" -- invalidInput
    // was misleading here; bookingFailed says what actually happened and
    // that a retry is worth trying.
    await whatsapp.sendText(session.phone, t(lang, 'bookingFailed'));
    // Session stays as-is -- confirm_yes can be retried without redoing the whole flow.
  }
}

const STEP_HANDLERS = {
  AWAITING_LANGUAGE: handleAwaitingLanguage,
  AWAITING_SERVICE : handleAwaitingService,
  AWAITING_SUBTYPE : handleAwaitingSubType,
  AWAITING_PICKUP  : handleAwaitingPickup,
  AWAITING_PICKUP_CHOICE: handleAwaitingPickupChoice,
  AWAITING_DROP    : handleAwaitingDrop,
  AWAITING_DROP_CHOICE  : handleAwaitingDropChoice,
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
