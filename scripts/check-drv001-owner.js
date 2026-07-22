/**
 * scripts/check-drv001-owner.js
 * READ-ONLY. Checks DRV-001 (phone 8884092777)'s owner link, and looks
 * for any other drivers with a null/missing owner field too.
 * Usage: node scripts/check-drv001-owner.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const drv001 = await User.findOne({ phone: '8884092777' }).select('name employeeId phone role owner approvalStatus').lean();
  console.log('DRV-001 (8884092777):', JSON.stringify(drv001, null, 2));

  const unlinkedDrivers = await User.find({ role: 'driver', owner: { $exists: false } })
    .select('name employeeId phone owner')
    .lean();
  console.log('\nAll drivers with NO owner field at all:', JSON.stringify(unlinkedDrivers, null, 2));

  const nullOwnerDrivers = await User.find({ role: 'driver', owner: null })
    .select('name employeeId phone owner')
    .lean();
  console.log('\nAll drivers with owner explicitly null:', JSON.stringify(nullOwnerDrivers, null, 2));

  await mongoose.disconnect();
})();
