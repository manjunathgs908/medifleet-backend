/**
 * scripts/fresh-start-cleanup.js
 * User-confirmed fresh-start cleanup. Deletes:
 *   - Test owners: "Test Owner" (9000000099), "Manjunath" (9008865545)
 *   - DRV-001 driver (8884092777)
 *   - Ambulances KA05AN4848, KA05AN5858 (+ their Fleets)
 *   - All Assignments/Shifts (all tied to the above, per inventory)
 *   - All Trips, plus any Bill/Income/Notification referencing them
 * Keeps:
 *   - Owner "SaveLife Owner" (9845474037)
 *   - Its shadow-driver record (isOwnerSelf) — deviceId cleared, not deleted
 * Usage: node scripts/fresh-start-cleanup.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Trip, Bill, Income, Notification } = require('../models');
const Owner = require('../models/Owner');
const Fleet = require('../models/Fleet');
const Ambulance = require('../models/Ambulance');
const Assignment = require('../models/Assignment');
const Shift = require('../models/Shift');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const tripIds = (await Trip.find({}).select('_id').lean()).map(t => t._id);

  const results = {};
  results.notifications = (await Notification.deleteMany({ trip: { $in: tripIds } })).deletedCount;
  results.bills         = (await Bill.deleteMany({ trip: { $in: tripIds } })).deletedCount;
  results.income        = (await Income.deleteMany({ trip: { $in: tripIds } })).deletedCount;
  results.trips          = (await Trip.deleteMany({})).deletedCount;

  results.assignments = (await Assignment.deleteMany({})).deletedCount;
  results.shifts       = (await Shift.deleteMany({})).deletedCount;

  results.ambulances = (await Ambulance.deleteMany({ registrationNumber: { $in: ['KA05AN4848', 'KA05AN5858'] } })).deletedCount;
  results.fleets      = (await Fleet.deleteMany({ name: 'My Fleet' })).deletedCount;

  results.drv001 = (await User.deleteOne({ phone: '8884092777', role: 'driver' })).deletedCount;

  results.testOwners = (await Owner.deleteMany({ phone: { $in: ['9000000099', '9008865545'] } })).deletedCount;

  // Keep the real owner's shadow-driver identity, just clear its device binding.
  results.deviceIdCleared = (await User.updateMany(
    { role: 'driver' },
    { $unset: { deviceId: '' } }
  )).modifiedCount;

  console.log(JSON.stringify(results, null, 2));

  await mongoose.disconnect();
})();
