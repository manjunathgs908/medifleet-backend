const express = require('express');
const router = express.Router();
const { Expense, Income, Loan } = require('../models');
const { protect, authorize } = require('../middleware/auth');

router.get('/expenses', protect, authorize('owner'), async (req, res, next) => {
  try { const expenses = await Expense.find().sort({ date: -1 }); res.json({ success: true, expenses }); } catch(err) { next(err); }
});

router.post('/expenses', protect, authorize('owner'), async (req, res, next) => {
  try { const expense = await Expense.create({ ...req.body, recordedBy: req.user._id }); res.status(201).json({ success: true, expense }); } catch(err) { next(err); }
});

router.get('/income', protect, authorize('owner'), async (req, res, next) => {
  try { const income = await Income.find().sort({ date: -1 }); res.json({ success: true, income }); } catch(err) { next(err); }
});

router.post('/income', protect, authorize('owner'), async (req, res, next) => {
  try { const income = await Income.create({ ...req.body, recordedBy: req.user._id }); res.status(201).json({ success: true, income }); } catch(err) { next(err); }
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