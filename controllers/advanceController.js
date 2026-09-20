'use strict';
const { Advance } = require('../models');
const { isPlatformDriver, platformDriverIds } = require('../utils/platformOwner');

// Driver — Request advance
exports.requestAdvance = async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || !reason) return res.status(400).json({ success: false, message: 'Amount & reason required' });

    // An advance is money against a future SaveLife payslip. A partner's
    // driver has no such payslip, so there is nothing to advance against and
    // no payroll run that would ever recover it.
    if (!await isPlatformDriver(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Salary advances are available to SaveLife drivers only. Please ask your fleet owner.',
      });
    }

    const advance = await Advance.create({ driver: req.user._id, amount, reason });
    return res.status(201).json({ success: true, advance });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Driver — My advances
exports.myAdvances = async (req, res) => {
  try {
    const advances = await Advance.find({ driver: req.user._id }).sort({ createdAt: -1 });
    return res.json({ success: true, advances });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Owner — All advances
exports.getAllAdvances = async (req, res) => {
  try {
    // Historical rows may predate the platform-driver rule — filter rather
    // than trust the table.
    const ourDriverIds = await platformDriverIds();
    const advances = await Advance.find({ driver: { $in: ourDriverIds } })
      .populate('driver', 'name phone').sort({ createdAt: -1 });
    return res.json({ success: true, advances });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Owner — Approve
exports.approveAdvance = async (req, res) => {
  try {
    const advance = await Advance.findByIdAndUpdate(req.params.id,
      { status: 'approved', approvedBy: req.user._id, approvedAt: new Date() },
      { new: true }
    );
    return res.json({ success: true, advance });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// Owner — Reject
exports.rejectAdvance = async (req, res) => {
  try {
    const { reason } = req.body;
    const advance = await Advance.findByIdAndUpdate(req.params.id,
      { status: 'rejected', rejectedReason: reason },
      { new: true }
    );
    return res.json({ success: true, advance });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};