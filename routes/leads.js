const express = require('express');
const router = express.Router();
const { Lead } = require('../models');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');

// The CRM Leads Dashboard filters by status (?status=new|contacted|
// converted|lost|spam). Without ?status every lead comes back, as before.
const LEAD_STATUSES = Lead.schema.path('status').enumValues;

router.get('/', protect, authorize(...OPERATIONS), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status !== undefined && req.query.status !== '' && req.query.status !== 'all') {
      const status = String(req.query.status);
      if (!LEAD_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Unknown lead status "${status}".` });
      }
      filter.status = status;
    }
    const leads = await Lead.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, leads });
  } catch (err) { next(err); }
});

router.put('/:id', protect, authorize(...OPERATIONS), async (req, res, next) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, lead });
  } catch (err) { next(err); }
});

module.exports = router;
