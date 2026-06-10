/**
 * models/index.js
 * ============================================================
 * Central export of ALL Mongoose schemas and models.
 *
 * Models defined here:
 *   1. User          â€” Staff (Owner / Telecaller / Driver)
 *   2. Vehicle       â€” Fleet asset with compliance documents
 *   3. Attendance    â€” Driver punch-in/out + shift record
 *   4. Hospital      â€” Tie-up hospital master + contract terms
 *   5. Lead          â€” Inbound leads from FB/Google Ads + calls
 *   6. Trip          â€” Booking lifecycle + fare computation
 *   7. Bill          â€” Auto-generated bill on trip completion
 *   8. HospitalInvoice â€” Monthly consolidated hospital invoice
 *   9. Expense       â€” All outflows (diesel, maintenance, EMIâ€¦)
 *  10. Income        â€” All inflows (trip fares, hospital credits)
 *  11. Loan          â€” Vehicle loan + EMI schedule
 *  12. SalaryRecord  â€” Computed monthly salary per driver
 *  13. ServiceLog    â€” Vehicle maintenance history
 *  14. Notification  â€” System compliance / alert notifications
 * ============================================================
 */

'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const { Schema } = mongoose;

// ============================================================
// 1. USER MODEL  (Owner | Telecaller | Driver)
// ============================================================
const userSchema = new Schema(
  {
    name: {
      type     : String,
      required : [true, 'Name is required'],
      trim     : true,
    },
    phone: {
      type     : String,
      required : [true, 'Phone number is required'],
      unique   : true,
      match    : [/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'],
    },
    email: {
      type     : String,
      lowercase: true,
      trim     : true,
      sparse   : true, // allow multiple null values
      match    : [/\S+@\S+\.\S+/, 'Enter a valid email address'],
    },
    password: {
      type     : String,
      minlength: 6,
      select   : false, // Never returned in queries by default
    },

    // â”€â”€ RBAC Role â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    role: {
      type    : String,
      enum    : ['owner', 'telecaller', 'driver'],
      default : 'driver',
    },

    // â”€â”€ Driver-specific fields (only populated when role=driver)
    licenseNumber : { type: String, trim: true },
    licenseExpiry : { type: Date },
    vehicleId     : { type: Schema.Types.ObjectId, ref: 'Vehicle' }, // Assigned ambulance
    shiftType     : { type: String, enum: ['day', 'night', 'flexible'], default: 'day' },
driverType    : { type: String, enum: ['shift_driver', 'trip_driver'], default: 'shift_driver' },

    // â”€â”€ Salary configuration (used by salary engine) â”€â”€â”€â”€â”€â”€â”€â”€â”€
    baseSalary  : { type: Number, default: 15000 },  // Fixed monthly component
    perTripBonus: { type: Number, default: 100 },    // Bonus per completed trip

    // â”€â”€ OTP & auth state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    otp           : { type: String, select: false },
    otpExpiry     : { type: Date,   select: false },
    refreshToken  : { type: String, select: false },
    isActive      : { type: Boolean, default: true },
    lastLogin     : { type: Date },

    // â”€â”€ Driver current availability (synced from mobile app) â”€â”€
    availability  : {
      status   : { type: String, enum: ['available', 'on_trip', 'offline'], default: 'offline' },
      updatedAt: { type: Date,   default: Date.now },
      lat      : { type: Number },
      lng      : { type: Number },
    },

    profileImage : { type: String }, // Cloudinary URL
  },
  { timestamps: true }
);

// â”€â”€ Hash password before save â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt    = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// â”€â”€ Instance method: compare password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// â”€â”€ Instance method: check if OTP is valid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
userSchema.methods.isOtpValid = function (otp) {
  return this.otp === otp && this.otpExpiry > Date.now();
};

const User = mongoose.model('User', userSchema);


// ============================================================
// 2. VEHICLE MODEL
// ============================================================
const vehicleSchema = new Schema(
  {
    registrationNumber: {
      type     : String,
      required : true,
      unique   : true,
      uppercase: true,
      trim     : true,
    },
    model        : { type: String, required: true, trim: true }, // e.g. "Force Traveller ALS"
    type         : { type: String, enum: ['ALS', 'BLS', 'Patient_Transport'], default: 'BLS' },
    assignedDriver: { type: Schema.Types.ObjectId, ref: 'User' },
    status        : {
      type    : String,
      enum    : ['available', 'on_trip', 'offline', 'maintenance'],
      default : 'offline',
    },

    // â”€â”€ GPS â€” updated via driver app WebSocket / REST â”€â”€â”€â”€â”€â”€â”€â”€â”€
    gps: {
      lat      : { type: Number },
      lng      : { type: Number },
      updatedAt: { type: Date },
    },

    odometer: { type: Number, default: 0 }, // km
    fuelType : { type: String, enum: ['diesel', 'petrol', 'cng', 'electric'], default: 'diesel' },

    // â”€â”€ Compliance Documents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Each sub-document has expiry date + alert tracking fields
    documents: {
      insurance: {
        number    : String,
        issueDate : Date,
        expiryDate: { type: Date, index: true }, // Indexed for expiry queries
        fileUrl   : String, // Cloudinary PDF/image URL
        alertSent : { type: Boolean, default: false }, // 15-day alert flag
        alertSentAt: Date,
      },
      fitnessCertificate: {
        number    : String,
        issueDate : Date,
        expiryDate: { type: Date, index: true },
        fileUrl   : String,
        alertSent : { type: Boolean, default: false },
        alertSentAt: Date,
      },
      rtoPermit: {
        number    : String,
        issueDate : Date,
        expiryDate: { type: Date, index: true },
        fileUrl   : String,
        alertSent : { type: Boolean, default: false },
        alertSentAt: Date,
      },
      pucCertificate: {
        number    : String,
        issueDate : Date,
        expiryDate: { type: Date, index: true },
        fileUrl   : String,
        alertSent : { type: Boolean, default: false },
        alertSentAt: Date,
      },
    },

    // â”€â”€ Loan reference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    loanId: { type: Schema.Types.ObjectId, ref: 'Loan' },

    notes    : { type: String },
    isActive : { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Virtual: list of documents expiring within N days
vehicleSchema.methods.getExpiringDocuments = function (withinDays = 15) {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + withinDays);
  const docs = [];
  const types = ['insurance', 'fitnessCertificate', 'rtoPermit', 'pucCertificate'];
  types.forEach(type => {
    const doc = this.documents[type];
    if (doc && doc.expiryDate && doc.expiryDate <= threshold) {
      docs.push({ type, expiryDate: doc.expiryDate, daysLeft: Math.ceil((doc.expiryDate - Date.now()) / 86400000) });
    }
  });
  return docs;
};

const Vehicle = mongoose.model('Vehicle', vehicleSchema);


// ============================================================
// 3. ATTENDANCE MODEL
// ============================================================
const attendanceSchema = new Schema(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date  : { type: Date, required: true }, // Store as YYYY-MM-DD 00:00:00 UTC

    shift : { type: String, enum: ['day', 'night'], required: true },

    clockIn : { type: Date },
    clockOut: { type: Date },

    // Computed duration in minutes (set on clock-out)
    durationMinutes: { type: Number },

    status: {
      type   : String,
      enum   : ['present', 'absent', 'half_day', 'leave', 'holiday'],
      default: 'absent',
    },

    // Pre-shift mandatory checklist â€” vehicle must pass before driver goes Available
    shiftChecklist: {
      oxygenLevelPct  : { type: Number },      // Must be >= 80 to unlock Available status
      kitComplete     : { type: Boolean },
      vehicleOk       : { type: Boolean },
      notes           : { type: String },
      submittedAt     : { type: Date },
      passed          : { type: Boolean, default: false },
    },

    location: {                                // Geolocation at clock-in
      lat: Number,
      lng: Number,
    },
  },
  { timestamps: true }
);

// Compound index: one record per driver per date
attendanceSchema.index({ driver: 1, date: 1 }, { unique: true });

// Auto-compute duration on clock-out
attendanceSchema.pre('save', function (next) {
  if (this.clockIn && this.clockOut) {
    this.durationMinutes = Math.round((this.clockOut - this.clockIn) / 60000);
  }
  next();
});

const Attendance = mongoose.model('Attendance', attendanceSchema);


// ============================================================
// 4. HOSPITAL MODEL
// ============================================================
const hospitalSchema = new Schema(
  {
    name     : { type: String, required: true, trim: true },
    address  : { type: String },
    city     : { type: String },
    phone    : { type: String },
    email    : { type: String },

    // Tie-up contract terms
    tieUp: {
      isActive       : { type: Boolean, default: false },
      discountPercent: { type: Number, default: 0, min: 0, max: 100 }, // Discount on gross fare
      creditDays     : { type: Number, default: 30 },                  // Payment cycle in days
      contractStartDate: Date,
      contactPersonName: String,
      contactPersonPhone: String,
    },

    notes    : String,
    isActive : { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Hospital = mongoose.model('Hospital', hospitalSchema);


// ============================================================
// 5. LEAD MODEL  (FB Ads | Google Ads | Inbound Calls)
// ============================================================
const leadSchema = new Schema(
  {
    // â”€â”€ Lead source â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    source: {
      type    : String,
      enum    : ['facebook_ad', 'google_ad', 'inbound_call', 'walk_in', 'referral', 'manual'],
      default : 'manual',
    },

    // â”€â”€ Raw platform IDs for deduplication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    fbLeadId     : { type: String, sparse: true }, // Facebook form lead ID
    googleLeadId : { type: String, sparse: true }, // Google Lead Extension ID

    // â”€â”€ Patient / Customer Details â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    patientName : { type: String, trim: true },
    phone       : { type: String, required: true, index: true },
    email       : { type: String, trim: true, lowercase: true },
    message     : { type: String },            // What they wrote in the ad form
    adName      : { type: String },            // Which ad/campaign triggered this
    formName    : { type: String },

    // â”€â”€ CRM state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    status: {
      type   : String,
      enum   : ['new', 'contacted', 'converted', 'lost', 'spam'],
      default: 'new',
    },
    assignedTo  : { type: Schema.Types.ObjectId, ref: 'User' }, // Telecaller
    notes       : { type: String },
    convertedTrip: { type: Schema.Types.ObjectId, ref: 'Trip' }, // If lead became a trip

    // â”€â”€ Call popup data (populated from telephony webhook) â”€â”€â”€
    callHistory: [
      {
        callSid   : String,
        direction : { type: String, enum: ['inbound', 'outbound'] },
        duration  : Number, // seconds
        status    : String,
        calledAt  : Date,
      },
    ],

    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Lead = mongoose.model('Lead', leadSchema);


// ============================================================
// 6. TRIP MODEL
// ============================================================
const tripSchema = new Schema(
  {
    tripNumber: { type: String, unique: true }, // Auto-generated: TRP-YYYYMMDD-001

    // â”€â”€ Patient Details â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    patientName   : { type: String, required: true, trim: true },
    patientPhone  : { type: String, required: true },
    emergencyType : {
      type    : String,
      enum    : ['cardiac', 'trauma', 'maternity', 'respiratory', 'neurological', 'general', 'critical'],
      default : 'general',
    },

    // â”€â”€ Locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    pickup: {
      address: { type: String, required: true },
      lat    : Number,
      lng    : Number,
    },
    dropHospital  : { type: Schema.Types.ObjectId, ref: 'Hospital' },
    dropAddress   : { type: String },

    // â”€â”€ Assignment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    vehicle       : { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    driver        : { type: Schema.Types.ObjectId, ref: 'User' },
    bookedBy      : { type: Schema.Types.ObjectId, ref: 'User' }, // Telecaller
    leadId        : { type: Schema.Types.ObjectId, ref: 'Lead' }, // If originated from ad lead

    // â”€â”€ Fare Computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    baseFare      : { type: Number, required: true, default: 1500 },
    distanceKm    : { type: Number, default: 0 },
    perKmRate     : { type: Number, default: 25 },
    additionalCharges: { type: Number, default: 0 }, // Consumables, extra time, etc.
    totalFare     : { type: Number },               // Computed on completion
    gstAmount     : { type: Number },
    grandTotal    : { type: Number },               // totalFare + GST

    // â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    status: {
      type   : String,
      enum   : ['booked', 'dispatched', 'en_route', 'completed', 'cancelled'],
      default: 'booked',
      index  : true,
    },

    // Timestamps for each status transition
    dispatchedAt  : Date,
    enRouteAt     : Date,
    completedAt   : Date,
    cancelledAt   : Date,
    cancellationReason: String,

    // â”€â”€ Billing state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    billId        : { type: Schema.Types.ObjectId, ref: 'Bill' },
    isHospitalBilled: { type: Boolean, default: false }, // Included in hospital invoice
  },
  { timestamps: true }
);

// Auto-generate trip number before save
tripSchema.pre('save', function (next) {
  if (!this.isNew) return next();
  const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
  this.tripNumber = `TRP-${Date.now()}-${rand}`;
  next();
});

const Trip = mongoose.model('Trip', tripSchema);


// ============================================================
// 7. BILL MODEL  (Auto-generated on trip completion)
// ============================================================
const billSchema = new Schema(
  {
    billNumber  : { type: String, unique: true }, // BILL-YYYYMMDD-001
    trip        : { type: Schema.Types.ObjectId, ref: 'Trip', required: true },
    patient     : { type: String },
    hospital    : { type: Schema.Types.ObjectId, ref: 'Hospital' },

    // â”€â”€ Fare Breakdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    baseFare          : { type: Number },
    distanceKm        : { type: Number },
    perKmRate         : { type: Number },
    distanceCharge    : { type: Number },   // distanceKm * perKmRate
    additionalCharges : { type: Number, default: 0 },
    subTotal          : { type: Number },
    gstRate           : { type: Number, default: 5 }, // 5% GST on medical transport
    gstAmount         : { type: Number },
    grandTotal        : { type: Number },

    // â”€â”€ Payment State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    paymentStatus: {
      type   : String,
      enum   : ['pending', 'paid', 'partial', 'waived'],
      default: 'pending',
    },
    paymentMode : { type: String, enum: ['cash', 'upi', 'card', 'insurance', 'hospital_credit'] },
    paidAmount  : { type: Number, default: 0 },
    paidAt      : { type: Date },

    // â”€â”€ Hospital Invoice Reference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    invoiceId   : { type: Schema.Types.ObjectId, ref: 'HospitalInvoice' },

    notes       : String,
  },
  { timestamps: true }
);

billSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const today  = new Date();
  const prefix = `BILL-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  const count  = await mongoose.model('Bill').countDocuments({ createdAt: { $gte: new Date(today.setHours(0,0,0,0)) } });
  this.billNumber = `${prefix}-${String(count + 1).padStart(3, '0')}`;
  next();
});

const Bill = mongoose.model('Bill', billSchema);


// ============================================================
// 8. HOSPITAL INVOICE MODEL  (Monthly consolidated)
// ============================================================
const hospitalInvoiceSchema = new Schema(
  {
    invoiceNumber  : { type: String, unique: true }, // INV-2025-12-001
    hospital       : { type: Schema.Types.ObjectId, ref: 'Hospital', required: true },

    billingPeriod: {
      month : { type: Number, required: true, min: 1, max: 12 },
      year  : { type: Number, required: true },
    },

    trips          : [{ type: Schema.Types.ObjectId, ref: 'Trip' }], // All trips in period
    bills          : [{ type: Schema.Types.ObjectId, ref: 'Bill' }],

    // â”€â”€ Totals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    totalTrips     : { type: Number },
    grossAmount    : { type: Number },  // Sum of all grandTotals
    discountPercent: { type: Number },  // From hospital.tieUp.discountPercent
    discountAmount : { type: Number },
    netPayable     : { type: Number },  // grossAmount - discountAmount

    status: {
      type   : String,
      enum   : ['draft', 'sent', 'paid', 'overdue'],
      default: 'draft',
    },

    generatedBy : { type: Schema.Types.ObjectId, ref: 'User' },
    sentAt      : Date,
    paidAt      : Date,
    dueDate     : Date,

    notes       : String,
  },
  { timestamps: true }
);

const HospitalInvoice = mongoose.model('HospitalInvoice', hospitalInvoiceSchema);


// ============================================================
// 9. EXPENSE MODEL
// ============================================================
const expenseSchema = new Schema(
  {
    category: {
      type    : String,
      enum    : ['diesel', 'maintenance', 'oxygen_refill', 'salary', 'emi_payment', 'insurance_renewal', 'misc'],
      required: true,
    },
    amount      : { type: Number, required: true },
    description : { type: String },
    vehicle     : { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    date        : { type: Date, required: true, default: Date.now },

    // â”€â”€ Diesel-specific â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    diesel: {
      litres        : Number,
      pricePerLitre : Number,
      odometerReading: Number, // km at time of fill-up
      pumpName      : String,
      receiptUrl    : String,  // Cloudinary URL
    },

    // â”€â”€ EMI-specific â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    emi: {
      loanId    : { type: Schema.Types.ObjectId, ref: 'Loan' },
      emiMonth  : Number,
      emiYear   : Number,
      emiNumber : Number, // Which installment (1 of 60)
    },

    recordedBy  : { type: Schema.Types.ObjectId, ref: 'User' },
    receiptUrl  : String,
  },
  { timestamps: true }
);

const Expense = mongoose.model('Expense', expenseSchema);


// ============================================================
// 10. INCOME MODEL
// ============================================================
const incomeSchema = new Schema(
  {
    category: {
      type    : String,
      enum    : ['trip_fare', 'hospital_credit', 'donation', 'grant', 'misc'],
      required: true,
    },
    amount      : { type: Number, required: true },
    description : { type: String },
    date        : { type: Date, required: true, default: Date.now },

    // â”€â”€ Reference links â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    trip       : { type: Schema.Types.ObjectId, ref: 'Trip' },
    invoice    : { type: Schema.Types.ObjectId, ref: 'HospitalInvoice' },
    vehicle    : { type: Schema.Types.ObjectId, ref: 'Vehicle' },

    recordedBy : { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const Income = mongoose.model('Income', incomeSchema);


// ============================================================
// 11. LOAN MODEL
// ============================================================
const loanSchema = new Schema(
  {
    vehicle     : { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    lenderName  : { type: String, required: true },
    accountNumber: String,

    principal   : { type: Number, required: true },     // Original loan amount
    interestRate: { type: Number, required: true },     // % per annum
    tenureMonths: { type: Number, required: true },
    emiAmount   : { type: Number, required: true },     // Calculated EMI
    emiDueDay   : { type: Number, default: 1, min: 1, max: 28 }, // Day of month EMI is due
    startDate   : { type: Date, required: true },

    // â”€â”€ Repayment tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    paidInstallments : { type: Number, default: 0 },
    totalPaidAmount  : { type: Number, default: 0 },
    status : { type: String, enum: ['active', 'closed', 'defaulted'], default: 'active' },

    notes : String,
  },
  { timestamps: true }
);

// Virtual: outstanding principal (approximate)
loanSchema.virtual('outstandingAmount').get(function () {
  const remaining = this.tenureMonths - this.paidInstallments;
  return Math.max(0, this.emiAmount * remaining);
});

// Virtual: next EMI date
loanSchema.virtual('nextEmiDate').get(function () {
  const now  = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), this.emiDueDay);
  if (date < now) date.setMonth(date.getMonth() + 1);
  return date;
});

loanSchema.set('toJSON', { virtuals: true });

const Loan = mongoose.model('Loan', loanSchema);


// ============================================================
// 12. SALARY RECORD MODEL
// ============================================================
const salaryRecordSchema = new Schema(
  {
    driver       : { type: Schema.Types.ObjectId, ref: 'User', required: true },
    month        : { type: Number, required: true, min: 1, max: 12 },
    year         : { type: Number, required: true },

    // â”€â”€ Computation Inputs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    workingDays     : { type: Number },  // Total working days in month
    presentDays     : { type: Number },  // From Attendance records
    completedTrips  : { type: Number },  // From Trip records
    baseSalary      : { type: Number },  // Snapshot of driver.baseSalary at calc time
    perTripBonus    : { type: Number },  // Snapshot of driver.perTripBonus

    // â”€â”€ Calculation Results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    earnedBase      : { type: Number },  // baseSalary * (presentDays / workingDays)
    tripBonusAmount : { type: Number },  // completedTrips * perTripBonus
    grossSalary     : { type: Number },  // earnedBase + tripBonusAmount
    deductions      : { type: Number, default: 0 }, // Advances, penalties
    netSalary       : { type: Number },  // grossSalary - deductions

    // â”€â”€ Payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    status    : { type: String, enum: ['draft', 'approved', 'paid'], default: 'draft' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidAt    : Date,
    paymentMode: { type: String, enum: ['bank_transfer', 'cash', 'upi'] },

    notes     : String,
  },
  { timestamps: true }
);

// Compound unique index: one salary record per driver per month
salaryRecordSchema.index({ driver: 1, month: 1, year: 1 }, { unique: true });

const SalaryRecord = mongoose.model('SalaryRecord', salaryRecordSchema);


// ============================================================
// 13. SERVICE LOG MODEL
// ============================================================
const serviceLogSchema = new Schema(
  {
    vehicle     : { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    serviceType : {
      type    : String,
      enum    : ['oil_change', 'tyre_replacement', 'oxygen_refill', 'battery', 'brake', 'general_service', 'other'],
      required: true,
    },

    date          : { type: Date, required: true, default: Date.now },
    odometerReading: { type: Number },
    vendor        : { type: String },
    cost          : { type: Number },
    description   : { type: String },
    receiptUrl    : { type: String },

    // â”€â”€ Tyre-specific â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    tyre: {
      position: { type: String, enum: ['FL', 'FR', 'RL', 'RR', 'spare'] },
      brand   : String,
    },

    // â”€â”€ O2 Cylinder-specific â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    oxygen: {
      cylinderId  : String,
      fillLevelPct: Number,
    },

    // â”€â”€ Next service reminder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    nextServiceDate  : Date,
    nextServiceOdoKm : Number,

    loggedBy : { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const ServiceLog = mongoose.model('ServiceLog', serviceLogSchema);


// ============================================================
// 14. NOTIFICATION MODEL  (In-app compliance alerts)
// ============================================================
const notificationSchema = new Schema(
  {
    type: {
      type    : String,
      enum    : ['compliance_expiry', 'emi_due', 'shift_checklist', 'trip_assigned', 'salary_generated', 'lead_received'],
      required: true,
    },
    title   : { type: String, required: true },
    message : { type: String, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },

    // â”€â”€ References â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    vehicle  : { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    user     : { type: Schema.Types.ObjectId, ref: 'User' },
    trip     : { type: Schema.Types.ObjectId, ref: 'Trip' },

    targetRole  : { type: String, enum: ['owner', 'telecaller', 'driver', 'all'] },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User' }, // If targeted at one user

    read    : { type: Boolean, default: false },
    readAt  : Date,
    smsSent : { type: Boolean, default: false }, // Was SMS notification fired?
  },
  { timestamps: true }
);

const Notification = mongoose.model('Notification', notificationSchema);

// ============================================================
// 15. ADVANCE MODEL
// ============================================================
const advanceSchema = new Schema(
  {
    driver        : { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount        : { type: Number, required: true },
    reason        : { type: String, required: true },
    status        : { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    approvedBy    : { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt    : { type: Date },
    rejectedReason: { type: String },
    deductedMonth : { type: Number },
    deductedYear  : { type: Number },
    isDeducted    : { type: Boolean, default: false },
  },
  { timestamps: true }
);
const Advance = mongoose.model('Advance', advanceSchema);
const pricingSchema = new Schema(
  {
    vehicleType: String,
    serviceType: String,
    nightMultiplier: Number,
    nightStartHour: Number,
    nightEndHour: Number,
    oxygenPerKm: Number,
    acPerKm: Number,
    after300KmRate: Number,
    slabs: Array,
    active: Boolean,
  },
  { timestamps: true }
);

const Pricing = mongoose.model('Pricing', pricingSchema);
// â”€â”€ Single export object â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = {
  User,
  Vehicle,
  Attendance,
  Hospital,
  Lead,
  Trip,
  Bill,
  HospitalInvoice,
  Expense,
  Income,
  Loan,
  SalaryRecord,
  ServiceLog,
  Notification,
  Advance,
  Pricing,
};

