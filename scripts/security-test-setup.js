/**
 * scripts/security-test-setup.js
 * Creates throwaway Owner B + Fleet B + Ambulance B + Driver B (all
 * clearly marked SECURITY-TEST-*), then mints JWTs for Owner A
 * ("SaveLife Owner", 9845474037) and DRV-001 (8884092777) so the owner-
 * scoping fixes can be exercised live against production via curl.
 * Prints everything needed, then scripts/security-test-cleanup.js
 * removes it all afterward.
 * Usage: node scripts/security-test-setup.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const Owner = require('../models/Owner');
const Fleet = require('../models/Fleet');
const Ambulance = require('../models/Ambulance');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const ownerA = await Owner.findOne({ phone: '9845474037' });
  const drv001 = await User.findOne({ phone: '8884092777', role: 'driver' });
  if (!ownerA || !drv001) throw new Error('Owner A or DRV-001 not found — aborting.');

  const ownerB = await Owner.findOneAndUpdate(
    { phone: '9111111111' },
    { name: 'SECURITY-TEST-OwnerB' },
    { upsert: true, new: true }
  );
  const fleetB = await Fleet.findOneAndUpdate(
    { owner: ownerB._id, name: 'SECURITY-TEST-FleetB' },
    {},
    { upsert: true, new: true }
  );
  const ambulanceB = await Ambulance.findOneAndUpdate(
    { registrationNumber: 'KA-SECTEST-01' },
    { owner: ownerB._id, fleet: fleetB._id, serviceType: 'BLS', status: 'available' },
    { upsert: true, new: true }
  );
  const driverB = await User.findOneAndUpdate(
    { phone: '9222222222', role: 'driver' },
    { employeeId: 'SECURITY-TEST-DRVB', name: 'SECURITY-TEST-DriverB', pin: '0000', approvalStatus: 'approved', owner: ownerB._id },
    { upsert: true, new: true }
  );

  const ownerAToken = jwt.sign({ id: ownerA._id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const drv001Token = jwt.sign({ id: drv001._id, deviceId: drv001.deviceId }, process.env.JWT_SECRET, { expiresIn: '10m' });

  console.log(JSON.stringify({
    ownerAId: String(ownerA._id),
    drv001Id: String(drv001._id),
    ownerBId: String(ownerB._id),
    driverBId: String(driverB._id),
    ambulanceBId: String(ambulanceB._id),
    ownerAToken,
    drv001Token,
  }, null, 2));

  await mongoose.disconnect();
})();
