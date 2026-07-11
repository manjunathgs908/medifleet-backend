/**
 * scripts/migrate-driver-to-pin.js
 * ============================================================
 * One-off migration (Phase 6 of the driver-auth redesign): gives an
 * existing phone+password driver an Employee ID + PIN login identity,
 * WITHOUT touching their existing password — so both phone+password
 * and the new PIN login work for them during the transition period.
 *
 * Sets:
 *   - employeeId       -> next available DRV-NNN (only if not already set)
 *   - approvalStatus    -> 'approved' (they're already a working live
 *                          driver, not a new pending one)
 *   - pin               -> the given temp PIN (hashed by the existing
 *                          pin pre('save') hook in models/index.js)
 *   - pinChangeRequired -> true (forces them to set their own PIN on
 *                          first PIN-login)
 *
 * Idempotent: if the user already has an employeeId, it does nothing
 * and exits cleanly rather than overwriting an existing migration.
 *
 * Usage:
 *   node scripts/migrate-driver-to-pin.js <phone> [tempPin]
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');

const DEFAULT_TEMP_PIN = '135790';

async function nextEmployeeId() {
  const last = await User.find({ employeeId: { $regex: /^DRV-\d+$/ } })
    .sort({ employeeId: -1 })
    .limit(1);
  if (!last.length) return 'DRV-001';
  const n = parseInt(last[0].employeeId.split('-')[1], 10) + 1;
  return `DRV-${String(n).padStart(3, '0')}`;
}

async function main() {
  const phone   = process.argv[2];
  const tempPin = process.argv[3] || DEFAULT_TEMP_PIN;

  if (!phone) {
    console.error('Usage: node scripts/migrate-driver-to-pin.js <phone> [tempPin]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ phone });
  if (!user) {
    console.error(`No user found with phone ${phone}. Nothing changed.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  if (user.role !== 'driver') {
    console.error(`User ${phone} has role '${user.role}', not 'driver' — refusing to migrate.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  if (user.employeeId) {
    console.log(`User ${phone} already has employeeId ${user.employeeId} — nothing to do.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  user.employeeId       = await nextEmployeeId();
  user.approvalStatus    = 'approved';
  user.pin               = tempPin; // hashed by the pin pre('save') hook — password field untouched
  user.pinChangeRequired = true;
  await user.save();

  console.log('Migrated driver to PIN login:');
  console.log('  phone:             ', user.phone);
  console.log('  name:              ', user.name);
  console.log('  employeeId:        ', user.employeeId);
  console.log('  approvalStatus:    ', user.approvalStatus);
  console.log('  tempPin:           ', tempPin);
  console.log('  pinChangeRequired: ', user.pinChangeRequired);
  console.log('  password field:     unchanged — phone+password login still works');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
