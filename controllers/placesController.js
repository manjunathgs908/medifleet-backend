/**
 * controllers/placesController.js
 * ─────────────────────────────────────────────────────────────
 * Server-side proxy for Google Places so the frontend/app never
 * sees GOOGLE_MAPS_API_KEY. Mirrors the try/catch + {success,...}
 * response shape used across the other controllers (see
 * pricingController.js).
 */

'use strict';

const axios = require('axios');

const AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS_URL      = 'https://maps.googleapis.com/maps/api/place/details/json';
const GEOCODE_URL      = 'https://maps.googleapis.com/maps/api/geocode/json';
const DIRECTIONS_URL   = 'https://maps.googleapis.com/maps/api/directions/json';

// Google statuses that mean the call itself succeeded (ZERO_RESULTS is a
// valid "no matches" outcome, not a failure).
const OK_STATUSES = ['OK', 'ZERO_RESULTS'];

// ============================================================
// @route   GET /api/places/autocomplete?input=<text>
// @desc    Proxies Google Places Autocomplete
// @access  Public (rate-limited)
// ============================================================
exports.autocomplete = async (req, res) => {
  const input = req.query.input;

  if (!input || !String(input).trim()) {
    return res.status(400).json({ success: false, message: 'Query param "input" is required.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[places] GOOGLE_MAPS_API_KEY is not set.');
    return res.status(500).json({ success: false, message: 'Places service is not configured.' });
  }

  try {
    const { data } = await axios.get(AUTOCOMPLETE_URL, {
      params : { input, key: apiKey },
      timeout: 5000,
    });

    if (!OK_STATUSES.includes(data.status)) {
      console.error('[places] autocomplete failed:', data.status, data.error_message);
      return res.status(502).json({ success: false, message: 'Could not fetch address suggestions right now.' });
    }

    return res.json({ success: true, predictions: data.predictions || [] });
  } catch (err) {
    console.error('[places] autocomplete request error:', err.message);
    return res.status(502).json({ success: false, message: 'Could not fetch address suggestions right now.' });
  }
};

// ============================================================
// @route   GET /api/places/details?placeid=<id>
// @desc    Proxies Google Place Details, returns only what the
//          client needs (address + coordinates)
// @access  Public (rate-limited)
// ============================================================
exports.details = async (req, res) => {
  const placeid = req.query.placeid;

  if (!placeid || !String(placeid).trim()) {
    return res.status(400).json({ success: false, message: 'Query param "placeid" is required.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[places] GOOGLE_MAPS_API_KEY is not set.');
    return res.status(500).json({ success: false, message: 'Places service is not configured.' });
  }

  try {
    const { data } = await axios.get(DETAILS_URL, {
      params : {
        place_id: placeid,
        key     : apiKey,
        fields  : 'formatted_address,geometry',
      },
      timeout: 5000,
    });

    if (!OK_STATUSES.includes(data.status)) {
      console.error('[places] details failed:', data.status, data.error_message);
      return res.status(502).json({ success: false, message: 'Could not fetch place details right now.' });
    }

    const result = data.result || {};
    return res.json({
      success           : true,
      formatted_address : result.formatted_address || null,
      lat               : result.geometry?.location?.lat ?? null,
      lng               : result.geometry?.location?.lng ?? null,
    });
  } catch (err) {
    console.error('[places] details request error:', err.message);
    return res.status(502).json({ success: false, message: 'Could not fetch place details right now.' });
  }
};

// ============================================================
// @route   GET /api/places/reverse?lat=<lat>&lng=<lng>
// @desc    Proxies Google Geocoding (reverse), returns only what
//          the client needs (formatted address + coordinates)
// @access  Public (rate-limited)
// ============================================================
exports.reverse = async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, message: 'Query params "lat" and "lng" must be valid numbers.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[places] GOOGLE_MAPS_API_KEY is not set.');
    return res.status(500).json({ success: false, message: 'Places service is not configured.' });
  }

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params : { latlng: `${lat},${lng}`, key: apiKey },
      timeout: 5000,
    });

    if (!OK_STATUSES.includes(data.status)) {
      console.error('[places] reverse geocode failed:', data.status, data.error_message);
      return res.status(502).json({ success: false, message: 'Could not resolve address for this location right now.' });
    }

    const result = (data.results || [])[0] || {};
    return res.json({
      success           : true,
      formatted_address : result.formatted_address || null,
      lat,
      lng,
    });
  } catch (err) {
    console.error('[places] reverse geocode request error:', err.message);
    return res.status(502).json({ success: false, message: 'Could not resolve address for this location right now.' });
  }
};

// ============================================================
// @route   GET /api/places/directions?originLat=&originLng=&destLat=&destLng=
// @desc    Proxies Google Directions — returns real driving distance/
//          duration (not straight-line) for fare calculation. Same
//          source of truth the customer app's routeUtils.js uses,
//          just server-side instead of a client-embedded key.
// @access  Public (rate-limited)
// ============================================================
exports.directions = async (req, res) => {
  const originLat = Number(req.query.originLat);
  const originLng = Number(req.query.originLng);
  const destLat   = Number(req.query.destLat);
  const destLng   = Number(req.query.destLng);

  if (![originLat, originLng, destLat, destLng].every(Number.isFinite)) {
    return res.status(400).json({
      success: false,
      message: 'Query params "originLat", "originLng", "destLat", "destLng" must all be valid numbers.',
    });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[places] GOOGLE_MAPS_API_KEY is not set.');
    return res.status(500).json({ success: false, message: 'Places service is not configured.' });
  }

  try {
    const { data } = await axios.get(DIRECTIONS_URL, {
      params : {
        origin     : `${originLat},${originLng}`,
        destination: `${destLat},${destLng}`,
        key        : apiKey,
      },
      timeout: 5000,
    });

    if (!OK_STATUSES.includes(data.status)) {
      console.error('[places] directions failed:', data.status, data.error_message);
      return res.status(502).json({ success: false, message: 'Could not calculate driving distance right now.' });
    }

    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) {
      return res.status(502).json({ success: false, message: 'No route found between these locations.' });
    }

    return res.json({
      success    : true,
      distanceKm : leg.distance.value / 1000,
      durationSec: leg.duration.value,
    });
  } catch (err) {
    console.error('[places] directions request error:', err.message);
    return res.status(502).json({ success: false, message: 'Could not calculate driving distance right now.' });
  }
};
