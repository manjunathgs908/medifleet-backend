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
    includes: ['oxygen on board', ...COMMON],
  },
  bls_tempo: {
    kind: 'patient', care: 'BLS (basic life support)', vehicle: 'tempo',
    includes: ['oxygen on board', ...COMMON],
  },
  als_tempo: {
    kind: 'patient', care: 'ALS (advanced life support)', vehicle: 'tempo',
    includes: ['a nurse for the journey (no separate helper needed)', 'AC', 'oxygen on board', ...COMMON], nurseIncluded: true,
  },
  acls_tempo: {
    kind: 'patient', care: 'ACLS (advanced cardiac life support)', vehicle: 'tempo',
    includes: ['a nurse for the journey (no separate helper needed)', 'AC', 'oxygen on board', ...COMMON], nurseIncluded: true,
  },
  nicu_tempo: {
    kind: 'patient', care: 'NICU (newborn intensive care)', vehicle: 'tempo',
    includes: ['a nurse for the journey', 'AC', 'an infant transport incubator', ...COMMON], nurseIncluded: true,
  },
  body_tempo: {
    kind: 'body', care: null, vehicle: 'tempo', oneWayOnly: true, freezerIncluded: true,
    includes: ['the freezer for the body (included in the fare)', ...COMMON],
  },
  body_mini: {
    kind: 'body', care: null, vehicle: 'eeco', oneWayOnly: true, freezerIncluded: false,
    includes: [...COMMON],
  },
};

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
    includes: f.includes,
    ...(f.kind === 'body' ? { freezer: f.freezerIncluded ? 'included in the fare' : 'NOT included (offer Body Shifting — Tempo if they need one)' } : {}),
    ...(f.oneWayOnly ? { one_way_only: true } : {}),
  };
}

module.exports = { FACTS, facts, describe, checkAgainstQuote, vehicleFamily, EECO_MAX_KM, TEMPO_FOR, VEHICLE_NAMES };
