/**
 * scripts/restore-driver.js
 * ============================================================
 * Restores driver DRV-001 (phone 8884092777) under their ORIGINAL
 * User._id (6a52091669c5bd105eda7b7d), found by scripts/find-driver-id.js
 * to be the orphaned _id still referenced by Vehicle KA-01-AB-1234
 * (assignedDriver) and an Advance record — restoring under the same
 * _id makes those references resolve again with zero data migration.
 *
 * Background: GET /setup (now removed) ran
 *   User.deleteMany({ phone: { $in: ['8884092777', '9986844442'] } })
 * then recreated 8884092777 fresh, with a new _id, no employeeId, no
 * pin, and a throwaway password. That placeholder is what step 1 finds
 * and step 2 replaces.
 *
 * Steps:
 *   1. Find the /setup placeholder: phone 8884092777, role driver,
 *      NO employeeId set. Refuses to proceed if the phone doesn't
 *      match this exact shape (see "Idempotency / safety" below).
 *   2. Look up Vehicle KA-01-AB-1234 or Vehicle collection instead of
 *      hardcoding its _id, and cross-check its assignedDriver still
 *      equals the target old _id (the same evidence you found earlier).
 *   3. Inside a single MongoDB transaction: delete the placeholder,
 *      then create a new User with the explicit old _id.
 *   4. Print before/after state.
 *
 * Why a transaction (not delete-then-create, or create-then-delete):
 *   `phone` has a unique index, and the new doc reuses the SAME phone
 *   as the placeholder — so create-then-delete would fail outright on
 *   a duplicate-key error while the placeholder still exists, and
 *   plain delete-then-create leaves a window where a crash between the
 *   two steps means zero driver documents. A transaction makes the
 *   delete+create atomic: if anything in it throws (validation error,
 *   duplicate employeeId, connection drop, etc.), MongoDB rolls back
 *   BOTH operations and the placeholder is left exactly as it was.
 *   This requires MONGO_URI to point at a replica-set-backed Mongo
 *   (MongoDB Atlas always is, including the free tier). If it isn't,
 *   the script fails loudly before touching anything — see catch block.
 *
 * Idempotency / safety:
 *   - Aborts immediately, before touching anything, if a User already
 *     exists with the target _id.
 *   - Aborts if no user has phone 8884092777, or if that user already
 *     has an employeeId (doesn't look like the /setup placeholder —
 *     refuses to guess).
 *   - Aborts if Vehicle KA-01-AB-1234 isn't found, or its
 *     assignedDriver isn't the expected old _id.
 *   - Never queries or touches phone 9986844442 (the telecaller) or
 *     any user other than the one placeholder found in step 1.
 *   - Sets `pin` via the document (not a raw hash) so the existing
 *     pre('save') hook in models/index.js hashes it — see Q1 in the
 *     accompanying write-up.
 *   - Leaves `deviceId` unset and `password` unset — see Q2.
 *
 * Usage:
 *   node scripts/restore-driver.js [tempPin] [driverName]
 *   node scripts/restore-driver.js                  # tempPin=135790, name="Driver"
 *   node scripts/restore-driver.js 246813            # custom tempPin, name="Driver"
 *   node scripts/restore-driver.js 246813 "Ravi K."  # custom tempPin + real name
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Vehicle } = require('../models');

const OLD_DRIVER_ID   = '6a52091669c5bd105eda7b7d';
const PLACEHOLDER_PHONE = '8884092777';
const EMPLOYEE_ID     = 'DRV-001';
const VEHICLE_REG     = 'KA-01-AB-1234';
const DEFAULT_TEMP_PIN = '135790'; // same default convention as migrate-driver-to-pin.js

async function main() {
  const tempPin    = process.argv[2] || DEFAULT_TEMP_PIN;
  const driverName = process.argv[3] || 'Driver';

  if (!mongoose.Types.ObjectId.isValid(OLD_DRIVER_ID)) {
    console.error(`OLD_DRIVER_ID "${OLD_DRIVER_ID}" is not a valid ObjectId. Aborting — nothing touched.`);
    process.exit(1);
  }
  const targetId = new mongoose.Types.ObjectId(OLD_DRIVER_ID);

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  try {
    // ── Guard 1: target _id must not already exist ─────────────
    const alreadyExists = await User.findById(targetId).lean();
    if (alreadyExists) {
      console.error(`ABORT: a User document already exists with _id ${OLD_DRIVER_ID} (phone: ${alreadyExists.phone}, name: ${alreadyExists.name}).`);
      console.error('Refusing to overwrite. Nothing was changed.');
      process.exit(1);
    }

    // ── Guard 2: find and validate the /setup placeholder ──────
    const placeholder = await User.findOne({ phone: PLACEHOLDER_PHONE }).lean();
    if (!placeholder) {
      console.error(`ABORT: no user found with phone ${PLACEHOLDER_PHONE}. Nothing to restore from. Nothing was changed.`);
      process.exit(1);
    }
    if (placeholder.role !== 'driver') {
      console.error(`ABORT: user with phone ${PLACEHOLDER_PHONE} has role '${placeholder.role}', not 'driver'. Refusing to touch it. Nothing was changed.`);
      process.exit(1);
    }
    if (placeholder.employeeId) {
      console.error(`ABORT: user with phone ${PLACEHOLDER_PHONE} already has employeeId '${placeholder.employeeId}' — doesn't look like the /setup placeholder. Refusing to guess. Nothing was changed.`);
      process.exit(1);
    }

    // ── Guard 3: look up the vehicle, don't hardcode its _id ────
    const vehicle = await Vehicle.findOne({ registrationNumber: VEHICLE_REG.toUpperCase() }).lean();
    if (!vehicle) {
      console.error(`ABORT: no Vehicle found with registrationNumber '${VEHICLE_REG}'. Nothing was changed.`);
      process.exit(1);
    }
    if (String(vehicle.assignedDriver || '') !== OLD_DRIVER_ID) {
      console.error(`ABORT: Vehicle ${VEHICLE_REG}.assignedDriver is '${vehicle.assignedDriver}', not the expected '${OLD_DRIVER_ID}'. Evidence doesn't match — refusing to proceed. Nothing was changed.`);
      process.exit(1);
    }

    // ── BEFORE snapshot ──────────────────────────────────────────
    console.log('='.repeat(70));
    console.log('BEFORE');
    console.log('='.repeat(70));
    console.log('Placeholder to be replaced:');
    console.log(`  _id:        ${placeholder._id}`);
    console.log(`  name:       ${placeholder.name}`);
    console.log(`  phone:      ${placeholder.phone}`);
    console.log(`  role:       ${placeholder.role}`);
    console.log(`  employeeId: ${placeholder.employeeId || '(none)'}`);
    console.log(`  isActive:   ${placeholder.isActive}`);
    console.log(`  createdAt:  ${placeholder.createdAt}`);
    console.log('\nVehicle to link (read-only, not modified by this script):');
    console.log(`  _id:                ${vehicle._id}`);
    console.log(`  registrationNumber: ${vehicle.registrationNumber}`);
    console.log(`  assignedDriver:     ${vehicle.assignedDriver}  (currently orphaned — matches target)`);
    console.log('');

    // ── Atomic delete + create ──────────────────────────────────
    const session = await mongoose.startSession();
    let created;
    try {
      await session.withTransaction(async () => {
        await User.deleteOne({ _id: placeholder._id }, { session });

        const docs = await User.create(
          [{
            _id              : targetId,
            name             : driverName,
            phone            : PLACEHOLDER_PHONE,
            role             : 'driver',
            employeeId       : EMPLOYEE_ID,
            pin              : tempPin, // hashed by the pin pre('save') hook
            pinChangeRequired: true,
            approvalStatus   : 'approved',
            isActive         : true,
            vehicleId        : vehicle._id,
            // deviceId intentionally omitted — driver app binds fresh on next login
            // password intentionally omitted — Employee ID + PIN is the login path
          }],
          { session }
        );
        created = docs[0];
      });
    } catch (txErr) {
      console.error('\nTransaction failed — MongoDB rolled back automatically. The placeholder was NOT deleted; nothing was changed.');
      console.error('If this says transactions aren\'t supported, MONGO_URI must point at a replica-set-backed');
      console.error('Mongo (e.g. MongoDB Atlas) — a standalone mongod cannot run transactions.');
      throw txErr;
    } finally {
      await session.endSession();
    }

    // ── AFTER snapshot — fresh reads, not the in-memory objects ──
    const restored       = await User.findById(targetId).lean();
    const placeholderGone = await User.findById(placeholder._id).lean();
    const vehicleAfter    = await Vehicle.findOne({ registrationNumber: VEHICLE_REG.toUpperCase() })
      .populate('assignedDriver', 'name employeeId phone')
      .lean();

    console.log('='.repeat(70));
    console.log('AFTER');
    console.log('='.repeat(70));
    console.log('Restored driver:');
    console.log(`  _id:               ${restored._id}`);
    console.log(`  name:              ${restored.name}`);
    console.log(`  phone:             ${restored.phone}`);
    console.log(`  role:              ${restored.role}`);
    console.log(`  employeeId:        ${restored.employeeId}`);
    console.log(`  approvalStatus:    ${restored.approvalStatus}`);
    console.log(`  pinChangeRequired: ${restored.pinChangeRequired}`);
    console.log(`  deviceId:          ${restored.deviceId || '(unset — will bind on next login)'}`);
    console.log(`  isActive:          ${restored.isActive}`);
    console.log(`  vehicleId:         ${restored.vehicleId}`);
    console.log(`  tempPin:           ${tempPin}  (must be changed on first login)`);
    console.log(`\nPlaceholder ${placeholder._id} deleted: ${placeholderGone === null ? 'confirmed' : 'STILL EXISTS — investigate'}`);
    console.log(`\nVehicle ${VEHICLE_REG}.assignedDriver now resolves to:`);
    console.log(`  ${JSON.stringify(vehicleAfter.assignedDriver)}`);
    console.log('\nNote: Advance record(s) and any other collections referencing the old _id');
    console.log('now resolve too, automatically — this script did not need to touch them.');

    await mongoose.disconnect();
    process.exit(0);

  } catch (err) {
    console.error('\nFailed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

main();
