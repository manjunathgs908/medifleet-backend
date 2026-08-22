/**
 * scripts/backfill-tracking-tokens.js
 * Gives a trackingToken to trips created before the field existed.
 *
 * The pre-save hook only fires on new documents, so every trip already in
 * the collection has none — including the ones live on the dispatch board
 * right now, whose customers are exactly the people who need a tracking
 * link today. Without this the feature only works for trips booked from
 * the deploy onward.
 *
 * Idempotent: only touches trips where the field is missing, so it is safe
 * to re-run. Uses updateOne per document rather than save() so the
 * pre-save hook (which would rewrite tripNumber and pickupOtp on a new
 * doc) is never involved.
 *
 * Usage: node scripts/backfill-tracking-tokens.js
 *        node scripts/backfill-tracking-tokens.js --active-only
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Trip } = require('../models');

const ACTIVE = ['booked', 'dispatched', 'en_route'];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const activeOnly = process.argv.includes('--active-only');
  const filter = {
    $or: [{ trackingToken: { $exists: false } }, { trackingToken: null }],
    ...(activeOnly ? { status: { $in: ACTIVE } } : {}),
  };

  const total = await Trip.countDocuments(filter);
  console.log(`${total} trip(s) without a trackingToken${activeOnly ? ' (active only)' : ''}.`);
  if (!total) { await mongoose.disconnect(); return; }

  // One at a time: the token is unique-indexed, and a bulk write would
  // abort the whole batch on the (astronomically unlikely) collision
  // rather than letting the rest through.
  let done = 0, failed = 0;
  const cursor = Trip.find(filter).select('_id').lean().cursor();

  for await (const { _id } of cursor) {
    try {
      await Trip.updateOne({ _id }, { $set: { trackingToken: crypto.randomBytes(16).toString('base64url') } });
      done++;
    } catch (err) {
      failed++;
      console.error(`  ${_id}: ${err.message}`);
    }
  }

  console.log(`Backfilled ${done}, failed ${failed}.`);
  const left = await Trip.countDocuments(filter);
  console.log(`Remaining without a token: ${left}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
