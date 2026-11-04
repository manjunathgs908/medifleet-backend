'use strict';
/**
 * models/Invoicing.js
 * ============================================================
 * GST invoicing (Phase 1) — new collections only; nothing existing changes.
 *
 *   parties          who we invoice: companies (GSTIN), unregistered
 *                    businesses, consumers. Opening balance = what they
 *                    owed on the cutover date (carried from Vyapar).
 *   catalogitems     services (and goods) with SAC/HSN, unit, default rate,
 *                    tax type, GST rate and reverse-charge flag.
 *   salesinvoices    tax invoices and bills of supply. Drafts are editable;
 *                    an issued invoice is frozen (its party is copied in as
 *                    it stood) and can only be cancelled.
 *   documentcounters one number sequence per series per financial year.
 *   billingsettings  one document: bank details, UPI, default terms, where
 *                    each series starts.
 *
 * Money: whole paise everywhere. Rates: percent (18 = 18%).
 * ============================================================
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const { TAX_TYPES, PARTY_KINDS, DOC_TYPES } = require('../services/gst');

const addressSchema = new Schema({
  line1: String, line2: String, city: String, pincode: String,
}, { _id: false });

// ── Party ───────────────────────────────────────────────────
const partySchema = new Schema({
  name     : { type: String, required: true, trim: true },
  kind     : { type: String, enum: PARTY_KINDS, required: true },
  gstin    : { type: String, uppercase: true, trim: true },   // required when kind = registered
  stateCode: { type: String, required: true },                // '29'; from the GSTIN when there is one
  address  : addressSchema,
  phone    : String,
  email    : String,
  creditDays: { type: Number, default: 0 },
  openingBalancePaise: { type: Number, default: 0 },          // owed to us on openingBalanceAsOf
  openingBalanceAsOf : Date,
  hospital : { type: Schema.Types.ObjectId, ref: 'Hospital' },// optional link to a tie-up hospital
  notes    : String,
  active   : { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
// One party per GSTIN (a second branch in another state has its own GSTIN).
partySchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } });
partySchema.index({ name: 1 });

// ── Catalog item ────────────────────────────────────────────
const catalogItemSchema = new Schema({
  name     : { type: String, required: true, trim: true },
  kind     : { type: String, enum: ['service', 'goods'], default: 'service' },
  code     : { type: String, required: true, trim: true },    // SAC (services) / HSN (goods)
  unit     : { type: String, default: 'Nos', trim: true },    // Month, Trip, Km, Nos, Day
  ratePaise: { type: Number, default: 0 },                    // default price per unit, before tax
  taxType  : { type: String, enum: TAX_TYPES, required: true },
  gstRate  : { type: Number, default: 0 },
  reverseCharge: { type: Boolean, default: false },
  description: String,
  active   : { type: Boolean, default: true },
}, { timestamps: true });

// ── Sales invoice ───────────────────────────────────────────
const lineSchema = new Schema({
  item       : { type: Schema.Types.ObjectId, ref: 'CatalogItem' },
  name       : { type: String, required: true },
  description: String,
  code       : String,          // SAC/HSN as printed
  kind       : { type: String, enum: ['service', 'goods'], default: 'service' },
  unit       : String,
  qtyMilli   : { type: Number, required: true },  // quantity × 1000
  ratePaise  : { type: Number, required: true },
  discountPercent: Number,
  discountPaise  : Number,        // the discount actually applied
  taxType    : { type: String, enum: TAX_TYPES, required: true },
  gstRate    : { type: Number, default: 0 },
  reverseCharge: { type: Boolean, default: false },
  grossPaise : Number,
  taxablePaise: Number,
  cgstPaise  : Number,
  sgstPaise  : Number,
  igstPaise  : Number,
  taxPaise   : Number,
  totalPaise : Number,
}, { _id: false });

const paymentSchema = new Schema({
  amountPaise: { type: Number, required: true },
  receivedOn : { type: Date, required: true },   // the date the money came in, as stated
  mode       : { type: String, enum: ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'], required: true },
  reference  : String,
  note       : String,
  by         : { type: Schema.Types.ObjectId, ref: 'User' },
  byName     : String,
  recordedAt : { type: Date, required: true },   // server time
}, { _id: true });

const salesInvoiceSchema = new Schema({
  status  : { type: String, enum: ['draft', 'issued', 'cancelled'], default: 'draft', index: true },
  docType : { type: String, enum: DOC_TYPES },   // set from the lines
  fy      : String,                              // '2026-27' — set at issue
  seq     : Number,
  number  : String,                              // '2026-27/59', 'BS/2026-27/1' — set at issue
  date    : { type: Date, required: true },      // the invoice date (IST day, stored as its IST midnight)

  party        : { type: Schema.Types.ObjectId, ref: 'Party', required: true, index: true },
  // The party as it stood when issued — later edits to the party never
  // change an issued invoice.
  partySnapshot: {
    name: String, kind: String, gstin: String, stateCode: String, stateName: String, address: addressSchema, phone: String,
  },
  placeOfSupply: { type: String, required: true }, // state code
  supplyType   : { type: String, enum: ['intra', 'inter'] },
  reverseCharge: { type: Boolean, default: false },
  roundOff     : { type: Boolean, default: true },

  lines: { type: [lineSchema], default: [] },
  totals: {
    taxablePaise: Number, cgstPaise: Number, sgstPaise: Number, igstPaise: Number,
    taxPaise: Number, roundOffPaise: Number, grandTotalPaise: Number,
  },
  taxSummary: [{ _id: false, gstRate: Number, taxablePaise: Number, cgstPaise: Number, sgstPaise: Number, igstPaise: Number }],

  paymentMode : { type: String, enum: ['credit', 'cash'], default: 'credit' },
  payments    : { type: [paymentSchema], default: [] },
  receivedPaise: { type: Number, default: 0 },

  // The site this invoice is for (a company taking ambulances at several
  // sites gets one invoice per site). Printed beside "Bill To".
  serviceLocation: { siteName: String, address: String, attention: String },
  description : String,           // e.g. "MONTH OF JULY"
  terms       : String,
  transport   : { driverName: String, vehicleNumber: String, pickup: String, drop: String },
  notes       : String,           // internal, never printed

  createdBy  : { type: Schema.Types.ObjectId, ref: 'User' },
  issuedBy   : { type: Schema.Types.ObjectId, ref: 'User' },
  issuedAt   : Date,
  cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
  cancelReason: String,
  // Monthly auto-bill (invoicingController.generateMonthlyDrafts): an issued
  // invoice with isMonthly is the template copied into next month's draft;
  // issuing that draft moves the flag to it. monthlyStoppedAt: when the
  // owner stopped it (server time); null when never stopped or resumed.
  isMonthly       : { type: Boolean, default: false },
  monthlyStoppedAt: { type: Date, default: null },
  sourceTemplateId: { type: Schema.Types.ObjectId, ref: 'SalesInvoice', default: null }, // a draft's template
  // Edits made after issue (the number never changes): who, when, whether
  // amounts/GST/party changed and the total before and after.
  edits: { type: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, financial: Boolean, changed: [String], totalBeforePaise: Number, totalAfterPaise: Number }], default: undefined },
  rev        : { type: Number, default: 0 },   // drafts: an edit from a stale screen is refused
}, { timestamps: true });
// A number is used once in its financial year.
salesInvoiceSchema.index({ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
salesInvoiceSchema.index({ docType: 1, fy: 1, seq: -1 });
salesInvoiceSchema.index({ date: -1 });

// ── Counter & settings ──────────────────────────────────────
const documentCounterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });

const billingSettingsSchema = new Schema({
  _id : { type: String, default: 'default' },
  bank: { name: String, accountNo: String, ifsc: String, holder: String },
  upiId: String,
  terms: String,                 // printed on every invoice unless the invoice has its own
  signatory: String,             // "For: <business name>" line
  // Where each series starts in a financial year: { 'tax_invoice:2026-27': 59 }.
  // Applied only before that series' first number is used.
  seriesStart: { type: Map, of: Number, default: undefined },
  // Each time the tax-invoice series was moved on to continue from a number
  // (invoicingController.restartTaxSeries): who, when, which unpaid CRM
  // numbers were deleted, and the number the series continues from.
  seriesRestarts: { type: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, fy: String, next: Number, deleted: [String], counterBefore: Number }], default: undefined },
  // Cancelled tax invoices deleted permanently (invoicingController
  // .deleteCancelledInvoice): what was deleted, by whom, and whether its
  // number was freed for reuse (it was the last one in the series).
  deletedInvoices: { type: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, number: String, fy: String, seq: Number, party: String, totalPaise: Number, cancelReason: String, numberReused: Boolean }], default: undefined },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = {
  Party          : mongoose.model('Party', partySchema),
  CatalogItem    : mongoose.model('CatalogItem', catalogItemSchema),
  SalesInvoice   : mongoose.model('SalesInvoice', salesInvoiceSchema),
  DocumentCounter: mongoose.model('DocumentCounter', documentCounterSchema),
  BillingSettings: mongoose.model('BillingSettings', billingSettingsSchema),
};
