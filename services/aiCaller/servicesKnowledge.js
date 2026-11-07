'use strict';
/**
 * services/aiCaller/servicesKnowledge.js
 * ============================================================
 * SaveLife's REAL list of services, for "what services do you have?".
 *
 *   - Road services that can be booked on the call: the ACTIVE Pricing
 *     documents in MongoDB (serviceType BLS, BLS_TEMPO, ... BODY_TEMPO —
 *     the same collection every fare comes from), with the vehicle the
 *     document names, joined to the catalog label and serviceFacts'
 *     description. A Pricing doc the catalog does not know, or a catalog
 *     service with no active Pricing, is reported in `notes` and never
 *     offered as bookable.
 *   - Everything else (air ambulance, train, air cargo, freezer box at
 *     home, Antim Yatra, event / standby): serviceFacts.OTHER_SERVICES —
 *     arranged by the team, never priced on the call.
 *
 * Loaded once per call (session.js -> prompt.buildInstructions) and by the
 * service_info tool. Never throws: if the database cannot be read, the
 * catalog list is used and `fromDb` is false.
 * ============================================================
 */
const catalog = require('../whatsappServiceCatalog');
const serviceFacts = require('./serviceFacts');

const LOAD_TIMEOUT_MS = 3000;

function catalogServices() {
  const out = [];
  for (const svc of catalog.getServiceList()) {
    (svc.subTypes || []).filter((s) => s.bookable).forEach((s) => out.push({ code: s.backendCode, label: `${svc.label.en} - ${s.label.en}` }));
  }
  return out;
}

async function activePricing() {
  const { Pricing } = require('../../models');
  if (!Pricing || typeof Pricing.find !== 'function') return null;
  const query = Pricing.find({ active: true }).select('serviceType vehicleType active');
  const docs = await Promise.race([
    typeof query.lean === 'function' ? query.lean() : query,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOAD_TIMEOUT_MS)),
  ]);
  return Array.isArray(docs) ? docs : null;
}

// { fromDb, bookable: [{ code, label, vehicleType, purpose, includes }], other, notes }
async function load() {
  const known = catalogServices();
  let docs = null;
  try { docs = await activePricing(); } catch (err) { console.error('[aiCaller] services list from Pricing failed:', err.message); }
  const notes = [];
  let bookable;
  if (docs) {
    const byCode = new Map(docs.map((d) => [String(d.serviceType || '').toLowerCase(), d]));
    bookable = known.filter((k) => byCode.has(k.code)).map((k) => ({ ...k, vehicleType: byCode.get(k.code).vehicleType }));
    known.filter((k) => !byCode.has(k.code)).forEach((k) => notes.push(`${k.label}: in the catalog but no active Pricing — not offered`));
    [...byCode.keys()].filter((c) => !known.some((k) => k.code === c)).forEach((c) => notes.push(`Pricing ${c.toUpperCase()}: active but not in the catalog — not offered`));
  } else {
    bookable = known.map((k) => ({ ...k, vehicleType: null }));
  }
  bookable = bookable.map((b) => {
    const f = serviceFacts.facts(b.code);
    return { ...b, purpose: f?.purpose || null, includes: f?.includes || [] };
  });
  return { fromDb: !!docs, bookable, other: serviceFacts.OTHER_SERVICES, notes };
}

// The block for the call's instructions.
function block(k) {
  const road = k.bookable.map((b) => `- ${b.label}${b.vehicleType ? ` (${b.vehicleType})` : ''}: ${b.purpose || 'see service_info'}.`).join('\n');
  const other = k.other.map((o) => `- ${o.name}: ${o.about}.`).join('\n');
  return [
    'SAVELIFE SERVICES — the real list. When asked "what services do you have?", answer from this list only, briefly (the main groups first; details only if asked). Never invent a service or what it includes.',
    'Road services you can quote and book on this call (prices only from get_quote):',
    road,
    'Arranged by our team — take the details (record_question) and say a team member will call back with the price:',
    other,
    'Funeral / cremation details and the step-by-step dead-body cargo process are explained by our team: never describe more than the lines above — record_question and offer a callback.',
  ].join('\n');
}

module.exports = { load, block, catalogServices };
