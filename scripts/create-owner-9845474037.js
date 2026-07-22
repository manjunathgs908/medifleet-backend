/**
 * scripts/create-owner-9845474037.js
 * Recreates the Owner record for phone 9845474037, confirmed missing
 * from the DB (see scripts/find-owner-9845474037.js). One-time fix for
 * a record lost during earlier test-data cleanup.
 * Usage: node scripts/create-owner-9845474037.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await Owner.findOne({ phone: '9845474037' });
  if (existing) {
    console.log('Already exists, not creating:', JSON.stringify(existing));
  } else {
    const owner = await Owner.create({ phone: '9845474037', name: 'SaveLife Owner' });
    console.log('Created:', JSON.stringify(owner));
  }

  await mongoose.disconnect();
})();
