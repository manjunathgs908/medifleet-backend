/**
 * utils/fareCalculator.js
 * ────────────────────────────────────────────────────────────
 * Pure fare computation engine.
 */
'use strict';

exports.compute = ({
  baseFare          = 1500,
  distanceKm        = 0,
  perKmRate         = 25,
  additionalCharges = 0,
  gstRate           = 5,
}) => {
  const distanceCharge = Math.round(distanceKm * perKmRate);
  const subTotal       = baseFare + distanceCharge + additionalCharges;
  const gstAmount      = Math.round(subTotal * gstRate / 100);
  const grandTotal     = subTotal + gstAmount;

  return { baseFare, distanceKm, perKmRate, distanceCharge, additionalCharges, subTotal, gstRate, gstAmount, grandTotal };
};

exports.estimateFare = (params) => {
  return { ...exports.compute(params), isEstimate: true };
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