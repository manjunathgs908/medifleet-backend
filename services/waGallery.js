'use strict';
/**
 * services/waGallery.js
 * ============================================================
 * The preset ambulance types staff can send a photo of from WhatsApp Chats.
 * The list and labels are fixed here; each type's photo is set by the owner
 * (models/WaGalleryPhoto) — a type with no photo yet cannot be sent.
 * ============================================================
 */
const PRESETS = [
  { id: 'bls_eeco',      label: 'BLS Maruti Eeco' },
  { id: 'bls_tempo',     label: 'BLS Tempo' },
  { id: 'als',           label: 'ALS' },
  { id: 'acls',          label: 'ACLS' },
  { id: 'nicu',          label: 'NICU' },
  { id: 'body_shifting', label: 'Body Shifting' },
  { id: 'body_mini',     label: 'Body Mini' },
];

const byId = (id) => PRESETS.find((p) => p.id === id) || null;
const defaultCaption = (label) => `SaveLife ${label} ambulance`;

module.exports = { PRESETS, byId, defaultCaption };
