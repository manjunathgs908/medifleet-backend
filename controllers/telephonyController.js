/**
 * controllers/telephonyController.js
 * ============================================================
 * Cloud Telephony Integration (Exotel / Tata Tele)
 *
 * Two key endpoints:
 *
 *  1. POST /api/telephony/inbound-webhook
 *     Called by Exotel when a call arrives at the business number.
 *     - Validates HMAC signature to reject spoofed requests.
 *     - Looks up the caller's phone in Leads + Trip history.
 *     - Returns a "popup payload" for the Telecaller's dashboard
 *       (name, last trip, last emergency type, open leads).
 *
 *  2. POST /api/telephony/call-status
 *     Called by Exotel when a call ends.
 *     - Logs the call to the Lead's callHistory.
 *
 * ============================================================
 *
 * controllers/leadController.js
 * ============================================================
 * Real-Time Lead Ads Integration:
 *
 *  Facebook Lead Ads:
 *   GET  /api/leads/fb/webhook  — Verification handshake (one-time setup)
 *   POST /api/leads/fb/webhook  — Receive new lead payload in real time
 *
 *  Google Lead Form Extensions:
 *   POST /api/leads/google/webhook — Receive new lead from Google Ads
 *
 *  CRM Lead management:
 *   GET  /api/leads            — All leads (newest first, filter by status)
 *   PUT  /api/leads/:id        — Update lead (status, notes, assign telecaller)
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { Lead, Trip, User, Notification } = require('../models');


// ════════════════════════════════════════════════════════════
//  TELEPHONY CONTROLLER
// ════════════════════════════════════════════════════════════

/**
 * verifyExotelSignature
 * Validates the HMAC-SHA1 signature that Exotel sends with every
 * webhook to confirm the payload is genuinely from Exotel.
 */
const verifyExotelSignature = (req) => {
  const receivedSig = req.headers['x-exotel-signature'] || '';
  const rawBody     = JSON.stringify(req.body);
  const computed    = crypto
    .createHmac('sha1', process.env.TELEPHONY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(receivedSig),
    Buffer.from(computed)
  );
};


// ============================================================
// @route   POST /api/telephony/inbound-webhook
// @desc    Inbound call received — look up caller, return popup
// @access  Public (secured by HMAC signature)
// ============================================================
exports.inboundCallWebhook = async (req, res, next) => {
  try {
    // ── 1. Validate Exotel signature ──────────────────────────
    // Skip in development to ease local testing
    if (process.env.NODE_ENV === 'production') {
      if (!verifyExotelSignature(req)) {
        return res.status(403).json({ success: false, message: 'Invalid webhook signature.' });
      }
    }

    // ── 2. Extract call data from Exotel payload ──────────────
    // Exotel sends: CallSid, From (caller), To (our number), CallType, etc.
    const {
      CallSid,
      From: callerPhone,
      To: ourNumber,
      CallType,
      CurrentTime,
    } = req.body;

    if (!callerPhone) {
      return res.status(400).json({ success: false, message: 'Caller phone not provided.' });
    }

    // Normalise Indian phone number (remove +91, country code, etc.)
    const normalised = callerPhone.replace(/^(\+91|91|0)/, '').replace(/\D/g, '');

    // ── 3. Customer History Lookup ────────────────────────────
    // Search leads, past trips to build caller context for popup
    const [existingLead, pastTrips] = await Promise.all([
      Lead.findOne({ phone: { $regex: normalised } })
        .sort({ createdAt: -1 })
        .populate('assignedTo', 'name')
        .lean(),
      Trip.find({ patientPhone: { $regex: normalised } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('dropHospital', 'name')
        .lean(),
    ]);

    // ── 4. Build popup payload for Telecaller UI ──────────────
    const popup = {
      callSid      : CallSid,
      callerPhone  : normalised,
      callType     : CallType,
      calledAt     : CurrentTime || new Date().toISOString(),

      // CRM context (null if first-time caller)
      isKnownCaller: !!existingLead || pastTrips.length > 0,
      patientName  : existingLead?.patientName || pastTrips[0]?.patientName || null,
      leadStatus   : existingLead?.status      || null,
      leadId       : existingLead?._id         || null,

      tripSummary  : pastTrips.map(t => ({
        tripNumber   : t.tripNumber,
        date         : t.createdAt,
        hospital     : t.dropHospital?.name,
        emergencyType: t.emergencyType,
        status       : t.status,
        fare         : t.grandTotal,
      })),

      // Suggestion for telecaller
      suggestedAction: existingLead
        ? `Follow-up on existing lead #${existingLead._id}`
        : pastTrips.length
          ? `Returning patient — ${pastTrips.length} past trip(s)`
          : 'New caller — create lead',
    };

    // ── 5. If no lead exists, create a 'new' lead auto ────────
    if (!existingLead && !pastTrips.length) {
      const newLead = await Lead.create({
        phone     : normalised,
        source    : 'inbound_call',
        status    : 'new',
        receivedAt: new Date(),
        callHistory: [{ callSid: CallSid, direction: 'inbound', status: 'ringing', calledAt: new Date() }],
      });
      popup.leadId = newLead._id;
      popup.suggestedAction = 'New lead auto-created from inbound call';
    } else if (existingLead) {
      // Append call to existing lead history
      await Lead.findByIdAndUpdate(existingLead._id, {
        $push: { callHistory: { callSid: CallSid, direction: 'inbound', status: 'ringing', calledAt: new Date() } },
      });
    }

    // ── 6. Push notification to all telecallers ───────────────
    // In production, this would emit via Socket.io room 'telecallers'
    await Notification.create({
      type      : 'trip_assigned',
      title     : `📞 Incoming Call — ${normalised}`,
      message   : popup.isKnownCaller ? `Known caller: ${popup.patientName}` : 'New caller — open popup',
      severity  : 'info',
      targetRole: 'telecaller',
    });

    // Respond with 200 so Exotel doesn't retry the webhook
    return res.json({ success: true, popup });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/telephony/call-status
// @desc    Call ended — log duration to lead record
// @access  Public (Exotel webhook)
// ============================================================
exports.callStatusWebhook = async (req, res, next) => {
  try {
    const { CallSid, From, CallDuration, Status } = req.body;
    const normalised = (From || '').replace(/^(\+91|91|0)/, '').replace(/\D/g, '');

    // Update call history entry for this CallSid
    await Lead.findOneAndUpdate(
      { phone: { $regex: normalised }, 'callHistory.callSid': CallSid },
      {
        $set: {
          'callHistory.$.duration': Number(CallDuration) || 0,
          'callHistory.$.status'  : Status || 'completed',
        },
      }
    );

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};


// ════════════════════════════════════════════════════════════
//  LEAD CONTROLLER (Facebook + Google Ads)
// ════════════════════════════════════════════════════════════

/**
 * extractFieldValue
 * Facebook sends lead data as an array of { name, values } pairs.
 * This helper finds the value for a given field name.
 */
const extractFieldValue = (fieldData, fieldName) => {
  if (!Array.isArray(fieldData)) return null;
  const field = fieldData.find(f => f.name.toLowerCase().includes(fieldName.toLowerCase()));
  return field?.values?.[0] || null;
};


// ============================================================
// @route   GET /api/leads/fb/webhook
// @desc    Facebook webhook verification handshake (one-time setup)
// @access  Public
// ============================================================
exports.facebookVerify = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    console.log('✅  Facebook webhook verified');
    return res.status(200).send(challenge); // FB requires plain text
  }
  return res.status(403).json({ success: false, message: 'Verification token mismatch.' });
};


// ============================================================
// @route   POST /api/leads/fb/webhook
// @desc    Receive real-time lead from Facebook Lead Ads
//          FB sends a JSON payload when user submits an Instant Form.
// @access  Public (secured by payload signature verification)
// ============================================================
exports.facebookLeadWebhook = async (req, res, next) => {
  try {
    // ── 1. Verify payload signature ───────────────────────────
    const signature = req.headers['x-hub-signature-256'] || '';
    const expected  = 'sha256=' + crypto
      .createHmac('sha256', process.env.FB_APP_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(403).json({ success: false, message: 'Invalid Facebook signature.' });
    }

    // ── 2. Respond immediately (FB requires sub-5s response) ──
    // Process asynchronously
    res.status(200).json({ success: true });

    // ── 3. Parse entries ──────────────────────────────────────
    const entries = req.body.entry || [];

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'leadgen') continue;

        const { leadgen_id, page_id, form_id } = change.value;

        // ── 4. Fetch full lead data from Graph API ─────────────
        // Facebook only sends the lead ID in the webhook; must fetch details
        let leadData;
        try {
          const { data } = await axios.get(
            `https://graph.facebook.com/v18.0/${leadgen_id}`,
            { params: { access_token: process.env.FB_PAGE_ACCESS_TOKEN } }
          );
          leadData = data;
        } catch (apiError) {
          console.error('[FB Lead API Error]', apiError.message);
          continue;
        }

        const fields      = leadData.field_data || [];
        const phone       = extractFieldValue(fields, 'phone');
        const name        = extractFieldValue(fields, 'name') || extractFieldValue(fields, 'full_name');
        const email       = extractFieldValue(fields, 'email');
        const message     = extractFieldValue(fields, 'message') || extractFieldValue(fields, 'comments');

        if (!phone) continue; // Phone is mandatory for ambulance leads

        // ── 5. Upsert lead — avoid duplicates by fbLeadId ──────
        const lead = await Lead.findOneAndUpdate(
          { fbLeadId: String(leadgen_id) },
          {
            $setOnInsert: {
              fbLeadId    : String(leadgen_id),
              source      : 'facebook_ad',
              patientName : name,
              phone       : phone.replace(/\D/g, '').replace(/^91/, ''),
              email,
              message,
              formName    : String(form_id),
              status      : 'new',
              receivedAt  : new Date(),
            },
          },
          { upsert: true, new: true }
        );

        // ── 6. Notify telecallers of new lead ──────────────────
        await Notification.create({
          type       : 'lead_received',
          title      : '📣 New Facebook Lead',
          message    : `${name || 'Unknown'} (${phone}) submitted a form.`,
          severity   : 'info',
          targetRole : 'telecaller',
        });

        console.log(`[FB Lead] Received: ${lead._id} — ${name} — ${phone}`);
      }
    }
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/leads/google/webhook
// @desc    Receive real-time lead from Google Lead Form Extensions
//          Google sends a JSON payload to a registered webhook URL.
// @access  Public (secured by Google-supplied secret key header)
// ============================================================
exports.googleLeadWebhook = async (req, res, next) => {
  try {
    // ── 1. Verify Google's secret key ────────────────────────
    // Google sends the key as a query param: ?key=YOUR_SECRET
    if (req.query.key !== process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      return res.status(403).json({ success: false, message: 'Invalid Google webhook key.' });
    }

    // ── 2. Parse Google lead payload ─────────────────────────
    // Google Lead Form Extension payload structure:
    const {
      google_key,
      lead_id,
      user_column_data, // Array of { column_name, string_value }
      campaign_id,
      campaign_name,
      adgroup_id,
      creative_id,
    } = req.body;

    // ── 3. Extract fields ─────────────────────────────────────
    const getField = (name) => {
      const field = (user_column_data || []).find(f => f.column_name === name);
      return field?.string_value || null;
    };

    const phone   = getField('PHONE_NUMBER');
    const name    = getField('FULL_NAME');
    const email   = getField('EMAIL');
    const message = getField('COMMENTS') || getField('DESCRIBE_YOUR_CONCERN');

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number not provided in lead.' });
    }

    const normalised = phone.replace(/\D/g, '').replace(/^91/, '');

    // ── 4. Upsert lead ────────────────────────────────────────
    const lead = await Lead.findOneAndUpdate(
      { googleLeadId: String(lead_id) },
      {
        $setOnInsert: {
          googleLeadId: String(lead_id),
          source      : 'google_ad',
          patientName : name,
          phone       : normalised,
          email,
          message,
          adName      : campaign_name,
          status      : 'new',
          receivedAt  : new Date(),
        },
      },
      { upsert: true, new: true }
    );

    // ── 5. Notify telecallers ─────────────────────────────────
    await Notification.create({
      type      : 'lead_received',
      title     : '🎯 New Google Lead',
      message   : `${name || 'Unknown'} (${normalised}) from campaign: ${campaign_name}`,
      severity  : 'info',
      targetRole: 'telecaller',
    });

    console.log(`[Google Lead] Received: ${lead._id} — ${name} — ${normalised}`);
    return res.status(200).json({ success: true, leadId: lead._id });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/leads
// @desc    Get all CRM leads (newest first, filterable)
// @access  Private [owner, telecaller]
// ============================================================
exports.getLeads = async (req, res, next) => {
  try {
    const { status, source, assignedTo, from, to, page = 1, limit = 30 } = req.query;
    const filter = {};

    if (status)     filter.status     = status;
    if (source)     filter.source     = source;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (from || to) {
      filter.receivedAt = {};
      if (from) filter.receivedAt.$gte = new Date(from);
      if (to)   filter.receivedAt.$lte = new Date(to);
    }

    // Telecallers see their own assigned leads + unassigned leads
    if (req.user.role === 'telecaller') {
      filter.$or = [
        { assignedTo: req.user._id },
        { assignedTo: { $exists: false } },
      ];
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Lead.countDocuments(filter);
    const leads = await Lead.find(filter)
      .populate('assignedTo',    'name phone')
      .populate('convertedTrip', 'tripNumber status')
      .sort({ receivedAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.json({ success: true, total, leads });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/leads/:id
// @desc    Update lead status, assign to telecaller, add notes
// @access  Private [owner, telecaller]
// ============================================================
exports.updateLead = async (req, res, next) => {
  try {
    const { status, assignedTo, notes } = req.body;
    const update = {};
    if (status)     update.status     = status;
    if (assignedTo) update.assignedTo = assignedTo;
    if (notes)      update.notes      = notes;

    const lead = await Lead.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    return res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
};
