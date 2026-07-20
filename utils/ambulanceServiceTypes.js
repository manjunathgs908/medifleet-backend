/**
 * utils/ambulanceServiceTypes.js
 * ============================================================
 * Vehicle-type options for Add Ambulance. The 7 medical/body entries
 * mirror the live MongoDB Pricing collection's serviceType values
 * exactly (cross-checked directly against both the Pricing collection
 * and savelife-app's src/utils/ambulanceCatalog.js — the two already
 * agree 1:1). HEARSE and FREEZER_BOX are vehicle-level categories: one
 * physical vehicle covers Basic/Standard/Luxury (hearse) or
 * Normal/Standard/VIP (freezer box) sub-types, which are priced
 * separately per-trip (hearse_basic/standard/luxury, normal/standard/vip)
 * but don't need their own Ambulance documents. Standby/Event ambulance
 * are service *modes* on existing vehicles, not separate vehicle types —
 * deliberately not listed here.
 *
 * medifleet-app's Add Ambulance screen hardcodes the identical list for
 * its picker — keep both in sync if this changes (same convention as
 * savelife-web's pricing.js "app inda EXACT same copy" comment).
 * ============================================================
 */
'use strict';

const AMBULANCE_SERVICE_TYPES = [
  { serviceType: 'BLS',        label: 'BLS Ambulance — Maruti Eeco',               vehicleModel: 'Maruti Eeco' },
  { serviceType: 'BLS_TEMPO',  label: 'BLS Ambulance — Tempo Traveller',           vehicleModel: 'Tempo Traveller' },
  { serviceType: 'ALS_TEMPO',  label: 'ALS Ambulance — Tempo Traveller',           vehicleModel: 'Tempo Traveller' },
  { serviceType: 'ACLS_TEMPO', label: 'ACLS Ambulance — Tempo Traveller',          vehicleModel: 'Tempo Traveller' },
  { serviceType: 'NICU_TEMPO', label: 'NICU Ambulance — Tempo Traveller',          vehicleModel: 'Tempo Traveller' },
  { serviceType: 'BODY_TEMPO', label: 'Body Shifting Ambulance — Tempo Traveller', vehicleModel: 'Tempo Traveller' },
  { serviceType: 'BODY_MINI',  label: 'Body Shifting Mini — Maruti Eeco',          vehicleModel: 'Maruti Eeco' },
  { serviceType: 'HEARSE',      label: 'Hearse (Basic / Standard / Luxury)',       vehicleModel: null },
  { serviceType: 'FREEZER_BOX', label: 'Freezer Box (Normal / Standard / VIP)',    vehicleModel: null },
];

const byServiceType = Object.fromEntries(AMBULANCE_SERVICE_TYPES.map(o => [o.serviceType, o]));

module.exports = { AMBULANCE_SERVICE_TYPES, byServiceType };
