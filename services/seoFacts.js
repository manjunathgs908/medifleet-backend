/**
 * services/seoFacts.js
 * ============================================================
 * The verified fact sheet handed to the generator.
 *
 * This is the whole safety story of the SEO engine. The model is given
 * these facts and told that anything not in them does not exist. Every
 * entry below is read from something the business actually runs -- the
 * Pricing collection, the freezer collections, the ambulance catalogue,
 * lib/config's contact block -- not typed in here.
 *
 * If you are tempted to hard-code a number into this file: don't. Put it
 * in the database and read it, or leave it out. A figure typed here is
 * indistinguishable, to the model, from a figure it invented.
 * ============================================================
 */
'use strict';

const crypto = require('crypto');
const { Pricing } = require('../models');
const FreezerDuration = require('../models/FreezerDuration');
const FreezerFloor = require('../models/FreezerFloor');
const { AMBULANCE_SERVICE_TYPES } = require('../utils/ambulanceServiceTypes');

// Live pages on savelife.health, for internal linking. Kept here rather
// than fetched: the sitemap is the source of truth and this list is checked
// against it by the generator, so a stale entry is caught rather than
// silently linked.
const LIVE_PAGES = [
  { href: '/', label: 'SaveLife Health Services' },
  { href: '/book', label: 'Book an ambulance' },
  { href: '/services', label: 'All services' },
  { href: '/fleet', label: 'Our fleet' },
  { href: '/coverage', label: 'Coverage areas' },
  { href: '/contact', label: 'Contact us' },
  { href: '/ambulance-service-bangalore', label: 'Ambulance service in Bangalore' },
  { href: '/ambulance-near-me-bangalore', label: 'Ambulance near me in Bangalore' },
  { href: '/bls-ambulance-bangalore', label: 'BLS ambulance in Bangalore' },
  { href: '/als-ambulance-bangalore', label: 'ALS ambulance in Bangalore' },
  { href: '/icu-ambulance-bangalore', label: 'ICU ambulance in Bangalore' },
  { href: '/cardiac-ambulance-bangalore', label: 'Cardiac ambulance in Bangalore' },
  { href: '/neonatal-ambulance-bangalore', label: 'Neonatal ambulance in Bangalore' },
  { href: '/patient-transfer-bangalore', label: 'Patient transfer in Bangalore' },
  { href: '/air-ambulance-bangalore', label: 'Air ambulance in Bangalore' },
  { href: '/train-ambulance-bangalore', label: 'Train ambulance in Bangalore' },
  { href: '/dead-body-transport-bangalore', label: 'Dead body transport in Bangalore' },
  { href: '/freezer-box-bangalore', label: 'Freezer box in Bangalore' },
  { href: '/funeral-services', label: 'Funeral & death-care services' },
  { href: '/funeral-services/freezer-box-bengaluru', label: 'Freezer box on rent in Bengaluru' },
  { href: '/funeral-services/embalming-services-bengaluru', label: 'Embalming in Bengaluru' },
  { href: '/ambulance-whitefield', label: 'Ambulance in Whitefield' },
  { href: '/ambulance-koramangala', label: 'Ambulance in Koramangala' },
  { href: '/ambulance-hsr-layout', label: 'Ambulance in HSR Layout' },
  { href: '/ambulance-indiranagar', label: 'Ambulance in Indiranagar' },
  { href: '/ambulance-jayanagar', label: 'Ambulance in Jayanagar' },
  { href: '/ambulance-marathahalli', label: 'Ambulance in Marathahalli' },
  { href: '/ambulance-electronic-city', label: 'Ambulance in Electronic City' },
  { href: '/ambulance-yelahanka', label: 'Ambulance in Yelahanka' },
  { href: '/ambulance-btm-layout', label: 'Ambulance in BTM Layout' },
  { href: '/ambulance-k-r-puram', label: 'Ambulance in K R Puram' },
];

// Verified business identity. Mirrors savelife-web's lib/config.js SITE
// block; both must stay in step, which is why the note is here too.
const BUSINESS = {
  name: 'SaveLife Health Services',
  legalName: 'SaveLife Health Services (Proprietorship)',
  callNumber: '+91 99868 44442',
  whatsappNumber: '+91 88840 92777',
  email: 'info@savelife.health',
  website: 'https://www.savelife.health',
  address: '103B, 4th Main Road, Govindraj Nagar, Vijaya Nagar, Bengaluru Urban, Karnataka 560040',
  city: 'Bengaluru',
  availability: '24 hours a day, every day (dispatch is staffed round the clock)',
};

// The things the model must never produce. Stated as a list rather than
// left to inference, because "do not make things up" is not a constraint a
// model can check itself against -- a named list is.
const FORBIDDEN = [
  'Any price, fee, rate or discount that is not in the VERIFIED PRICING section below.',
  'Response times, arrival times, or "reach you in N minutes" claims of any kind.',
  'Fleet size, vehicle counts, number of ambulances, or number of cities covered.',
  'Years in business, founding dates, or experience claims.',
  'Reviews, ratings, testimonials, star counts, or "trusted by N families".',
  'Hospital names, hospital partnerships, tie-ups, or empanelment.',
  'Crematorium names, crematorium charges, or burial-ground details.',
  'Medical advice, clinical claims, or statements about treatment outcomes.',
  'Legal or statutory procedure — what documents a law requires, how to obtain a certificate, permit requirements.',
  'Licences, accreditations, certifications, ISO numbers or regulatory approvals.',
  'Awards, rankings, "number one", "best in Bangalore", or comparative superiority claims.',
  'Any service, city or area not listed in VERIFIED SERVICES or VERIFIED COVERAGE below.',
  'Statistics, percentages or survey figures of any kind.',
];

/**
 * Reads the live configuration and assembles the fact sheet.
 * Everything is read at call time so a price change in MongoDB reaches the
 * next generation without a deploy.
 */
async function buildFactSheet() {
  const [pricingDocs, freezerDurations, freezerFloors] = await Promise.all([
    Pricing.find({ active: true }).lean(),
    // `active` is absent on the stored freezer documents -- Mongoose fills it
    // from the schema default on read, so {active:true} matches nothing in
    // the database while every hydrated doc still reports true. $ne:false is
    // the filter that actually means "not deactivated", and .lean() skips
    // defaults entirely, so the flag has to be normalised below too.
    FreezerDuration.find({ active: { $ne: false } }).sort({ boxId: 1, displayOrder: 1 }).lean(),
    FreezerFloor.find({ active: { $ne: false } }).sort({ boxId: 1, displayOrder: 1 }).lean(),
  ]);

  const labelFor = (serviceType) => {
    const entry = AMBULANCE_SERVICE_TYPES.find(
      (t) => t.serviceType.toUpperCase() === String(serviceType).toUpperCase(),
    );
    return entry ? entry.label : serviceType;
  };

  // Only services with an active Pricing doc are bookable. Anything else is
  // enquiry-only and the model is told so explicitly, so it cannot imply a
  // service can be booked online when it cannot.
  const bookableServices = pricingDocs.map((p) => ({
    code: p.serviceType,
    label: labelFor(p.serviceType),
    vehicle: p.vehicleType,
    minimumFare: Array.isArray(p.slabs) && p.slabs.length
      ? (Array.isArray(p.slabs[0]) ? p.slabs[0][1] : p.slabs[0].price)
      : null,
    acAvailable: Boolean(p.acPerKm),
    acPerKm: p.acPerKm || 0,
    fareModel: 'Distance-based. The fare is interpolated from a slab table by actual road distance, and is shown before the booking is confirmed.',
  }));

  const enquiryOnlyServices = [
    'Air ambulance', 'Air cargo (transport of the departed)', 'Train transport',
    'Event ambulance standby', 'Standby ambulance', 'Antim Yatra', 'Freezer box',
  ];

  const freezer = {
    note: 'Freezer box is quoted from these figures. It is arranged by phone or WhatsApp, not booked through the app.',
    durations: freezerDurations.map((d) => ({
      city: d.city, box: d.boxId, label: d.label, price: d.basePrice,
      discountPercentage: d.discountPercentage || 0,
      embalmingIncluded: Boolean(d.embalmingIncluded),
    })),
    floorCharges: freezerFloors.map((f) => ({
      city: f.city, box: f.boxId, floor: f.label,
      charge: f.isFree ? 0 : (f.charge || 0),
    })),
  };

  const sheet = {
    business: BUSINESS,
    bookableServices,
    enquiryOnlyServices,
    freezer,
    coverage: {
      city: 'Bengaluru',
      note: 'Bengaluru is the verified operating city. Intercity journeys are arranged on request and must be described as "on request", never as an established route or a covered city.',
    },
    livePages: LIVE_PAGES,
    forbidden: FORBIDDEN,
  };

  // Provenance: two articles generated against the same facts share a hash.
  // If a fact turns out to be wrong, this is how you find everything built
  // on it.
  sheet.hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...sheet, hash: undefined }))
    .digest('hex')
    .slice(0, 16);

  return sheet;
}

module.exports = { buildFactSheet, LIVE_PAGES, BUSINESS, FORBIDDEN };
