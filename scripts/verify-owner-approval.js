/**
 * scripts/verify-owner-approval.js
 * Live verification of the Owner Approval (KYC) flow against
 * production. Creates a throwaway Owner (SECURITY-TEST style, easy to
 * find/delete), mints JWTs for it and for the real SaveLife Owner, and
 * prints everything needed to drive curl checks.
 * Usage: node scripts/verify-owner-approval.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const realOwner = await Owner.findOne({ phone: '9845474037' });
  if (!realOwner) throw new Error('Real owner not found.');

  const testOwner = await Owner.findOneAndUpdate(
    { phone: '9444444444' },
    { name: 'VERIFY-OWNER-APPROVAL-TEST' },
    { upsert: true, new: true }
  );

  const realToken = jwt.sign({ id: realOwner._id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const testToken = jwt.sign({ id: testOwner._id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  console.log(JSON.stringify({
    realOwnerId: String(realOwner._id),
    testOwnerId: String(testOwner._id),
    testOwnerKycStatus: testOwner.kycStatus,
    realToken,
    testToken,
  }, null, 2));

  await mongoose.disconnect();
})();
