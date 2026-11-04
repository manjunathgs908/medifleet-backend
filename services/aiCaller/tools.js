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
 *                   of a price exists for the model.
 *   create_booking  only after a successful get_quote in THIS call, only
 *                   with customer_confirmed=true, once per call; books via
 *                   createBookedTrip with bookingSource 'ai_telecaller'
 *                   (no bookedBy, so it rings the CRM and a person
 *                   dispatches it).
 *   handoff_to_human / end_call   carried out by the session (session.js).
 * ============================================================
 */
const catalog = require('../whatsappServiceCatalog');
const { resolvePlaceFromText } = require('../whatsappFlow');
const { quoteTrip, createBookedTrip } = require('../../controllers/tripController');
const bookingPush = require('../bookingPush');
const AiCall = require('../../models/AiCall');

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
        },
        required: ['service_code', 'pickup', 'drop'],
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
          scheduled_time    : { type: 'string', description: 'For later: India time as YYYY-MM-DD HH:mm.' },
          customer_confirmed: { type: 'boolean', description: 'true only if the caller explicitly confirmed these details.' },
        },
        required: ['when', 'customer_confirmed'],
      },
    },
    {
      type: 'function',
      name: 'handoff_to_human',
      description: 'Transfer the caller to a SaveLife team member NOW. Use on any distress or medical emergency, any medical question, if the caller asks for a person, or if you are confused or unsure after one retry.',
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

async function getQuote(args, ctx) {
  const services = bookableServices();
  const service = services.find((s) => s.code === args.service_code);
  if (!service) return { ok: false, reason: 'unknown_service', services: services.map((s) => s.label) };

  const [p, d] = await Promise.all([
    resolvePlace(args.pickup, args.pickup_choice, ctx.state.options?.pickup),
    resolvePlace(args.drop, args.drop_choice, ctx.state.options?.drop),
  ]);
  ctx.state.options = {
    pickup: p.status === 'multiple' ? p.places : undefined,
    drop  : d.status === 'multiple' ? d.places : undefined,
  };
  if (p.status !== 'single' || d.status !== 'single') {
    const describe = (r) => (r.status === 'none'
      ? { status: 'not_found' }
      : r.status === 'multiple'
        ? { status: 'several', options: r.places.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}, ${x.address}`) }
        : { status: 'found', place: `${r.place.name}, ${r.place.address}` });
    return { ok: false, reason: 'clarify_places', pickup: describe(p), drop: describe(d), say: 'Ask the caller to clarify, then call get_quote again.' };
  }

  const pickup = { address: `${p.place.name}, ${p.place.address}`, lat: p.place.lat, lng: p.place.lng };
  const drop = { address: `${d.place.name}, ${d.place.address}`, lat: d.place.lat, lng: d.place.lng };
  const quote = await quoteTrip({
    pickupLat: pickup.lat, pickupLng: pickup.lng, dropLat: drop.lat, dropLng: drop.lng,
    selectedType: service.code, tripType: 'one_way',
  });
  if (!quote) return { ok: false, reason: 'no_route', say: 'Could not find a road route. Ask the caller to check the places, or hand off.' };
  if (!quote.fare) return { ok: false, reason: 'no_price', say: 'No price for this service right now. Offer a callback from the team (end_call follow_up).' };

  ctx.state.quote = { service, pickup, drop, quote };
  return {
    ok: true,
    service    : service.label,
    pickup     : pickup.address,
    drop       : drop.address,
    distance_km: Math.round(quote.distanceKm * 10) / 10,
    estimated_fare_rupees: quote.fare.grandTotal,
    say: 'This is an estimate; the final bill can differ (waiting time, extra distance).',
  };
}

async function createBooking(args, ctx) {
  if (ctx.state.booked) return { ok: false, reason: 'already_booked', trip_number: ctx.state.booked };
  if (!ctx.state.quote) return { ok: false, reason: 'no_quote', say: 'Call get_quote first.' };
  if (args.customer_confirmed !== true) return { ok: false, reason: 'not_confirmed', say: 'Read the details back and get a clear yes first.' };
  if (args.when === 'later' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(args.scheduled_time || ''))) {
    return { ok: false, reason: 'bad_time', say: 'Ask for the date and time, then pass scheduled_time as YYYY-MM-DD HH:mm.' };
  }

  const { service, pickup, drop, quote } = ctx.state.quote;
  const trip = await createBookedTrip({
    patientName  : String(args.patient_name || '').trim().slice(0, 80) || 'AI call customer',
    patientPhone : ctx.phone,
    emergencyType: 'general',
    pickupLabel  : pickup.address, pickupLat: pickup.lat, pickupLng: pickup.lng,
    dropLabel    : drop.address,   dropLat  : drop.lat,   dropLng  : drop.lng,
    dist         : quote.oneWayKm,
    effectiveDist: quote.distanceKm,
    selectedType : service.code,
    tripType     : 'one_way',
    scheduleType : args.when === 'later' ? 'later' : 'now',
    scheduleDate : args.when === 'later' ? args.scheduled_time.replace(' ', 'T') : undefined,
  }, { bookingSource: 'ai_telecaller' });

  ctx.state.booked = trip.tripNumber || String(trip._id);
  await AiCall.updateOne({ _id: ctx.callId }, { $set: { trip: trip._id, outcome: 'booked' } });
  bookingPush.notifyIncomingBooking(trip._id); // rings the CRM — a person dispatches it
  return { ok: true, trip_number: ctx.state.booked, estimated_fare_rupees: trip.estimatedFare, say: 'Booked. Tell the caller the team will confirm the ambulance shortly.' };
}

const HANDLERS = { get_quote: getQuote, create_booking: createBooking };

module.exports = { definitions, bookableServices, HANDLERS };
