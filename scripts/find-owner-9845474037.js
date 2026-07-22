/**
 * scripts/find-owner-9845474037.js
 * READ-ONLY. Looks up Owner records matching phone 9845474037 in every
 * plausible stored format (plain 10-digit, +91-prefixed, 91-prefixed,
 * with whitespace) to determine whether the record exists at all, and
 * if so, under what exact phone string.
 *
 * Only .find()/.findOne() reads — no writes.
 *
 * Usage: node scripts/find-owner-9845474037.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Owner = require('../models/Owner');

const CANDIDATES = [
  '9845474037',
  '+919845474037',
  '919845474037',
  '+91 9845474037',
  '91-9845474037',
  ' 9845474037',
  '9845474037 ',
];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  console.log('--- Exact-match checks ---');
  for (const candidate of CANDIDATES) {
    const owner = await Owner.findOne({ phone: candidate }).select('name phone otpVerified createdAt').lean();
    console.log(JSON.stringify(candidate), '->', owner ? JSON.stringify(owner) : 'not found');
  }

  console.log('\n--- Regex scan for any phone containing 9845474037 ---');
  const matches = await Owner.find({ phone: { $regex: '9845474037' } }).select('name phone otpVerified createdAt').lean();
  console.log(matches.length ? JSON.stringify(matches, null, 2) : 'no matches');

  console.log('\n--- Total Owner count in DB ---');
  console.log(await Owner.countDocuments());

  await mongoose.disconnect();
})();
