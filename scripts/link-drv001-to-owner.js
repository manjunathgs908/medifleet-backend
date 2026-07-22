/**
 * scripts/link-drv001-to-owner.js
 * Links DRV-001 (phone 8884092777), created before the Phase 4 owner
 * field existed, to the SaveLife Owner account (phone 9845474037).
 * Usage: node scripts/link-drv001-to-owner.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const owner = await Owner.findOne({ phone: '9845474037' });
  if (!owner) throw new Error('Owner 9845474037 not found — aborting.');

  const driver = await User.findOneAndUpdate(
    { phone: '8884092777', role: 'driver' },
    { owner: owner._id },
    { new: true }
  ).select('name employeeId phone owner');

  if (!driver) throw new Error('DRV-001 (8884092777) not found — aborting.');
  console.log('Linked:', JSON.stringify(driver));

  await mongoose.disconnect();
})();
