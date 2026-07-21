/**
 * scripts/find-driver-id.js
 * ============================================================
 * READ-ONLY. Finds the old, now-deleted driver User._id by scanning
 * every collection that references User via a driver-style field, and
 * reporting any ObjectId that does NOT resolve to a document in the
 * User collection (i.e. an orphaned reference).
 *
 * Background: GET /setup (now removed) ran
 *   User.deleteMany({ phone: { $in: ['8884092777', '9986844442'] } })
 * then recreated those two users fresh — with brand-new _ids. Every
 * doc below that pointed at the old driver's _id is now orphaned.
 * Finding that old _id lets us restore the driver document under the
 * SAME _id, so all these references resolve again without a data
 * migration.
 *
 * This script performs ONLY .find()/.aggregate() reads via .lean().
 * It never calls .save(), .create(), .updateOne(), .deleteOne(),
 * .findOneAndUpdate(), or any other write method — do not add any.
 *
 * Usage:
 *   node scripts/find-driver-id.js
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const { User, Vehicle, Attendance, Trip, SalaryRecord, Advance } = require('../models');
const Ambulance    = require('../models/Ambulance');
const Assignment   = require('../models/Assignment');
const Shift        = require('../models/Shift');
const TripActivity = require('../models/TripActivity');
const BookingTrip  = require('../models/BookingTrip');

// Every collection/field that references a driver User._id, plus a
// few identifying fields to display per hit (nothing sensitive —
// no names/phones, since those only ever lived on the deleted User doc).
const TARGETS = [
  { label: 'Assignment.driver',       Model: Assignment,   field: 'driver',   sample: 'ambulance active startTime endTime deviceId createdAt' },
  { label: 'Shift.driver',            Model: Shift,        field: 'driver',   sample: 'ambulance status shiftStart shiftEnd deviceId createdAt' },
  { label: 'Attendance.driver',       Model: Attendance,   field: 'driver',   sample: 'date shift status clockIn clockOut createdAt' },
  { label: 'Trip.driver',             Model: Trip,         field: 'driver',   sample: 'tripNumber status patientName vehicle createdAt' },
  { label: 'BookingTrip.driver',      Model: BookingTrip,  field: 'driver',   sample: 'vehicle tripDate currentStage isCompleted createdAt' },
  { label: 'TripActivity.driverId',   Model: TripActivity, field: 'driverId', sample: 'ambulanceId tripStatus tripId createdAt' },
  { label: 'SalaryRecord.driver',     Model: SalaryRecord, field: 'driver',   sample: 'month year status netSalary createdAt' },
  { label: 'Advance.driver',          Model: Advance,      field: 'driver',   sample: 'amount reason status createdAt' },
  { label: 'Ambulance.assignedDriver',Model: Ambulance,    field: 'assignedDriver', sample: 'registrationNumber status fleet owner createdAt' },
  { label: 'Vehicle.assignedDriver',  Model: Vehicle,      field: 'assignedDriver', sample: 'registrationNumber model type status createdAt' },
];

const MAX_SAMPLES_PER_GROUP = 3;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Scanning for orphaned driver references (read-only)...\n');

  // 1. Pull every (collection, field, docId, refId, sampleFields) hit.
  const hits = [];
  for (const target of TARGETS) {
    const selectFields = `${target.field} ${target.sample}`;
    const docs = await target.Model.find({ [target.field]: { $exists: true, $ne: null } })
      .select(selectFields)
      .lean();

    for (const doc of docs) {
      const refId = doc[target.field];
      const { _id, [target.field]: _omit, ...sample } = doc;
      hits.push({ label: target.label, refId: String(refId), docId: _id, sample });
    }
  }

  if (!hits.length) {
    console.log('No documents found with any of the target driver fields set. Nothing to report.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // 2. Resolve which referenced ids actually exist in User.
  const uniqueRefIds = [...new Set(hits.map(h => h.refId))];
  const existingUsers = await User.find({ _id: { $in: uniqueRefIds } }).select('_id').lean();
  const existingIdSet = new Set(existingUsers.map(u => String(u._id)));

  const orphanedHits = hits.filter(h => !existingIdSet.has(h.refId));

  if (!orphanedHits.length) {
    console.log(`Scanned ${hits.length} references across ${TARGETS.length} collections — every referenced driver _id resolves to an existing User. No orphans found.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // 3. Group orphaned hits by refId, then by collection label within each group.
  const byRefId = new Map(); // refId -> Map(label -> hits[])
  for (const hit of orphanedHits) {
    if (!byRefId.has(hit.refId)) byRefId.set(hit.refId, new Map());
    const byLabel = byRefId.get(hit.refId);
    if (!byLabel.has(hit.label)) byLabel.set(hit.label, []);
    byLabel.get(hit.label).push(hit);
  }

  console.log(`Scanned ${hits.length} references across ${TARGETS.length} collections.`);
  console.log(`Found ${orphanedHits.length} orphaned references, across ${byRefId.size} distinct orphaned _id(s).\n`);
  console.log('='.repeat(70));

  for (const [refId, byLabel] of byRefId) {
    const total = [...byLabel.values()].reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\nOrphaned _id: ${refId}   (${total} total references, ${byLabel.size} collection${byLabel.size === 1 ? '' : 's'})`);

    for (const [label, labelHits] of byLabel) {
      console.log(`  ${label}: ${labelHits.length} doc(s)`);
      for (const hit of labelHits.slice(0, MAX_SAMPLES_PER_GROUP)) {
        console.log(`    - _id=${hit.docId}  ${JSON.stringify(hit.sample)}`);
      }
      if (labelHits.length > MAX_SAMPLES_PER_GROUP) {
        console.log(`    ... and ${labelHits.length - MAX_SAMPLES_PER_GROUP} more`);
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('\nDone. No data was modified — this script only read.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
