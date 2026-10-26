'use strict';

// ============================================================
// Customer numbers never leave this backend, except to a signed-in CRM
// owner (see utils/phoneViewer.js). Telecallers, the driver app and the
// fleet-owner app get two things instead:
//
//   maskPhone(raw)       "••••••4442" -- enough to recognise a caller,
//                        not enough to dial them.
//   customerRef(raw)     an opaque token that stands for the number. The
//                        CRM passes it back (to log a call outcome, open a
//                        customer's history, or place a masked call) and
//                        only this module can turn it back into a number.
//
// The ref is deterministic -- the same number always gives the same ref --
// because the CRM keys its WhatsApp conversation rows on it, exactly as it
// used to key them on the phone. It is AES-256-CTR with a synthetic IV
// (HMAC of the number), so it is both reversible here and tamper-evident:
// a decoded number whose HMAC does not reproduce the IV is rejected.
//
// Keys derive from CUSTOMER_REF_SECRET, falling back to JWT_SECRET so no
// new Render variable is required. Rotating either invalidates refs the
// CRM holds in memory; it just reloads the list.
// ============================================================

const crypto = require('crypto');
const { normalisePhone } = require('./phone');

const REF_PREFIX = 'c_';

function keys() {
  const secret = process.env.CUSTOMER_REF_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('CUSTOMER_REF_SECRET (or JWT_SECRET) must be set to issue customer references.');
  return {
    enc: crypto.createHash('sha256').update(`customer-ref:enc:${secret}`).digest(),
    mac: crypto.createHash('sha256').update(`customer-ref:mac:${secret}`).digest(),
  };
}

function syntheticIv(macKey, phone) {
  return crypto.createHmac('sha256', macKey).update(phone).digest().subarray(0, 16);
}

function maskPhone(raw) {
  const digits = normalisePhone(raw);
  return digits.length >= 4 ? `••••••${digits.slice(-4)}` : null;
}

// Encodes the stored digits exactly as stored (WhatsApp keeps "9199…",
// trips keep 10 digits), not a normalised form: the WhatsApp outcome log is
// matched to its conversation on the exact string, so a ref must hand back
// precisely what it was made from.
function customerRef(raw) {
  const phone = String(raw ?? '').replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 15) return null;
  const { enc, mac } = keys();
  const iv = syntheticIv(mac, phone);
  const cipher = crypto.createCipheriv('aes-256-ctr', enc, iv);
  const body = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  return REF_PREFIX + Buffer.concat([iv, body]).toString('base64url');
}

// Returns the stored digits, or null for anything that is not a ref this
// backend issued. Callers that dial normalise it themselves.
function phoneFromRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX) || ref.length > 200) return null;
  let raw;
  try {
    raw = Buffer.from(ref.slice(REF_PREFIX.length), 'base64url');
  } catch {
    return null;
  }
  if (raw.length < 26 || raw.length > 31) return null; // 16-byte IV + 10-15 digits
  const { enc, mac } = keys();
  const iv = raw.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', enc, iv);
  const phone = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
  if (!/^\d{10,15}$/.test(phone)) return null;
  const expected = syntheticIv(mac, phone);
  return crypto.timingSafeEqual(expected, iv) ? phone : null;
}

const isCustomerRef = (v) => typeof v === 'string' && v.startsWith(REF_PREFIX);

module.exports = { maskPhone, customerRef, phoneFromRef, isCustomerRef };
