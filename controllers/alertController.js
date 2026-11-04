'use strict';
const incomingAlerts = require('../services/incomingAlerts');

// ============================================================
// @route   PUT /api/alerts/:type/:id/acknowledge
// @desc    Stop a WhatsApp lead (type wa_lead) or WhatsApp conversation
//          (type wa_chat) ringing — Open or Dismiss on the CRM's incoming
//          alert. Body { action: 'accepted' | 'dismissed' }. First tap
//          wins; a later one gets acknowledged:false and who did it; a
//          conversation that already ended gets acknowledged:false,
//          gone:true. Bookings keep PUT /api/trips/:id/acknowledge.
// @access  Private [owner, telecaller]
// ============================================================
exports.acknowledge = async (req, res, next) => {
  try {
    const { status, body } = await incomingAlerts.acknowledge(
      req.params.type, req.params.id, req.user, req.body?.action,
    );
    return res.status(status).json(body);
  } catch (err) {
    next(err);
  }
};
