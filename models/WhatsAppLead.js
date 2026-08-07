'use strict';
const mongoose = require('mongoose');

// A WhatsApp conversation that asked for a service with no working
// backendCode (see whatsappServiceCatalog.js's bookable flag) or hit a
// pricing failure -- there's nowhere for that customer to go except a
// manual follow-up call, so it's recorded here instead of just a
// console.log. Deliberately separate from the existing Lead model
// (models/index.js) -- that one is ads-specific (fbLeadId/googleLeadId/
// adName/formName/callHistory, assignedTo as a CRM sales-rep queue) and
// none of that fits a WhatsApp booking abandonment.
const WhatsAppLeadSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },

    // English label of whatever service/sub-type the customer asked for
    // (e.g. "Air Ambulance", "Emergency Ambulance / BLS (Tempo)") --
    // always English regardless of the customer's chosen language, so the
    // CRM lead list reads consistently for staff.
    service: { type: String, required: true },

    // Always 'whatsapp' in practice (this model only exists for WhatsApp
    // leads) -- kept as an explicit field rather than implied by the
    // model name, in case another inbound-message channel needs the same
    // shape later.
    source: { type: String, default: 'whatsapp' },

    status: { type: String, enum: ['new', 'contacted', 'closed'], default: 'new', index: true },
    notes : { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WhatsAppLead', WhatsAppLeadSchema);
