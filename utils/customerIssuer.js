'use strict';
/**
 * utils/customerIssuer.js
 * ============================================================
 * Who issues customer-facing bills and payment receipts — exactly what is
 * printed on them, and nothing more. Business name, GSTIN, registered
 * address and contact details only: no proprietor or other personal name,
 * and no legal-entity line. The internal legal identity
 * (services/seoFacts.js BUSINESS.legalName) is deliberately not used here
 * and stays unchanged.
 *
 * GSTIN as given by the owner. 29 = Karnataka, matching the address; the
 * check digit is verified in tests/payments.test.js.
 * ============================================================
 */
const { BUSINESS } = require('../services/seoFacts');

const CUSTOMER_ISSUER = Object.freeze({
  name   : BUSINESS.name,
  gstin  : '29CIQPM9958R1ZK',
  address: BUSINESS.address,
  phone  : BUSINESS.callNumber,
  whatsapp: BUSINESS.whatsappNumber,
  email  : BUSINESS.email,
  website: BUSINESS.website,
  // MSME (Udyam) registration, printed on GST invoices.
  udyam  : 'UDYAM-KR-03-0024329',
});

// GSTIN check digit (the standard mod-36 scheme), for the test above.
function gstinCheckDigitValid(gstin) {
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = cs.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return cs[(36 - (sum % 36)) % 36] === gstin[14];
}

module.exports = { CUSTOMER_ISSUER, gstinCheckDigitValid };
