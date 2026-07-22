/**
 * scripts/list-owners.js
 * READ-ONLY. Lists all Owner documents (name, phone, createdAt) to see
 * what's actually in the collection right now.
 * Usage: node scripts/list-owners.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const owners = await Owner.find({}).select('name phone otpVerified kycStatus createdAt').lean();
  console.log(JSON.stringify(owners, null, 2));
  await mongoose.disconnect();
})();
