/**
 * scripts/create-crm-admin.js
 * Creates a CRM admin (User model, role:'owner') account — the login
 * medifleet-frontend's "Owners" review page (and every other CRM page,
 * since telecaller is temporarily removed) requires.
 *
 * Interactive — no positional command-line arguments to get in the
 * wrong order or mangle via shell quoting. Just run it and answer the
 * three prompts (name, phone, password) with your own real values:
 *
 *   node scripts/create-crm-admin.js
 *
 * Password is hashed by the User model's existing pre-save bcrypt hook
 * (models/index.js) — same as authController.register — this script
 * doesn't hash anything itself, just calls User.create().
 */
'use strict';

require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const { User } = require('../models');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

async function askName() {
  const name = (await ask('Name: ')).trim();
  if (!name) {
    console.log('Name cannot be empty.');
    return askName();
  }
  return name;
}

async function askPhone() {
  const phone = (await ask('Phone (10 digits): ')).trim();
  if (!/^[6-9]\d{9}$/.test(phone)) {
    console.log('Must be exactly 10 digits, starting with 6-9. Try again.');
    return askPhone();
  }
  return phone;
}

async function askPassword() {
  const password = (await ask('Password (min 6 characters): ')).trim();
  if (password.length < 6) {
    console.log('Password must be at least 6 characters. Try again.');
    return askPassword();
  }
  return password;
}

(async () => {
  const name = await askName();
  const phone = await askPhone();
  const password = await askPassword();
  rl.close();

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ phone });
  if (existing) {
    console.error(`\nA User already exists with phone ${phone} (role: ${existing.role}). Not creating a duplicate — pick a different number or update that account instead.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = await User.create({ name, phone, password, role: 'owner' });
  console.log('\nCreated CRM admin:', JSON.stringify({ id: user._id, name: user.name, phone: user.phone, role: user.role }));
  console.log('Log into the CRM at your usual login page with this phone number and password.');

  await mongoose.disconnect();
})();
