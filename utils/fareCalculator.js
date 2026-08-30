/**
 * utils/fareCalculator.js
 * ────────────────────────────────────────────────────────────
 * Fare computation engine. MongoDB's Pricing collection is the only
 * source of truth for baseFare/slabs/acPerKm — nothing here is guessed
 * or defaulted. Mirrors the slab-interpolation algorithm in the
 * frontend's src/utils/pricingUtils.js so both sides compute identically.
 */
'use strict';

const { Pricing } = require('../models');

function interpolateSlabFare(doc, km) {
  const pts = doc.slabs.map(s => (Array.isArray(s) ? s : [s.km, s.price]));

  if (km <= pts[0][0]) return pts[0][1];

  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (km <= x1) return Math.round(y0 + ((km - x0) * (y1 - y0)) / (x1 - x0));
  }

  const [lastKm, lastPrice] = pts[pts.length - 1];
  if (doc.after300KmRate) {
    return Math.round(lastPrice + (km - lastKm) * doc.after300KmRate);
  }
  const [x0, y0] = pts[pts.length - 2];
  const [x1, y1] = pts[pts.length - 1];
  return Math.round(y0 + ((km - x0) * (y1 - y0)) / (x1 - x0));
}

// Matches the frontend's calcFare() lookup: active Pricing doc whose
// serviceType equals the selected vehicle/service type, case-insensitively.
async function findPricingDoc(selectedType) {
  if (!selectedType) return null;
  return Pricing.findOne({
    active     : true,
    serviceType: { $regex: new RegExp(`^${selectedType}$`, 'i') },
  });
}
exports.findPricingDoc = findPricingDoc;

// True only when this trip should be priced off the dedicated round-trip
// table: the caller said round trip AND the service actually has one. A
// service without the field falls through to the historical behaviour
// rather than silently losing its round-trip uplift.
function roundTripTable(doc, tripType) {
  if (tripType !== 'round_trip') return null;
  if (!Array.isArray(doc.roundTripSlabs) || doc.roundTripSlabs.length < 2) return null;
  return { slabs: doc.roundTripSlabs, after300KmRate: doc.roundTripAfter300KmRate };
}

exports.compute = async ({
  selectedType,
  distanceKm        = 0,
  // The single leg. Only used to look up roundTripSlabs, which is keyed on
  // it. Derived from distanceKm when a caller cannot supply it (completeTrip
  // only ever holds the round figure), because distanceKm for a round trip
  // is that leg doubled.
  oneWayKm,
  tripType          = 'one_way',
  acEnabled         = false,
  helperEnabled     = false,
  additionalCharges = 0,
  gstRate,
}) => {
  if (gstRate == null) throw new Error('gstRate is required to compute a fare');

  const doc = await findPricingDoc(selectedType);
  if (!doc || !Array.isArray(doc.slabs) || doc.slabs.length < 2) {
    throw new Error(`No active pricing found for vehicle type "${selectedType}"`);
  }

  // Round trip reads its own table at the one-way distance; everything else
  // reads the ordinary slabs at the distance being billed. Same
  // interpolation either way — there is one implementation of that maths.
  const rtTable = roundTripTable(doc, tripType);
  const rtLegKm = oneWayKm != null ? oneWayKm : distanceKm / 2;
  const baseFare = rtTable
    ? interpolateSlabFare(rtTable, rtLegKm)
    : interpolateSlabFare(doc, distanceKm);

  // AC stays on the distance actually driven, not the one-way leg: the air
  // conditioning runs for the whole journey, both directions.
  const acCharge = acEnabled && doc.acPerKm ? Math.round(doc.acPerKm * distanceKm) : 0;

  // Helper/attendant: a flat per-LEG fee. Still deliberately NOT multiplied
  // by distance the way acCharge is - a helper costs the same whether the
  // trip is 5 km or 50. Legs are the exception: on a round trip the helper
  // travels out and back, so the one-way fee is charged twice.
  //
  // doc.helperCharge stays the ONE-WAY rate in the Pricing collection and
  // the doubling lives here, mirroring how acCharge reads a per-km rate and
  // applies the distance. Storing 600 instead would silently overcharge
  // every one-way booking.
  //
  // Falls back to 0 when the Pricing doc carries no helperCharge, so a
  // service without one can never be billed for it. NOTE: which services may
  // offer a helper, and the distance cap, are enforced by the booking UIs
  // only - this function bills whatever a caller asks for. Tighten here if
  // that becomes a trust boundary.
  const helperLegs   = tripType === 'round_trip' ? 2 : 1;
  const helperCharge = helperEnabled && doc.helperCharge ? doc.helperCharge * helperLegs : 0;
  const totalAdditionalCharges = additionalCharges + acCharge + helperCharge;

  const subTotal   = baseFare + totalAdditionalCharges;
  const gstAmount   = Math.round((subTotal * gstRate) / 100);
  const grandTotal  = subTotal + gstAmount;

  return {
    vehicleType: doc.vehicleType,
    serviceType: doc.serviceType,
    baseFare,
    distanceKm,
    additionalCharges: totalAdditionalCharges,
    subTotal,
    gstRate,
    gstAmount,
    grandTotal,
  };
};

exports.estimateFare = async (params) => {
  const result = await exports.compute(params);
  return { ...result, isEstimate: true };
};

// ────────────────────────────────────────────────────────────
// utils/smsService.js
// ────────────────────────────────────────────────────────────
const axios = require('axios');

const sendOtp = async (phone, otp) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS Mock] OTP for ${phone}: ${otp}`);
    return { success: true, mock: true };
  }
  // MSG91's v5 OTP endpoint reads its params from the query string, not a
  // JSON body — sending them as a JSON body (as this used to) means MSG91
  // never sees mobile/otp/template_id, which is a silent-failure mode this
  // endpoint doesn't clearly error on.
  const response = await axios.post(
    'https://api.msg91.com/api/v5/otp',
    {},
    {
      params: {
        template_id: process.env.MSG91_TEMPLATE_ID,
        mobile     : `91${phone}`,
        authkey    : process.env.MSG91_AUTH_KEY,
        sender     : process.env.MSG91_SENDER_ID,
        otp,
      },
    }
  );
  console.log('[smsService.sendOtp] MSG91 raw response:', JSON.stringify(response.data));
  return response.data;
};

// Tracking-link SMS. Uses MSG91's v5 Flow API rather than the legacy
// sendhttp.php that sendAlert below still uses, because in India a
// transactional SMS has to quote a DLT-approved template -- a free-text
// body is accepted by MSG91 and then held by the operator in 'pending'
// forever, which is exactly how the OTP rollout failed.
//
// MSG91_TRACKING_TEMPLATE_ID is MSG91's own template id for the approved
// tracking message (NOT the 19-digit DLT id -- that one is entered into
// the template on the MSG91 panel). The template must define the
// ##TRACKING_URL## variable, and the URL's domain has to be whitelisted
// on the DLT portal or the message is rejected on content.
//
// Unset means no approved template exists yet: skip loudly rather than
// send something that will silently never arrive.
const sendTrackingSms = async (phone, trackingUrl) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS Mock] Tracking link for ${phone}: ${trackingUrl}`);
    return { success: true, mock: true };
  }

  const templateId = process.env.MSG91_TRACKING_TEMPLATE_ID;
  if (!templateId) {
    return { skipped: true, reason: 'MSG91_TRACKING_TEMPLATE_ID is not set — no DLT-approved tracking template' };
  }

  const response = await axios.post(
    'https://control.msg91.com/api/v5/flow/',
    {
      template_id: templateId,
      // Never shorten: DLT matches the delivered body against the approved
      // template, and a rewritten link no longer matches.
      short_url  : '0',
      ...(process.env.MSG91_SENDER_ID ? { sender: process.env.MSG91_SENDER_ID } : {}),
      recipients : [{ mobiles: `91${phone}`, TRACKING_URL: trackingUrl }],
    },
    { headers: { 'Content-Type': 'application/json', authkey: process.env.MSG91_AUTH_KEY } },
  );

  console.log('[smsService.sendTrackingSms] MSG91 raw response:', JSON.stringify(response.data));
  // MSG91 answers HTTP 200 with a payload-level failure, so the caller
  // cannot rely on the absence of a throw.
  if (response.data?.type === 'error') {
    return { skipped: true, reason: response.data.message || 'MSG91 rejected the send', msg91: response.data };
  }
  return response.data;
};

const sendAlert = async (phone, message) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS Mock] Alert to ${phone}: ${message}`);
    return { success: true, mock: true };
  }
  const response = await axios.get('https://api.msg91.com/api/sendhttp.php', {
    params: {
      authkey : process.env.MSG91_AUTH_KEY,
      mobiles : `91${phone}`,
      message,
      sender  : process.env.MSG91_SENDER_ID || 'MEDIFT',
      route   : '4',
      country : '91',
    },
  });
  return response.data;
};

// ────────────────────────────────────────────────────────────
// utils/cloudinary.js
// ────────────────────────────────────────────────────────────
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

const uploadToCloudinary = (base64String, folder = 'uploads') => {
  return cloudinary.uploader.upload(base64String, {
    folder,
    resource_type: 'auto',
  });
};

// ಎಲ್ಲಾ ಸರ್ವಿಸ್‌ಗಳನ್ನು ಒಟ್ಟಿಗೆ ಎಕ್ಸ್‌ಪೋರ್ಟ್ ಮಾಡಲಾಗುತ್ತಿದೆ
module.exports = {
  compute: exports.compute,
  estimateFare: exports.estimateFare,
  findPricingDoc,
  sendOtp,
  sendAlert,
  sendTrackingSms,
  cloudinary,
  uploadToCloudinary
};