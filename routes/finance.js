const express = require('express');
const router = express.Router();
const { Expense, Income, Loan } = require('../models');
const { protect, authorize } = require('../middleware/auth');
const { parseAmount } = require('../utils/money');

router.get('/expenses', protect, authorize('owner'), async (req, res, next) => {
  try { const expenses = await Expense.find().sort({ date: -1 }); res.json({ success: true, expenses }); } catch(err) { next(err); }
});

router.post('/expenses', protect, authorize('owner'), async (req, res, next) => {
  try { const expense = await Expense.create({ ...req.body, recordedBy: req.user._id }); res.status(201).json({ success: true, expense }); } catch(err) { next(err); }
});

router.get('/income', protect, authorize('owner'), async (req, res, next) => {
  try { const income = await Income.find().sort({ date: -1 }); res.json({ success: true, income }); } catch(err) { next(err); }
});

// Manual income: donation / grant / misc only. trip_fare is written when a
// trip completes and hospital_credit by the system — entering either by hand
// would count the same revenue twice. Only these fields are accepted.
const MANUAL_INCOME = ['donation', 'grant', 'misc'];
router.post('/income', protect, authorize('owner'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!MANUAL_INCOME.includes(b.category)) {
      return res.status(400).json({ success: false, message: 'Income can be entered for donation, grant or misc only — trip fares and hospital credit are recorded automatically.' });
    }
    const paise = parseAmount(b.amount);
    if (!paise) return res.status(400).json({ success: false, message: 'Enter an amount in rupees (up to 2 decimals, above ₹0).' });
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (description.length > 200) return res.status(400).json({ success: false, message: 'Keep the description under 200 characters.' });
    let date = new Date();
    if (b.date !== undefined && b.date !== '') {
      // A plain date ("2026-11-01") is that day in India.
      date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? new Date(`${b.date}T00:00:00+05:30`) : new Date(NaN);
      if (Number.isNaN(date.getTime())) return res.status(400).json({ success: false, message: 'Give the date as YYYY-MM-DD.' });
      if (date.getTime() > Date.now() + 864e5) return res.status(400).json({ success: false, message: 'The date is in the future.' });
    }
    const income = await Income.create({ category: b.category, amount: paise / 100, description: description || undefined, date, recordedBy: req.user._id });
    res.status(201).json({ success: true, income });
  } catch(err) { next(err); }
});

router.get('/loans', protect, authorize('owner'), async (req, res, next) => {
  try { const loans = await Loan.find(); res.json({ success: true, loans }); } catch(err) { next(err); }
});

router.post('/loans', protect, authorize('owner'), async (req, res, next) => {
  try { const loan = await Loan.create(req.body); res.status(201).json({ success: true, loan }); } catch(err) { next(err); }
});

// Billed vs collected for the India calendar month (?month=YYYY-MM, default
// this month) — the same figures as the Dashboard and Billing
// (services/payments.js). The income/expense/profit fields are still
// placeholders, as before.
router.get('/summary', protect, authorize('owner'), async (req, res, next) => {
  try {
    const { istMonth, collectionTotals } = require('../services/payments');
    let at = new Date();
    if (req.query.month !== undefined) {
      const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month));
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return res.status(400).json({ success: false, message: 'month must be YYYY-MM.' });
      at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
    }
    const { start, end } = istMonth(at);
    const collections = await collectionTotals({ from: start, to: end });
    res.json({ success: true, summary: { totalIncome: 0, totalExpense: 0, netProfit: 0, collections } });
  } catch(err) { next(err); }
});

module.exports = router;