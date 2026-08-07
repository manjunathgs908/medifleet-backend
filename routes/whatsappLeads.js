/**
 * routes/whatsappLeads.js
 * ============================================================
 * CRM read/update access to WhatsApp lead-capture records — mounted at
 * /api/whatsapp-leads, additive. Separate from /api/whatsapp (the
 * inbound webhook, public/signature-authenticated) and from /api/leads
 * (the ads-specific Lead model) -- see models/WhatsAppLead.js.
 * ============================================================
 */
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/whatsappLeadController');
const { protect, authorize } = require('../middleware/auth');

// Private [owner] — same CRM-only access as /api/leads and /api/geofence-events.
router.get  ('/',               protect, authorize('owner'), ctrl.getLeads);
router.patch('/:id/status',     protect, authorize('owner'), ctrl.updateLeadStatus);

module.exports = router;
