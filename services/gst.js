'use strict';

// ============================================================
// services/gst.js — the GST maths for sale invoices. Pure functions, no
// database: every rule here is tested on its own (tests/gstInvoicing.test.js).
//
// Money is whole paise. Rates are percentages (18 = 18%), never hard-coded
// per service: each catalog item carries its own SAC/HSN, tax type, rate and
// reverse-charge flag, set by the owner.
//
//   Intra-state (place of supply = our state): CGST + SGST, each half the
//   rate, each computed and rounded to the paisa on its own.
//   Inter-state: IGST at the full rate.
//   Exempt / nil / non-GST lines carry no tax. An invoice whose lines are all
//   untaxed is a bill of supply (Section 31(3)(c), Rule 49); any taxable line
//   makes it a tax invoice.
//   Reverse charge: the tax is worked out and shown, but the recipient pays
//   it — it is not added to what the customer owes us.
// ============================================================

const { financialYear } = require('./payments');
const { gstinCheckDigitValid } = require('../utils/customerIssuer');

// GST state codes as printed on invoices and returns.
const STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim',
  12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam',
  19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep',
  32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana',
  37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
});
const stateName = (code) => STATES[String(code).padStart(2, '0')] || null;
const isStateCode = (code) => /^\d{2}$/.test(String(code || '')) && !!stateName(code);

// Ours: the state of the GSTIN we invoice under.
const SUPPLIER_STATE = '29';

const TAX_TYPES = ['taxable', 'exempt', 'nil', 'non_gst'];
// Rates GST uses. Which applies to which service is the owner's setting.
const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40];
const PARTY_KINDS = ['registered', 'unregistered', 'consumer'];
const DOC_TYPES = ['tax_invoice', 'bill_of_supply'];

// ── GSTIN ─────────────────────────────────────────────────────
const normaliseGstin = (v) => String(v || '').trim().toUpperCase();
function gstinProblem(gstin) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return 'A GSTIN is 15 characters, e.g. 29AAACN7335C1ZL.';
  if (!isStateCode(gstin.slice(0, 2))) return 'The first two digits of this GSTIN are not a state code.';
  if (!gstinCheckDigitValid(gstin)) return 'This GSTIN fails its check digit — please re-check it.';
  return null;
}
const stateOfGstin = (gstin) => String(gstin || '').slice(0, 2);

// ── SAC / HSN ─────────────────────────────────────────────────
// SAC codes are 6 digits starting 99; HSN codes for goods 4, 6 or 8 digits.
function codeProblem(code, kind = 'service') {
  const c = String(code || '').trim();
  if (kind === 'service') return /^99\d{4}$/.test(c) ? null : 'A SAC code is 6 digits starting with 99, e.g. 999315.';
  return /^(\d{4}|\d{6}|\d{8})$/.test(c) ? null : 'An HSN code is 4, 6 or 8 digits.';
}

// ── Amounts typed by a person ─────────────────────────────────
// "64000", "64,000.50" → paise. Up to ₹1 crore per figure.
const MAX_FIGURE_PAISE = 1_00_00_000 * 100;
function parseRupees(input, { allowZero = false } = {}) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (paise > MAX_FIGURE_PAISE) return null;
  return paise > 0 || (allowZero && paise === 0) ? paise : null;
}
// Quantity: up to 3 decimals (e.g. 12.5 km), kept as thousandths.
function parseQty(input) {
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(String(input ?? '').trim());
  if (!m) return null;
  const milli = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  return milli > 0 ? milli : null;
}

// ── The invoice ───────────────────────────────────────────────
const bp = (rate) => Math.round(Number(rate) * 100); // 18 → 1800 basis points
const pct = (paise, basisPoints) => Math.round((paise * basisPoints) / 10000);

// One line. qtyMilli: quantity in thousandths; ratePaise: per unit;
// discount: { paise } or { percent }.
function computeLine(line, { interState }) {
  const gross = Math.round((line.qtyMilli * line.ratePaise) / 1000);
  let discountPaise = 0;
  if (line.discountPercent != null) discountPaise = pct(gross, bp(line.discountPercent));
  else if (line.discountPaise != null) discountPaise = line.discountPaise;
  const taxablePaise = gross - discountPaise;
  const taxed = line.taxType === 'taxable' && Number(line.gstRate) > 0;
  const rateBp = taxed ? bp(line.gstRate) : 0;
  const cgstPaise = taxed && !interState ? pct(taxablePaise, rateBp / 2) : 0;
  const sgstPaise = cgstPaise;
  const igstPaise = taxed && interState ? pct(taxablePaise, rateBp) : 0;
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  return {
    grossPaise: gross, discountPaise, taxablePaise,
    gstRate: taxed ? Number(line.gstRate) : 0,
    cgstPaise, sgstPaise, igstPaise, taxPaise,
    totalPaise: taxablePaise + taxPaise,
  };
}

// lines: [{ name, code, unit, qtyMilli, ratePaise, discountPaise|discountPercent,
// taxType, gstRate, reverseCharge }]; placeOfSupply: state code.
// Returns problems (if any) and the computed invoice.
function computeInvoice({ lines = [], placeOfSupply, roundOff = true }) {
  const problems = [];
  if (!isStateCode(placeOfSupply)) problems.push('Choose the place of supply (state).');
  const interState = String(placeOfSupply).padStart(2, '0') !== SUPPLIER_STATE;
  if (!lines.length) problems.push('Add at least one line.');

  const out = lines.map((l, i) => {
    const n = `Line ${i + 1}`;
    if (!l.name) problems.push(`${n}: name the service.`);
    if (!(l.qtyMilli > 0)) problems.push(`${n}: quantity must be more than 0.`);
    if (!(l.ratePaise >= 0)) problems.push(`${n}: enter a rate.`);
    if (!TAX_TYPES.includes(l.taxType)) problems.push(`${n}: choose taxable, exempt, nil or non-GST.`);
    if (l.taxType === 'taxable' && !GST_RATES.includes(Number(l.gstRate))) problems.push(`${n}: choose a GST rate.`);
    if (l.discountPercent != null && !(l.discountPercent >= 0 && l.discountPercent <= 100)) problems.push(`${n}: discount must be 0–100%.`);
    const c = computeLine(l, { interState });
    if (c.discountPaise > c.grossPaise || c.discountPaise < 0) problems.push(`${n}: the discount is more than the line.`);
    return { ...l, ...c };
  });

  const rcm = out.filter((l) => l.reverseCharge && l.taxType === 'taxable');
  const reverseCharge = rcm.length > 0;
  if (reverseCharge && rcm.length !== out.filter((l) => l.taxType === 'taxable').length) {
    problems.push('Reverse-charge and ordinary taxable services cannot be on one invoice — issue them separately.');
  }

  const sum = (k) => out.reduce((s, l) => s + l[k], 0);
  const taxablePaise = sum('taxablePaise');
  const cgstPaise = sum('cgstPaise');
  const sgstPaise = sum('sgstPaise');
  const igstPaise = sum('igstPaise');
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  // Under reverse charge the recipient pays the tax to the government.
  const beforeRound = taxablePaise + (reverseCharge ? 0 : taxPaise);
  const rounded = roundOff ? Math.round(beforeRound / 100) * 100 : beforeRound;
  const roundOffPaise = rounded - beforeRound;

  // The tax breakup printed under the lines: one row per rate.
  const byRate = new Map();
  for (const l of out.filter((x) => x.taxPaise > 0)) {
    const r = byRate.get(l.gstRate) || { gstRate: l.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    r.taxablePaise += l.taxablePaise; r.cgstPaise += l.cgstPaise; r.sgstPaise += l.sgstPaise; r.igstPaise += l.igstPaise;
    byRate.set(l.gstRate, r);
  }

  const docType = out.some((l) => l.taxType === 'taxable') ? 'tax_invoice' : 'bill_of_supply';
  if (rounded <= 0 && lines.length) problems.push('The invoice total must be more than ₹0.');
  return {
    problems,
    invoice: {
      docType,
      supplyType: interState ? 'inter' : 'intra',
      reverseCharge,
      lines: out,
      totals: { taxablePaise, cgstPaise, sgstPaise, igstPaise, taxPaise, roundOffPaise, grandTotalPaise: rounded },
      taxSummary: [...byRate.values()].sort((a, b) => a.gstRate - b.gstRate),
    },
  };
}

// ── Numbering ─────────────────────────────────────────────────
// Rule 46: unique in the financial year, at most 16 characters.
const SERIES_PREFIX = { tax_invoice: '', bill_of_supply: 'BS/' };
const formatNumber = (docType, fy, seq) => `${SERIES_PREFIX[docType]}${fy}/${seq}`;

// ── Amount in words (Indian system) ───────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}
function rupeesInWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1_00_00_000);
  const lakh = Math.floor((n % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((n % 1_00_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${rupeesInWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}
function amountInWords(paise) {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `${rupeesInWords(rupees)} Rupees${p ? ` and ${twoDigits(p)} Paise` : ''} only`;
}

module.exports = {
  STATES, stateName, isStateCode, SUPPLIER_STATE, TAX_TYPES, GST_RATES, PARTY_KINDS, DOC_TYPES,
  normaliseGstin, gstinProblem, stateOfGstin, codeProblem, parseRupees, parseQty,
  computeLine, computeInvoice, formatNumber, amountInWords, financialYear,
};
