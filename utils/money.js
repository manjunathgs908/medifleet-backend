'use strict';
/**
 * utils/money.js
 * ============================================================
 * Money as whole paise (integers) wherever it is added up or compared.
 * Bills keep their amounts in rupees as they always have (grandTotal,
 * paidAmount); they are converted here, once, so ₹1234.50 is always
 * 123450 paise and no float sum ever drifts.
 * ============================================================
 */

const MAX_PAYMENT_PAISE = 10_00_000 * 100; // ₹10,00,000 — no single receipt above this

// A stored rupee figure (Bill.grandTotal / paidAmount, Trip.estimatedFare) -> paise.
const toPaise = (rupees) => {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toRupees = (paise) => paise / 100;

// What a person typed: "1500", "1500.5", "1,500.50" -> paise; anything
// else (negative, zero, more than two decimals, words, objects) -> null.
function parseAmount(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return paise > 0 && paise <= MAX_PAYMENT_PAISE ? paise : null;
}

// "₹1,234.50" / "₹1,234" for messages and receipts.
const formatRupees = (paise) => {
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

module.exports = { toPaise, toRupees, parseAmount, formatRupees, MAX_PAYMENT_PAISE };
