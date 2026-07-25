/**
 * scripts/check-ownerA-ambulances.js
 * READ-ONLY. Lists Owner A's (9845474037) ambulances and DRV-001's
 * current approvalStatus/driverDocuments, to confirm there's actually
 * an ambulance DRV-001 can pick after the duty-check fix.
 * Usage: node scripts/check-ownerA-ambulances.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');
const Owner = require('../models/Owner');
const Ambulance = require('../models/Ambulance');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const owner = await Owner.findOne({ phone: '9845474037' });
  const drv001 = await User.findOne({ phone: '8884092777', role: 'driver' }).select('name employeeId approvalStatus driverDocuments owner').lean();
  const ambulances = await Ambulance.find({ owner: owner._id, isActive: true }).select('registrationNumber status serviceType').lean();

  console.log('DRV-001:', JSON.stringify(drv001, null, 2));
  console.log('\nOwner A ambulances:', JSON.stringify(ambulances, null, 2));

  await mongoose.disconnect();
})();
