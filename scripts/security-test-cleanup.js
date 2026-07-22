/**
 * scripts/security-test-cleanup.js
 * Removes the throwaway SECURITY-TEST-* fixtures created by
 * scripts/security-test-setup.js after live cross-tenant verification.
 * Usage: node scripts/security-test-cleanup.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');
const Owner = require('../models/Owner');
const Fleet = require('../models/Fleet');
const Ambulance = require('../models/Ambulance');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const r1 = await User.deleteOne({ phone: '9222222222', role: 'driver', employeeId: 'SECURITY-TEST-DRVB' });
  const r2 = await Ambulance.deleteOne({ registrationNumber: 'KA-SECTEST-01' });
  const r3 = await Fleet.deleteOne({ name: 'SECURITY-TEST-FleetB' });
  const r4 = await Owner.deleteOne({ phone: '9111111111', name: 'SECURITY-TEST-OwnerB' });

  console.log('Deleted driverB:', r1.deletedCount, 'ambulanceB:', r2.deletedCount, 'fleetB:', r3.deletedCount, 'ownerB:', r4.deletedCount);

  await mongoose.disconnect();
})();
