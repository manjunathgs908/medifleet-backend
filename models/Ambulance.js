/**
 * models/Ambulance.js
 * ============================================================
 * An ambulance owned by a fleet Owner, belonging to one of their Fleets.
 * `assignedDriver` references the *existing* `User` model (drivers) —
 * read-only reference, User schema itself is untouched.
 * Phase 1 of the driver-auth redesign — additive only.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const { AMBULANCE_SERVICE_TYPES } = require('../utils/ambulanceServiceTypes');

const SERVICE_TYPES = AMBULANCE_SERVICE_TYPES.map(o => o.serviceType);

// documents.pollution is the PUC (Pollution Under Control) certificate —
// key kept as `pollution` for consistency with the existing DOC_TYPES list
// in ambulanceController.js; only the owner-facing label says "PUC".
const documentSchema = new Schema(
  {
    url       : { type: String },
    publicId  : { type: String }, // Cloudinary public_id — for future delete/replace
    number    : { type: String }, // certificate/document number, optional
    expiryDate: { type: Date },
  },
  { _id: false }
);

const photoSchema = new Schema(
  {
    url     : { type: String, required: true },
    publicId: { type: String },
  },
  { _id: false }
);

const ambulanceSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    fleet: { type: Schema.Types.ObjectId, ref: 'Fleet', required: true, index: true },

    registrationNumber: {
      type    : String,
      required: true,
      unique  : true,
      uppercase: true,
      trim    : true,
    },

    // Vehicle type — see utils/ambulanceServiceTypes.js. serviceTypeLabel/
    // vehicleModel are derived server-side from that fixed lookup (not
    // owner-entered free text) so display strings stay consistent across
    // the fleet; both are null for HEARSE/FREEZER_BOX, which have no
    // single fixed vehicleModel.
    serviceType     : { type: String, enum: SERVICE_TYPES, required: true },
    serviceTypeLabel: { type: String },
    vehicleModel    : { type: String, enum: ['Maruti Eeco', 'Tempo Traveller', null], default: null },
    year            : { type: Number },

    photos: [photoSchema],

    // WHO IS ON DUTY RIGHT NOW. Transient, and owned entirely by the duty
    // lifecycle: written by assignmentController.startDuty inside its
    // atomic claim, cleared by endDuty/forceEndDuty. Null whenever nobody
    // is on shift. Trip dispatch reads it to find someone to send.
    //
    // Not settable by an owner — updateAmbulance/createAmbulance refuse it.
    // The roster answer is defaultDriver below.
    assignedDriver: { type: Schema.Types.ObjectId, ref: 'User' },

    // WHO USUALLY DRIVES THIS. Durable, and owned entirely by the owner,
    // set through PUT /api/ambulances/:id/default-driver.
    //
    // Deliberately a separate field rather than a reuse of assignedDriver.
    // The two answer different questions and change on different clocks —
    // one per shift, one per roster decision — and the earlier attempt to
    // express both in one field failed because the transient writer runs
    // every shift and always wins.
    defaultDriver: { type: Schema.Types.ObjectId, ref: 'User' },

    // How hard defaultDriver is enforced at start-duty:
    //   open      — anyone in the fleet may claim it; defaultDriver is
    //               only a label.
    //   preferred — anyone may claim it, but the rostered driver sees it
    //               first in their picker. The default, because it is the
    //               one setting that cannot strand an ambulance.
    //   locked    — only defaultDriver may claim it. Enforced inside
    //               startDuty's atomic filter, so the guarantee is the
    //               same single write as the availability check.
    //
    // 'locked' with no defaultDriver would make an ambulance unclaimable
    // by anyone; the endpoint refuses that combination rather than letting
    // a vehicle be bricked by a dropdown.
    driverLock: {
      type   : String,
      enum   : ['open', 'preferred', 'locked'],
      default: 'preferred',
    },

    deviceId: { type: String, trim: true }, // GPS/telematics hardware ID

    status: {
      type   : String,
      enum   : ['available', 'assigned', 'maintenance'],
      default: 'available',
    },

    documents: {
      rc       : documentSchema,
      insurance: documentSchema,
      fitness  : documentSchema,
      permit   : documentSchema,
      pollution: documentSchema,
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Ambulance', ambulanceSchema);
