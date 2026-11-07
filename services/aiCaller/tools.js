'use strict';
/**
 * services/aiCaller/tools.js
 * ============================================================
 * AI TELECALLER — PILOT. The functions the Realtime model may call. Every
 * one is validated HERE, not trusted to the model:
 *
 *   get_quote       resolves pickup + drop (same Places search and "never
 *                   silently pick one of several" rule as the WhatsApp
 *                   bot) and prices it with the existing quoteTrip — the
 *                   same fare engine every booking uses. No other source
 *                   of a price exists for the model. The pickup can be the
 *                   location the caller shared on WhatsApp
 *                   (use_shared_location); the drop can be "the nearest
 *                   hospital" (drop_nearest_hospital — the closest one to
 *                   the pickup, read back by name). helper_needed prices a
 *                   helper from the Pricing collection.
 *   read_back_booking  fixes the exact details (pickup time, appointment
 *                   kept separate, home address detail, helper) on the
 *                   CURRENT quote and returns the one-line summary to read
 *                   back. Any new get_quote voids it.
 *   create_booking  only after a successful get_quote in THIS call AND a
 *                   read-back of it AND the caller's own clear yes after
 *                   the read-back (ctx.approval — the server reads the
 *                   transcript, approval.js; "ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ" voids
 *                   it), once per call even on retries, never for a time
 *                   already past; books via createBookedTrip with
 *                   bookingSource 'ai_telecaller' (no bookedBy, so it rings
 *                   the CRM and a person dispatches it). The patient's
 *                   needs (condition, oxygen, helper, home/hospital) go on
 *                   the AiCall for the team.
 *   send_location_request  WhatsApp "share your pickup location"
 *                   (services/locationRequests.js).
 *   freezer_box_request    a freezer box kept at home: area + days, for the
 *                   team to price and call back (not bookable here).
 *   handoff_to_human / end_call   carried out by the session (session.js).
 * ============================================================
 */
const catalog = require('../whatsappServiceCatalog');
const { resolvePlaceFromText } = require('../whatsappFlow');
const { quoteTrip, quoteWaitCharge, createBookedTrip } = require('../../controllers/tripController');
const bookingPush = require('../bookingPush');
const AiCall = require('../../models/AiCall');
const { isPastIst, parseIst, sayIst } = require('./prompt');

// Bookable service codes (the Pricing serviceType values), English labels.
function bookableServices() {
  const out = [];
  for (const svc of catalog.getServiceList()) {
    if (svc.subTypes?.length) {
      svc.subTypes.filter((s) => s.bookable).forEach((s) => out.push({ code: s.backendCode, label: `${svc.label.en} - ${s.label.en}` }));
    } else if (svc.bookable) {
      out.push({ code: svc.backendCode, label: svc.label.en });
    }
  }
  return out;
}

function definitions() {
  const services = bookableServices();
  return [
    {
      type: 'function',
      name: 'get_quote',
      description: 'Find the pickup and drop places and get the real fare estimate. The ONLY way to know a price. '
        + `Service codes: ${services.map((s) => `${s.code} = ${s.label}`).join('; ')}.`,
      parameters: {
        type: 'object',
        properties: {
          service_code: { type: 'string', enum: services.map((s) => s.code) },
          pickup      : { type: 'string', description: 'Pickup place as the caller said it (area, landmark, hospital), in English letters.' },
          drop        : { type: 'string', description: 'Drop place (usually a hospital), in English letters.' },
          pickup_choice: { type: 'integer', description: 'If the last get_quote returned several pickup options, the number (1-based) the caller chose.' },
          drop_choice  : { type: 'integer', description: 'If the last get_quote returned several drop options, the number (1-based) the caller chose.' },
          use_shared_location  : { type: 'boolean', description: 'true to use the pickup location the caller shared on WhatsApp (after send_location_request).' },
          drop_nearest_hospital: { type: 'boolean', description: 'true when the caller wants the nearest / any nearby hospital — no name needed.' },
          helper_needed        : { type: 'boolean', description: 'true if the caller wants a helper to lift or carry the patient.' },
          round_trip           : { type: 'boolean', description: 'true for a return / round trip ("up and down", "ಅಪ್ ಅಂಡ್ ಡೌನ್", "ಹೋಗಿ-ಬರೋದು"), or whenever the ambulance must wait and bring them back.' },
          wait_hours           : { type: 'number', description: 'Round trip only: how long the ambulance waits at the drop before coming back, in hours (e.g. 1.5). 0 if no wait or not known.' },
          patient_at           : { type: 'string', enum: ['home', 'hospital', 'other'], description: 'Where the patient is picked up from, if known. hospital = discharge / hospital pickup: no helper is offered.' },
          nurse_needed         : { type: 'boolean', description: 'true if the caller asked for a nurse.' },
        },
        required: ['service_code'],
      },
    },
    {
      type: 'function',
      name: 'read_back_booking',
      description: 'Before booking: fix the pickup time (and any appointment time) and get the ONE-sentence summary to read back — pickup, drop, pickup time, service and current fare. Read it back, ask "ಬುಕ್ ಮಾಡಲಾ?" and wait. Call again if anything changes.',
      parameters: {
        type: 'object',
        properties: {
          when            : { type: 'string', enum: ['now', 'later'] },
          scheduled_time  : { type: 'string', description: 'For later: the PICKUP time — when the ambulance should be at the pickup — India time as YYYY-MM-DD HH:mm, from the DATE AND TIME list.' },
          appointment_time: { type: 'string', description: 'Only if the caller has a hospital appointment / must ARRIVE by a time: that time, YYYY-MM-DD HH:mm. Never the same thing as the pickup time.' },
          helper_needed   : { type: 'boolean' },
          patient_at      : { type: 'string', enum: ['home', 'hospital', 'other'] },
          pickup_details  : { type: 'string', description: 'Home pickup: house / flat / street and a landmark, in English letters, as the caller said it.' },
          patient_name    : { type: 'string' },
        },
        required: ['when'],
      },
    },
    {
      type: 'function',
      name: 'create_booking',
      description: 'Book exactly what read_back_booking read back. Only after the caller clearly said yes to that read-back — the server checks the caller\'s own words and refuses otherwise. Never call it after "not yet" / "ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ".',
      parameters: {
        type: 'object',
        properties: {
          patient_name      : { type: 'string' },
          when              : { type: 'string', enum: ['now', 'later'] },
          scheduled_time    : { type: 'string', description: 'Must match what was read back (YYYY-MM-DD HH:mm).' },
          patient_condition : { type: 'string', description: 'What happened / the condition, in a few English words, as the caller said it.' },
          oxygen_needed     : { type: 'boolean' },
          helper_needed     : { type: 'boolean' },
          nurse_needed      : { type: 'boolean' },
          freezer_box_needed: { type: 'boolean', description: 'Body transport: true if they also want a freezer box.' },
          special_care      : { type: 'string', description: 'Any special care needed on the way, in a few English words (long trips).' },
          patient_at        : { type: 'string', enum: ['home', 'hospital', 'other'] },
          customer_confirmed: { type: 'boolean', description: 'true only if the caller explicitly said yes to the read-back.' },
        },
        required: ['customer_confirmed'],
      },
    },
    {
      type: 'function',
      name: 'send_location_request',
      description: 'Send the caller a WhatsApp message asking them to share their pickup location (a location pin). Use when you need the exact pickup, or the caller is in a hurry. Say a link was sent ONLY if this returns status sent.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'function',
      name: 'freezer_box_request',
      description: 'A freezer box kept AT HOME (not body transport by vehicle): record the delivery address, start time and how long, for the team to price and call back.',
      parameters: {
        type: 'object',
        properties: {
          address   : { type: 'string', description: 'Delivery address (house / street / area and a landmark), in English letters.' },
          area      : { type: 'string', description: 'The area, if no fuller address was given.' },
          start_time: { type: 'string', description: '"now", or India time YYYY-MM-DD HH:mm from the DATE AND TIME list.' },
          days      : { type: 'integer', description: 'For how many days.' },
          hours     : { type: 'number', description: 'Or for how many hours, if less than a day.' },
        },
        required: ['start_time'],
      },
    },
    {
      type: 'function',
      name: 'handoff_to_human',
      description: 'Transfer the caller to a SaveLife team member NOW. Only for a real medical emergency happening now (unconscious, not breathing, chest pain, seizure, stroke, heavy bleeding), a medical question, the caller asking for a person, or still not understanding after one retry. NOT for the word "urgent".',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', enum: ['distress', 'medical_question', 'caller_asked', 'confused', 'low_confidence', 'other'] } },
        required: ['reason'],
      },
    },
    {
      type: 'function',
      name: 'end_call',
      description: 'End the call after saying goodbye. outcome booked = a booking was created; follow_up = a team member should call back; not_needed = the caller needs nothing.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['booked', 'follow_up', 'not_needed'] },
          summary: { type: 'string', description: 'One line for the team, in English.' },
        },
        required: ['outcome', 'summary'],
      },
    },
  ];
}

// One place: the caller's choice from the previous options, else a search.
async function resolvePlace(query, choice, previous) {
  if (Number.isInteger(choice) && previous?.[choice - 1]) return { status: 'single', place: previous[choice - 1] };
  return resolvePlaceFromText(String(query || '').slice(0, 200));
}

// The pickup the caller shared on WhatsApp, as a resolved place, or null.
async function sharedPickup(callId) {
  const call = await AiCall.findById(callId).select('sharedLocation').lean();
  const loc = call?.sharedLocation;
  return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
    ? { status: 'single', place: { name: loc.address || 'Shared location', address: '', lat: loc.lat, lng: loc.lng } }
    : null;
}

const MAX_WAIT_HOURS = 24;
// One-way road km. Above LONG_TRIP_KM (where Pricing's own after-300 km
// rate starts) Sahana asks more about the patient; above TWO_DRIVER_KM two
// drivers are assigned (said to the caller — no Pricing field charges it).
const LONG_TRIP_KM = 300;
const TWO_DRIVER_KM = 1000;

const placeAddress = (place) => [place.name, place.address].filter(Boolean).join(', ');

async function getQuote(args, ctx) {
  // A new quote request means something changed (place, branch, service,
  // round trip...): the old quote and its read-back no longer count. Only a
  // quote that comes back ok below can be read back and booked.
  ctx.state.quote = null;
  ctx.state.pending = null;
  const services = bookableServices();
  const service = services.find((s) => s.code === args.service_code);
  if (!service) return { ok: false, reason: 'unknown_service', services: services.map((s) => s.label) };

  const usesShared = args.use_shared_location === true;
  const nearest = args.drop_nearest_hospital === true;
  const roundTrip = args.round_trip === true;
  const waitHours = args.wait_hours == null ? 0 : Number(args.wait_hours);
  if (!Number.isFinite(waitHours) || waitHours < 0 || waitHours > MAX_WAIT_HOURS) {
    return { ok: false, reason: 'bad_wait', say: `Ask how many hours the ambulance should wait (0 to ${MAX_WAIT_HOURS}).` };
  }
  if (waitHours > 0 && !roundTrip) {
    return { ok: false, reason: 'wait_needs_round_trip', say: 'Waiting means the ambulance waits and brings them back: confirm it is a round trip, then get_quote with round_trip true and wait_hours.' };
  }
  if (!usesShared && !args.pickup && !Number.isInteger(args.pickup_choice)) {
    return { ok: false, reason: 'need_pickup', say: 'Ask the pickup area (or send the WhatsApp location request).' };
  }
  if (!nearest && !args.drop && !Number.isInteger(args.drop_choice)) {
    return { ok: false, reason: 'need_drop', say: 'Ask where to go — a hospital name, or the nearest hospital.' };
  }

  let p;
  if (usesShared) {
    p = await sharedPickup(ctx.callId);
    if (!p) return { ok: false, reason: 'location_not_received', say: 'The WhatsApp location has not arrived yet. Ask the caller to tap Send location in WhatsApp — or ask the pickup area and call get_quote with pickup.' };
  }
  let d;
  if (!nearest) {
    [p, d] = await Promise.all([
      p || resolvePlace(args.pickup, args.pickup_choice, ctx.state.options?.pickup),
      resolvePlace(args.drop, args.drop_choice, ctx.state.options?.drop),
    ]);
  } else if (!p) {
    p = await resolvePlace(args.pickup, args.pickup_choice, ctx.state.options?.pickup);
  }
  ctx.state.options = {
    pickup: p.status === 'multiple' ? p.places : undefined,
    drop  : d?.status === 'multiple' ? d.places : undefined,
  };
  const describe = (r) => (r.status === 'none'
    ? { status: 'not_found' }
    : r.status === 'multiple'
      ? { status: 'several', options: r.places.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}, ${x.address}`) }
      : { status: 'found', place: placeAddress(r.place) });

  if (nearest) {
    if (p.status !== 'single') return { ok: false, reason: 'clarify_places', pickup: describe(p), drop: { status: 'nearest hospital — found once the pickup is clear' }, say: 'Ask the caller to clarify the pickup, then call get_quote again.' };
    const h = await require('../nearbyHospital').nearestHospital(p.place.lat, p.place.lng);
    if (!h) return { ok: false, reason: 'no_nearby_hospital', say: 'Could not find a hospital near the pickup. Ask which hospital they prefer, or offer a callback from the team (end_call follow_up).' };
    d = { status: 'single', place: h };
  }
  if (p.status !== 'single' || d.status !== 'single') {
    return { ok: false, reason: 'clarify_places', pickup: describe(p), drop: describe(d), say: 'Ask the caller to clarify, then call get_quote again.' };
  }

  const pickup = { address: placeAddress(p.place), lat: p.place.lat, lng: p.place.lng };
  const drop = { address: placeAddress(d.place), lat: d.place.lat, lng: d.place.lng };
  // The app's own quote: round trip = the Pricing round-trip slabs (or
  // one-way slabs at twice the distance), helper charged per leg —
  // quoteTrip / fareCalculator.compute, exactly as the booking apps.
  // Helper: never offered for a pickup AT A HOSPITAL (the hospital loads the
  // patient). Otherwise both prices are worked out in one go, so the caller
  // hears "without helper ₹X; with helper ₹Y" and either can be booked
  // without asking again.
  const tripType = roundTrip ? 'round_trip' : 'one_way';
  const atHospital = args.patient_at === 'hospital';
  const base = { pickupLat: pickup.lat, pickupLng: pickup.lng, dropLat: drop.lat, dropLng: drop.lng, selectedType: service.code, tripType };
  const [plain, withHelper] = await Promise.all([
    quoteTrip(base),
    atHospital ? null : quoteTrip({ ...base, helperEnabled: true }),
  ]);
  if (!plain) return { ok: false, reason: 'no_route', say: 'Could not find a road route. Ask the caller to check the places, or hand off.' };
  if (!plain.fare) return { ok: false, reason: 'no_price', say: 'No price for this service right now. Offer a callback from the team (end_call follow_up).' };
  const helperOption = withHelper?.fare ? withHelper : null;

  // Waiting at the drop, from the Pricing wait fields (quoteWaitCharge).
  let wait = null;
  if (roundTrip) {
    wait = await quoteWaitCharge({ selectedType: service.code, tripType, waitMinutes: waitHours * 60 });
    if (!wait) return { ok: false, reason: 'no_price', say: 'No waiting price for this service right now. Offer a callback from the team (end_call follow_up).' };
  }
  const waitCharge = wait ? wait.amount : 0;
  const plainTotal = plain.fare.grandTotal + waitCharge;
  const helperTotal = helperOption ? helperOption.fare.grandTotal + waitCharge : null;
  const helperExtra = helperOption ? helperTotal - plainTotal : null;
  const helperDecided = atHospital || typeof args.helper_needed === 'boolean';
  const helper = !atHospital && args.helper_needed === true && !!helperOption;
  const total = helper ? helperTotal : plainTotal;
  const tripFare = (helper ? helperOption : plain).fare.grandTotal;

  // Long distance (one-way road km): more patient questions, and over
  // TWO_DRIVER_KM two drivers go. No Pricing field charges for either, so
  // nothing is added to the fare for it.
  const oneWayKm = plain.oneWayKm ?? (roundTrip ? plain.distanceKm / 2 : plain.distanceKm);
  const longTrip = oneWayKm > LONG_TRIP_KM;
  const twoDrivers = oneWayKm > TWO_DRIVER_KM;
  const nurse = args.nurse_needed === true;

  ctx.state.quoteSeq = (ctx.state.quoteSeq || 0) + 1;
  ctx.state.quote = {
    seq: ctx.state.quoteSeq,
    service, pickup, drop, tripType, atHospital,
    patientAt: ['home', 'hospital', 'other'].includes(args.patient_at) ? args.patient_at : undefined,
    usedShared: usesShared,
    quotes: { plain, helper: helperOption },
    helper, waitHours: roundTrip ? waitHours : 0, waitCharge, longTrip, twoDrivers,
  };
  const waitRule = wait
    ? `first ${wait.freeMinutes} minutes of waiting free, then ₹${wait.ratePerMin}/min${wait.tier2RatePerMin != null ? ` for ${wait.tier1Minutes} minutes, then ₹${wait.tier2RatePerMin}/min` : ''}`
    : '';

  // What to say: the price straight away, then ask to book.
  const price = (n) => `₹${n}`;
  let priceLine;
  if (atHospital || !helperOption) priceLine = `Quote ${price(plainTotal)}.`;
  else if (helper) priceLine = `Quote ${price(helperTotal)} including the helper.`;
  else if (helperDecided) priceLine = `Quote ${price(plainTotal)} (no helper); just mention it is +${price(helperExtra)} if they want a helper.`;
  else priceLine = `Quote both in one go: without helper ${price(plainTotal)}; with helper ${price(helperTotal)}.`;
  const say = [
    roundTrip
      ? `Up-and-down fare ${price(tripFare)}${waitHours ? ` + about ${waitHours} hour${waitHours === 1 ? '' : 's'} waiting ${price(waitCharge)}` : ''} — read the TOTAL back clearly. Waiting is billed by the actual minutes (${waitRule}).`
      : '',
    priceLine,
    atHospital ? 'The patient is at a hospital: do NOT ask about a helper.' : '',
    twoDrivers ? 'Over 1000 km: tell the caller two drivers are assigned for this trip.' : '',
    longTrip ? 'Long trip: before booking, ask briefly what happened, whether oxygen or a nurse is needed, and any special care — only what you do not know yet.' : '',
    nurse ? 'Nurse: there is no nurse charge in our price list — say the team will confirm the nurse charge; do not quote one.' : '',
    nearest ? 'Say this is the nearest hospital found, by name; the team can change it.' : '',
    'It is an estimate. Then ask if they want to book; when they do, read_back_booking first.',
  ].filter(Boolean).join(' ');

  return {
    ok: true,
    service    : service.label,
    pickup     : pickup.address,
    drop       : drop.address,
    ...(nearest ? { drop_is_nearest_hospital: true } : {}),
    helper,
    trip_type  : tripType,
    distance_km: Math.round(plain.distanceKm * 10) / 10,
    one_way_km : Math.round(oneWayKm * 10) / 10,
    ...(roundTrip ? {
      trip_fare_rupees      : tripFare,
      wait_hours            : waitHours,
      waiting_charge_rupees : waitCharge,
      waiting_rule          : waitRule,
    } : {}),
    ...(atHospital ? { helper_offered: false } : helperOption ? {
      fare_without_helper_rupees: plainTotal,
      fare_with_helper_rupees   : helperTotal,
      helper_extra_rupees       : helperExtra,
    } : {}),
    ...(longTrip ? { long_trip: true } : {}),
    ...(twoDrivers ? { two_drivers: true } : {}),
    estimated_fare_rupees: total,
    say,
  };
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// ── Read-back, then the caller's own yes, then ONE booking ──────────────
// read_back_booking fixes the exact details (on the quote that is current
// now) and returns the summary Sahana reads back. create_booking books
// THOSE details and only when the caller's own words after the read-back
// were a clear yes (ctx.approval — the session judges the transcript with
// approval.js). Any new get_quote, a "no / not yet", or different details
// mean a fresh read-back. One booking per call, even on retries.
async function readBackBooking(args, ctx) {
  const q = ctx.state.quote;
  if (ctx.state.booked) return { ok: false, reason: 'already_booked', trip_number: ctx.state.booked, say: 'It is already booked — do not book again.' };
  if (!q) return { ok: false, reason: 'no_quote', say: 'Call get_quote for the confirmed pickup, drop and service first.' };

  const when = args.when === 'later' ? 'later' : args.when === 'now' ? 'now' : null;
  if (!when) return { ok: false, reason: 'need_time', say: 'Ask when the ambulance should come: now, or a pickup date and time.' };
  if (when === 'later' && !TIME_RE.test(String(args.scheduled_time || ''))) {
    return { ok: false, reason: 'bad_time', say: 'Ask for the PICKUP date and time, then pass scheduled_time as YYYY-MM-DD HH:mm.' };
  }
  if (when === 'later' && isPastIst(args.scheduled_time)) {
    return { ok: false, reason: 'past_time', say: 'That pickup time has already passed. Check it with the caller using the DATE AND TIME list.' };
  }
  let appointment = null;
  if (args.appointment_time != null && String(args.appointment_time).trim()) {
    appointment = parseIst(args.appointment_time);
    if (!appointment) return { ok: false, reason: 'bad_appointment_time', say: 'Pass the appointment time as YYYY-MM-DD HH:mm.' };
    const pickupAt = when === 'later' ? parseIst(args.scheduled_time) : new Date();
    if (appointment.getTime() <= pickupAt.getTime()) {
      return { ok: false, reason: 'pickup_not_before_appointment', say: 'The pickup must be BEFORE the appointment. Ask what time the ambulance should pick them up — the appointment time is not the pickup time.' };
    }
  }

  const patientAt = ['home', 'hospital', 'other'].includes(args.patient_at) ? args.patient_at : q.patientAt;
  const pickupDetails = clean(args.pickup_details, 200);
  if (patientAt === 'home' && !q.usedShared && !pickupDetails) {
    return { ok: false, reason: 'need_pickup_details', say: 'Home pickup: ask the exact address — house or flat, street — and a landmark (or send the WhatsApp location request). Then read_back_booking with pickup_details.' };
  }

  const helper = !q.atHospital && (typeof args.helper_needed === 'boolean' ? args.helper_needed : q.helper);
  if (helper && !q.quotes.helper) return { ok: false, reason: 'requote_helper', say: 'Call get_quote again with helper_needed true, and read back the new fare.' };
  const fare = (helper ? q.quotes.helper : q.quotes.plain).fare.grandTotal + (q.waitCharge || 0);

  const details = {
    when,
    scheduled_time: when === 'later' ? args.scheduled_time : null,
    appointment_time: appointment ? args.appointment_time : null,
    helper, patientAt, pickupDetails,
    patient_name: clean(args.patient_name, 80),
    fare,
  };
  const pickupText = pickupDetails ? `${pickupDetails}, ${q.pickup.address}` : q.pickup.address;
  const summary = [
    `Pickup: ${pickupText}.`,
    `Drop: ${q.drop.address}.`,
    `Pickup time: ${when === 'now' ? 'now' : sayIst(args.scheduled_time)}.`,
    appointment ? `Hospital appointment: ${sayIst(args.appointment_time)} (separate from the pickup time).` : '',
    `Service: ${q.service.label}${q.tripType === 'round_trip' ? `, up and down${q.waitHours ? ` with about ${q.waitHours} h waiting` : ''}` : ''}${helper ? ', with helper' : ''}.`,
    `Fare: ₹${fare} (estimate).`,
  ].filter(Boolean).join(' ');
  ctx.state.pending = { at: typeof ctx.now === 'function' ? ctx.now() : Date.now(), quoteSeq: q.seq, details, summary };
  return {
    ok: true,
    summary,
    say: 'Read this back in ONE short sentence in the caller\'s language — pickup, drop, pickup time'
      + `${appointment ? ' and, separately, the appointment time' : ''}, service and fare — then ask "ಬುಕ್ ಮಾಡಲಾ?" and wait for their answer. `
      + 'It is NOT booked yet: never say it is booked. Book only after a clear yes to this read-back.',
  };
}

// What create_booking was given that differs from what was read back.
function changedFromReadBack(args, d) {
  const changed = [];
  if (args.when && args.when !== d.when) changed.push('when');
  if (d.when === 'later' && args.scheduled_time && args.scheduled_time !== d.scheduled_time) changed.push('scheduled_time');
  if (typeof args.helper_needed === 'boolean' && args.helper_needed !== d.helper) changed.push('helper');
  return changed;
}

const NOT_APPROVED = {
  not_read_back        : 'Read the details back first (read_back_booking), say them, ask "ಬುಕ್ ಮಾಡಲಾ?" and wait for the answer.',
  read_back_interrupted: 'The caller spoke over the read-back, so they did not hear all of it. Read it back again briefly and ask "ಬುಕ್ ಮಾಡಲಾ?".',
  no                   : 'The caller did NOT approve (no / not yet / wait). Do NOT book and do NOT say it is booked. Ask what they want to change or when to book; read back again before booking.',
  unclear              : 'The caller\'s answer was not a clear yes. Ask once, simply: "ಬುಕ್ ಮಾಡಲಾ?" and wait. Do not say it is booked.',
  unavailable          : 'The caller\'s answer could not be checked. Ask "ಬುಕ್ ಮಾಡಲಾ?" again and wait.',
};

async function createBooking(args, ctx) {
  const { state } = ctx;
  const alreadyBooked = () => ({ ok: false, reason: 'already_booked', trip_number: state.booked, say: 'It is already booked — do not book again. Give the trip number if asked.' });
  if (state.booked) return alreadyBooked();
  // A retry while the first booking is still being made: never a second trip.
  if (state.bookingInFlight) {
    await state.bookingInFlight.catch(() => null);
    return state.booked ? alreadyBooked() : { ok: false, reason: 'booking_in_progress', say: 'A booking attempt just finished without booking. Do not say it is booked.' };
  }
  state.bookingInFlight = (async () => {
    if (!state.quote) return { ok: false, reason: 'no_quote', say: 'Call get_quote first.' };
    if (args.customer_confirmed !== true) return { ok: false, reason: 'not_confirmed', say: 'Read the details back and get a clear yes first.' };
    const p = state.pending;
    if (!p || p.quoteSeq !== state.quote.seq) return { ok: false, reason: 'not_read_back', say: NOT_APPROVED.not_read_back };
    const changed = changedFromReadBack(args, p.details);
    if (changed.length) {
      state.pending = null;
      return { ok: false, reason: 'details_changed', changed, say: 'These details differ from what was read back. Call read_back_booking with the new details and read them back.' };
    }
    const verdict = typeof ctx.approval === 'function' ? await ctx.approval() : { status: 'unavailable' };
    if (verdict.status !== 'yes') {
      if (verdict.status === 'no') state.pending = null; // "not yet": a fresh read-back is needed before any booking
      return { ok: false, reason: verdict.status === 'no' ? 'caller_said_no' : `approval_${verdict.status}`, say: NOT_APPROVED[verdict.status] || NOT_APPROVED.unclear };
    }
    // Belt and braces for a retry after the in-memory state was lost.
    const existing = await AiCall.findById(ctx.callId).select('trip').lean();
    if (existing?.trip) { state.booked = String(existing.trip); return alreadyBooked(); }
    return book(args, ctx, p.details);
  })();
  try {
    return await state.bookingInFlight;
  } finally {
    state.bookingInFlight = null;
  }
}

async function book(args, ctx, d) {
  const { service, pickup, drop, quotes, atHospital, tripType = 'one_way', waitHours = 0, twoDrivers } = ctx.state.quote;
  const helper = !atHospital && d.helper;
  const quote = helper ? quotes.helper : quotes.plain;
  // The address detail for a home pickup goes in front of the place, so the
  // crew sees it (the Trip has no separate notes field).
  const pickupLabel = d.pickupDetails ? `${d.pickupDetails}, ${pickup.address}` : pickup.address;

  const trip = await createBookedTrip({
    patientName  : clean(args.patient_name, 80) || d.patient_name || 'AI call customer',
    patientPhone : ctx.phone,
    emergencyType: 'general',
    pickupLabel, pickupLat: pickup.lat, pickupLng: pickup.lng,
    dropLabel    : drop.address,   dropLat  : drop.lat,   dropLng  : drop.lng,
    dist         : quote.oneWayKm,
    effectiveDist: quote.distanceKm,
    selectedType : service.code,
    tripType,
    // Same as the CRM form: a round trip returns to the pickup.
    ...(tripType === 'round_trip' ? { returnAddress: pickupLabel } : {}),
    ...(helper ? { helperEnabled: true } : {}),
    scheduleType : d.when === 'later' ? 'later' : 'now',
    scheduleDate : d.when === 'later' ? d.scheduled_time.replace(' ', 'T') : undefined,
  }, { bookingSource: 'ai_telecaller' });

  ctx.state.booked = trip.tripNumber || String(trip._id);
  ctx.state.pending = null;
  const patientAt = ['home', 'hospital', 'other'].includes(args.patient_at) ? args.patient_at : d.patientAt || (atHospital ? 'hospital' : undefined);
  const needs = {
    ...(clean(args.patient_condition, 300) ? { condition: clean(args.patient_condition, 300) } : {}),
    ...(typeof args.oxygen_needed === 'boolean' ? { oxygen: args.oxygen_needed } : {}),
    helper,
    ...(typeof args.nurse_needed === 'boolean' ? { nurse: args.nurse_needed } : {}),
    ...(clean(args.special_care, 300) ? { specialCare: clean(args.special_care, 300) } : {}),
    ...(patientAt ? { patientAt } : {}),
    // So dispatch knows the ambulance waits and comes back, and that a
    // trip this long needs two drivers.
    ...(tripType === 'round_trip' ? { roundTrip: true, waitHours } : {}),
    ...(twoDrivers ? { twoDrivers: true } : {}),
    ...(d.pickupDetails ? { pickupDetails: d.pickupDetails } : {}),
    // The appointment is NOT the pickup time (scheduleDate): kept apart.
    ...(d.appointment_time ? { appointmentAt: parseIst(d.appointment_time) } : {}),
    ...(typeof args.freezer_box_needed === 'boolean' ? { freezerBox: args.freezer_box_needed } : {}),
  };
  await AiCall.updateOne({ _id: ctx.callId }, { $set: { trip: trip._id, outcome: 'booked', needs } });
  bookingPush.notifyIncomingBooking(trip._id); // rings the CRM — a person dispatches it
  const pendingWithTeam = [
    needs.nurse ? 'the nurse and its charge' : '',
    needs.freezerBox ? 'the freezer box and its charge' : '',
  ].filter(Boolean);
  return {
    ok: true,
    trip_number: ctx.state.booked,
    estimated_fare_rupees: trip.estimatedFare,
    say: `Booked. Now say "ಬುಕ್ಕಿಂಗ್ ಆಯ್ತು" and the trip number. Then, separately: the team will call shortly to confirm the ambulance (it is not assigned yet)${pendingWithTeam.length ? ` and ${pendingWithTeam.join(' and ')}` : ''}.`,
  };
}

async function sendLocationRequest(args, ctx) {
  const r = await require('../locationRequests').request({ phone: ctx.phone, source: 'ai_caller', aiCall: ctx.callId });
  const say = {
    sent            : 'WhatsApp sent. Now you may say "ಲಿಂಕ್ ಕಳಿಸಿದ್ದೇನೆ" — ask them to open it and tap Send location, and ask the address or a landmark meanwhile.',
    already_sent    : 'A WhatsApp was already sent earlier. Ask them to open it and tap Send location; ask the address or a landmark meanwhile.',
    already_received: 'Their location is already here: call get_quote with use_shared_location true.',
  }[r.status];
  // The session's claim guard reads this: Sahana may only say a link was
  // sent when it really was.
  ctx.state.whatsapp = say ? (r.status === 'already_received' ? 'received' : 'sent') : (r.status === 'disabled' ? 'off' : 'failed');
  return say
    ? { ok: true, status: r.status, say }
    : {
      ok: false,
      status: 'not_sent',
      reason: r.status === 'disabled' ? 'whatsapp_off' : 'whatsapp_failed',
      say: 'WhatsApp was NOT sent. Do not say a link was sent and do not mention WhatsApp again. Ask on the call for the address — house, street, area — and a nearby landmark.',
    };
}

async function freezerBoxRequest(args, ctx) {
  const address = clean(args.address, 300);
  const area = clean(args.area, 200);
  if (!address && !area) return { ok: false, reason: 'need_address', say: 'Ask the delivery address — house, street, area — and a landmark.' };
  const start = String(args.start_time || '').trim();
  if (!start) return { ok: false, reason: 'need_start', say: 'Ask from when the box is needed: now, or a date and time.' };
  let startAt;
  if (start === 'now') startAt = new Date();
  else {
    startAt = parseIst(start);
    if (!startAt) return { ok: false, reason: 'bad_start', say: 'Pass start_time as "now" or YYYY-MM-DD HH:mm.' };
    if (isPastIst(start)) return { ok: false, reason: 'past_time', say: 'That start time has already passed. Check it with the caller using the DATE AND TIME list.' };
  }
  const days = args.days == null ? null : Number(args.days);
  const hours = args.hours == null ? null : Number(args.hours);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 60;
  const hoursOk = Number.isFinite(hours) && hours > 0 && hours <= 72;
  if (!daysOk && !hoursOk) return { ok: false, reason: 'need_duration', say: 'Ask for how long the box is needed (days, or hours).' };
  await AiCall.updateOne({ _id: ctx.callId }, {
    $set: {
      request: {
        type: 'freezer_box',
        area: area || address.slice(0, 200),
        ...(address ? { address } : {}),
        startAt,
        ...(daysOk ? { days } : {}),
        ...(hoursOk && !daysOk ? { hours } : {}),
        at: new Date(),
      },
    },
  });
  return { ok: true, say: 'Noted. Tell the caller the team will call back shortly with the price, then end_call follow_up with a one-line summary.' };
}

const HANDLERS = {
  get_quote: getQuote,
  read_back_booking: readBackBooking,
  create_booking: createBooking,
  send_location_request: sendLocationRequest,
  freezer_box_request: freezerBoxRequest,
};

module.exports = { definitions, bookableServices, HANDLERS };
