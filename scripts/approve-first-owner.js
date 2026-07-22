/**
 * scripts/approve-first-owner.js
 * Bootstrap: approves the real SaveLife Owner account (9845474037) so
 * the new KYC gating (requireKycApproved) doesn't lock you out of your
 * own platform. Run once, right after deploying the gating changes.
 * Usage: node scripts/approve-first-owner.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Owner = require('../models/Owner');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const owner = await Owner.findOneAndUpdate(
    { phone: '9845474037' },
    { kycStatus: 'approved', $unset: { kycRejectionReason: '' } },
    { new: true }
  ).select('name phone kycStatus');

  if (!owner) throw new Error('Owner 9845474037 not found — aborting.');
  console.log('Approved:', JSON.stringify(owner));

  await mongoose.disconnect();
})();
