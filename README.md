# MediFleet CRM — Backend Architecture

## Folder Structure

```
ambulance-backend/
├── server.js                     ← Express app entry point, middleware stack, route mounting
├── package.json                  ← Dependencies
├── .env.example                  ← Environment variable template (copy to .env)
│
├── config/
│   └── db.js                     ← Mongoose connection factory
│
├── models/
│   └── index.js                  ← ALL 14 Mongoose schemas in one file:
│                                    User, Vehicle, Attendance, Hospital, Lead,
│                                    Trip, Bill, HospitalInvoice, Expense,
│                                    Income, Loan, SalaryRecord, ServiceLog,
│                                    Notification
│
├── middleware/
│   ├── auth.js                   ← protect() JWT verify + authorize() RBAC + driverSelfOnly()
│   └── errorHandler.js           ← Global Express error handler + ApiError class
│
├── controllers/
│   ├── authController.js         ← OTP login, password login, JWT, refresh, register users
│   ├── tripController.js         ← Create trip, auto-assign, complete (fare+bill+income), cancel
│   ├── vehicleController.js      ← Fleet CRUD, GPS update, document upload, compliance dashboard
│   ├── telephonyController.js    ← Exotel inbound webhook + FB Lead Ads + Google Lead Ads
│   ├── billingController.js      ← Trip bills, hospital invoice generation, payment recording
│   └── salaryController.js       ← Salary engine, payslips, attendance clock-in/out, checklist
│
├── routes/
│   └── index.js                  ← Master route file (split into individual files in production)
│       auth.js                   ← /api/auth/*
│       vehicles.js               ← /api/vehicles/*
│       trips.js                  ← /api/trips/*
│       billing.js                ← /api/billing/*
│       salary.js                 ← /api/salary/*
│       attendance.js             ← /api/attendance/*
│       telephony.js              ← /api/telephony/* (webhooks)
│       leads.js                  ← /api/leads/* (FB/Google webhooks + CRM)
│       compliance.js             ← /api/compliance/* (manual cron triggers)
│       hospitals.js              ← /api/hospitals/*
│
├── jobs/
│   └── scheduler.js              ← node-cron jobs:
│                                    - Daily compliance expiry alerts (08:00 IST)
│                                    - Daily EMI auto-deduction (09:00 IST)
│                                    - Monthly hospital invoices (1st, 10:00 IST)
│                                    - Month-end salary pre-calc (last day, 23:00 IST)
│
└── utils/
    └── index.js                  ← fareCalculator, smsService (MSG91), cloudinary
```

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your MongoDB URI, JWT secrets, MSG91, etc.

# 3. Run in development
npm run dev

# 4. API base URL
http://localhost:5000/api
```

## API Endpoints Summary

### Auth
| Method | Route                        | Access        |
|--------|------------------------------|---------------|
| POST   | /api/auth/register           | Owner         |
| POST   | /api/auth/send-otp           | Public        |
| POST   | /api/auth/verify-otp         | Public        |
| POST   | /api/auth/login              | Public        |
| POST   | /api/auth/refresh            | Public        |
| POST   | /api/auth/logout             | All           |
| GET    | /api/auth/me                 | All           |
| GET    | /api/auth/users              | Owner         |
| PUT    | /api/auth/users/:id          | Owner         |

### Fleet
| Method | Route                               | Access            |
|--------|-------------------------------------|-------------------|
| POST   | /api/vehicles                        | Owner             |
| GET    | /api/vehicles                        | Owner |
| GET    | /api/vehicles/compliance-dashboard   | Owner             |
| GET    | /api/vehicles/:id                    | Owner |
| PUT    | /api/vehicles/:id/document           | Owner             |
| PUT    | /api/vehicles/:id/gps                | Driver            |
| POST   | /api/vehicles/:id/service-log        | Owner             |

### Trips
| Method | Route                        | Access            |
|--------|------------------------------|-------------------|
| POST   | /api/trips                   | Owner |
| GET    | /api/trips/live              | Owner |
| GET    | /api/trips                   | All (drivers: own)|
| PUT    | /api/trips/:id/complete      | All               |
| PUT    | /api/trips/:id/cancel        | Owner |

### Billing
| Method | Route                                      | Access |
|--------|--------------------------------------------|--------|
| GET    | /api/billing/dashboard                     | Owner  |
| GET    | /api/billing/bills                         | Owner |
| PUT    | /api/billing/bills/:id/payment             | Owner  |
| POST   | /api/billing/hospital-invoice/generate     | Owner  |
| GET    | /api/billing/hospital-invoices             | Owner  |

### Salary & Attendance
| Method | Route                              | Access            |
|--------|------------------------------------|-------------------|
| POST   | /api/salary/calculate/:month/:year | Owner             |
| GET    | /api/salary/summary/:month/:year   | Owner             |
| GET    | /api/salary/:driverId/:month/:year | Owner, Driver(own)|
| PUT    | /api/salary/:id/mark-paid          | Owner             |
| POST   | /api/attendance/clock-in           | Driver            |
| POST   | /api/attendance/clock-out          | Driver            |
| POST   | /api/attendance/shift-checklist    | Driver            |

### Webhooks (no JWT — signature verified)
| Method | Route                        | Trigger           |
|--------|------------------------------|-------------------|
| POST   | /api/telephony/inbound-webhook | Exotel call     |
| GET    | /api/leads/fb/webhook          | FB verification |
| POST   | /api/leads/fb/webhook          | FB new lead     |
| POST   | /api/leads/google/webhook      | Google new lead |

## Role Access Matrix

Telecaller role removed for now — planned to come back later; every
route it used to share with Owner is Owner-only until then.

| Feature                    | Owner | Driver   |
|----------------------------|-------|----------|
| Book trips                 | ✓     |          |
| View all trips             | ✓     | own only |
| View fleet                 | ✓     |          |
| Complete/cancel trips      | ✓     | own only |
| Financial reports          | ✓     |            |          |
| Add expenses/income        | ✓     |            |          |
| Salary management          | ✓     |            |          |
| View own salary            | ✓     |            | ✓        |
| Clock in/out               |       |            | ✓        |
| Shift checklist            |       |            | ✓        |
| Compliance documents       | ✓     |            |          |
| User management            | ✓     |            |          |
| System settings            | ✓     |            |          |

## Key Design Decisions

1. **OTP-first auth for drivers** — Drivers log in via phone OTP (no password to forget/lose).
2. **Refresh token rotation** — Access tokens expire in 7d; refresh tokens in 30d with SHA-256 hash stored in DB.
3. **Fare engine is pure** — `utils/fareCalculator.js` has zero DB calls; every billing path uses it.
4. **Cron jobs are idempotent** — Re-running any job is safe; invoices use upsert, salary uses upsert.
5. **Webhook security** — FB uses SHA-256 payload signing, Exotel uses HMAC-SHA1, both with timing-safe comparison.
6. **Lead deduplication** — FB leads keyed on `fbLeadId`, Google on `googleLeadId`; both use `findOneAndUpdate` upsert.
7. **Driver self-isolation** — `driverSelfOnly` middleware enforces at route level, not just controller level.
