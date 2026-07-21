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

exports.compute = async ({
  selectedType,
  distanceKm        = 0,
  acEnabled         = false,
  additionalCharges = 0,
  gstRate,
}) => {
  if (gstRate == null) throw new Error('gstRate is required to compute a fare');

  const doc = await findPricingDoc(selectedType);
  if (!doc || !Array.isArray(doc.slabs) || doc.slabs.length < 2) {
    throw new Error(`No active pricing found for vehicle type "${selectedType}"`);
  }

  const baseFare = interpolateSlabFare(doc, distanceKm);
  const acCharge = acEnabled && doc.acPerKm ? Math.round(doc.acPerKm * distanceKm) : 0;
  const totalAdditionalCharges = additionalCharges + acCharge;

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
  const response = await axios.post(
    'https://api.msg91.com/api/v5/otp',
    {
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile      : `91${phone}`,
      authkey     : process.env.MSG91_AUTH_KEY,
      sender      : process.env.MSG91_SENDER_ID, // was missing — DLT requires the approved sender tied to this template
      otp,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
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
  sendOtp, 
  sendAlert, 
  cloudinary, 
  uploadToCloudinary 
};