/**
 * controllers/quoteController.js
 * ============================================================
 * "Quote & Confirm" booking links.
 *
 *   CRM (owner):  create a quote + send its link on WhatsApp, list quotes.
 *   Public:       the customer's page, keyed only by the quote's random
 *                 token -- read it, price it, confirm it.
 *
 * No pricing or trip logic lives here. Prices come from
 * tripController.quoteTrip (the same function POST /api/trips/estimate
 * runs) and a confirmed quote is booked through
 * tripController.createBookedTrip (the same function POST /api/trips runs),
 * so a quoted trip is indistinguishable from any other booking.
 *
 * The public endpoints only ever touch the one quote the token names, and
 * only ever return the fields that customer already gave or was given.
 * ============================================================
 */
'use strict';

const Quote = require('../models/Quote');
const { Trip } = require('../models');
const { quoteTrip, createBookedTrip } = require('./tripController');
const fareCalculator = require('../utils/fareCalculator');
const { normalisePhone } = require('../utils/phone');
const whatsappNotifications = require('../services/whatsappNotifications');
const { resolveTrackingUrl } = require('../services/trackingNotifications');

// Served by the CRM frontend's public /q/:token route (no login).
const QUOTE_URL_BASE = `${process.env.PUBLIC_QUOTE_BASE_URL || 'https://crm.savelife.health'}/q`;

const quoteUrl = (quote) => `${QUOTE_URL_BASE}/${quote.token}`;

// 16 random bytes in base64url -- see Quote.token. Checked before any
// lookup so a malformed path never reaches the database.
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

// fareCalculator.findPricingDoc builds a regex from this value, so on the
// public side it must be a plain service id and nothing else -- '.*' would
// otherwise match whichever Pricing doc came first.
const SERVICE_ID_RE = /^[A-Za-z0-9_]{1,40}$/;

const MAX_ADDRESS = 300;
const MAX_NAME    = 80;
const RECENT_DAYS = 7;

// A place is only usable with an address AND real coordinates -- an
// address string alone can be neither routed nor priced.
function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const address = typeof p.address === 'string' ? p.address.trim().slice(0, MAX_ADDRESS) : '';
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!address || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { address, lat, lng };
}

function cleanName(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
}

function cleanServiceId(v) {
  if (typeof v !== 'string') return '';
  const id = v.trim();
  return SERVICE_ID_RE.test(id) ? id : '';
}

// What the operator set when creating the quote is fixed: the customer's
// page shows it read-only, and these resolve it from the stored quote
// rather than from the request, so a hand-made request cannot change it
// either. The service and its AC choice lock together — the operator chose
// AC for that service. Pickup is never locked: it is the customer's own
// location. Only meaningful before confirm; confirm overwrites these fields
// with what was booked.
const lockedDrop    = (quote) => cleanPlace(quote.drop);
const lockedService = (quote) => cleanServiceId(quote.selectedType);

function resolveChoices(quote, body) {
  const drop    = lockedDrop(quote);
  const service = lockedService(quote);
  return {
    drop        : drop || cleanPlace(body.drop),
    selectedType: service || cleanServiceId(body.selectedType),
    acEnabled   : service ? !!quote.acEnabled : !!body.acEnabled,
  };
}

const isExpired = (quote) => !!quote.expiresAt && quote.expiresAt.getTime() <= Date.now();

// 'confirming' is an internal claim, not something the operator acts on.
const displayStatus = (quote) => (quote.status === 'confirming' ? 'viewed' : quote.status);

function crmView(quote) {
  const trip = quote.trip && typeof quote.trip === 'object' ? quote.trip : null;
  return {
    _id         : quote._id,
    url         : quoteUrl(quote),
    phone       : quote.phone,
    patientName : quote.patientName || null,
    pickup      : quote.pickup || null,
    drop        : quote.drop || null,
    selectedType: quote.selectedType || null,
    acEnabled   : !!quote.acEnabled,
    status      : displayStatus(quote),
    expired     : quote.status !== 'confirmed' && isExpired(quote),
    sentAt      : quote.sentAt,
    viewedAt    : quote.viewedAt || null,
    confirmedAt : quote.confirmedAt || null,
    expiresAt   : quote.expiresAt,
    whatsappSent : !!quote.whatsappSent,
    whatsappError: quote.whatsappError || null,
    trip: trip ? {
      _id          : trip._id,
      tripNumber   : trip.tripNumber,
      status       : trip.status,
      estimatedFare: trip.estimatedFare,
    } : null,
  };
}

// The phone is the customer's own, but the link can be forwarded -- show
// only enough to recognise it.
const maskPhone = (phone) => (phone ? `••••••${String(phone).slice(-4)}` : null);

function publicView(quote, extra = {}) {
  return {
    patientName : quote.patientName || '',
    phoneMasked : maskPhone(quote.phone),
    pickup      : quote.pickup || null,
    drop        : quote.drop || null,
    selectedType: quote.selectedType || '',
    acEnabled   : !!quote.acEnabled,
    status      : quote.status === 'confirmed' ? 'confirmed' : 'open',
    expired     : quote.status !== 'confirmed' && isExpired(quote),
    expiresAt   : quote.expiresAt,
    // Which fields the page must show read-only (see resolveChoices).
    locked      : quote.status === 'confirmed'
      ? { drop: true, service: true }
      : { drop: !!lockedDrop(quote), service: !!lockedService(quote) },
    supportPhone: supportPhone(),
    ...extra,
  };
}

// The confirmed page shows the booking number and the customer's own
// tracking link -- both already theirs, and sent to them once a driver is
// assigned anyway.
async function confirmedExtras(quote) {
  if (quote.status !== 'confirmed' || !quote.trip) return {};
  const tripId = quote.trip._id || quote.trip;
  const trip = await Trip.findById(tripId).select('tripNumber').lean();
  return {
    tripNumber : trip?.tripNumber || null,
    trackingUrl: await resolveTrackingUrl(tripId),
  };
}

async function findByToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return Quote.findOne({ token });
}

// The same helpline the WhatsApp bot quotes (services/whatsappFlow.js), so
// a customer whose link no longer works has somewhere to turn.
const supportPhone = () => process.env.SUPPORT_PHONE || null;

const notFound = (res) =>
  res.status(404).json({ success: false, message: 'This booking link is not valid.', supportPhone: supportPhone() });

const expiredResponse = (res) =>
  res.status(410).json({ success: false, message: 'This booking link has expired.', supportPhone: supportPhone() });


// ============================================================
// @route   POST /api/quotes
// @desc    Create a quote and send its link to the customer on WhatsApp.
//          Only the phone is required; every other field is optional and
//          the customer fills in what is missing.
// @access  Private [owner]
// ============================================================
exports.createQuote = async (req, res, next) => {
  try {
    const phone = normalisePhone(req.body.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    const selectedType = cleanServiceId(req.body.selectedType);
    if (req.body.selectedType && !selectedType) {
      return res.status(400).json({ success: false, message: 'Unknown service type.' });
    }
    if (selectedType && !(await fareCalculator.findPricingDoc(selectedType))) {
      return res.status(400).json({ success: false, message: `No active pricing found for "${selectedType}".` });
    }

    const quote = await Quote.create({
      phone,
      patientName : cleanName(req.body.patientName) || undefined,
      pickup      : cleanPlace(req.body.pickup) || undefined,
      drop        : cleanPlace(req.body.drop) || undefined,
      selectedType: selectedType || undefined,
      acEnabled   : !!req.body.acEnabled,
      createdBy   : req.user?._id,
    });

    // Never throws for a Meta-side failure (see whatsappService.sendMessage);
    // the try/catch is for anything unexpected around it. Either way the
    // quote stands and the operator gets the link to share by hand.
    let sendResult;
    try {
      sendResult = await whatsappNotifications.notifyQuoteLink(phone, quoteUrl(quote));
    } catch (err) {
      sendResult = { skipped: true, reason: err.message };
    }

    quote.whatsappSent  = !sendResult?.skipped;
    quote.whatsappError = sendResult?.skipped ? sendResult.reason : undefined;
    await quote.save();

    return res.status(201).json({ success: true, quote: crmView(quote) });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/quotes
// @desc    Recent quotes (last 7 days), newest first, for the dispatch
//          board's Sent / Viewed / Confirmed list.
// @access  Private [owner]
// ============================================================
exports.listQuotes = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const quotes = await Quote.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('trip', 'tripNumber status estimatedFare');

    return res.json({ success: true, quotes: quotes.map(crmView) });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/quotes/public/:token
// @desc    The customer's quote. The first open marks it Viewed.
// @access  Public (token)
// ============================================================
exports.getPublicQuote = async (req, res, next) => {
  try {
    let quote = await findByToken(req.params.token);
    if (!quote) return notFound(res);

    // Conditional on 'sent' so viewedAt is the FIRST open and a later
    // open can never move a confirmed quote backwards.
    if (quote.status === 'sent' && !isExpired(quote)) {
      quote = await Quote.findOneAndUpdate(
        { _id: quote._id, status: 'sent' },
        { $set: { status: 'viewed', viewedAt: new Date() } },
        { new: true },
      ) || quote;
    }

    return res.json({ success: true, quote: publicView(quote, await confirmedExtras(quote)) });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/quotes/public/:token/estimate
// @desc    Price the customer's current choices. tripController.quoteTrip,
//          so this is the same number the CRM's estimate and the booking
//          itself produce. Only for an open, unexpired quote.
// @access  Public (token)
// ============================================================
exports.estimatePublicQuote = async (req, res, next) => {
  try {
    const quote = await findByToken(req.params.token);
    if (!quote) return notFound(res);
    if (quote.status === 'confirmed') {
      return res.status(409).json({ success: false, message: 'This booking is already confirmed.' });
    }
    if (isExpired(quote)) return expiredResponse(res);

    const pickup = cleanPlace(req.body.pickup);
    const { drop, selectedType, acEnabled } = resolveChoices(quote, req.body);
    if (!pickup || !drop) {
      return res.status(400).json({ success: false, message: 'Choose both a pickup and a drop location.' });
    }

    const result = await quoteTrip({
      pickupLat: pickup.lat, pickupLng: pickup.lng,
      dropLat  : drop.lat,   dropLng  : drop.lng,
      selectedType: selectedType || undefined,
      tripType : 'one_way',
      acEnabled,
    });
    if (!result) {
      return res.status(422).json({
        success: false,
        message: 'Could not find a route between these locations. Please check both addresses.',
      });
    }

    return res.json({
      success    : true,
      distanceKm : result.distanceKm,
      durationSec: result.durationSec,
      fare       : result.fare ? { grandTotal: result.fare.grandTotal } : null,
      fareError  : result.fareError ? 'Price is not available for this service right now.' : undefined,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/quotes/public/:token/confirm
// @desc    Book the trip. The quote is claimed atomically first, so two
//          taps (or two tabs) can never create two trips; the claim is
//          released again if booking fails, so the customer can retry.
// @access  Public (token)
// ============================================================
exports.confirmPublicQuote = async (req, res, next) => {
  try {
    const existing = await findByToken(req.params.token);
    if (!existing) return notFound(res);

    // A repeat confirm after success answers with the booking rather than
    // an error: the customer's first response may simply have been lost.
    if (existing.status === 'confirmed') {
      return res.json({ success: true, quote: publicView(existing, await confirmedExtras(existing)) });
    }
    if (isExpired(existing)) return expiredResponse(res);

    const patientName  = cleanName(req.body.patientName) || existing.patientName || '';
    const pickup       = cleanPlace(req.body.pickup);
    const { drop, selectedType, acEnabled } = resolveChoices(existing, req.body);

    if (!patientName)   return res.status(400).json({ success: false, message: 'Enter the patient name.' });
    if (!pickup)        return res.status(400).json({ success: false, message: 'Set the pickup location.' });
    if (!drop)          return res.status(400).json({ success: false, message: 'Set the drop location.' });
    if (!selectedType)  return res.status(400).json({ success: false, message: 'Choose a service.' });

    const claimed = await Quote.findOneAndUpdate(
      { _id: existing._id, status: { $in: ['sent', 'viewed'] }, expiresAt: { $gt: new Date() } },
      { $set: { status: 'confirming' } },
      { new: true },
    );
    if (!claimed) {
      const now = await Quote.findById(existing._id);
      if (now?.status === 'confirmed') {
        return res.json({ success: true, quote: publicView(now, await confirmedExtras(now)) });
      }
      return res.status(409).json({ success: false, message: 'This booking is already being confirmed. Please wait a moment.' });
    }

    const release = () => Quote.updateOne(
      { _id: claimed._id, status: 'confirming' },
      { $set: { status: 'viewed', viewedAt: claimed.viewedAt || new Date() } },
    );

    let trip;
    try {
      // Price it first. createBookedTrip re-verifies the route itself, but
      // if Google failed there it would fall back to a client distance --
      // and there is no client distance on this path. Passing the figure
      // just computed server-side keeps that fallback honest, and a quote
      // that cannot be routed at all is refused instead of booked at 0 km.
      const priced = await quoteTrip({
        pickupLat: pickup.lat, pickupLng: pickup.lng,
        dropLat  : drop.lat,   dropLng  : drop.lng,
        selectedType, tripType: 'one_way', acEnabled,
      });
      if (!priced) {
        await release();
        return res.status(422).json({
          success: false,
          message: 'Could not find a route between these locations. Please check both addresses.',
        });
      }
      if (!priced.fare) {
        await release();
        return res.status(400).json({ success: false, message: 'Price is not available for this service right now.' });
      }

      trip = await createBookedTrip({
        patientName,
        patientPhone : claimed.phone,
        emergencyType: 'general',
        pickupLabel  : pickup.address, pickupLat: pickup.lat, pickupLng: pickup.lng,
        dropLabel    : drop.address,   dropLat  : drop.lat,   dropLng  : drop.lng,
        dist         : priced.oneWayKm,
        effectiveDist: priced.distanceKm,
        selectedType,
        tripType     : 'one_way',
        acEnabled,
        scheduleType : 'now',
      }, { bookedBy: claimed.createdBy, bookingSource: 'crm' });
    } catch (err) {
      await release();
      if (err.isFareError) return res.status(400).json({ success: false, message: 'Price is not available for this service right now.' });
      throw err;
    }

    const confirmed = await Quote.findOneAndUpdate(
      { _id: claimed._id },
      {
        $set: {
          status: 'confirmed', confirmedAt: new Date(), trip: trip._id,
          // What the customer actually booked, for the CRM record.
          patientName, pickup, drop, selectedType, acEnabled,
        },
      },
      { new: true },
    );

    return res.status(201).json({
      success: true,
      quote  : publicView(confirmed, {
        tripNumber : trip.tripNumber,
        trackingUrl: await resolveTrackingUrl(trip._id),
      }),
    });
  } catch (err) {
    next(err);
  }
};
