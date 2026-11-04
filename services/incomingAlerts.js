'use strict';
/**
 * services/incomingAlerts.js
 * ============================================================
 * Everything the CRM's incoming alert rings for (full-screen ring + loud
 * tone in components/IncomingBookingAlert, background Web Push in
 * services/bookingPush.js), in one shape:
 *
 *   booking  — a customer booking (services/incomingBookings.js, unchanged)
 *   wa_lead  — a new WhatsAppLead: the customer asked the WhatsApp bot for
 *              a service with no automated booking (status 'new')
 *   wa_chat  — a WhatsApp conversation (one WhatsAppSession) the moment it
 *              first becomes MEANINGFUL: past the language pick AND a
 *              service chosen or booking details given — the step moved
 *              into one of MEANINGFUL_STEPS. Claimed once, in
 *              session.meaningfulAt, at that transition (whatsappFlow's
 *              saveSession). Never for a conversation still picking a
 *              language or a service.
 *
 * Each rings until an operator Opens or Dismisses it (crmAckAt, set once,
 * for everyone) or it leaves the INCOMING_WINDOW_MS window. A wa_chat
 * also stops when its conversation ends: the session is deleted when it
 * becomes a booking or a lead (each of which then rings on its own) and
 * TTL-expires 30 minutes after the customer's last message.
 *
 * Alert item: { key, type, id, at, title, service, stage?, phoneMasked,
 * phone (CRM owner only), customerRef?, link, ... } — link is where Open
 * goes: /dispatch?trip=<id>, /whatsapp-leads, or /whatsapp-conversations
 * opened on that customer.
 * ============================================================
 */
const mongoose = require('mongoose');
const WhatsAppLead = require('../models/WhatsAppLead');
const WhatsAppSession = require('../models/WhatsAppSession');
const catalog = require('./whatsappServiceCatalog');
const { maskPhone, customerRef } = require('../utils/customerPhone');
const { fullPhone } = require('../utils/phoneViewer');
const { INCOMING_WINDOW_MS, findIncoming } = require('./incomingBookings');

// Past language AND a service chosen (or further). AWAITING_SERVICE /
// AWAITING_SERVICE_MORE are past language but no service yet — not
// meaningful. Staff-facing stage text for the alert.
const MEANINGFUL_STEPS = {
  AWAITING_SUBTYPE      : 'Chose a service, picking the type',
  AWAITING_PICKUP       : 'Chose a service, sharing pickup next',
  AWAITING_PICKUP_CHOICE: 'Sharing pickup location',
  AWAITING_DROP         : 'Shared pickup, sharing drop next',
  AWAITING_DROP_CHOICE  : 'Sharing drop location',
  AWAITING_CONFIRM      : 'Saw the fare, deciding',
};
const isMeaningfulStep = (step) => Object.prototype.hasOwnProperty.call(MEANINGFUL_STEPS, step);

const since = (now = Date.now()) => new Date(now - INCOMING_WINDOW_MS);
const leadFilter = (now) => ({ status: 'new', crmAckAt: null, createdAt: { $gte: since(now) } });
const chatFilter = (now) => ({ crmAckAt: null, meaningfulAt: { $gte: since(now) } });

// English for staff, whatever language the customer chose. While picking
// a sub-type draftBooking.serviceType holds the parent service id; after,
// the bookable backend code.
function englishService(session) {
  const code = session.draftBooking?.serviceType;
  if (code) {
    const parent = catalog.getService(code);
    if (parent) return parent.label.en;
    for (const svc of catalog.getServiceList()) {
      if (svc.backendCode === code) return svc.label.en;
      const sub = (svc.subTypes || []).find((s) => s.backendCode === code);
      if (sub) return `${svc.label.en} / ${sub.label.en}`;
    }
  }
  return session.serviceLabel || code || 'WhatsApp';
}

const phoneFields = (raw) => {
  const ref = customerRef(raw);
  return { phoneMasked: maskPhone(raw), phone: fullPhone(raw), customerRef: ref };
};

function bookingAlert({ trip, via }) {
  const json = trip.toJSON();
  const id = String(trip._id);
  return {
    key: `booking:${id}`, type: 'booking', id, at: trip.createdAt,
    title: 'New booking',
    service: trip.selectedType || '',
    phoneMasked: json.patientPhoneMasked, phone: json.patientPhone,
    link: `/dispatch?trip=${id}`,
    incomingVia: via,
    trip: { ...json, incomingVia: via },
  };
}

function leadAlert(lead) {
  const id = String(lead._id);
  return {
    key: `wa_lead:${id}`, type: 'wa_lead', id, at: lead.createdAt,
    title: `New WhatsApp lead - ${lead.service}`,
    service: lead.service,
    stage: 'Asked for a service with no automated booking — call back',
    ...phoneFields(lead.phone),
    link: '/whatsapp-leads',
  };
}

function chatAlert(session) {
  const id = String(session._id);
  const service = englishService(session);
  const phone = phoneFields(session.phone);
  return {
    key: `wa_chat:${id}`, type: 'wa_chat', id, at: session.meaningfulAt,
    title: `WhatsApp enquiry - ${service}`,
    service,
    stage: MEANINGFUL_STEPS[session.step] || 'In conversation with the WhatsApp bot',
    language: session.language,
    ...phone,
    link: phone.customerRef
      ? `/whatsapp-conversations?customer=${encodeURIComponent(phone.customerRef)}`
      : '/whatsapp-conversations',
  };
}

// Everything ringing right now, oldest first. bookings is the raw
// findIncoming() result, for GET /incoming's unchanged `trips` list.
async function findAlerts({ limit = 20 } = {}) {
  const [bookings, leads, chats] = await Promise.all([
    findIncoming({ limit }),
    WhatsAppLead.find(leadFilter()).sort({ createdAt: 1 }).limit(limit),
    WhatsAppSession.find(chatFilter()).sort({ meaningfulAt: 1 }).limit(limit),
  ]);
  const alerts = [...bookings.map(bookingAlert), ...leads.map(leadAlert), ...chats.map(chatAlert)]
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  return { bookings, alerts };
}

// One lead / conversation, if it is ringing right now — or null.
async function incomingLead(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const lead = await WhatsAppLead.findOne({ _id: id, ...leadFilter() });
  return lead ? leadAlert(lead) : null;
}
async function incomingChat(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const session = await WhatsAppSession.findOne({ _id: id, ...chatFilter() });
  return session ? chatAlert(session) : null;
}

// The meaningful transition, from whatsappFlow's saveSession. True only
// for the one call that set meaningfulAt — every later step, message or
// concurrent save gets false, so it alerts once per conversation.
async function claimMeaningful(sessionId) {
  const result = await WhatsAppSession.updateOne(
    { _id: sessionId, meaningfulAt: null },
    { $set: { meaningfulAt: new Date() } },
  );
  return (result?.modifiedCount || 0) === 1;
}

// Open / Dismiss on the ring for a lead or conversation. First tap wins
// (conditional on crmAckAt still null); a later one is told who. A
// conversation that already ended (session gone) is reported, not 404'd —
// for the operator it simply stopped ringing.
const ACK_MODELS = { wa_lead: WhatsAppLead, wa_chat: WhatsAppSession };
const ACK_ACTIONS = ['accepted', 'dismissed'];
async function acknowledge(type, id, user, action) {
  const Model = ACK_MODELS[type];
  if (!Model) return { status: 400, body: { success: false, message: `type must be one of: ${Object.keys(ACK_MODELS).join(', ')}.` } };
  if (!ACK_ACTIONS.includes(action)) return { status: 400, body: { success: false, message: `action must be one of: ${ACK_ACTIONS.join(', ')}.` } };
  if (!mongoose.isValidObjectId(id)) return { status: 400, body: { success: false, message: 'Invalid id.' } };

  const at = new Date();
  const claimed = await Model.findOneAndUpdate(
    { _id: id, crmAckAt: null },
    { $set: { crmAckAt: at, crmAckBy: user._id, crmAckAction: action } },
    { new: true, projection: { _id: 1 } },
  );
  if (claimed) {
    return { status: 200, body: { success: true, acknowledged: true, ack: { at, by: { _id: user._id, name: user.name }, action } } };
  }
  const existing = await Model.findById(id).select('crmAckAt crmAckBy crmAckAction').populate('crmAckBy', 'name').lean();
  if (!existing) return { status: 200, body: { success: true, acknowledged: false, gone: true } };
  return {
    status: 200,
    body: { success: true, acknowledged: false, ack: { at: existing.crmAckAt, by: existing.crmAckBy || null, action: existing.crmAckAction } },
  };
}

module.exports = {
  MEANINGFUL_STEPS, isMeaningfulStep, leadFilter, chatFilter,
  findAlerts, incomingLead, incomingChat, claimMeaningful, acknowledge,
  bookingAlert, leadAlert, chatAlert,
};
