/**
 * scripts/check-mongo-compat.js
 * ============================================================
 * READ-ONLY check that a MongoDB server can run this release:
 *
 *   node scripts/check-mongo-compat.js        # uses MONGO_URI (.env)
 *
 * Minimum: MongoDB 4.2, as a replica set (Atlas clusters are).
 *   - 4.2   the installed MongoDB Node driver's minimum server version
 *           (node_modules/mongodb MIN_SUPPORTED_SERVER_VERSION); the call
 *           pipelines in services/callStats.js themselves need 4.0+.
 *   - replica set: booking from a lead commits its trip, claim and lead
 *           conversion in ONE transaction (services/leadBooking.js).
 *
 * What it does — and nothing else:
 *   1. reads the server version, replica-set name and session support
 *      (buildInfo, hello) and, if this user may, featureCompatibilityVersion;
 *   2. sends every aggregation the Call Logs views and the customer overview
 *      use, each behind a first $match that can match NO document (a fixed
 *      impossible _id), so the server parses and validates every stage and
 *      operator but reads no data;
 *   3. opens a transaction, runs one such empty read inside it, and aborts.
 * It loads no Mongoose model (so no index or collection is ever created),
 * writes nothing, and prints no data — only versions and pass/fail.
 * Exit code 0 = compatible, 1 = not, 2 = could not check.
 * ============================================================
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const stats = require('../services/callStats');

const MIN = [4, 2];
const atLeast = (v, min) => { const p = String(v).split('.').map(Number); return p[0] > min[0] || (p[0] === min[0] && p[1] >= min[1]); };
const NOTHING = { _id: new mongoose.Types.ObjectId('000000000000000000000000'), context: '__compat_probe__' };

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const admin = db.admin();
  const out = { checks: [] };
  const check = (name, ok, detail) => { out.checks.push({ name, ok, ...(detail ? { detail } : {}) }); };

  const build = await admin.command({ buildInfo: 1 });
  const hello = await admin.command({ hello: 1 });
  out.server = { version: build.version, replicaSet: hello.setName || null, sessions: hello.logicalSessionTimeoutMinutes != null };
  try {
    const p = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 });
    out.server.featureCompatibilityVersion = p.featureCompatibilityVersion?.version || null;
  } catch { out.server.featureCompatibilityVersion = 'not readable with this user (fine)'; }
  check(`server version ${build.version} >= ${MIN.join('.')}`, atLeast(build.version, MIN));
  if (out.server.featureCompatibilityVersion && /^\d/.test(out.server.featureCompatibilityVersion)) {
    check(`featureCompatibilityVersion ${out.server.featureCompatibilityVersion} >= ${MIN.join('.')}`, atLeast(out.server.featureCompatibilityVersion, MIN));
  }
  check('replica set (transactions for booking from a lead)', !!hello.setName && out.server.sessions);

  // Every pipeline shape the views use, reading nothing.
  const coll = db.collection('calllogs');
  const now = Date.now();
  const calls = stats.callStages({ match: NOTHING, post: { from: new Date(now - 864e5), staff: '000000000000000000000000', kind: 'incoming', outcome: 'answered', phone: { $in: ['9000000000'] } }, now, withRecords: true });
  const probes = {
    'customer overview (counts, last attempt, last connected)': [...calls, { $facet: {
      totals: [{ $group: { _id: null, logicalCalls: { $sum: 1 }, rows: { $sum: '$rows' }, firstAt: { $min: '$at' }, ...stats.periodAccumulators(now) } }],
      last: [{ $sort: { at: -1, _id: -1 } }, { $limit: 1 }],
    } }],
    'All call events (records + totals)': [...calls, { $facet: {
      page: [...stats.recordListStages({ recordMatch: { at: { $gte: new Date(0) }, $and: [{ phone: { $regex: '0$' } }] }, keyset: { at: new Date(), id: new mongoose.Types.ObjectId() } }), { $limit: 51 }],
      records: [...stats.recordListStages({}), { $count: 'n' }],
    } }],
    'By customer (grouped by number)': [...calls, { $group: { _id: '$phone', lastAt: { $max: '$at' }, n: { $sum: { $cond: [{ $eq: ['$outcome', 'missed'] }, 1, 0] } } } }, { $facet: { total: [{ $count: 'n' }], rows: [{ $sort: { lastAt: -1, _id: -1 } }, { $limit: 31 }] } }],
  };
  for (const [name, pipeline] of Object.entries(probes)) {
    try { await coll.aggregate(pipeline, { allowDiskUse: true }).toArray(); check(`pipeline: ${name}`, true); } catch (err) { check(`pipeline: ${name}`, false, err.message); }
  }
  try { await coll.distinct('providerCallId', { ...NOTHING, providerCallId: { $type: 'string' } }); check('distinct (linked records)', true); } catch (err) { check('distinct (linked records)', false, err.message); }

  // A transaction can start (read only, then aborted).
  const session = await mongoose.connection.getClient().startSession();
  try {
    session.startTransaction();
    await coll.find(NOTHING, { session }).toArray();
    await session.abortTransaction();
    check('transaction (read only, aborted)', true);
  } catch (err) {
    check('transaction (read only, aborted)', false, err.message);
  } finally { await session.endSession(); }

  out.compatible = out.checks.every((c) => c.ok);
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
  process.exit(out.compatible ? 0 : 1);
})().catch(async (err) => {
  console.error(`[compat] could not check: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
