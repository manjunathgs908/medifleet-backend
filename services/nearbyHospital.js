'use strict';
/**
 * services/nearbyHospital.js
 * ============================================================
 * The hospital closest to a point — Google Places Nearby Search
 * (type=hospital, rankby=distance), same GOOGLE_MAPS_API_KEY as the other
 * Places calls, server-side only. Used when a caller asks the AI
 * telecaller for "the nearest hospital" as the drop: the quote is priced
 * to this hospital and read back by name, and the team can change it.
 * Returns { name, address, lat, lng } or null (never throws).
 * ============================================================
 */
const axios = require('axios');

const NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

async function nearestHospital(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const { data } = await axios.get(NEARBY_URL, {
      params: { location: `${lat},${lng}`, rankby: 'distance', type: 'hospital', key },
      timeout: 8000,
    });
    const r = (data?.results || []).find((x) => x.business_status !== 'CLOSED_PERMANENTLY' && x.geometry?.location);
    if (!r) {
      if (data?.status && data.status !== 'ZERO_RESULTS') console.warn(`[nearbyHospital] Places status ${data.status}`);
      return null;
    }
    return { name: r.name, address: r.vicinity || '', lat: r.geometry.location.lat, lng: r.geometry.location.lng };
  } catch (err) {
    console.error('[nearbyHospital] request failed:', err.message);
    return null;
  }
}

module.exports = { nearestHospital };
