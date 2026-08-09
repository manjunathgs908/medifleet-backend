'use strict';

// ============================================================
// The one place a phone number gets normalised for comparison anywhere in
// this codebase. Every collection that stores a phone number disagrees
// with every other on format: WhatsApp-side collections (WhatsAppSession/
// WhatsAppFunnelEvent/WhatsAppCallLog) store Meta's wa_id verbatim --
// country code, no '+' (e.g. "919986844442"); Trip.patientPhone and
// Lead.phone are whatever the booking/call channel sent, unvalidated --
// sometimes the bare 10-digit number, sometimes with a country code,
// occasionally with a leading trunk '0'. A prefix-strip regex
// (`^(\+91|91|0)`) only recognises those THREE specific prefixes and only
// at the very start of the string -- it silently fails on anything else
// (a stray space before the prefix, a dash in the middle, a prefix it
// doesn't know about) and two formats of the same real number then look
// like two different people everywhere a phone is looked up.
//
// The rule here is simpler and covers all of that: strip every non-digit
// character, then keep only the last 10 digits. Indian mobile numbers are
// always 10 digits, so whatever precedes them (country code, trunk zero,
// nothing, or stray formatting) is irrelevant -- the last 10 digits alone
// identify the subscriber.
//
// Every phone comparison in this codebase must go through normalisePhone
// or phoneSuffixQuery below, not its own regex.
// ============================================================

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// Mongo query filter matching a phone field that ends with these 10
// digits, whatever (if anything) precedes them -- for querying fields
// that may or may not carry a country code/leading zero/formatting.
// Takes the RAW value (not pre-normalised) and normalises it itself, so
// callers never have to remember to call normalisePhone first.
function phoneSuffixQuery(raw) {
  const normalised = normalisePhone(raw);
  return { $regex: `${normalised}$` };
}

module.exports = { normalisePhone, phoneSuffixQuery };
