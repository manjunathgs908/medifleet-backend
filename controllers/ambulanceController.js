/**
 * controllers/ambulanceController.js
 * ============================================================
 * Ambulance CRUD + per-ambulance document/photo upload — Phase 1 of
 * the driver-auth redesign, extended in Phase 2 (Add Ambulance) with
 * serviceType/year/photos. Every operation is scoped to req.user._id
 * (the authenticated Owner). `assignedDriver` may reference an existing
 * `User` (driver) document by id — read-only reference, User untouched.
 * ============================================================
 */
'use strict';

const Ambulance  = require('../models/Ambulance');
const Assignment = require('../models/Assignment');
const Fleet      = require('../models/Fleet');
const { User }   = require('../models');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { byServiceType } = require('../utils/ambulanceServiceTypes');

const DOC_TYPES = ['rc', 'insurance', 'fitness', 'permit', 'pollution'];

// The only two an owner may set. 'assigned' is the duty system's — see the
// comment in updateAmbulance.
const OWNER_SETTABLE_STATUSES = ['available', 'maintenance'];

// Shared by the owner's own live dashboard (assignmentController.
// getFleetShiftStatus) and the CRM-admin ambulance list below — a
// single available/on_trip/off/maintenance value derived from
// Ambulance.status (is anyone on duty at all) combined with that
// driver's own live availability.status (idle vs mid-trip). 'off'
// means the ambulance itself is unclaimed right now, not necessarily
// broken.
exports.computeAmbulanceDisplayStatus = (amb) => {
  if (amb.status === 'maintenance') return 'maintenance';
  if (amb.status === 'assigned') {
    return amb.assignedDriver?.availability?.status === 'on_trip' ? 'on_trip' : 'available';
  }
  return 'off';
};

// One implicit Fleet per owner, created on first use and never shown to
// anyone. Fleet is now purely an implementation detail of Ambulance.fleet,
// which is required:true on the schema and so cannot simply be dropped —
// the field stays, the concept is gone from the API.
//
// No longer takes a fleetId. The user-facing Fleet concept is removed:
// nothing in the app or CRM ever sent one (verified by grep across both
// repos), and accepting it kept an owner-supplied id on a path that had to
// be ownership-checked for no benefit.
async function resolveFleet(ownerId) {
  let fleet = await Fleet.findOne({ owner: ownerId, isActive: true }).sort({ createdAt: 1 });
  if (!fleet) {
    fleet = await Fleet.create({ owner: ownerId, name: 'My Fleet' });
  }
  return fleet;
}

// ============================================================
// @route   POST /api/ambulances
// @access  Private [owner]
// ============================================================
exports.createAmbulance = async (req, res, next) => {
  try {
    const { registrationNumber, serviceType, year, deviceId, assignedDriverId } = req.body;

    // Same rule as updateAmbulance, at the other door. A new ambulance
    // cannot have an active Assignment, but seeding assignedDriver here
    // would still hand trip dispatch a driver with no open Shift, and
    // startDuty would later overwrite it anyway. Nothing sends this — the
    // owner app has never had an assignedDriverId field — so refusing it
    // costs nothing and keeps one rule instead of two.
    if (assignedDriverId !== undefined) {
      return res.status(400).json({
        success: false,
        code   : 'ASSIGNED_DRIVER_READ_ONLY',
        message: 'assignedDriver is set by the duty system when a driver starts duty. Add the ambulance first, then choose its assigned driver.',
      });
    }

    if (!registrationNumber || !serviceType) {
      return res.status(400).json({ success: false, message: 'registrationNumber and serviceType are required.' });
    }

    const typeInfo = byServiceType[serviceType];
    if (!typeInfo) {
      return res.status(400).json({
        success: false,
        message: `serviceType must be one of: ${Object.keys(byServiceType).join(', ')}`,
      });
    }

    const fleet = await resolveFleet(req.user._id);

    const ambulance = await Ambulance.create({
      owner : req.user._id,
      fleet : fleet._id,
      registrationNumber,
      serviceType,
      serviceTypeLabel: typeInfo.label,
      vehicleModel    : typeInfo.vehicleModel,
      year: year || undefined,
      deviceId,
    });

    return res.status(201).json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/ambulances?status=
// @access  Private [owner]
// ============================================================
exports.getAmbulances = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { owner: req.user._id, isActive: true };
    if (status) filter.status = status;

    const ambulances = await Ambulance.find(filter)
      .populate('fleet', 'name')
      // Both, and they mean different things — assignedDriver is who is on
      // duty right now, defaultDriver is who the owner rostered. The app
      // shows them as two separate lines for exactly that reason.
      .populate('assignedDriver', 'name phone')
      .populate('defaultDriver', 'name phone')
      .sort({ createdAt: -1 });

    return res.json({ success: true, ambulances });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/ambulances/:id
// @access  Private [owner]
// ============================================================
exports.getAmbulanceById = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id })
      .populate('fleet', 'name')
      .populate('assignedDriver', 'name phone')
      .populate('defaultDriver', 'name phone');
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });
    return res.json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/ambulances/:id
// @access  Private [owner]
// ============================================================
exports.updateAmbulance = async (req, res, next) => {
  try {
    const { registrationNumber, serviceType, year, deviceId, assignedDriverId, status } = req.body;

    // ── assignedDriver belongs to the duty lifecycle, not the owner ──
    //
    // It is written by startDuty and cleared by endDuty/forceEndDuty, and
    // `status` is the latch those use to claim an ambulance atomically:
    // startDuty's findOneAndUpdate filters on status:'available', which is
    // the ONLY thing stopping two drivers claiming the same vehicle.
    //
    // This endpoint used to set both, unconditionally and with no check for
    // an active Assignment. An owner flipping status back to 'available'
    // mid-shift let a second driver claim an ambulance that was already
    // out, and writing assignedDriverId pointed trip dispatch at a driver
    // with no open Shift.
    //
    // The roster-level answer to "who usually drives this" is
    // defaultDriver, set through PUT /api/ambulances/:id/default-driver.
    if (assignedDriverId !== undefined) {
      return res.status(400).json({
        success: false,
        code   : 'ASSIGNED_DRIVER_READ_ONLY',
        message: 'assignedDriver is set by the duty system when a driver starts duty. To choose who usually drives this ambulance, set its assigned driver instead.',
      });
    }

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    // The owner's one legitimate reason to touch status is taking a vehicle
    // off the road and putting it back. Everything else is the duty system's.
    if (status !== undefined) {
      if (!OWNER_SETTABLE_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          code   : 'STATUS_NOT_OWNER_SETTABLE',
          message: `status can only be set to ${OWNER_SETTABLE_STATUSES.join(' or ')}. 'assigned' is set by the duty system when a driver starts duty.`,
        });
      }

      // Refuse while someone is actually on duty on it, in either
      // direction. Sending it to maintenance would strand a driver
      // mid-shift; sending it to available would unlatch the claim and let
      // a second driver take a vehicle that is already out.
      const active = await Assignment.findOne({ ambulance: ambulance._id, active: true })
        .populate('driver', 'name');
      if (active) {
        return res.status(409).json({
          success: false,
          code   : 'AMBULANCE_ON_DUTY',
          message: `${active.driver?.name || 'A driver'} is on duty on this ambulance. Ask them to end duty first.`,
        });
      }

      ambulance.status = status;
    }

    if (registrationNumber)             ambulance.registrationNumber = registrationNumber;
    if (serviceType) {
      const typeInfo = byServiceType[serviceType];
      if (!typeInfo) {
        return res.status(400).json({
          success: false,
          message: `serviceType must be one of: ${Object.keys(byServiceType).join(', ')}`,
        });
      }
      ambulance.serviceType      = serviceType;
      ambulance.serviceTypeLabel = typeInfo.label;
      ambulance.vehicleModel     = typeInfo.vehicleModel;
    }
    if (year !== undefined)     ambulance.year = year;
    if (deviceId !== undefined) ambulance.deviceId = deviceId;

    await ambulance.save();
    return res.json({ success: true, ambulance });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   DELETE /api/ambulances/:id  (soft delete)
// @access  Private [owner]
// ============================================================
exports.deleteAmbulance = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { isActive: false },
      { new: true }
    );
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });
    return res.json({ success: true, message: 'Ambulance removed.' });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/ambulances/:id/document
// @desc    Upload/replace one compliance document (rc/insurance/
//          fitness/permit/pollution — PUC) and/or set its number/expiry.
// @access  Private [owner]
// ============================================================
exports.updateDocument = async (req, res, next) => {
  try {
    const { docType, base64, number, expiryDate } = req.body;

    if (!DOC_TYPES.includes(docType)) {
      return res.status(400).json({
        success: false,
        message: `docType must be one of: ${DOC_TYPES.join(', ')}`,
      });
    }

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    const existing = ambulance.documents?.[docType] || {};
    let { url, publicId } = existing;
    if (base64) {
      const result = await uploadToCloudinary(base64, `owners/${req.user._id}/ambulances/${ambulance._id}/documents`);
      url      = result.secure_url;
      publicId = result.public_id;
    }

    ambulance.documents = ambulance.documents || {};
    ambulance.documents[docType] = {
      url,
      publicId,
      number    : number !== undefined ? number : existing.number,
      expiryDate: expiryDate ? new Date(expiryDate) : existing.expiryDate,
    };
    await ambulance.save();

    return res.json({ success: true, documents: ambulance.documents });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   POST /api/ambulances/:id/photos
// @desc    Add one ambulance photo (base64) — called once per photo,
//          same one-upload-per-call pattern as updateDocument above.
// @access  Private [owner]
// ============================================================
exports.addPhoto = async (req, res, next) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ success: false, message: 'base64 is required.' });

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    const result = await uploadToCloudinary(base64, `owners/${req.user._id}/ambulances/${ambulance._id}/photos`);
    ambulance.photos.push({ url: result.secure_url, publicId: result.public_id });
    await ambulance.save();

    return res.json({ success: true, photos: ambulance.photos });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/ambulances/admin
// @desc    CRM-facing view of every Ambulance (any status), so the
//          legacy Vehicle-only Fleet/Dispatch pages can show an owner
//          (or any driver) on duty via the newer Ambulance/Assignment/
//          Shift system alongside legacy Vehicle records. No owner
//          scoping — matches Vehicle's/User-listing's existing
//          unscoped, single-tenant CRM behavior.
// @access  Private [CRM owner/admin] (protect, NOT protectOwner —
//          this is the CRM's own User-model session, same actor as
//          ownerController's admin listOwners/approveOwner/rejectOwner)
// ============================================================
exports.listAmbulancesAdmin = async (req, res, next) => {
  try {
    const ambulances = await Ambulance.find({ isActive: true })
      .populate('fleet', 'name')
      .populate('assignedDriver', 'name phone availability')
      .populate('defaultDriver', 'name phone')
      // The partner this unit belongs to. On a multi-partner board every
      // row has to say whose vehicle it is, or a dispatcher cannot tell
      // our own fleet from a partner's when deciding who to send.
      .populate('owner', 'name businessName isPlatformOwner')
      .sort({ createdAt: -1 });

    const shaped = ambulances.map((amb) => ({
      _id               : amb._id,
      registrationNumber: amb.registrationNumber,
      serviceType       : amb.serviceType,
      serviceTypeLabel  : amb.serviceTypeLabel,
      status            : amb.status,
      displayStatus     : exports.computeAmbulanceDisplayStatus(amb),
      source            : 'ambulance',
      driverLock        : amb.driverLock,
      partner           : amb.owner ? {
        _id            : amb.owner._id,
        // businessName is what a dispatcher recognises; name is the
        // person who registered and is the fallback for owners created
        // before businessName existed.
        label          : amb.owner.businessName || amb.owner.name,
        isPlatformOwner: !!amb.owner.isPlatformOwner,
      } : null,
      assignedDriver    : amb.assignedDriver ? {
        _id  : amb.assignedDriver._id,
        name : amb.assignedDriver.name,
        phone: amb.assignedDriver.phone,
      } : null,
      defaultDriver     : amb.defaultDriver ? {
        _id  : amb.defaultDriver._id,
        name : amb.defaultDriver.name,
        phone: amb.defaultDriver.phone,
      } : null,
    }));

    return res.json({ success: true, ambulances: shaped });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// DEFAULT DRIVER — the owner's roster decision.
//
// Separate from assignedDriver on purpose. See the field comments in
// models/Ambulance.js: assignedDriver says who is on shift right now and
// belongs to the duty lifecycle; defaultDriver says who usually drives
// this and belongs to the owner. Nothing here writes assignedDriver.
// ============================================================

const DRIVER_LOCKS = ['open', 'preferred', 'locked'];

// ============================================================
// @route   PUT /api/ambulances/:id/default-driver
// @desc    Assign (or re-assign) the rostered driver, and set how hard
//          that is enforced at start-duty.
// @access  Private [owner]
// ============================================================
exports.setDefaultDriver = async (req, res, next) => {
  try {
    const { driverId, driverLock } = req.body;

    if (!driverId) {
      return res.status(400).json({ success: false, message: 'driverId is required.' });
    }
    if (driverLock !== undefined && !DRIVER_LOCKS.includes(driverLock)) {
      return res.status(400).json({
        success: false,
        message: `driverLock must be one of: ${DRIVER_LOCKS.join(', ')}.`,
      });
    }

    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    // Scoped to this owner's own drivers. Without the owner filter an
    // owner could roster another partner's driver onto their vehicle by
    // posting a raw id — the same cross-tenant hole startDuty closes with
    // owner:req.user.owner on its claim.
    const driver = await User.findOne({ _id: driverId, role: 'driver', owner: req.user._id });
    if (!driver) {
      // Same answer whether the driver belongs to another owner or does
      // not exist, so this cannot be used to probe for driver ids.
      return res.status(404).json({ success: false, message: 'Driver not found in your fleet.' });
    }
    if (driver.approvalStatus !== 'approved') {
      return res.status(409).json({
        success: false,
        code   : 'DRIVER_NOT_APPROVED',
        message: `${driver.name} is not approved yet. Approve them before assigning an ambulance.`,
      });
    }

    // One ambulance per driver. 409 rather than silently clearing the
    // other one, deliberately:
    //
    // Clearing is a destructive edit to a vehicle the owner is not
    // looking at. If that other ambulance was 'locked' to this driver, a
    // silent clear leaves it locked to nobody — unclaimable by the whole
    // fleet — and the owner finds out when a driver cannot go on duty.
    // Naming the conflict lets them decide which vehicle this driver
    // should be on, and costs one tap on Remove.
    //
    // It also matches how startDuty already refuses a second concurrent
    // duty ("end your current duty first") rather than ending the first.
    const clash = await Ambulance.findOne({
      owner        : req.user._id,
      defaultDriver: driver._id,
      isActive     : true,
      _id          : { $ne: ambulance._id },
    }).select('registrationNumber');
    if (clash) {
      return res.status(409).json({
        success: false,
        code   : 'DRIVER_ALREADY_ASSIGNED',
        message: `${driver.name} is already the assigned driver of ${clash.registrationNumber}. Remove them from that ambulance first.`,
        conflict: { ambulanceId: clash._id, registrationNumber: clash.registrationNumber },
      });
    }

    ambulance.defaultDriver = driver._id;
    if (driverLock !== undefined) ambulance.driverLock = driverLock;
    await ambulance.save();

    await ambulance.populate('defaultDriver', 'name phone');
    return res.json({
      success  : true,
      message  : `${driver.name} is now the assigned driver of ${ambulance.registrationNumber}.`,
      ambulance,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   DELETE /api/ambulances/:id/default-driver
// @desc    Clear the rostered driver.
// @access  Private [owner]
// ============================================================
exports.clearDefaultDriver = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findOne({ _id: req.params.id, owner: req.user._id });
    if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });

    // Dropping the lock along with the driver is not a convenience, it is
    // required: 'locked' with no defaultDriver is an ambulance nobody in
    // the fleet can claim, including the owner. Anything else would let
    // Remove brick a vehicle.
    ambulance.defaultDriver = null;
    ambulance.driverLock    = 'open';
    await ambulance.save();

    return res.json({
      success  : true,
      message  : `Assigned driver removed from ${ambulance.registrationNumber}.`,
      ambulance,
    });
  } catch (err) {
    next(err);
  }
};
