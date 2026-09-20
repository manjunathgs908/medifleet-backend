/**
 * scripts/backup-db.js
 * ============================================================
 * Full read-only export of the medifleet database.
 *
 *   node scripts/backup-db.js
 *   node scripts/backup-db.js --out D:/medifleet-backups
 *   node scripts/backup-db.js --pretty
 *
 * Writes backups/<timestamp>/<collection>.json, one file per collection,
 * plus a manifest.json recording what was taken and how many documents
 * each file holds.
 *
 * EJSON, NOT JSON.stringify
 *
 * The whole point of this file is that the dump can be put back. Plain
 * JSON.stringify flattens an ObjectId to a string and a Date to an ISO
 * string, and on reload they come back as strings — every ref in the
 * database silently stops matching, and nothing errors to tell you. EJSON
 * (bson's Extended JSON, already present via the mongodb driver that
 * mongoose depends on) round-trips both: an ObjectId becomes
 * {"$oid":"..."} and a Date {"$date":"..."}, and EJSON.parse turns them
 * back into the real types.
 *
 * Relaxed mode is deliberately OFF. Relaxed EJSON writes numbers as plain
 * JSON numbers, which loses the Int32/Double/Long distinction — fine for
 * reading, wrong for restoring money fields. Canonical mode keeps the type.
 *
 * READ-ONLY. This script opens a connection, reads, and writes to disk.
 * It contains no insert, update or delete of any kind — restoring is a
 * separate, deliberate act, not something this file can do by accident.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const outIx  = process.argv.indexOf('--out');
const OUT    = outIx > -1 ? process.argv[outIx + 1] : path.join(__dirname, '..', 'backups');
const PRETTY = process.argv.includes('--pretty');

// 2026-09-20T14-31-08 — colons are not legal in Windows path names, so the
// ISO string has them stripped rather than being used as-is.
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db  = mongoose.connection.db;
  const dir = path.join(OUT, stamp());
  fs.mkdirSync(dir, { recursive: true });

  console.log('');
  console.log('DB:  ' + db.databaseName);
  console.log('Out: ' + dir);
  console.log('');

  // Collection listing rather than mongoose.models: a collection that no
  // model file declares any more still holds data, and a backup that
  // quietly skips it is not a backup.
  const infos = await db.listCollections().toArray();
  const names = infos
    .filter((c) => c.type !== 'view')          // a view has no documents of its own
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const manifest = {
    database : db.databaseName,
    takenAt  : new Date().toISOString(),
    format   : 'EJSON canonical',
    collections: [],
  };
  let grandTotal = 0;

  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    const file = path.join(dir, name + '.json');

    // EJSON.stringify handles the whole array in one pass and emits a
    // parseable document, so a restore is EJSON.parse(readFileSync(...)).
    fs.writeFileSync(file, EJSON.stringify(docs, undefined, PRETTY ? 2 : 0, { relaxed: false }), 'utf8');

    const bytes = fs.statSync(file).size;
    manifest.collections.push({ name, documents: docs.length, bytes });
    grandTotal += docs.length;
    console.log('  ' + name.padEnd(28) + String(docs.length).padStart(7) + ' docs  '
      + (bytes / 1024).toFixed(1).padStart(9) + ' KB');
  }

  manifest.totalDocuments = grandTotal;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('');
  console.log('  ' + String(names.length) + ' collections, ' + grandTotal + ' documents');
  console.log('  manifest: ' + path.join(dir, 'manifest.json'));
  console.log('');
  console.log('Backup complete. Nothing in the database was modified.');

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('BACKUP FAILED:', e.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
