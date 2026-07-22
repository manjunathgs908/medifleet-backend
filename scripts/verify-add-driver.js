/**
 * scripts/verify-add-driver.js
 * Mints a short-lived Owner A JWT and prints it, so the new
 * POST /driver-auth/register (Add Driver) flow can be exercised live
 * against production via curl before publishing the app OTA update.
 * Usage: node scripts/verify-add-driver.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const ownerA = await Owner.findOne({ phone: '9845474037' });
  if (!ownerA) throw new Error('Owner A not found.');

  const token = jwt.sign({ id: ownerA._id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  console.log(token);

  await mongoose.disconnect();
})();
