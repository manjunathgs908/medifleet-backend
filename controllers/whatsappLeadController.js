'use strict';
const WhatsAppLead = require('../models/WhatsAppLead');

// Owner-facing query -- same filter shape as geofenceEventController.
// @route   GET /api/whatsapp-leads?status=new
exports.getLeads = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const leads = await WhatsAppLead.find(filter).sort({ createdAt: -1 }).limit(500);
    return res.json({ success: true, leads });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// @route   PATCH /api/whatsapp-leads/:id/status
// @desc    Move a lead through new -> contacted -> closed. Body: { status }.
exports.updateLeadStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const VALID_STATUSES = ['new', 'contacted', 'closed'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const lead = await WhatsAppLead.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    return res.json({ success: true, lead });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
