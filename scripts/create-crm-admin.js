/**
 * scripts/create-crm-admin.js
 * Creates a CRM admin (User model, role:'owner') account — the login
 * medifleet-frontend's "Owners" review page (and every other CRM page,
 * since telecaller is temporarily removed) requires.
 *
 * YOU supply the phone number, password, and name — nothing here is
 * pre-filled or invented. Run it yourself with your own values:
 *
 *   node scripts/create-crm-admin.js <10-digit-phone> <password> "<Your Name>"
 *
 * Example (replace with your own real values):
 *   node scripts/create-crm-admin.js 9XXXXXXXXX "a-real-password" "Manjunath"
 *
 * Password is hashed by the User model's existing pre-save bcrypt hook
 * (models/index.js) — same as authController.register — this script
 * doesn't hash anything itself, just calls User.create().
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models');

const [, , phone, password, name] = process.argv;

if (!phone || !password || !name) {
  console.error('Usage: node scripts/create-crm-admin.js <10-digit-phone> <password> "<Your Name>"');
  process.exit(1);
}
if (!/^[6-9]\d{9}$/.test(phone)) {
  console.error('Phone must be a valid 10-digit Indian mobile number.');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters (matches the User model\'s minlength).');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ phone });
  if (existing) {
    console.error(`A User already exists with phone ${phone} (role: ${existing.role}). Not creating a duplicate — pick a different number or update that account instead.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = await User.create({ name, phone, password, role: 'owner' });
  console.log('Created CRM admin:', JSON.stringify({ id: user._id, name: user.name, phone: user.phone, role: user.role }));
  console.log('\nLog into the CRM at your usual login page with this phone number and password.');

  await mongoose.disconnect();
})();
