/**
 * scripts/create-admin.js
 * ============================================================
 * Bootstrap a CRM admin (User, role 'owner') when there is no admin left
 * to create one with.
 *
 *   node scripts/create-admin.js --name "Manjunath" --phone 9986844442
 *
 * POST /api/auth/register is gated on `protect, authorize('owner')`, so it
 * needs an existing admin and cannot recover from an empty users
 * collection. This can, because it talks to the database directly.
 *
 * THE PASSWORD IS NEVER A CLI ARGUMENT
 *
 * It is asked for interactively, twice, with the echo suppressed. An
 * argument would be recorded in PowerShell's history file
 * (ConsoleHost_history.txt), in the process list while the script runs,
 * and in any shell transcript — a credential written to three places that
 * outlive the command. The script refuses --password outright rather than
 * quietly accepting it, and refuses to run at all when stdin is not a TTY,
 * since a piped password cannot be hidden either.
 *
 * HASHING IS THE MODEL'S JOB
 *
 * The plaintext is handed to User.create() and the schema's own pre('save')
 * hook hashes it (bcrypt, 12 rounds — models/index.js). Hashing here would
 * double-hash, because that hook fires on any modified `password`, and the
 * resulting account could never log in. Nothing in this file calls bcrypt.
 * ============================================================
 */
'use strict';

require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');

const PASSWORD_MIN = 8;
const PHONE_RE = /^[6-9]\d{9}$/;

// ------------------------------------------------------------
// Argument parsing
// ------------------------------------------------------------
function parseArgs(argv) {
  // Refused explicitly rather than ignored. Someone who passes --password
  // believes it was accepted, and would not think to clear their history.
  const banned = argv.find((a) => /^--(password|pass|pwd)(=|$)/i.test(a));
  if (banned) {
    return { error: 'The password cannot be passed on the command line — it would be stored in your shell history. Run the command again without it and you will be prompted.' };
  }

  const read = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };

  const name  = read('--name');
  const phone = read('--phone');

  if (!name || !name.trim())  return { error: 'Missing --name. Usage: node scripts/create-admin.js --name "<name>" --phone <10-digit>' };
  if (!phone)                 return { error: 'Missing --phone. Usage: node scripts/create-admin.js --name "<name>" --phone <10-digit>' };
  if (!PHONE_RE.test(phone))  return { error: 'Enter a valid 10-digit Indian mobile number (no +91, no spaces).' };

  return { name: name.trim(), phone };
}

// ------------------------------------------------------------
// The document
// ------------------------------------------------------------
/**
 * Every field this admin needs, and deliberately nothing else.
 *
 * Required paths on the schema are just name and phone; the rest below is
 * either what makes the account an admin, or a driver-shaped default that
 * would be misleading left at its schema value. Verified against
 * User.schema.requiredPaths() before saving, so a new required field added
 * later fails loudly here instead of at .save().
 *
 * Fields left UNSET on purpose:
 *   deviceId   — `protect` rejects a token whose deviceId does not equal
 *                the user's (middleware/auth.js). Password login mints a
 *                token with no deviceId, so setting one here would produce
 *                an admin who can log in and is then rejected on every
 *                subsequent request.
 *   employeeId — unique+sparse. A value would collide with the driver
 *                DRV-nnn sequence; absent, the sparse index ignores it.
 *   pin, owner, vehicleId, assignedAmbulanceId — driver plumbing an admin
 *                has no use for. `owner` in particular must stay unset:
 *                it links a driver to a fleet Owner, and an admin is not
 *                one of anybody's drivers.
 */
function buildAdminPayload({ name, phone, password }) {
  return {
    name,
    phone,
    password,          // plaintext — the model's pre('save') hook hashes it
    role    : 'owner', // the CRM's admin role, not the fleet-Owner model
    isActive: true,    // loginPassword and protect both refuse otherwise

    // Driver-lifecycle field with a 'pending' default. Nothing gates an
    // admin on it, but an admin listed as awaiting approval is a
    // confusing thing to leave in the database.
    approvalStatus: 'approved',

    // Schema defaults are 15000 / 100, aimed at drivers. Payroll only ever
    // selects role:'driver', so these are never read for an admin — zeroed
    // anyway so nothing can later mistake this row for a payable employee.
    baseSalary  : 0,
    perTripBonus: 0,
  };
}

// ------------------------------------------------------------
// Creation
// ------------------------------------------------------------
/**
 * @param {object} input  { name, phone, password }
 * @param {object} deps   { User } — injected so the test can drive this
 *                        with a mocked model and no database.
 * @returns {Promise<{ok: boolean, message: string, user?: object}>}
 */
async function createAdmin(input, { User }) {
  if (!input.password || input.password.length < PASSWORD_MIN) {
    return { ok: false, message: `Password must be at least ${PASSWORD_MIN} characters.` };
  }

  // Phone is unique on the schema, so this is a clearer error than the
  // E11000 that would otherwise come back — and it stops the script
  // overwriting or duplicating a real account.
  const existing = await User.findOne({ phone: input.phone });
  if (existing) {
    return { ok: false, message: `A user with phone ${input.phone} already exists. Refusing to create a second one.` };
  }

  const payload = buildAdminPayload(input);

  // Ask the schema what it requires rather than trusting this file's idea
  // of it. If a required field is added to User later, this reports it by
  // name instead of failing inside .save() with a stack trace.
  if (User.schema && typeof User.schema.requiredPaths === 'function') {
    const missing = User.schema.requiredPaths().filter((p) => payload[p] === undefined || payload[p] === null || payload[p] === '');
    if (missing.length) {
      return { ok: false, message: `The User schema requires fields this script does not set: ${missing.join(', ')}. Update buildAdminPayload().` };
    }
  }

  const user = await User.create(payload);

  return {
    ok: true,
    message: 'Admin created.',
    user: { id: user._id, name: user.name, phone: user.phone, role: user.role, isActive: user.isActive },
  };
}

// ------------------------------------------------------------
// Hidden prompt
// ------------------------------------------------------------
/**
 * Read a line with the echo suppressed.
 *
 * readline writes each keystroke back to the terminal itself; overriding
 * _writeToOutput is the documented way to stop it. Newlines are still let
 * through, or Enter would not move the cursor and the prompt would look
 * frozen. Nothing is echoed at all — not even asterisks, which would leak
 * the length to anyone watching.
 */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    rl._writeToOutput = function (chunk) {
      if (chunk.includes('\n') || chunk.includes('\r')) rl.output.write('\n');
    };

    process.stdout.write(question);
    rl.question('', (answer) => { rl.close(); resolve(answer); });
    rl.on('SIGINT', () => { rl.close(); reject(new Error('Cancelled.')); });
  });
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error('This script must be run in an interactive terminal — the password is typed in, never piped or passed as an argument.');
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing in .env');
    process.exit(1);
  }

  console.log('');
  console.log(`Creating CRM admin:  ${args.name}  (${args.phone})`);
  console.log('');

  const password = await askHidden(`Password (min ${PASSWORD_MIN} characters): `);
  if (password.length < PASSWORD_MIN) {
    console.error(`Password must be at least ${PASSWORD_MIN} characters. Nothing was created.`);
    process.exit(1);
  }

  const again = await askHidden('Confirm password: ');
  if (password !== again) {
    console.error('The two passwords do not match. Nothing was created.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const { User } = require('../models');
    const result = await createAdmin({ ...args, password }, { User });

    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }

    console.log('');
    console.log('  ' + result.message);
    console.log('  id     ' + result.user.id);
    console.log('  name   ' + result.user.name);
    console.log('  phone  ' + result.user.phone);
    console.log('  role   ' + result.user.role);
    console.log('');
    console.log('Log in to the CRM with this phone number and the password you just set.');
    console.log('');
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { parseArgs, buildAdminPayload, createAdmin, PASSWORD_MIN, PHONE_RE };

if (require.main === module) {
  main().catch(async (e) => {
    // Message only, never the error object — a mongoose ValidationError
    // stringifies the document it was validating, and this one holds a
    // plaintext password.
    console.error('FAILED:', e.message);
    try { await mongoose.disconnect(); } catch { /* already down */ }
    process.exit(1);
  });
}
