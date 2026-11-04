/**
 * scripts/cleanup-transactional-data.js
 * ============================================================
 * ONE-OFF fresh start: empties the TRANSACTIONAL collections — trips and
 * bookings, billing and finance transactions, and call logs — and nothing
 * else. Take an Atlas backup first.
 *
 *   node scripts/cleanup-transactional-data.js            # dry run: counts only, deletes nothing
 *   node scripts/cleanup-transactional-data.js --confirm  # deletes every document in TARGETS
 *
 * Safety:
 *   - Connects with MONGO_URI from the environment only; prints the host
 *     and database name (never the URI or its password) before anything.
 *   - Deletes ONLY the collections named in TARGETS below — an explicit
 *     allowlist; nothing is matched by pattern. Documents are removed with
 *     deleteMany({}); the collections themselves, their indexes and
 *     validators stay.
 *   - Refuses to start if TARGETS ever names a collection in NEVER_TOUCH
 *     (clients/partners, hospitals, pricing, staff, settings, config,
 *     counters) — a guard against a careless edit of this file.
 *   - Every other collection is counted before and after, and the script
 *     reports any whose count changed (it never writes to them; live app
 *     traffic or TTL expiry can still move a count).
 *   - Any argument other than --confirm stops it, so a typo never runs.
 *
 * Kept on purpose (not "transactional" in the sense asked for):
 *   paymentreceiptcounters — receipt/refund/reversal numbering continues,
 *     so a receipt number already given to a customer is never reissued;
 *   loans — the vehicle-loan master and its EMI schedule;
 *   leads, whatsappleads, sosalerts, notifications, attendance, shifts,
 *   assignments — not trips, finance or calls.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

// The only collections this script deletes from.
const TARGETS = {
  'Trips & bookings': [
    'trips',            // Trip — every booking/trip
    'bookingtrips',     // BookingTrip — a booking's stage records
    'quotes',           // Quote — "Quote & Confirm" booking links
    'tripactivities',   // TripActivity — driver trip/duty activity log
    'tripcallevents',   // TripCallEvent — a trip's dispatch-notification trail
    'chatmessages',     // ChatMessage — in-trip customer/driver chat
  ],
  'Billing & finance': [
    'bills',                 // Bill — trip invoices
    'hospitalinvoices',      // HospitalInvoice — monthly hospital invoices
    'payments',              // Payment — receipts, advances taken, refunds, reversals
    'providerpaymentissues', // Razorpay payments held for owner review
    'incomes',               // Income
    'expenses',              // Expense (incl. EMI payments)
    'advances',              // Advance — driver salary advances
    'salaryrecords',         // SalaryRecord — monthly payroll
  ],
  'Call logs': [
    'calllogs',          // CallLog — every Plivo/Exotel call
    'callbacktasks',     // CallbackTask — the missed-call callback queue (links to calllogs)
    'whatsappcalllogs',  // WhatsAppCallLog — call-backs on WhatsApp conversations
    'webrtcdebugevents', // in-app calling diagnostics (24h TTL)
  ],
};

// Must never be emptied by this script, whatever TARGETS says.
const NEVER_TOUCH = [
  'users',                   // staff, telecallers, drivers
  'owners',                  // fleet partners (clients)
  'hospitals',               // hospital clients
  'pricing',                 // pricing slabs
  'ambulances', 'fleets', 'vehicles', 'assignments',
  'leads', 'leadclaims', 'whatsappleads', 'whatsappsessions',
  'paymentreceiptcounters',  // receipt numbering
  'loans',
  'webrtcendpoints',
  'seoarticles', 'seolivepages',
  'durations', 'floors',
  'settings', 'configs', 'config', 'counters',
];

const targetList = Object.values(TARGETS).flat();

function fail(msg) {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(9);

async function countAll(db, names) {
  const out = {};
  for (const n of names) out[n] = await db.collection(n).countDocuments({});
  return out;
}

(async () => {
  // ── Arguments ───────────────────────────────────────────────
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--confirm');
  if (unknown.length) fail(`unknown argument(s): ${unknown.join(' ')}. Use no argument for a dry run, or --confirm to delete.`);
  const confirm = args.includes('--confirm');

  // ── Guards on this file itself ──────────────────────────────
  const clash = targetList.filter((c) => NEVER_TOUCH.includes(c));
  if (clash.length) fail(`TARGETS includes protected collection(s): ${clash.join(', ')}. Nothing was changed.`);
  if (new Set(targetList).size !== targetList.length) fail('TARGETS lists a collection twice. Nothing was changed.');

  if (!process.env.MONGO_URI) fail('MONGO_URI is not set in the environment.');

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const { host } = mongoose.connection;

  console.log('============================================================');
  console.log(confirm ? ' CLEANUP — DELETING (--confirm)' : ' CLEANUP — DRY RUN (nothing will be deleted)');
  console.log('============================================================');
  console.log(` Host     : ${host}`);
  console.log(` Database : ${db.databaseName}`);

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const presentTargets = targetList.filter((c) => existing.has(c));
  const missingTargets = targetList.filter((c) => !existing.has(c));
  const others = [...existing].filter((c) => !targetList.includes(c) && !c.startsWith('system.')).sort();

  const before = await countAll(db, presentTargets);
  const othersBefore = await countAll(db, others);

  console.log('\n Would delete ALL documents from:' );
  let total = 0;
  for (const [group, names] of Object.entries(TARGETS)) {
    console.log(`\n  ${group}`);
    for (const n of names) {
      if (!existing.has(n)) { console.log(`    ${pad(n, 24)} ${num('—')}   (no such collection — skipped)`); continue; }
      total += before[n];
      console.log(`    ${pad(n, 24)} ${num(before[n])}`);
    }
  }
  console.log(`\n  ${pad('TOTAL', 26)} ${num(total)}`);

  console.log('\n Not touched (count now):');
  for (const n of others) console.log(`    ${pad(n, 24)} ${num(othersBefore[n])}${NEVER_TOUCH.includes(n) ? '   protected' : ''}`);

  if (!confirm) {
    console.log('\n DRY RUN — nothing was deleted. To delete the documents above, run again with --confirm.');
    await mongoose.disconnect();
    return;
  }

  // ── Delete ──────────────────────────────────────────────────
  console.log('\n Deleting…');
  const removed = {};
  for (const n of presentTargets) {
    const r = await db.collection(n).deleteMany({});
    removed[n] = r.deletedCount;
    console.log(`    ${pad(n, 24)} removed ${num(r.deletedCount)}`);
  }

  const after = await countAll(db, presentTargets);
  const othersAfter = await countAll(db, others);

  console.log('\n Result:');
  console.log(`    ${pad('collection', 24)} ${num('before')} ${num('removed')} ${num('remaining')}`);
  let removedTotal = 0;
  for (const n of presentTargets) {
    removedTotal += removed[n];
    console.log(`    ${pad(n, 24)} ${num(before[n])} ${num(removed[n])} ${num(after[n])}`);
  }
  console.log(`    ${pad('TOTAL', 24)} ${num(total)} ${num(removedTotal)} ${num(Object.values(after).reduce((a, b) => a + b, 0))}`);
  if (missingTargets.length) console.log(`\n    Not present (skipped): ${missingTargets.join(', ')}`);

  const notEmpty = presentTargets.filter((n) => after[n] > 0);
  if (notEmpty.length) {
    console.log(`\n NOTE: new documents arrived during the run in: ${notEmpty.join(', ')} (live app traffic). Re-run with --confirm if they should go too.`);
  }

  console.log('\n Not touched (before → after):');
  const moved = [];
  for (const n of others) {
    const changed = othersBefore[n] !== othersAfter[n];
    if (changed) moved.push(n);
    console.log(`    ${pad(n, 24)} ${num(othersBefore[n])} → ${num(othersAfter[n])}${changed ? '   (changed — app traffic or TTL expiry, not this script)' : ''}`);
  }
  console.log(moved.length
    ? `\n Done. ${moved.length} untouched collection(s) moved on their own: ${moved.join(', ')}.`
    : '\n Done. Every untouched collection has the same count as before.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('\nFAILED:', err?.message || err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
