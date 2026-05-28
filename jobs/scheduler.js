/**
 * jobs/scheduler.js
 * ============================================================
 * Background Cron Jobs — powered by node-cron
 *
 * Schedule overview:
 * ┌─────────────────────────────────────────────────────────┐
 * │ JOB                          │ SCHEDULE               │
 * ├─────────────────────────────────────────────────────────┤
 * │ Compliance expiry alerts      │ Every day at 08:00 AM  │
 * │ EMI auto-deduction check      │ Every day at 09:00 AM  │
 * │ Monthly hospital invoices     │ 1st of month, 10:00 AM │
 * │ Salary auto-calculate         │ Last day of month      │
 * └─────────────────────────────────────────────────────────┘
 *
 * Each job is wrapped in try/catch to prevent one failure
 * from crashing the scheduler.
 * ============================================================
 */

'use strict';

const cron       = require('node-cron');
const { Vehicle, Loan, Hospital, Trip, User, Notification, Expense } = require('../models');
const billingController = require('../controllers/billingController');
const smsService        = require('../utils/smsService');

// ── Fake req/res shims for calling controller methods from cron ──
const systemUser = { _id: 'SYSTEM', role: 'owner' };

const mockReqRes = (body = {}, query = {}) => ({
  req: { body, query, params: {}, user: systemUser },
  res: {
    status : () => ({ json: (data) => data }),
    json   : (data) => data,
  },
  next: (err) => console.error('[Cron Error]', err),
});


// ════════════════════════════════════════════════════════════
// JOB 1 — Document Expiry Compliance Alerts
// Runs every day at 08:00 AM
// Checks all vehicle documents expiring within 15 days
// and sends in-app + SMS notifications.
// ════════════════════════════════════════════════════════════
const runComplianceAlerts = async () => {
  console.log('[Cron] 🔍 Running compliance expiry check...');
  try {
    const ALERT_DAYS = Number(process.env.COMPLIANCE_ALERT_DAYS) || 15;
    const threshold  = new Date();
    threshold.setDate(threshold.getDate() + ALERT_DAYS);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const vehicles = await Vehicle.find({ isActive: true });
    const docTypes = ['insurance', 'fitnessCertificate', 'rtoPermit', 'pucCertificate'];
    const docLabels = {
      insurance          : 'Insurance',
      fitnessCertificate : 'Fitness Certificate',
      rtoPermit          : 'RTO Permit',
      pucCertificate     : 'PUC Certificate',
    };

    let alertCount = 0;

    for (const vehicle of vehicles) {
      for (const type of docTypes) {
        const doc = vehicle.documents?.[type];
        if (!doc?.expiryDate) continue;

        const expiryDate = new Date(doc.expiryDate);
        const daysLeft   = Math.ceil((expiryDate - Date.now()) / 86400000);

        // Only alert if: expiring within threshold AND (alert not sent OR resend for critical)
        const shouldAlert =
          daysLeft <= ALERT_DAYS &&
          (!doc.alertSent || (daysLeft <= 3 && !isAlertSentToday(doc.alertSentAt)));

        if (!shouldAlert) continue;

        const severity = daysLeft < 0 ? 'critical' : daysLeft <= 5 ? 'critical' : 'warning';
        const statusMsg = daysLeft < 0
          ? `EXPIRED ${Math.abs(daysLeft)} days ago`
          : `expires in ${daysLeft} day(s)`;

        // ── Create in-app notification ──────────────────────
        await Notification.create({
          type       : 'compliance_expiry',
          title      : `⚠️ ${docLabels[type]} Alert — ${vehicle.registrationNumber}`,
          message    : `${docLabels[type]} for ${vehicle.registrationNumber} ${statusMsg}. Renew immediately.`,
          severity,
          vehicle    : vehicle._id,
          targetRole : 'owner',
        });

        // ── Send SMS to Owner ───────────────────────────────
        try {
          const owners = await User.find({ role: 'owner', isActive: true });
          for (const owner of owners) {
            await smsService.sendAlert(
              owner.phone,
              `MediFleet Alert: ${docLabels[type]} for vehicle ${vehicle.registrationNumber} ${statusMsg}. Please renew urgently.`
            );
          }
        } catch (smsErr) {
          console.error('[Cron SMS Error]', smsErr.message);
        }

        // ── Mark alert as sent ──────────────────────────────
        await Vehicle.findByIdAndUpdate(vehicle._id, {
          [`documents.${type}.alertSent`]  : true,
          [`documents.${type}.alertSentAt`]: new Date(),
        });

        alertCount++;
        console.log(`[Cron] Alert: ${vehicle.registrationNumber} — ${docLabels[type]} — ${statusMsg}`);
      }
    }

    console.log(`[Cron] ✅ Compliance check done. ${alertCount} alert(s) sent.`);
  } catch (err) {
    console.error('[Cron] ❌ Compliance alert job failed:', err.message);
  }
};

// Helper: was an alert already sent today?
const isAlertSentToday = (alertSentAt) => {
  if (!alertSentAt) return false;
  const sentDate = new Date(alertSentAt);
  const today    = new Date();
  return (
    sentDate.getFullYear() === today.getFullYear() &&
    sentDate.getMonth()    === today.getMonth()    &&
    sentDate.getDate()     === today.getDate()
  );
};


// ════════════════════════════════════════════════════════════
// JOB 2 — EMI Auto-Deduction Check
// Runs every day at 09:00 AM
// Checks if today is the EMI due date for any active loan.
// Creates an Expense entry and sends notification.
// ════════════════════════════════════════════════════════════
const runEmiCheck = async () => {
  console.log('[Cron] 💳 Running EMI due date check...');
  try {
    const todayDate = new Date().getDate(); // Day of month (1–31)

    const dueLoans = await Loan.find({
      status    : 'active',
      emiDueDay : todayDate,
    }).populate('vehicle', 'registrationNumber');

    for (const loan of dueLoans) {
      const nextInstallment = loan.paidInstallments + 1;
      if (nextInstallment > loan.tenureMonths) {
        // Loan fully paid — close it
        await Loan.findByIdAndUpdate(loan._id, { status: 'closed' });
        console.log(`[Cron] Loan ${loan._id} fully repaid. Marked closed.`);
        continue;
      }

      // Auto-create expense entry
      await Expense.create({
        category   : 'emi_payment',
        amount     : loan.emiAmount,
        description: `EMI #${nextInstallment} — ${loan.vehicle?.registrationNumber} — ${loan.lenderName}`,
        date       : new Date(),
        emi: {
          loanId    : loan._id,
          emiMonth  : new Date().getMonth() + 1,
          emiYear   : new Date().getFullYear(),
          emiNumber : nextInstallment,
        },
      });

      // Increment paid count
      await Loan.findByIdAndUpdate(loan._id, {
        $inc: { paidInstallments: 1, totalPaidAmount: loan.emiAmount },
      });

      // Notify owner
      await Notification.create({
        type      : 'emi_due',
        title     : `💳 EMI Due — ${loan.vehicle?.registrationNumber}`,
        message   : `EMI #${nextInstallment} of ₹${loan.emiAmount.toLocaleString('en-IN')} for ${loan.lenderName} recorded.`,
        severity  : 'info',
        vehicle   : loan.vehicle?._id,
        targetRole: 'owner',
      });

      console.log(`[Cron] EMI recorded: Loan ${loan._id} — Instalment ${nextInstallment}`);
    }

    console.log(`[Cron] ✅ EMI check done. ${dueLoans.length} loan(s) processed.`);
  } catch (err) {
    console.error('[Cron] ❌ EMI job failed:', err.message);
  }
};


// ════════════════════════════════════════════════════════════
// JOB 3 — Monthly Hospital Invoice Generation
// Runs on the 1st of every month at 10:00 AM
// Generates consolidated invoices for all tie-up hospitals
// for the PREVIOUS month.
// ════════════════════════════════════════════════════════════
const runMonthlyHospitalInvoices = async () => {
  console.log('[Cron] 🏥 Running monthly hospital invoice generation...');
  try {
    const now    = new Date();
    // Invoice previous month
    const month  = now.getMonth() === 0 ? 12 : now.getMonth();
    const year   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

    const tieUpHospitals = await Hospital.find({ 'tieUp.isActive': true, isActive: true });

    if (!tieUpHospitals.length) {
      console.log('[Cron] No tie-up hospitals configured.');
      return;
    }

    let generated = 0;
    for (const hospital of tieUpHospitals) {
      try {
        // Check if invoice already exists for this period
        const { HospitalInvoice } = require('../models');
        const existing = await HospitalInvoice.findOne({
          hospital: hospital._id,
          'billingPeriod.month': month,
          'billingPeriod.year' : year,
        });

        if (existing) {
          console.log(`[Cron] Invoice already exists for ${hospital.name} — ${month}/${year}`);
          continue;
        }

        // Call the billing controller's generate function
        const { req, res, next } = mockReqRes({
          hospitalId: hospital._id.toString(),
          month,
          year,
        });

        await billingController.generateHospitalInvoice(req, res, next);
        generated++;
        console.log(`[Cron] Invoice generated for ${hospital.name} — ${month}/${year}`);
      } catch (invoiceErr) {
        console.error(`[Cron] Failed for ${hospital.name}:`, invoiceErr.message);
      }
    }

    console.log(`[Cron] ✅ Hospital invoices done. ${generated} generated.`);
  } catch (err) {
    console.error('[Cron] ❌ Invoice job failed:', err.message);
  }
};


// ════════════════════════════════════════════════════════════
// JOB 4 — Auto Salary Calculation
// Runs on the last day of each month at 11:00 PM
// Pre-calculates salary records (status='draft') so Owner can
// review and approve on the 1st.
// ════════════════════════════════════════════════════════════
const runSalaryPreCalc = async () => {
  console.log('[Cron] 💰 Pre-calculating salaries for current month...');
  try {
    const now   = new Date();
    const month = now.getMonth() + 1;
    const year  = now.getFullYear();

    // Inline salary calculation (avoids full HTTP request)
    const salaryController = require('../controllers/salaryController');
    const { req, res, next } = mockReqRes({}, {});
    req.params = { month: String(month), year: String(year) };

    await salaryController.calculateSalaries(req, res, next);
    console.log(`[Cron] ✅ Salary pre-calc done for ${month}/${year}`);
  } catch (err) {
    console.error('[Cron] ❌ Salary calc job failed:', err.message);
  }
};


// ════════════════════════════════════════════════════════════
// SCHEDULER BOOT
// Called from server.js after Express is up
// ════════════════════════════════════════════════════════════
exports.startScheduler = () => {
  console.log('⏰  Starting background scheduler...');

  // JOB 1: Compliance check — every day at 08:00 AM (IST)
  cron.schedule('0 8 * * *', runComplianceAlerts, {
    scheduled: true,
    timezone : 'Asia/Kolkata',
  });

  // JOB 2: EMI check — every day at 09:00 AM (IST)
  cron.schedule('0 9 * * *', runEmiCheck, {
    scheduled: true,
    timezone : 'Asia/Kolkata',
  });

  // JOB 3: Hospital invoices — 1st of every month at 10:00 AM
  cron.schedule('0 10 1 * *', runMonthlyHospitalInvoices, {
    scheduled: true,
    timezone : 'Asia/Kolkata',
  });

  // JOB 4: Salary pre-calc — last day of every month at 11:00 PM
  // (cron runs on 28th to cover February too; then on 30th and 31st as well)
  cron.schedule('0 23 28-31 * *', async () => {
    // Only run on the actual last day of the month
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (now.getDate() === lastDay) {
      await runSalaryPreCalc();
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰  Cron jobs registered:');
  console.log('    📋 Compliance alerts      — daily 08:00 IST');
  console.log('    💳 EMI check              — daily 09:00 IST');
  console.log('    🏥 Hospital invoices      — 1st of month 10:00 IST');
  console.log('    💰 Salary pre-calculation — last day of month 23:00 IST');
};

// Export individual jobs for manual triggering from admin API
exports.runComplianceAlerts    = runComplianceAlerts;
exports.runEmiCheck            = runEmiCheck;
exports.runMonthlyHospitalInvoices = runMonthlyHospitalInvoices;
exports.runSalaryPreCalc       = runSalaryPreCalc;
