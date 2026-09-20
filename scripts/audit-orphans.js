/**
 * scripts/audit-orphans.js
 * ============================================================
 * Orphan audit + repair after the driver-User / Owner wipe.
 *
 * DRY-RUN BY DEFAULT. It reports and changes nothing unless you pass
 * --apply. The read-only path is safe to run against production.
 *
 *   node scripts/audit-orphans.js                      # report only
 *   node scripts/audit-orphans.js --json               # report as JSON
 *   node scripts/audit-orphans.js --apply              # release/close live state
 *   node scripts/audit-orphans.js --apply --reassign-owner <ownerId>
 *   node scripts/audit-orphans.js --apply --null-refs  # also null dangling pointers
 *
 * What --apply does, and only this:
 *   1. Ambulances stuck status:'assigned' whose assignedDriver no longer
 *      exists  -> status:'available', assignedDriver:null
 *   2. Assignments active:true whose driver no longer exists
 *      -> active:false, endTime:now
 *   3. Shifts status active|break whose driver no longer exists
 *      -> status:'ended', shiftEnd:now. totalWorkingMinutes is left alone:
 *      these are abandoned sessions, not real worked time, and writing a
 *      number here would feed payroll.
 *   --reassign-owner re-parents Fleets/Ambulances whose owner is gone onto
 *   an existing Owner _id (use the new SaveLife Owner). Without it they are
 *   only reported: `owner` and `fleet` are required:true, so nulling them
 *   would make the documents unsaveable.
 *   --null-refs nulls dangling OPTIONAL scalar pointers. Never required ones.
 *
 * Money/attendance rule: this script never deletes a Trip, Attendance,
 * SalaryRecord, Advance or Bill, and never edits an amount. A dangling
 * driver ref on a historical record is a reporting problem, not a reason
 * to destroy the record.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY     = process.argv.includes('--apply');
const NULL_REFS = process.argv.includes('--null-refs');
const AS_JSON   = process.argv.includes('--json');
const rIx       = process.argv.indexOf('--reassign-owner');
const REASSIGN  = rIx > -1 ? process.argv[rIx + 1] : null;

// [collection, field, referenced collection, required?]
// Real Mongo collection names, so this runs without needing every model
// file to load cleanly.
const REFS = [
  ['ambulances',       'owner',               'owners',     true ],
  ['ambulances',       'fleet',               'fleets',     true ],
  ['ambulances',       'assignedDriver',      'users',      false],
  ['fleets',           'owner',               'owners',     true ],
  ['assignments',      'driver',              'users',      true ],
  ['assignments',      'ambulance',           'ambulances', true ],
  ['shifts',           'driver',              'users',      true ],
  ['shifts',           'ambulance',           'ambulances', false],
  ['users',            'owner',               'owners',     false],
  ['users',            'vehicleId',           'vehicles',   false],
  ['users',            'assignedAmbulanceId', 'ambulances', false],
  ['vehicles',         'assignedDriver',      'users',      false],
  ['trips',            'driver',              'users',      false],
  ['trips',            'vehicle',             'vehicles',   false],
  ['trips',            'ambulance',           'ambulances', false],
  ['trips',            'bookedBy',            'users',      false],
  ['attendances',      'driver',              'users',      true ],
  ['salaryrecords',    'driver',              'users',      true ],
  ['salaryrecords',    'approvedBy',          'users',      false],
  ['advances',         'driver',              'users',      true ],
  ['advances',         'approvedBy',          'users',      false],
  ['sosalerts',        'driver',              'users',      true ],
  ['tripactivities',   'driverId',            'users',      true ],
  ['tripcallevents',   'driverId',            'users',      true ],
  ['geofenceevents',   'driverId',            'users',      true ],
  ['bookingtrips',     'driver',              'users',      true ],
  ['whatsappcalllogs', 'calledBy',            'users',      true ],
  ['notifications',    'user',                'users',      false],
  ['notifications',    'targetUserId',        'users',      false],
  ['expenses',         'recordedBy',          'users',      false],
  ['incomes',          'recordedBy',          'users',      false],
  ['servicelogs',      'loggedBy',            'users',      false],
  ['leads',            'assignedTo',          'users',      false],
  ['hospitalinvoices', 'generatedBy',         'users',      false],
];

const log = (...a) => { if (!AS_JSON) console.log(...a); };
const pad = (s, n) => String(s).padEnd(n);

async function danglingIds(db, coll, field, refColl) {
  const ids = await db.collection(coll).distinct(field, { [field]: { $ne: null } });
  if (!ids.length) return [];
  const found = await db.collection(refColl)
    .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  const alive = new Set(found.map((d) => String(d._id)));
  return ids.filter((id) => !alive.has(String(id)));
}

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing in .env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  log('');
  log('DB: ' + db.databaseName + '   mode: ' + (APPLY ? 'APPLY' : 'DRY-RUN (nothing will be written)'));

  const report = { db: db.databaseName, apply: APPLY, totals: {}, refs: [], liveState: {}, actions: [] };

  // ---- 0. baseline collection counts --------------------------------
  const BASE = ['owners', 'fleets', 'ambulances', 'vehicles', 'users', 'assignments',
                'shifts', 'trips', 'attendances', 'salaryrecords', 'advances'];
  for (const c of BASE) {
    try { report.totals[c] = await db.collection(c).countDocuments(); }
    catch { report.totals[c] = null; }
  }
  report.totals['users(role:driver)'] = await db.collection('users').countDocuments({ role: 'driver' });
  report.totals['users(role:owner)']  = await db.collection('users').countDocuments({ role: 'owner' });

  log('');
  log('-- collection counts --');
  for (const k of Object.keys(report.totals)) log('  ' + pad(k, 24) + report.totals[k]);

  // ---- 1. dangling references ---------------------------------------
  log('');
  log('-- dangling references (docs pointing at a deleted _id) --');
  for (const [coll, field, refColl, required] of REFS) {
    let bad, docs;
    try {
      bad  = await danglingIds(db, coll, field, refColl);
      docs = bad.length ? await db.collection(coll).countDocuments({ [field]: { $in: bad } }) : 0;
    } catch (e) {
      log('  ' + pad(coll + '.' + field, 34) + 'skipped (' + e.message + ')');
      continue;
    }
    if (!docs) continue;
    report.refs.push({ coll, field, refColl, required, missingIds: bad.length, docs });
    log('  ' + pad(coll + '.' + field, 34) + String(docs).padStart(6) + ' docs -> '
        + bad.length + ' missing ' + refColl + (required ? '  [REQUIRED]' : ''));
  }
  if (!report.refs.length) log('  none');

  // ---- 2. live state that blocks the duty system ---------------------
  const deadAsgDriver = await danglingIds(db, 'assignments', 'driver', 'users');
  const deadShfDriver = await danglingIds(db, 'shifts', 'driver', 'users');
  const deadAmbDriver = await danglingIds(db, 'ambulances', 'assignedDriver', 'users');

  report.liveState = {
    assignmentsActive:             await db.collection('assignments').countDocuments({ active: true }),
    assignmentsActiveOrphanDriver: await db.collection('assignments').countDocuments({ active: true, driver: { $in: deadAsgDriver } }),
    shiftsNotEnded:                await db.collection('shifts').countDocuments({ status: { $in: ['active', 'break'] } }),
    shiftsNotEndedOrphanDriver:    await db.collection('shifts').countDocuments({ status: { $in: ['active', 'break'] }, driver: { $in: deadShfDriver } }),
    ambulancesAssigned:            await db.collection('ambulances').countDocuments({ status: 'assigned' }),
    ambulancesAssignedOrphan:      await db.collection('ambulances').countDocuments({ status: 'assigned', assignedDriver: { $in: deadAmbDriver } }),
    ambulancesOrphanOwner:         (await danglingIds(db, 'ambulances', 'owner', 'owners')).length,
    fleetsOrphanOwner:             (await danglingIds(db, 'fleets', 'owner', 'owners')).length,
  };
  log('');
  log('-- live state --');
  for (const k of Object.keys(report.liveState)) log('  ' + pad(k, 32) + report.liveState[k]);

  // ---- 3. repairs ----------------------------------------------------
  const plan = [
    ['release stuck ambulances', 'ambulances',
      { status: 'assigned', assignedDriver: { $in: deadAmbDriver } },
      { $set: { status: 'available', assignedDriver: null } }],
    ['close orphan assignments', 'assignments',
      { active: true, driver: { $in: deadAsgDriver } },
      { $set: { active: false, endTime: new Date() } }],
    ['end orphan shifts', 'shifts',
      { status: { $in: ['active', 'break'] }, driver: { $in: deadShfDriver } },
      { $set: { status: 'ended', shiftEnd: new Date() } }],
  ];

  if (REASSIGN) {
    let target = null;
    try { target = await db.collection('owners').findOne({ _id: new mongoose.Types.ObjectId(REASSIGN) }); }
    catch { /* malformed id falls through to the abort below */ }
    if (!target) {
      console.error('ABORT: --reassign-owner ' + REASSIGN + ' is not an existing Owner. Nothing was changed.');
      await mongoose.disconnect();
      process.exit(1);
    }
    const badFleetOwners = await danglingIds(db, 'fleets', 'owner', 'owners');
    const badAmbOwners   = await danglingIds(db, 'ambulances', 'owner', 'owners');
    plan.push(['reassign orphan fleets', 'fleets',
      { owner: { $in: badFleetOwners } }, { $set: { owner: target._id } }]);
    plan.push(['reassign orphan ambulances', 'ambulances',
      { owner: { $in: badAmbOwners } }, { $set: { owner: target._id } }]);
  }

  if (NULL_REFS) {
    for (const [coll, field, refColl, required] of REFS) {
      if (required) continue;                                            // never null a required ref
      if (coll === 'ambulances' && field === 'assignedDriver') continue; // handled above
      let bad = [];
      try { bad = await danglingIds(db, coll, field, refColl); } catch { continue; }
      if (bad.length) {
        plan.push(['null ' + coll + '.' + field, coll,
          { [field]: { $in: bad } }, { $set: { [field]: null } }]);
      }
    }
  }

  log('');
  log('-- repairs (' + (APPLY ? 'APPLYING' : 'dry-run') + ') --');
  for (const [label, coll, filter, update] of plan) {
    const n = await db.collection(coll).countDocuments(filter);
    report.actions.push({ label, coll, wouldAffect: n, applied: APPLY && n > 0 });
    if (!n) { log('  ' + pad(label, 32) + '0'); continue; }
    if (APPLY) {
      const r = await db.collection(coll).updateMany(filter, update);
      log('  ' + pad(label, 32) + n + ' -> modified ' + r.modifiedCount);
    } else {
      log('  ' + pad(label, 32) + n + ' (would change)');
    }
  }

  if (!APPLY) {
    log('');
    log('DRY-RUN complete. Nothing was written. Re-run with --apply to perform the repairs above.');
  }
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
