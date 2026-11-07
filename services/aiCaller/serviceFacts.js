'use strict';
/**
 * services/aiCaller/serviceFacts.js
 * ============================================================
 * What each bookable service IS and INCLUDES — never what it costs (every
 * rupee comes from Pricing via get_quote). Sahana answers "what vehicle /
 * what is included" questions from here and nowhere else.
 *
 * Source: the customer booking pages — savelife-web lib/config.js
 * (AMBULANCE_TYPES, SERVICE_INCLUSIONS, ONE_WAY_ONLY_TYPES; mirrored in
 * savelife-app src/utils/ambulanceCatalog.js). Keep the three in sync.
 * The backend's own data only stores the VEHICLE (Pricing.vehicleType),
 * so each quote checks that against `vehicle` here (checkAgainstQuote):
 * when they disagree, Sahana makes no inclusion claim and the mismatch is
 * recorded on the AiCall for staff.
 * ============================================================
 */

const COMMON = ['driver batta and fuel included', 'no toll charges'];

const FACTS = {
  bls: {
    kind: 'patient', care: 'BLS (basic life support)', vehicle: 'eeco',
    purpose: 'basic life support for patients who are stable — oxygen on board, in a Maruti Eeco',
    includes: ['oxygen on board', ...COMMON],
  },
  bls_tempo: {
    kind: 'patient', care: 'BLS (basic life support)', vehicle: 'tempo',
    purpose: 'basic life support for patients who are stable — oxygen on board, in a bigger Tempo Traveller',
    includes: ['oxygen on board', ...COMMON],
  },
  als_tempo: {
    kind: 'patient', care: 'ALS (advanced life support)', vehicle: 'tempo',
    purpose: 'advanced life support — a nurse, AC and oxygen on board',
    includes: ['a nurse for the journey (no separate helper needed)', 'AC', 'oxygen on board', ...COMMON], nurseIncluded: true,
  },
  acls_tempo: {
    kind: 'patient', care: 'ACLS (advanced cardiac life support)', vehicle: 'tempo',
    purpose: 'advanced cardiac life support — a nurse, AC and oxygen on board, for critical patients',
    includes: ['a nurse for the journey (no separate helper needed)', 'AC', 'oxygen on board', ...COMMON], nurseIncluded: true,
  },
  nicu_tempo: {
    kind: 'patient', care: 'NICU (newborn intensive care)', vehicle: 'tempo',
    purpose: 'newborn intensive care transport — a nurse, AC and an infant incubator',
    includes: ['a nurse for the journey', 'AC', 'an infant transport incubator', ...COMMON], nurseIncluded: true,
  },
  body_tempo: {
    kind: 'body', care: null, vehicle: 'tempo', oneWayOnly: true, freezerIncluded: true,
    purpose: 'dead body transport by road in a Tempo Traveller, freezer included',
    includes: ['the freezer for the body (included in the fare)', ...COMMON],
  },
  body_mini: {
    kind: 'body', care: null, vehicle: 'eeco', oneWayOnly: true, freezerIncluded: false,
    purpose: 'dead body transport by road in a Maruti Eeco, no freezer',
    includes: [...COMMON],
  },
};

// The services that are not booked on the call: the team arranges them and
// calls back with the price. Descriptions are the website's own words
// (savelife-web lib/config.js SERVICES) — nothing more is claimed.
const OTHER_SERVICES = [
  { id: 'svc_air_ambulance', name: 'Air Ambulance', about: 'fixed-wing and helicopter ambulance transfers for long-distance and critical emergencies, anywhere in India' },
  { id: 'svc_train_transport', name: 'Train Ambulance (Train Transport)', about: 'coordinated rail transport with onboard medical support for long-distance, non-emergency transfers' },
  { id: 'svc_air_cargo', name: 'Air Cargo (dead body by air)', about: 'long-distance air transport of the departed, coordinated door-to-door with documentation and permissions handled' },
  { id: 'svc_freezer_box', name: 'Freezer Box at home', about: 'a home-delivered freezer box to preserve the departed until the final rites (for transport, Body Shifting — Tempo includes a freezer)' },
  { id: 'svc_antim_yatra', name: 'Antim Yatra', about: 'end-to-end support for the last journey — transport, coordination and care, handled with dignity' },
  { id: 'svc_event_ambulance', name: 'Event Ambulance', about: 'on-site ambulance and medic cover for weddings, sports, concerts and corporate events, by the hour or day' },
  { id: 'svc_standby_ambulance', name: 'Standby Ambulance', about: 'a dedicated ambulance kept on standby for a facility or campus, ready any time' },
];

// TO BE FILLED BY SAVELIFE (left empty on purpose — never guessed):
// what the funeral / cremation service covers, and the step-by-step dead-
// body air-cargo process. Until filled, Sahana describes the services only
// in the words above and records the question for a team callback.
const FUNERAL_DETAILS = null;
const CARGO_PROCESS = null;

const VEHICLE_NAMES = {
  eeco : 'a Maruti Suzuki Eeco van used as an ambulance',
  tempo: 'a Tempo Traveller (a bigger van) used as an ambulance',
};

// Over this one-way road distance (strictly greater), an Eeco is not
// recommended: suggest the same service in a Tempo Traveller.
const EECO_MAX_KM = 800;
const TEMPO_FOR = { bls: 'bls_tempo', body_mini: 'body_tempo' };

const facts = (code) => FACTS[code] || null;

// Pricing.vehicleType ("Maruti Eeco", "Tempo Traveller") -> 'eeco' | 'tempo' | null
function vehicleFamily(vehicleType) {
  const v = String(vehicleType || '').toLowerCase();
  if (/eeco/.test(v)) return 'eeco';
  if (/tempo|traveller|traveler/.test(v)) return 'tempo';
  return null;
}

// Does the quote (fare.vehicleType from the Pricing doc) agree with the
// catalog? null when it does; a mismatch description when not.
function checkAgainstQuote(code, fare) {
  const f = facts(code);
  if (!f) return { code, problem: 'service not in the AI catalog (serviceFacts.js)' };
  const fromPricing = vehicleFamily(fare?.vehicleType);
  if (!fromPricing) return { code, problem: `Pricing vehicleType "${fare?.vehicleType || ''}" is not recognised`, expected: f.vehicle };
  if (fromPricing !== f.vehicle) return { code, problem: `Pricing says ${fare.vehicleType}, the booking page says ${f.vehicle === 'eeco' ? 'Maruti Eeco' : 'Tempo Traveller'}`, expected: f.vehicle, pricing: fare.vehicleType };
  return null;
}

// Plain facts for Sahana to say (one or two sentences, in the caller's language).
function describe(code, label) {
  const f = facts(code);
  if (!f) return null;
  return {
    service : label || code,
    vehicle : VEHICLE_NAMES[f.vehicle],
    ...(f.care ? { care_level: f.care } : {}),
    purpose : f.purpose,
    includes: f.includes,
    ...(f.kind === 'body' ? { freezer: f.freezerIncluded ? 'included in the fare' : 'NOT included (offer Body Shifting — Tempo if they need one)' } : {}),
    ...(f.oneWayOnly ? { one_way_only: true } : {}),
  };
}

module.exports = { OTHER_SERVICES, FUNERAL_DETAILS, CARGO_PROCESS, FACTS, facts, describe, checkAgainstQuote, vehicleFamily, EECO_MAX_KM, TEMPO_FOR, VEHICLE_NAMES };
