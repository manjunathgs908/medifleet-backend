'use strict';
/**
 * services/aiCaller/hospitals.js
 * ============================================================
 * A hospital the caller named, checked against Google Places (the same
 * Text Search as every other place — whatsappFlow.resolvePlaceFromText):
 *
 *   one real location        -> 'single' + the area to CONFIRM it by
 *                               ("Bangalore Baptist Hospital, Hebbal ಅಲ್ವಾ?")
 *                               — never "which branch?"
 *   several real branches    -> 'branches': ask which branch / area
 *   named with an area that has no such hospital ("Vijayanagar Fortis")
 *                            -> 'not_in_area' + the real branches: clarify,
 *                               never accept it as said
 *   nothing by that name     -> 'none'
 *   not a hospital at all    -> 'not_hospital' + the plain search result
 *
 * "Same hospital" = every distinctive word of the name the caller gave
 * appears in the result's name (generic words like "hospital" ignored).
 * "In the area" = the area appears in the result's name or address, or
 * the result is within AREA_RADIUS_KM of the area itself (one more Places
 * lookup, only when the text does not match).
 * ============================================================
 */

const AREA_RADIUS_KM = 3;
const GENERIC = new Set(['hospital', 'hospitals', 'the', 'clinic', 'nursing', 'home', 'multispeciality', 'multispecialty', 'super', 'speciality', 'specialty', 'medical', 'centre', 'center', 'and', 'research', 'institute', 'ltd', 'pvt', 'ಆಸ್ಪತ್ರೆ']);
const HOSPITAL_WORDS = /hospital|clinic|nursing home|medical|health|institute|ಆಸ್ಪತ್ರೆ|अस्पताल|ఆసుపత్రి|மருத்துவமனை|ആശുപത്രി/i;

const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const squash = (t) => norm(t).replace(/\s+/g, '').replace(/nagara\b/g, 'nagar');
const words = (t) => norm(t).split(' ').filter((w) => w.length > 1 && !GENERIC.has(w));

function km(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// The locality from a Google address: the part just before the city.
function areaOf(place) {
  const parts = String(place.address || '').split(',').map((p) => p.trim()).filter(Boolean);
  const city = parts.findIndex((p) => /bengaluru|bangalore/i.test(p));
  if (city > 0) return parts[city - 1];
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0] || '';
}
const label = (place) => {
  const area = areaOf(place);
  return area && !norm(place.name).includes(norm(area)) ? `${place.name}, ${area}` : place.name;
};

const looksLikeHospital = (query, places) => HOSPITAL_WORDS.test(query) || places.some((p) => (p.types || []).some((t) => t === 'hospital' || t === 'health'));

/**
 * @param {string} name   what the caller said ("Fortis", "Baptist hospital", "Vijayanagar Fortis")
 * @param {string} [area] the area they said it is in, if separate
 * @param {object} deps   { resolve } — whatsappFlow.resolvePlaceFromText
 * @returns {Promise<{status, place?, confirm?, places?, area?}>}
 */
async function findHospital(name, area, { resolve } = {}) {
  const search = resolve || require('../whatsappFlow').resolvePlaceFromText;
  const query = [name, area].filter(Boolean).join(' ');
  const r = await search(query.slice(0, 200));
  const results = r.status === 'single' ? [r.place] : r.status === 'multiple' ? r.places : [];
  if (!results.length) return { status: 'not_hospital', result: r };
  if (!looksLikeHospital(query, results)) return { status: 'not_hospital', result: r }; // the ordinary place rules apply

  // Which of the caller's words are the hospital's name, which the area.
  const said = words(name);
  const inSomeName = (w) => results.some((p) => squash(p.name).includes(squash(w)));
  let brand = said.filter(inSomeName);
  let where = area || '';
  // "Vijayanagar Fortis": the words that are in no result's name may be the
  // area — but only if Google confirms they ARE an area (below).
  let inferred = false;
  if (!where && brand.length && brand.length < said.length) { where = said.filter((w) => !inSomeName(w)).join(' '); inferred = true; }
  if (!brand.length) brand = said;
  const same = results.filter((p) => brand.every((w) => squash(p.name).includes(squash(w))));
  if (!same.length) return { status: 'none' };

  let candidates = same;
  if (where) {
    const w = squash(where);
    let inArea = same.filter((p) => squash(`${p.name} ${p.address}`).includes(w));
    if (!inArea.length) {
      const a = (await search(`${where} Bengaluru`.slice(0, 200))) || {};
      const spot = a.status === 'single' ? a.place : a.status === 'multiple' ? a.places[0] : null;
      const isArea = !!spot && (!inferred || (spot.types || []).some((t) => /sublocality|neighborhood|locality/.test(t)));
      if (isArea) inArea = same.filter((p) => km(spot, p) <= AREA_RADIUS_KM);
      else if (inferred) where = ''; // "GMCH" is not an area: just part of the name
    }
    if (where) {
      if (!inArea.length) return { status: 'not_in_area', area: where, places: same };
      candidates = inArea;
    }
  }
  if (candidates.length === 1) return { status: 'single', place: candidates[0], confirm: label(candidates[0]) };
  return { status: 'branches', places: candidates };
}

module.exports = { findHospital, areaOf, label, AREA_RADIUS_KM };
