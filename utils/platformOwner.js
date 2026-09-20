/**
 * utils/platformOwner.js
 * ============================================================
 * One answer to "do we employ this driver?", used by every place that
 * writes attendance or computes pay.
 *
 * A driver's User document carries `owner` — the Owner who created them.
 * If that Owner has isPlatformOwner true, the driver is SaveLife's own and
 * gets an attendance row and a payslip. If it is a partner's Owner, they
 * do not: the partner employs and pays that driver, and computing a salary
 * for someone we do not employ would be inventing a liability we might
 * then act on.
 *
 * Deliberately fail-closed. A driver with no `owner` link at all — a
 * pre-Phase-4 record, or one whose Owner was deleted — is treated as NOT
 * ours. Getting this wrong in the permissive direction quietly adds a
 * stranger to payroll; getting it wrong in the strict direction leaves a
 * real employee off a report, which is visible and fixable.
 *
 * Lives in utils/ rather than in one of the controllers because
 * assignmentController (attendance) and salaryController (payroll) both
 * need it, and a copy in each is a copy that will drift.
 * ============================================================
 */
'use strict';

const Owner = require('../models/Owner');
const { User } = require('../models');

/**
 * The _ids of every Owner marked as SaveLife's own.
 * Usually one document; returned as an array so callers can use $in
 * without caring how many there are.
 */
async function platformOwnerIds() {
  const owners = await Owner.find({ isPlatformOwner: true }).select('_id').lean();
  return owners.map((o) => o._id);
}

/**
 * Is this driver one of ours?
 *
 * @param {ObjectId|string|object} driverOrId  a driver User doc, or their _id
 * @returns {Promise<boolean>}                 false when unknown or unlinked
 */
async function isPlatformDriver(driverOrId) {
  if (!driverOrId) return false;

  // Accept a populated document so a caller that already loaded the driver
  // does not pay for a second round trip.
  let ownerId = driverOrId.owner;
  if (ownerId === undefined) {
    const driver = await User.findById(driverOrId).select('owner').lean();
    if (!driver) return false;
    ownerId = driver.owner;
  }
  if (!ownerId) return false;   // unlinked driver — fail closed

  const owner = await Owner.findById(ownerId).select('isPlatformOwner').lean();
  return Boolean(owner && owner.isPlatformOwner);
}

/**
 * The _ids of every driver employed by a platform Owner — the population
 * payroll is allowed to consider.
 */
async function platformDriverIds() {
  const ownerIds = await platformOwnerIds();
  if (!ownerIds.length) return [];
  const drivers = await User.find({ role: 'driver', owner: { $in: ownerIds } })
    .select('_id').lean();
  return drivers.map((d) => d._id);
}

module.exports = { platformOwnerIds, isPlatformDriver, platformDriverIds };
