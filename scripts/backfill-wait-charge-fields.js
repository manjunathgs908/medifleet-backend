/**
 * scripts/backfill-wait-charge-fields.js
 * ============================================================
 * ONE-OFF MIGRATION. Schema defaults (pricingSchema in models/index.js)
 * only apply to Pricing documents created AFTER the schema change —
 * existing docs (BLS, ICU, etc.) have these wait-charge fields as
 * `undefined` until this backfill runs.
 *
 * Sets every EXISTING Pricing document to the agreed wait-charge
 * defaults via $set. Idempotent — safe to re-run; it always writes the
 * same fixed values, it does not increment/toggle anything.
 *
 * Usage:
 *   node scripts/backfill-wait-charge-fields.js
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const { Pricing } = require('../models');

const WAIT_DEFAULTS = {
  pickupFreeWaitMinutes: 10,
  pickupWaitPerMin     : 5,

  dropFreeWaitMinutes: 10,
  dropWaitPerMin     : 10,

  returnDropFreeWaitMinutes : 10,
  returnDropWaitTier1PerMin : 5,
  returnDropWaitTier1Minutes: 120,
  returnDropWaitTier2PerMin : 10,

  trafficWaitPerMin: 3,
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Backfilling wait-charge fields on all Pricing documents...\n');

  const before = await Pricing.countDocuments({});
  console.log(`Total Pricing documents: ${before}`);

  const result = await Pricing.updateMany({}, { $set: WAIT_DEFAULTS });
  console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount} document(s).\n`);

  const sample = await Pricing.findOne({}).lean();
  console.log('Sample readback (one Pricing document):');
  console.log(JSON.stringify(sample, null, 2));

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
