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
 *   create_booking  only after a successful get_quote in THIS call, only
 *                   with customer_confirmed=true, once per call, never for
 *                   a time already past; books via createBookedTrip with
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
const { isPastIst } = require('./prompt');

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
        },
        required: ['service_code'],
      },
    },
    {
      type: 'function',
      name: 'create_booking',
      description: 'Book the ambulance quoted by the last successful get_quote. Only after reading the service, pickup, drop, time and estimated fare back to the caller and the caller clearly saying yes.',
      parameters: {
        type: 'object',
        properties: {
          patient_name      : { type: 'string' },
          when              : { type: 'string', enum: ['now', 'later'] },
          scheduled_time    : { type: 'string', description: 'For later: India time as YYYY-MM-DD HH:mm, taken from the DATE AND TIME list.' },
          patient_condition : { type: 'string', description: 'What happened / the condition, in a few English words, as the caller said it.' },
          oxygen_needed     : { type: 'boolean' },
          helper_needed     : { type: 'boolean' },
          patient_at        : { type: 'string', enum: ['home', 'hospital', 'other'] },
          customer_confirmed: { type: 'boolean', description: 'true only if the caller explicitly confirmed these details.' },
        },
        required: ['when', 'customer_confirmed'],
      },
    },
    {
      type: 'function',
      name: 'send_location_request',
      description: 'Send the caller a WhatsApp message asking them to share their pickup location (a location pin). Use when you need the exact pickup, or the caller is in a hurry.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'function',
      name: 'freezer_box_request',
      description: 'A freezer box to be kept at home (not road transport): record the area and number of days for the team to price and call back.',
      parameters: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'The area where the box is needed, in English letters.' },
          days: { type: 'integer', description: 'For how many days.' },
        },
        required: ['area', 'days'],
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

const placeAddress = (place) => [place.name, place.address].filter(Boolean).join(', ');

async function getQuote(args, ctx) {
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

  const helper = args.helper_needed === true;
  const pickup = { address: placeAddress(p.place), lat: p.place.lat, lng: p.place.lng };
  const drop = { address: placeAddress(d.place), lat: d.place.lat, lng: d.place.lng };
  // The app's own quote: round trip = the Pricing round-trip slabs (or
  // one-way slabs at twice the distance), helper charged per leg —
  // quoteTrip / fareCalculator.compute, exactly as the booking apps.
  const tripType = roundTrip ? 'round_trip' : 'one_way';
  const quote = await quoteTrip({
    pickupLat: pickup.lat, pickupLng: pickup.lng, dropLat: drop.lat, dropLng: drop.lng,
    selectedType: service.code, tripType, ...(helper ? { helperEnabled: true } : {}),
  });
  if (!quote) return { ok: false, reason: 'no_route', say: 'Could not find a road route. Ask the caller to check the places, or hand off.' };
  if (!quote.fare) return { ok: false, reason: 'no_price', say: 'No price for this service right now. Offer a callback from the team (end_call follow_up).' };

  // Waiting at the drop, from the Pricing wait fields (quoteWaitCharge).
  let wait = null;
  if (roundTrip) {
    wait = await quoteWaitCharge({ selectedType: service.code, tripType, waitMinutes: waitHours * 60 });
    if (!wait) return { ok: false, reason: 'no_price', say: 'No waiting price for this service right now. Offer a callback from the team (end_call follow_up).' };
  }
  const tripFare = quote.fare.grandTotal;
  const waitCharge = wait ? wait.amount : 0;
  const total = tripFare + waitCharge;

  ctx.state.quote = { service, pickup, drop, quote, helper, tripType, waitHours: roundTrip ? waitHours : 0 };
  const waitRule = wait
    ? `first ${wait.freeMinutes} minutes of waiting free, then ₹${wait.ratePerMin}/min${wait.tier2RatePerMin != null ? ` for ${wait.tier1Minutes} minutes, then ₹${wait.tier2RatePerMin}/min` : ''}`
    : '';
  return {
    ok: true,
    service    : service.label,
    pickup     : pickup.address,
    drop       : drop.address,
    ...(nearest ? { drop_is_nearest_hospital: true } : {}),
    helper,
    trip_type  : tripType,
    distance_km: Math.round(quote.distanceKm * 10) / 10,
    ...(roundTrip ? {
      trip_fare_rupees      : tripFare,
      wait_hours            : waitHours,
      waiting_charge_rupees : waitCharge,
      waiting_rule          : waitRule,
    } : {}),
    estimated_fare_rupees: total,
    say: roundTrip
      ? `Read back clearly: up-and-down fare ₹${tripFare}${waitHours ? ` + about ${waitHours} hour${waitHours === 1 ? '' : 's'} waiting ₹${waitCharge}` : ''} = total about ₹${total}. Waiting is billed by the actual minutes (${waitRule}). It is an estimate.${nearest ? ' Say this is the nearest hospital found, by name; the team can change it.' : ''}`
      : `This is an estimate; the final bill can differ (waiting time, extra distance).${nearest ? ' Tell the caller this is the nearest hospital found, by name; the team can change it.' : ''}`,
  };
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function createBooking(args, ctx) {
  if (ctx.state.booked) return { ok: false, reason: 'already_booked', trip_number: ctx.state.booked };
  if (!ctx.state.quote) return { ok: false, reason: 'no_quote', say: 'Call get_quote first.' };
  if (args.customer_confirmed !== true) return { ok: false, reason: 'not_confirmed', say: 'Read the details back and get a clear yes first.' };
  if (args.when === 'later' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(args.scheduled_time || ''))) {
    return { ok: false, reason: 'bad_time', say: 'Ask for the date and time, then pass scheduled_time as YYYY-MM-DD HH:mm.' };
  }
  if (args.when === 'later' && isPastIst(args.scheduled_time)) {
    return { ok: false, reason: 'past_time', say: 'That date and time has already passed. Check it with the caller using the DATE AND TIME list.' };
  }
  const { service, pickup, drop, quote, helper, tripType = 'one_way', waitHours = 0 } = ctx.state.quote;
  // The fare read back was for this helper choice; a different one is a
  // different price.
  if (typeof args.helper_needed === 'boolean' && args.helper_needed !== helper) {
    return { ok: false, reason: 'requote_helper', say: 'The helper choice changed: call get_quote again with helper_needed, and read back the new fare.' };
  }

  const trip = await createBookedTrip({
    patientName  : clean(args.patient_name, 80) || 'AI call customer',
    patientPhone : ctx.phone,
    emergencyType: 'general',
    pickupLabel  : pickup.address, pickupLat: pickup.lat, pickupLng: pickup.lng,
    dropLabel    : drop.address,   dropLat  : drop.lat,   dropLng  : drop.lng,
    dist         : quote.oneWayKm,
    effectiveDist: quote.distanceKm,
    selectedType : service.code,
    tripType,
    // Same as the CRM form: a round trip returns to the pickup.
    ...(tripType === 'round_trip' ? { returnAddress: pickup.address } : {}),
    ...(helper ? { helperEnabled: true } : {}),
    scheduleType : args.when === 'later' ? 'later' : 'now',
    scheduleDate : args.when === 'later' ? args.scheduled_time.replace(' ', 'T') : undefined,
  }, { bookingSource: 'ai_telecaller' });

  ctx.state.booked = trip.tripNumber || String(trip._id);
  const needs = {
    ...(clean(args.patient_condition, 300) ? { condition: clean(args.patient_condition, 300) } : {}),
    ...(typeof args.oxygen_needed === 'boolean' ? { oxygen: args.oxygen_needed } : {}),
    helper,
    ...(['home', 'hospital', 'other'].includes(args.patient_at) ? { patientAt: args.patient_at } : {}),
    // So dispatch knows the ambulance waits and comes back.
    ...(tripType === 'round_trip' ? { roundTrip: true, waitHours } : {}),
  };
  await AiCall.updateOne({ _id: ctx.callId }, { $set: { trip: trip._id, outcome: 'booked', needs } });
  bookingPush.notifyIncomingBooking(trip._id); // rings the CRM — a person dispatches it
  return { ok: true, trip_number: ctx.state.booked, estimated_fare_rupees: trip.estimatedFare, say: 'Booked. Tell the caller the team will confirm the ambulance shortly.' };
}

async function sendLocationRequest(args, ctx) {
  const r = await require('../locationRequests').request({ phone: ctx.phone, source: 'ai_caller', aiCall: ctx.callId });
  const say = {
    sent            : 'WhatsApp sent. Ask the caller to open it and tap Send location — and ask the pickup area meanwhile.',
    already_sent    : 'A WhatsApp was already sent. Ask them to open it and tap Send location; ask the area meanwhile.',
    already_received: 'Their location is already here: call get_quote with use_shared_location true.',
  }[r.status];
  return say
    ? { ok: true, status: r.status, say }
    : { ok: false, reason: r.status === 'disabled' ? 'whatsapp_off' : 'whatsapp_failed', say: 'WhatsApp could not be sent. Just ask the pickup area and a landmark.' };
}

async function freezerBoxRequest(args, ctx) {
  const area = clean(args.area, 200);
  const days = Number(args.days);
  if (!area) return { ok: false, reason: 'need_area', say: 'Ask which area the box is needed in.' };
  if (!Number.isInteger(days) || days < 1 || days > 60) return { ok: false, reason: 'need_days', say: 'Ask for how many days the box is needed.' };
  await AiCall.updateOne({ _id: ctx.callId }, { $set: { request: { type: 'freezer_box', area, days, at: new Date() } } });
  return { ok: true, say: 'Noted. Tell the caller the team will call back shortly with the price, then end_call follow_up with a one-line summary.' };
}

const HANDLERS = {
  get_quote: getQuote,
  create_booking: createBooking,
  send_location_request: sendLocationRequest,
  freezer_box_request: freezerBoxRequest,
};

module.exports = { definitions, bookableServices, HANDLERS };
