'use strict';
const mongoose = require('mongoose');
const crypto   = require('crypto');

// A "Quote & Confirm" link: the CRM sends a customer a link, the customer
// fills in whatever the operator left blank (pickup by GPS or search, drop,
// service, AC), sees the fare, and confirms -- which books a real Trip
// through the same createBookedTrip path every other booking uses.
//
// Nothing about the fare is stored here. The customer page asks for a fresh
// quote (tripController.quoteTrip) every time the inputs change, and the
// booked number is whatever createBookedTrip computes at confirm time; the
// trip carries it from then on.
const placeSchema = new mongoose.Schema(
  {
    address: { type: String, trim: true },
    lat    : { type: Number },
    lng    : { type: Number },
  },
  { _id: false },
);

// How long a link stays usable. An ambulance quote is for now, not next
// week; a link that turns up days later should send the customer back to
// the call desk rather than book against a stale situation.
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const QuoteSchema = new mongoose.Schema(
  {
    // The only key the public page has. Random, never the _id -- same
    // reasoning as Trip.trackingToken: an ObjectId's neighbours are
    // guessable, and this page books ambulances.
    token: {
      type    : String,
      required: true,
      unique  : true,
      index   : true,
      default : () => crypto.randomBytes(16).toString('base64url'),
    },

    // 10-digit Indian mobile, normalised with utils/phone.js. Set by the
    // operator and never changeable from the public page: it is the number
    // the link was sent to, and the trip's patientPhone.
    phone: { type: String, required: true, index: true },

    // Everything below is optional when the operator creates the quote. The
    // customer's page fills the gaps and may change what the operator set.
    patientName : { type: String, trim: true },
    pickup      : { type: placeSchema, default: undefined },
    drop        : { type: placeSchema, default: undefined },
    selectedType: { type: String, trim: true },
    acEnabled   : { type: Boolean, default: false },

    // 'confirming' is the short-lived claim held while the trip is being
    // created, so a double tap on Confirm can never book two ambulances.
    // The CRM shows it as Viewed.
    status: {
      type   : String,
      enum   : ['sent', 'viewed', 'confirming', 'confirmed'],
      default: 'sent',
      index  : true,
    },

    // Server time only, all of them.
    sentAt     : { type: Date, default: Date.now },
    viewedAt   : { type: Date },
    confirmedAt: { type: Date },
    expiresAt  : { type: Date, default: () => new Date(Date.now() + LINK_TTL_MS) },

    // Result of the WhatsApp send. A failed send still leaves a usable
    // quote: the operator can copy the link from the CRM and share it.
    whatsappSent : { type: Boolean, default: false },
    whatsappError: { type: String },

    trip     : { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

QuoteSchema.statics.LINK_TTL_MS = LINK_TTL_MS;

module.exports = mongoose.model('Quote', QuoteSchema);
