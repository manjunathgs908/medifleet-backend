/**
 * controllers/tripController.js
 * ============================================================
 * Handles the complete trip lifecycle:
 *   - Create booking (Owner)
 *   - Auto / manual ambulance assignment (Owner)
 *   - Driver accept / decline with timeout fallback
 *   - Status transitions (en_route → completed → bill generation)
 *   - Trip cancellation
 *   - Fare engine: Base + (KM × Rate) + GST
 *   - Auto income ledger entry on completion
 * ============================================================
 */

'use strict';

const { Trip, Vehicle, User, Bill, Income, Notification, Hospital, Lead, ChatMessage, computeSegmentAmount } = require('../models');
const Ambulance = require('../models/Ambulance');
const { computeAmbulanceDisplayStatus } = require('./ambulanceController');
const { sendPush } = require('../utils/pushService');
const { sendFullScreenTrip } = require('../utils/fcmService');
const TripCallEvent = require('../models/TripCallEvent');
const BookingOtp = require('../models/BookingOtp');
const fareCalculator = require('../utils/fareCalculator');
const smsService = require('../utils/smsService');
const { haversineKm } = require('../utils/haversine');
const axios = require('axios');
const whatsappNotifications = require('../services/whatsappNotifications');
const trackingNotifications = require('../services/trackingNotifications');

const GOOGLE_DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Independently resolves the route server-side via Google Directions, using
// the trip's own coordinates — never trusts the client-submitted
// dist/effectiveDist for billing (a client bug, like the website's old
// silent Haversine fallback, or outright tampering, could otherwise
// underprice a trip). Returns null if coordinates are incomplete or the
// Google call fails, so the caller can fall back safely rather than
// hard-blocking every booking on a Google outage. Same GOOGLE_MAPS_API_KEY
// env var placesController.js already uses for /api/places/directions.
//
// One call, three consumers: the billing distance (via verifyRoadDistanceKm
// below), and the duration + overview polyline the dispatch map draws — so
// quoting a trip and drawing its route cost one Directions request, not two.
async function verifyRoute(originLat, originLng, destLat, destLng) {
  if (![originLat, originLng, destLat, destLng].every(Number.isFinite)) return null;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const { data } = await axios.get(GOOGLE_DIRECTIONS_URL, {
      params : { origin: `${originLat},${originLng}`, destination: `${destLat},${destLng}`, key: apiKey },
      timeout: 5000,
    });
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) return null;
    return {
      distanceKm : leg.distance.value / 1000,
      durationSec: leg.duration?.value ?? null,
      polyline   : data.routes[0].overview_polyline?.points || null,
    };
  } catch {
    return null;
  }
}
exports.verifyRoute = verifyRoute;

async function verifyRoadDistanceKm(originLat, originLng, destLat, destLng) {
  const route = await verifyRoute(originLat, originLng, destLat, destLng);
  return route ? route.distanceKm : null;
}
exports.verifyRoadDistanceKm = verifyRoadDistanceKm; // reused by whatsappFlow.js for the same Google-Directions-verified billing distance

// ── Phase 6 light bridge: best-effort Vehicle -> Ambulance match by
// registrationNumber. Both schemas already normalize to uppercase+trim
// on save, so an exact match covers the common case cheaply; the
// fallback strips all non-alphanumeric characters before comparing, to
// catch the same physical plate entered differently in the two systems
// (e.g. "KA01AB1234" in the CRM vs "KA-01-AB-1234" in Add Ambulance).
// Never throws, never returns anything but a doc or null — a miss must
// not block dispatch.
const normalizePlate = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function findMatchingAmbulance(registrationNumber) {
  try {
    const exact = await Ambulance.findOne({ registrationNumber });
    if (exact) return exact;

    const target = normalizePlate(registrationNumber);
    if (!target) return null;
    const candidates = await Ambulance.find({}, 'registrationNumber');
    const fuzzy = candidates.find(a => normalizePlate(a.registrationNumber) === target);
    return fuzzy || null;
  } catch (err) {
    return null;
  }
}

// GST is ZERO on every fare this controller computes. That is an
// exemption, not an oversight, and not a value waiting to be filled in.
// Please do not "restore" it to 5.
//
// Patient ambulance transport is SAC 999315, exempt under Notification
// 12/2017-Central Tax (Rate). Dead body transport is SAC 999732 and
// carries no GST. Between them those two cover all seven bookable
// service types, so there is no service reachable from this controller
// whose fare is taxable.
//
// The rate is zero; the machinery deliberately is not. gstRate is still
// passed to fareCalculator, gstAmount/grandTotal are still written, and
// Bill.gstRate is still required. Corporate monthly ambulance rental
// (SAC 9993) IS taxable at 18% and needs all of it. Zero here is the
// rate for these booking flows, not a statement that GST does not apply
// to the business.
const GST_RATE = 0;


// ============================================================
// @route   POST /api/trips/send-otp
// @desc    Phone verification for the website booking form — real MSG91
//          SMS for every number, with no allowlist and no bypass. Not gated
//          on any account: a website visitor isn't a User/Owner.
// @access  Public
// ============================================================
exports.sendBookingOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit, website booking OTP only

    await BookingOtp.findOneAndUpdate(
      { phone },
      { otp, otpExpiry },
      { upsert: true, new: true }
    );

    const smsResult = await smsService.sendOtp(phone, otp);
    console.log('[sendBookingOtp] MSG91 response for', phone, ':', JSON.stringify(smsResult));

    // MSG91 can return HTTP 200 with a payload-level failure (bad/missing
    // authkey, unapproved template, etc.) — axios won't throw on that, so
    // without this check a broken credential would silently report
    // "OTP sent" while no SMS ever went out. Echoing the raw MSG91 response
    // back (msg91: smsResult) is a temporary debugging aid while confirming
    // real delivery — safe to strip later, it holds no secrets.
    if (smsResult?.type === 'error') {
      return res.status(502).json({
        success: false,
        message: smsResult.message || 'Could not send OTP right now. Please try again.',
        msg91: smsResult,
      });
    }

    // In development, return OTP in response for testing — same dev-echo
    // convention as driver/owner login OTP (length differs: 4 digits here
    // to match the website's MSG91 widget setting, 6 for app login).
    const devPayload = process.env.NODE_ENV === 'development' ? { otp } : {};

    return res.json({ success: true, message: `OTP sent to ${phone}.`, msg91: smsResult, ...devPayload });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/trips/verify-otp
// @desc    Verify the website booking form's phone OTP. One-time use —
//          deleted on success. Does NOT issue a token or mark anything
//          for POST /api/trips to check; the website itself only calls
//          the booking endpoint from this call's success callback,
//          exactly like the widget flow it replaces. Keeps this
//          decoupled from CRM and customer-app bookings,
//          neither of which go through phone verification.
// @access  Public
// ============================================================
exports.verifyBookingOtp = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });

    const record = await BookingOtp.findOne({ phone });
    if (!record || !record.isOtpValid(otp)) {
      return res.status(400).json({ success: false, message: 'OTP is invalid or has expired.' });
    }

    await BookingOtp.deleteOne({ _id: record._id });

    return res.json({ success: true, message: 'Phone verified.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/trips/estimate
// @desc    Quote a trip without creating one. Deliberately runs the SAME
//          two steps createTrip runs -- verifyRoute for the billing
//          distance, then fareCalculator.compute at the same GST_RATE --
//          so the number the CRM operator reads out to a caller is the
//          number the booking will actually be created with. Any other
//          implementation would be a second pricing formula, which is
//          exactly what the three existing client-side copies already
//          cost us.
//
//          selectedType is optional: without it this returns route only
//          (distance/duration/polyline), which is what the dispatch map
//          needs before the operator has picked a service. Read-only --
//          writes nothing.
// @access  Private [all CRM staff]
// ============================================================
exports.estimateTrip = async (req, res, next) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng, selectedType, tripType, acEnabled, helperEnabled } = req.body;

    const route = await verifyRoute(pickupLat, pickupLng, dropLat, dropLng);
    if (!route) {
      return res.status(422).json({
        success: false,
        message: 'Could not calculate a route between these locations. Check both pins and try again.',
      });
    }

    // Round trip bills the road distance both ways -- identical to
    // createTrip, not a rule re-invented here.
    const isRound    = tripType === 'round_trip';
    const distanceKm = isRound ? route.distanceKm * 2 : route.distanceKm;

    const payload = {
      success   : true,
      tripType  : isRound ? 'round_trip' : 'one_way',
      oneWayKm  : route.distanceKm,
      distanceKm,
      // Duration stays one-way: it is how long until the ambulance
      // reaches the drop, which is what dispatch actually needs.
      durationSec: route.durationSec,
      polyline   : route.polyline,
      fare       : null,
    };

    if (!selectedType) return res.json(payload);

    try {
      payload.fare = await fareCalculator.compute({
        selectedType,
        distanceKm,
        oneWayKm : route.distanceKm,
        tripType : isRound ? 'round_trip' : 'one_way',
        acEnabled: !!acEnabled,
        helperEnabled: !!helperEnabled,
        gstRate  : GST_RATE,
      });
    } catch (fareErr) {
      // A missing Pricing doc is a configuration answer, not a crash: the
      // route is still valid and the map should still draw.
      payload.fareError = fareErr.message;
    }

    return res.json(payload);
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   POST /api/trips
// @desc    Create a new booking (Owner)
// @access  Private [owner]
// ============================================================
exports.createTrip = async (req, res, next) => {
  try {
    const {
      // Internal (owner/CRM) fields
      patientName, patientPhone, emergencyType,
      pickupAddress, pickupLat, pickupLng,
      dropHospitalId, dropAddress,
      vehicleId,
      leadId,
      // Customer app fields
      pickupLabel, dropLabel, dist, effectiveDist,
      dropLat, dropLng,
      scheduleType, scheduleDate, selectedType,
      tripType, returnAddress, acEnabled, helperEnabled,
      paymentPreference,
    } = req.body;

    // Never let a bad/missing value block booking — falls back to the
    // schema default ('cash') exactly as if the field were omitted.
    const PAYMENT_PREFS = ['cash', 'upi', 'card'];
    const validPaymentPreference = PAYMENT_PREFS.includes(paymentPreference) ? paymentPreference : undefined;

    // Authoritative distance for billing — never trust the client-submitted
    // dist/effectiveDist outright. Independently re-verify the real road
    // distance via Google Directions from the trip's own coordinates; only
    // fall back to the client-submitted figure if verification isn't
    // possible (client not yet sending dropLat/dropLng, or the Google call
    // itself fails) so a booking never hard-blocks on that.
    const verifiedRoute    = await verifyRoute(pickupLat, pickupLng, dropLat, dropLng);
    const verifiedOneWayKm = verifiedRoute ? verifiedRoute.distanceKm : null;
    const distanceKm = verifiedOneWayKm != null
      ? (tripType === 'round_trip' ? verifiedOneWayKm * 2 : verifiedOneWayKm)
      : (effectiveDist ?? dist ?? 0);

    // ── Compute the authoritative fare server-side from MongoDB Pricing —
    //    never trust a client-supplied baseFare/perKmRate/totalFare. ──────
    let fare;
    try {
      fare = await fareCalculator.compute({
        selectedType,
        distanceKm,
        // Null when Google could not be reached and distanceKm fell back to
        // the client figure; compute() then derives the leg itself.
        oneWayKm : verifiedOneWayKm ?? undefined,
        tripType : tripType === 'round_trip' ? 'round_trip' : 'one_way',
        acEnabled: !!acEnabled,
        helperEnabled: !!helperEnabled,
        gstRate  : GST_RATE,
      });
    } catch (fareErr) {
      return res.status(400).json({ success: false, message: fareErr.message });
    }

    // ── Build trip document ───────────────────────────────────
    const tripData = {
      patientName   : patientName   || 'Customer Booking',
      patientPhone  : patientPhone  || 'N/A',
      emergencyType : emergencyType || 'general',
      pickup        : { address: pickupAddress || pickupLabel, lat: pickupLat, lng: pickupLng },
      dropHospital  : dropHospitalId || undefined,
      dropAddress   : dropAddress   || dropLabel,
      // Additive — already received above (used transiently for
      // verifyRoadDistanceKm), just never stored until now. Undefined on
      // trips from a client that doesn't send them, same as pickupLat/Lng.
      dropLat       : dropLat,
      dropLng       : dropLng,
      selectedType,
      tripType      : tripType || 'one_way',
      returnAddress : tripType === 'round_trip' ? returnAddress : undefined,
      scheduleType  : scheduleType || 'now',
      scheduleDate  : scheduleType === 'later' && scheduleDate ? new Date(scheduleDate) : undefined,
      acEnabled     : !!acEnabled,
      helperEnabled : !!helperEnabled,
      baseFare      : fare.baseFare,
      distanceKm    : fare.distanceKm,
      additionalCharges: fare.additionalCharges,
      // Estimate snapshot — preserved as-is even after distanceKm/baseFare/
      // grandTotal get recomputed at completion (see Trip schema comment).
      estimatedDistanceKm: fare.distanceKm,
      estimatedFare      : fare.grandTotal,
      estimatedDurationSec: verifiedRoute?.durationSec ?? undefined,
      bookedBy      : req.user?._id || undefined,
      leadId,
      paymentPreference: validPaymentPreference,
      status        : 'booked',
    };

    const trip = await Trip.create(tripData);

    // Mark lead as converted if applicable
    if (leadId) {
      await Lead.findByIdAndUpdate(leadId, { status: 'converted', convertedTrip: trip._id });
    }

    // ── Auto-assign if no vehicle specified ───────────────────
    let assignedVehicle = null;
    if (vehicleId) {
      assignedVehicle = await Vehicle.findById(vehicleId);
    } else {
      assignedVehicle = await autoAssign(trip);
    }

    if (assignedVehicle) {
      await assignTripToVehicle(trip, assignedVehicle);
    }

    // Populate references for response
    await trip.populate(['dropHospital', 'vehicle', 'driver']);

    return res.status(201).json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ── Auto-assign: find closest Available ambulance ────────────
const autoAssign = async (trip) => {
  const available = await Vehicle.find({ status: 'available' })
    .populate('assignedDriver', 'name phone availability');

  if (!available.length) return null;

  // If we have pickup coordinates, sort by GPS distance
  if (trip.pickup.lat && trip.pickup.lng) {
    available.sort((a, b) => {
      const distA = (a.gps?.lat && a.gps?.lng)
        ? haversineKm(trip.pickup.lat, trip.pickup.lng, a.gps.lat, a.gps.lng) : Infinity;
      const distB = (b.gps?.lat && b.gps?.lng)
        ? haversineKm(trip.pickup.lat, trip.pickup.lng, b.gps.lat, b.gps.lng) : Infinity;
      return distA - distB;
    });
  }

  return available[0];
};


// ── Shared tail: notify the driver + flip their availability to
//    'on_trip'. Called from both the legacy Vehicle-sourced assignment
//    path and the Ambulance-sourced one below — Trip.driver is a plain
//    User ref either way, so this needs no per-source branching at all. ──
const dispatchTripToDriver = async (trip, driverId) => {
  trip.status      = 'dispatched';
  trip.dispatchedAt = new Date();
  trip.driverConfirmed = false; // (re)assignment always re-prompts the driver
  trip.driver = driverId;
  await trip.save();

  if (!driverId) return;

  await User.findByIdAndUpdate(driverId, {
    'availability.status'   : 'on_trip',
    'availability.updatedAt': new Date(),
  });

  await Notification.create({
    type        : 'trip_assigned',
    title       : '🚑 New Trip Assigned',
    message     : `You have a new trip: ${trip.patientName} — ${trip.pickup.address}`,
    severity    : 'info',
    trip        : trip._id,
    targetUserId: driverId,
    targetRole  : 'driver',
  });

  const driverUser = await User.findById(driverId).select('pushToken fcmToken');
  sendPush(driverUser?.pushToken, '🚑 New Trip Assigned', `${trip.patientName} — ${trip.pickup.address}`, { tripId: trip._id.toString() });
  // Phase 2 — additive, alongside the Expo push above, not instead of it.
  // Both are fire-and-forget; sendFullScreenTrip's own internal try/catch
  // (utils/fcmService.js) means a failure here can never affect dispatch or
  // the Expo push, which stays completely untouched.
  sendFullScreenTrip(driverUser?.fcmToken, trip);
  // Fire-and-forget, same as the pushes above — a logging failure must
  // never affect dispatch. Logged even if fcmToken is missing (that's
  // itself useful CRM signal — sendFullScreenTrip no-ops on a missing
  // token, so PUSH_SENT here means "we attempted it", not "it definitely
  // reached the device"; meta.hadFcmToken distinguishes the two cases).
  TripCallEvent.create({
    tripId  : trip._id,
    driverId,
    type    : 'PUSH_SENT',
    source  : 'backend',
    meta    : { hadFcmToken: !!driverUser?.fcmToken },
  }).catch((err) => console.log('[TripCallEvent] Could not log PUSH_SENT:', err.message));

  // Fire-and-forget WhatsApp notification -- no-ops internally for any
  // trip that isn't bookingSource:'whatsapp'. Covers both dispatch paths
  // (auto-assign in createTrip and manual assign via assignVehicle),
  // since both funnel through this shared tail.
  whatsappNotifications.notifyDriverAssigned(trip)
    .catch((err) => console.error('[whatsappNotifications] notifyDriverAssigned failed:', err.message));

  // Customer's live tracking link, over SMS and WhatsApp. Placed here
  // because this tail is the single point both dispatch paths funnel
  // through — auto-assign in createTrip and manual assign via
  // assignVehicle — so website, app, CRM and WhatsApp bookings all get it
  // from one call site. Once per trip, not per assignment: the guard lives
  // in the service, keyed on trip.trackingLinkSentAt.
  trackingNotifications.notifyTrackingLink(trip)
    .catch((err) => console.error('[trackingNotifications] notifyTrackingLink failed:', err.message));
};

// ── Helper: assign trip to a specific vehicle (legacy Vehicle-sourced
//    path) ──────────────────────────────────────────────────────────
const assignTripToVehicle = async (trip, vehicle) => {
  trip.vehicle   = vehicle._id;
  trip.ambulance = (await findMatchingAmbulance(vehicle.registrationNumber))?._id || undefined;
  await Vehicle.findByIdAndUpdate(vehicle._id, { status: 'on_trip' });
  await dispatchTripToDriver(trip, vehicle.assignedDriver);
};

// ── Helper: assign trip to an on-duty Ambulance operator (owner or
//    driver — same "someone is on shift on this Ambulance" shape either
//    way). No Ambulance.status change needed: 'assigned' already covers
//    the whole duty shift regardless of individual trips, and the
//    per-trip busy/available signal lives entirely on the driver's own
//    User.availability.status, exactly like the Vehicle path. ──
const assignTripToAmbulance = async (trip, ambulance) => {
  trip.ambulance = ambulance._id;
  trip.vehicle   = undefined;
  await dispatchTripToDriver(trip, ambulance.assignedDriver?._id || ambulance.assignedDriver);
};


// ============================================================
// @route   PUT /api/trips/:id/assign
// @desc    Manually assign / reassign a vehicle to a trip
// @access  Private [owner]
// ============================================================
exports.assignVehicle = async (req, res, next) => {
  try {
    const { vehicleId, ambulanceId } = req.body;
    if (!vehicleId && !ambulanceId) {
      return res.status(400).json({ success: false, message: 'vehicleId or ambulanceId is required.' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Cannot reassign a ${trip.status} trip.` });
    }

    // Release previous vehicle if any — no equivalent release needed on
    // the Ambulance side even when reassigning away from one: Ambulance.
    // status stays 'assigned' for the whole duty shift regardless of
    // individual trips (see assignTripToAmbulance's comment).
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }

    if (ambulanceId) {
      const ambulance = await Ambulance.findById(ambulanceId).populate('assignedDriver', 'availability');
      if (!ambulance) return res.status(404).json({ success: false, message: 'Ambulance not found.' });
      if (computeAmbulanceDisplayStatus(ambulance) !== 'available') {
        return res.status(400).json({ success: false, message: 'Selected ambulance is not available.' });
      }
      await assignTripToAmbulance(trip, ambulance);
    } else {
      const vehicle = await Vehicle.findById(vehicleId);
      if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });
      if (vehicle.status !== 'available') {
        return res.status(400).json({ success: false, message: 'Selected vehicle is not available.' });
      }
      await assignTripToVehicle(trip, vehicle);
    }

    await trip.populate(['vehicle', 'ambulance', 'driver', 'dropHospital']);

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/status
// @desc    Update trip status (driver app: en_route flow)
// @access  Private [driver] — driver can only update their own trip
// ============================================================
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validTransitions = {
      dispatched : ['en_route'],
      en_route   : ['completed', 'cancelled'],
    };

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    // Drivers can only update their OWN trips
    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only update your own trips.' });
    }

    // Validate transition
    if (!validTransitions[trip.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        message : `Cannot transition trip from '${trip.status}' to '${status}'.`,
      });
    }

    trip.status = status;
    if (status === 'en_route')   trip.enRouteAt   = new Date();
    if (status === 'cancelled') {
      trip.cancelledAt = new Date();
      trip.closeAllOpenWaitSegments(trip.cancelledAt);
    }
    await trip.save();

    // Only reachable from 'dispatched' per validTransitions above — this
    // is the driver heading toward pickup, not toward the hospital (that
    // moment is verifyPickupOtp below, once the patient is actually
    // onboard).
    if (status === 'en_route') {
      sendPush(trip.customerPushToken, '🚑 Ambulance On The Way', 'Your ambulance is on the way.', { tripId: trip._id.toString() });

      // Guarded on bookingSource before the extra query, not just inside
      // notifyTripStarted -- pickupOtp has {select:false}, so it must be
      // fetched separately here; doing that unconditionally on every
      // en_route transition would mean an extra DB read for every non-
      // WhatsApp trip too. The `trip` object returned in the response
      // below is never touched, so pickupOtp can't leak to the driver app.
      if (trip.bookingSource === 'whatsapp') {
        Trip.findById(trip._id).select('+pickupOtp').lean()
          .then((withOtp) => whatsappNotifications.notifyTripStarted(trip, withOtp?.pickupOtp))
          .catch((err) => console.error('[whatsappNotifications] notifyTripStarted failed:', err.message));
      }
    }

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// GPS proximity guard for "Reached Pickup" — CLAUDE.md's 150m rule.
// Never blocks on missing data (driver app may not send coordinates yet,
// or the last availability ping may be stale); it only blocks when we
// actually have a confident position AND it's too far, and even then only
// once ENFORCE_PICKUP_GPS_GUARD is flipped on.
const PICKUP_GPS_RADIUS_METERS = 150;
const GPS_STALENESS_MS = 2 * 60 * 1000; // 2 minutes
// Log-only until the driver app has an override UI and we've seen the
// real distance distribution. Flip to true to start returning 400s.
const ENFORCE_PICKUP_GPS_GUARD = false;

// ============================================================
// @route   PUT /api/trips/:id/arrive-pickup
// @desc    Driver taps "Reached Pickup" — marks arrival at the pickup
//          location using SERVER time only, GPS-guarded against the
//          trip's pickup coordinates (150m) when a position is available,
//          and opens a PICKUP wait segment rated from the Pricing
//          collection. Mirrors verify-otp: a sub-event within 'en_route',
//          does not change trip.status. Pairs with pickupVerifiedAt (set
//          by verify-otp below) — that bracket is still what completeTrip
//          bills from; waitSegments is recording-only until the two are
//          verified to agree on real trips.
// @access  Private [driver, owner] — driver can only mark their own trip;
//          owner (CRM dispatcher) can force an arrival for any trip.
// ============================================================
exports.arrivePickup = async (req, res, next) => {
  try {
    const { lat, lng, override, reason } = req.body;

    const trip = await Trip.findById(req.params.id).populate('driver', 'availability');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (req.user.role === 'driver' && trip.driver?._id?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'This trip is not assigned to you.' });
    }

    if (trip.status !== 'en_route') {
      return res.status(400).json({ success: false, message: 'Trip must be en route to mark pickup arrival.' });
    }

    // Already recorded — idempotent no-op, same as before. Don't re-run
    // the GPS check or open a second wait segment.
    if (trip.arrivedAtPickupAt) {
      return res.json({ success: true, message: 'Pickup arrival recorded.', arrivedAtPickupAt: trip.arrivedAtPickupAt });
    }

    // ── Resolve a position to check proximity with: prefer the
    //    freshly-supplied body coordinates, fall back to the driver's
    //    last known availability ping if it's <= 2 minutes old. ──
    let gpsSource = 'none';
    let checkLat, checkLng;
    if (typeof lat === 'number' && typeof lng === 'number') {
      gpsSource = 'body';
      checkLat = lat;
      checkLng = lng;
    } else {
      const avail = trip.driver?.availability;
      const isFresh = avail?.updatedAt && (Date.now() - new Date(avail.updatedAt).getTime()) <= GPS_STALENESS_MS;
      if (isFresh && typeof avail.lat === 'number' && typeof avail.lng === 'number') {
        gpsSource = 'availability';
        checkLat = avail.lat;
        checkLng = avail.lng;
      }
    }

    let distanceMeters = null;
    let gpsVerified = false;
    let autoReason;
    let overridden = false;
    let overriddenByRole;

    if (gpsSource === 'none') {
      autoReason = 'No current GPS position available (no coordinates sent and no fresh driver location on file).';
    } else if (trip.pickup?.lat == null || trip.pickup?.lng == null) {
      autoReason = 'Pickup coordinates are not set on this trip.';
    } else {
      distanceMeters = Math.round(haversineKm(checkLat, checkLng, trip.pickup.lat, trip.pickup.lng) * 1000);
      if (distanceMeters <= PICKUP_GPS_RADIUS_METERS) {
        gpsVerified = true;
      } else if (override) {
        if (!reason || !String(reason).trim()) {
          return res.status(400).json({ success: false, message: 'A reason is required to override the GPS check.' });
        }
        overridden = true;
        overriddenByRole = req.user.role;
      } else if (ENFORCE_PICKUP_GPS_GUARD) {
        return res.status(400).json({
          success: false,
          message: `You are ${distanceMeters}m from the pickup location — must be within ${PICKUP_GPS_RADIUS_METERS}m. Override with a reason if this is correct.`,
          distanceMeters,
          maxAllowedMeters: PICKUP_GPS_RADIUS_METERS,
        });
      } else {
        // Log-only: never block. Record the miss so the real distance
        // distribution can be reviewed before ENFORCE_PICKUP_GPS_GUARD flips on.
        autoReason = `Outside ${PICKUP_GPS_RADIUS_METERS}m pickup radius (${distanceMeters}m) — guard is in log-only mode, not enforced.`;
      }
    }

    trip.arrivedAtPickupAt = new Date();

    // ── Open the PICKUP wait segment, rated from the Pricing collection —
    //    never hardcoded. ──
    const pricingDoc = await fareCalculator.findPricingDoc(trip.selectedType);
    trip.waitSegments.push({
      segmentType: 'pickup',
      startedAt  : trip.arrivedAtPickupAt,
      ratePerMin : pricingDoc?.pickupWaitPerMin ?? 0,
      freeSeconds: (pricingDoc?.pickupFreeWaitMinutes ?? 0) * 60,
    });

    trip.events.push({
      type    : 'PICKUP_ARRIVED',
      at      : trip.arrivedAtPickupAt,
      by      : req.user._id,
      location: gpsSource !== 'none' ? { lat: checkLat, lng: checkLng } : undefined,
      meta    : {
        gpsSource,
        distanceMeters,
        gpsVerified,
        overridden,
        overriddenByRole,
        reason: overridden ? reason : autoReason,
      },
    });

    await trip.save();
    sendPush(trip.customerPushToken, '📍 Ambulance Arrived', 'Your ambulance has arrived at the pickup location.', { tripId: trip._id.toString() });

    return res.json({
      success: true,
      message: 'Pickup arrival recorded.',
      arrivedAtPickupAt: trip.arrivedAtPickupAt,
      distanceMeters,
      gpsVerified,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/reached-hospital
// @desc    Driver taps "Reached Hospital" — marks arrival at the drop
//          location using SERVER time only, and opens a drop wait segment
//          rated from the Pricing collection (one-way: flat dropWaitPerMin;
//          round trip: tiered returnDropWaitTier1/2PerMin). No drop
//          coordinate exists anywhere in the schema yet (dropAddress/
//          Hospital.address are both free text), so unlike arrivePickup
//          this can never actually verify proximity — it still resolves
//          and records the driver's GPS (gpsSource/location) on the event
//          purely for later analysis, always non-blocking. Mirrors
//          arrivePickup: a sub-event within 'en_route', does not change
//          trip.status. Segment closes in completeTrip (closeAllOpenWaitSegments),
//          same as pickup's; completeTrip's own drop-wait calc (below) is
//          what actually bills, independent of the segment.
// @access  Private [driver, owner] — driver can only mark their own trip;
//          owner (CRM dispatcher) can force an arrival for any trip.
// ============================================================
exports.arriveDrop = async (req, res, next) => {
  try {
    const { lat, lng } = req.body;

    const trip = await Trip.findById(req.params.id).populate('driver', 'availability');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (req.user.role === 'driver' && trip.driver?._id?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'This trip is not assigned to you.' });
    }

    if (trip.status !== 'en_route') {
      return res.status(400).json({ success: false, message: 'Trip must be en route to mark hospital arrival.' });
    }

    if (!trip.pickupVerified) {
      return res.status(400).json({ success: false, message: 'Patient must be picked up (OTP verified) before marking hospital arrival.' });
    }

    // Already recorded — idempotent no-op, same as arrivePickup. Don't
    // re-run GPS resolution or open a second wait segment.
    if (trip.reachedHospitalAt) {
      return res.json({ success: true, message: 'Hospital arrival recorded.', reachedHospitalAt: trip.reachedHospitalAt });
    }

    // ── Resolve a position purely for the record — there's no drop
    //    coordinate to compare it against yet, so this never verifies or
    //    blocks. Kept in the same shape as arrivePickup so a real guard
    //    can slot in later once a drop coordinate exists. ──
    let gpsSource = 'none';
    let checkLat, checkLng;
    if (typeof lat === 'number' && typeof lng === 'number') {
      gpsSource = 'body';
      checkLat = lat;
      checkLng = lng;
    } else {
      const avail = trip.driver?.availability;
      const isFresh = avail?.updatedAt && (Date.now() - new Date(avail.updatedAt).getTime()) <= GPS_STALENESS_MS;
      if (isFresh && typeof avail.lat === 'number' && typeof avail.lng === 'number') {
        gpsSource = 'availability';
        checkLat = avail.lat;
        checkLng = avail.lng;
      }
    }

    const autoReason = gpsSource === 'none'
      ? 'No current GPS position available (no coordinates sent and no fresh driver location on file).'
      : 'No drop coordinates exist on this trip to verify proximity against.';

    trip.reachedHospitalAt = new Date();

    // ── Open the drop wait segment, rated from the Pricing collection —
    //    never hardcoded. One-way is flat-rate; round trip is tiered. ──
    const pricingDoc = await fareCalculator.findPricingDoc(trip.selectedType);
    const isRoundTrip = trip.tripType === 'round_trip';
    trip.waitSegments.push({
      segmentType: isRoundTrip ? 'drop_return' : 'drop_oneway',
      startedAt  : trip.reachedHospitalAt,
      ratePerMin : isRoundTrip ? (pricingDoc?.returnDropWaitTier1PerMin ?? 0) : (pricingDoc?.dropWaitPerMin ?? 0),
      freeSeconds: (isRoundTrip ? (pricingDoc?.returnDropFreeWaitMinutes ?? 0) : (pricingDoc?.dropFreeWaitMinutes ?? 0)) * 60,
      ...(isRoundTrip ? {
        tier1CapMinutes: pricingDoc?.returnDropWaitTier1Minutes ?? 0,
        tier2RatePerMin: pricingDoc?.returnDropWaitTier2PerMin ?? 0,
      } : {}),
    });

    trip.events.push({
      type    : 'DROP_ARRIVED',
      at      : trip.reachedHospitalAt,
      by      : req.user._id,
      location: gpsSource !== 'none' ? { lat: checkLat, lng: checkLng } : undefined,
      meta    : {
        gpsSource,
        distanceMeters: null,
        gpsVerified: false,
        overridden: false,
        overriddenByRole: undefined,
        reason: autoReason,
      },
    });

    await trip.save();

    return res.json({
      success: true,
      message: 'Hospital arrival recorded.',
      reachedHospitalAt: trip.reachedHospitalAt,
      gpsSource,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/start-return
// @desc    Driver taps "Starting Return" on a round trip — marks the start
//          of the return leg using SERVER time only, and closes the open
//          drop wait segment right here rather than at completion. Without
//          this, completeTrip would bracket drop wait as reachedHospitalAt
//          -> completedAt, billing the entire return drive as waiting time.
//          Conceptually mirrors BookingTrip's RETURN_STARTED stage, but
//          lives on Trip since it feeds fare/billing, not the duty log.
// @access  Private [driver, owner] — driver can only mark their own trip;
//          owner (CRM dispatcher) can force it for any trip.
// ============================================================
exports.startReturn = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'This trip is not assigned to you.' });
    }

    if (trip.tripType !== 'round_trip') {
      return res.status(400).json({ success: false, message: 'Only round trips have a return leg.' });
    }

    if (trip.status !== 'en_route') {
      return res.status(400).json({ success: false, message: 'Trip must be en route to start the return leg.' });
    }

    if (!trip.reachedHospitalAt) {
      return res.status(400).json({ success: false, message: 'Mark hospital arrival before starting the return leg.' });
    }

    // Already recorded — idempotent no-op. Don't reclose an already-closed
    // segment or push a duplicate event.
    if (trip.returnStartedAt) {
      return res.json({ success: true, message: 'Return leg already started.', returnStartedAt: trip.returnStartedAt });
    }

    trip.returnStartedAt = new Date();
    trip.closeWaitSegment('drop_return', trip.returnStartedAt);

    trip.events.push({
      type: 'RETURN_STARTED',
      at  : trip.returnStartedAt,
      by  : req.user._id,
    });

    await trip.save();

    return res.json({ success: true, message: 'Return leg started.', returnStartedAt: trip.returnStartedAt });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/verify-otp
// @desc    Driver enters the 4-digit pickup OTP the customer shares
//          at the pickup location. On success, marks the trip's
//          pickup as verified (does not change trip status — the
//          driver's separate en_route/completed flow stays as-is).
// @access  Private [driver] — driver can only verify their own trip
// ============================================================
exports.verifyPickupOtp = async (req, res, next) => {
  try {
    const { otp } = req.body;
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required.' });
    }

    const trip = await Trip.findById(req.params.id).select('+pickupOtp');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'This trip is not assigned to you.' });
    }

    if (trip.pickupVerified) {
      return res.json({ success: true, message: 'Pickup already verified.', alreadyVerified: true });
    }

    if (String(otp) !== String(trip.pickupOtp)) {
      return res.status(400).json({ success: false, message: 'Incorrect OTP. Please check with the patient.' });
    }

    trip.pickupVerified = true;
    trip.pickupVerifiedAt = new Date();
    trip.closeWaitSegment('pickup', trip.pickupVerifiedAt);
    await trip.save();

    // The real "trip started" moment from the customer's point of view —
    // patient actually onboard, heading to hospital (not the earlier
    // 'en_route' status flip above, which is the driver heading toward
    // pickup).
    sendPush(trip.customerPushToken, '✅ Trip Started', 'Your trip is now underway.', { tripId: trip._id.toString() });

    return res.json({ success: true, message: 'Pickup verified successfully.' });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/complete
// @desc    Mark trip as completed:
//          1. Compute total fare using fare engine
//          2. Auto-generate Bill document
//          3. Auto-create Income ledger entry
//          4. Release vehicle back to 'available'
// @access  Private [driver, owner]
// ============================================================
exports.completeTrip = async (req, res, next) => {
  try {
    const { distanceKm, actualDistanceKm, additionalCharges } = req.body;

    const trip = await Trip.findById(req.params.id).populate('dropHospital');
    if (!trip)                    return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed') return res.status(400).json({ success: false, message: 'Trip already completed.' });
    if (trip.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot complete a cancelled trip.' });

    // Driver guard
    if (req.user.role === 'driver' && trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only complete your own trips.' });
    }

    // ── 1. Update distance — actualDistanceKm (driver app's client-side
    //      haversine accumulation over the en_route GPS pings) takes
    //      precedence over the legacy distanceKm body param. Also stored
    //      on its own field so estimate-vs-actual stays comparable;
    //      estimatedDistanceKm/estimatedFare (booking-time snapshot) are
    //      never touched here. ──
    const finalDistanceKm = actualDistanceKm != null ? actualDistanceKm : distanceKm;
    if (finalDistanceKm) {
      trip.distanceKm       = finalDistanceKm;
      trip.actualDistanceKm = finalDistanceKm;
    }

    // ── 2. Recompute the authoritative fare from MongoDB Pricing —
    //      distanceKm may have changed since booking (driver GPS update). ──
    let fare;
    try {
      fare = await fareCalculator.compute({
        selectedType     : trip.selectedType,
        distanceKm       : trip.distanceKm,
        // No one-way figure is stored, so compute() halves trip.distanceKm
        // to find the leg. That matches how createTrip built it.
        tripType         : trip.tripType,
        acEnabled        : trip.acEnabled,
        helperEnabled    : trip.helperEnabled,
        additionalCharges: additionalCharges ? additionalCharges : 0,
        gstRate          : GST_RATE,
      });
    } catch (fareErr) {
      return res.status(400).json({ success: false, message: fareErr.message });
    }

    // Bracketing timestamp for both wait calcs below and the trip's own
    // completedAt — one Date instance so nothing drifts between them.
    const completedAt = new Date();

    // Rate/free-minutes always come from Pricing — never hardcoded. Fetched
    // once, shared by both the pickup and drop wait calcs below.
    const pricingDoc = await fareCalculator.findPricingDoc(trip.selectedType);

    // ── 2b. Pickup wait charge — bracketed by arrivedAtPickupAt (driver's
    //      "Reached Pickup" tap) and pickupVerifiedAt (OTP verify). Both
    //      are optional (older trips / CRM-completed trips won't have
    //      them), so wait stays 0 unless the full bracket exists. Uses the
    //      same computeSegmentAmount as getLiveWaitState/closeWaitSegment
    //      (models/index.js) — one implementation of the wait-charge math,
    //      not a second copy that can drift from it. ──
    let pickupWaitMinutes = 0;
    let pickupWaitCharge  = 0;
    if (trip.arrivedAtPickupAt && trip.pickupVerifiedAt) {
      const elapsedMs = trip.pickupVerifiedAt - trip.arrivedAtPickupAt;
      const result = computeSegmentAmount(
        { ratePerMin: pricingDoc?.pickupWaitPerMin ?? 0, freeSeconds: (pricingDoc?.pickupFreeWaitMinutes ?? 0) * 60 },
        elapsedMs
      );
      pickupWaitMinutes = result.billableMinutes;
      pickupWaitCharge  = result.amount;
    }

    // ── 2c. Drop wait charge — bracketed by reachedHospitalAt (driver's
    //      "Reached Hospital" tap) and, for a round trip, returnStartedAt
    //      (driver's "Starting Return" tap) — NOT completedAt, otherwise
    //      the entire return drive gets billed as waiting time. One-way
    //      has no return leg, so completedAt is the correct end there.
    //      If a round trip somehow reaches completion with no
    //      returnStartedAt (driver skipped the tap, or a trip predates
    //      this feature), there's no safe way to bracket it — charge Rs 0
    //      rather than guess against completedAt. Under-charging is
    //      recoverable (ops can bill it manually after review);
    //      over-charging is a customer complaint and a refund. Log an
    //      event and flag the trip either way, so it's visible/auditable
    //      rather than silently wrong or silently free. ──
    let dropWaitMinutes = 0;
    let dropWaitCharge  = 0;
    if (trip.reachedHospitalAt) {
      const isRoundTrip = trip.tripType === 'round_trip';

      if (isRoundTrip && !trip.returnStartedAt) {
        trip.dropWaitNeedsReview = true;
        trip.events.push({
          type: 'DROP_WAIT_FALLBACK_COMPLETEDAT',
          at  : completedAt,
          by  : req.user._id,
          meta: {
            reason: 'Round trip completed with no returnStartedAt — drop wait could not be safely bracketed, charged Rs 0 and flagged for manual review.',
          },
        });
      } else {
        const dropWaitEndedAt = isRoundTrip ? trip.returnStartedAt : completedAt;
        const elapsedMs = dropWaitEndedAt - trip.reachedHospitalAt;
        const segmentShape = isRoundTrip
          ? {
              ratePerMin     : pricingDoc?.returnDropWaitTier1PerMin ?? 0,
              freeSeconds    : (pricingDoc?.returnDropFreeWaitMinutes ?? 0) * 60,
              tier1CapMinutes: pricingDoc?.returnDropWaitTier1Minutes ?? 0,
              tier2RatePerMin: pricingDoc?.returnDropWaitTier2PerMin ?? 0,
            }
          : {
              ratePerMin : pricingDoc?.dropWaitPerMin ?? 0,
              freeSeconds: (pricingDoc?.dropFreeWaitMinutes ?? 0) * 60,
            };

        const result = computeSegmentAmount(segmentShape, elapsedMs);
        dropWaitMinutes = result.billableMinutes;
        dropWaitCharge  = result.amount;
      }
    }

    const totalWaitCharge = pickupWaitCharge + dropWaitCharge;
    trip.pickupWaitMinutes = pickupWaitMinutes;
    trip.dropWaitMinutes   = dropWaitMinutes;
    trip.waitCharge        = totalWaitCharge;

    trip.baseFare     = fare.baseFare;
    trip.additionalCharges = fare.additionalCharges;
    trip.totalFare    = fare.subTotal;
    trip.gstAmount    = fare.gstAmount;
    trip.grandTotal   = fare.grandTotal + totalWaitCharge;
    trip.status       = 'completed';
    trip.completedAt  = completedAt;
    trip.closeAllOpenWaitSegments(trip.completedAt);
    await trip.save();

    // Fire-and-forget WhatsApp notification -- no-ops internally for any
    // trip that isn't bookingSource:'whatsapp'. trip.grandTotal above is
    // already the final billed amount (fare + wait charges) by this point.
    whatsappNotifications.notifyTripCompleted(trip)
      .catch((err) => console.error('[whatsappNotifications] notifyTripCompleted failed:', err.message));

    // ── 3. Auto-generate Bill ─────────────────────────────────
    const bill = await Bill.create({
      trip            : trip._id,
      patient         : trip.patientName,
      hospital        : trip.dropHospital?._id,
      baseFare        : trip.baseFare,
      distanceKm      : trip.distanceKm,
      additionalCharges: trip.additionalCharges,
      subTotal        : fare.subTotal,
      gstRate         : GST_RATE,
      gstAmount       : fare.gstAmount,
      waitCharge      : trip.waitCharge,
      grandTotal      : trip.grandTotal,
    });

    // Link bill to trip
    trip.billId = bill._id;
    await trip.save();

    // ── 4. Auto-create Income ledger entry ─────────────────────
    await Income.create({
      category   : 'trip_fare',
      amount     : trip.grandTotal,
      description: `Trip ${trip.tripNumber} — ${trip.patientName}`,
      date       : new Date(),
      trip       : trip._id,
      vehicle    : trip.vehicle,
      recordedBy : req.user._id,
    });

    // ── 5. Release vehicle & driver ───────────────────────────
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }
    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, {
        $set: {
          'availability.status'   : 'available',
          'availability.updatedAt': new Date(),
        },
        $inc: { completedTripsCount: 1 },
      });
    }

    await bill.populate(['trip', 'hospital']);

    sendPush(trip.customerPushToken, '🎉 Trip Completed', 'Your trip is complete. View your bill in the app.', { tripId: trip._id.toString() });

    return res.json({
      success : true,
      message : 'Trip completed. Bill auto-generated.',
      trip,
      bill,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/confirm
// @desc    Driver accepts a trip that was just dispatched to them —
//          the Accept half of the Accept/Reject popup. 'dispatched'
//          alone only means "assigned"; this flips driverConfirmed so
//          the driver app can distinguish "awaiting accept" from
//          "accepted, awaiting pickup". Does not touch trip.status —
//          the dispatched -> en_route transition still happens via
//          the existing /status route on "Trip Started".
// @access  Private [driver] — only the currently-assigned driver
// ============================================================
exports.confirmTrip = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only confirm your own assigned trip.' });
    }
    if (trip.status !== 'dispatched') {
      return res.status(400).json({ success: false, message: `Cannot confirm a trip with status '${trip.status}'.` });
    }

    trip.driverConfirmed = true;
    await trip.save();
    await trip.populate(['vehicle', 'driver', 'dropHospital']);

    sendPush(trip.customerPushToken, '🚑 Driver Assigned', `${req.user.name} has been assigned to your trip.`, { tripId: trip._id.toString() });

    TripCallEvent.create({
      tripId  : trip._id,
      driverId: req.user._id,
      type    : 'ACCEPTED',
      source  : 'backend',
    }).catch((err) => console.log('[TripCallEvent] Could not log ACCEPTED:', err.message));

    return res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/decline
// @desc    Driver declines a trip that was just dispatched to them.
//          Unlike /cancel (owner-only, ends the trip), this
//          returns the trip to the unassigned pool ('booked') so an
//          owner can reassign it to a different vehicle/driver.
//          Additive — does not touch cancelTrip below.
// @access  Private [driver] — only the currently-assigned driver
// ============================================================
exports.declineTrip = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only decline your own assigned trip.' });
    }
    if (trip.status !== 'dispatched') {
      return res.status(400).json({ success: false, message: `Cannot decline a trip with status '${trip.status}'.` });
    }

    const previousVehicle = trip.vehicle;
    const previousDriver  = trip.driver;

    TripCallEvent.create({
      tripId  : trip._id,
      driverId: req.user._id,
      type    : 'REJECTED',
      source  : 'backend',
    }).catch((err) => console.log('[TripCallEvent] Could not log REJECTED:', err.message));

    trip.status       = 'booked';
    trip.vehicle       = undefined;
    trip.driver        = undefined;
    trip.dispatchedAt  = undefined;
    trip.driverConfirmed = false; // defensive — trip is unassigned again anyway
    await trip.save();

    if (previousVehicle) {
      await Vehicle.findByIdAndUpdate(previousVehicle, { status: 'available' });
    }
    if (previousDriver) {
      await User.findByIdAndUpdate(previousDriver, {
        'availability.status'   : 'available',
        'availability.updatedAt': new Date(),
      });
    }

    return res.json({ success: true, message: 'Trip declined and returned to the assignment pool.', trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/cancel
// @desc    Cancel a trip and release the vehicle
// @access  Private [owner]
// ============================================================
exports.cancelTrip = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Trip is already ${trip.status}.` });
    }

    trip.status             = 'cancelled';
    trip.cancelledAt        = new Date();
    trip.closeAllOpenWaitSegments(trip.cancelledAt);
    trip.cancellationReason = reason;
    await trip.save();

    // Release vehicle
    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }
    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, { 'availability.status': 'available' });
    }

    return res.json({ success: true, message: 'Trip cancelled.', trip });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/customer-cancel
// @desc    Customer-initiated cancel from the tracking screen. No auth
//          exists for the customer app — identity is just possession of
//          the tripId, same trust model as trackTrip/pickupOtp. Shares
//          cancelTrip's release logic but is deliberately more
//          restrictive: blocked once pickupVerified is true (the patient
//          may already be onboard — cancelling mid-transport is a
//          different, riskier action than cancelling before pickup, and
//          should go through the helpline/ops instead of a public
//          endpoint with no human in the loop).
// @access  Public
// ============================================================
exports.customerCancelTrip = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Trip is already ${trip.status}.` });
    }
    if (trip.pickupVerified) {
      return res.status(400).json({
        success: false,
        message: 'This trip is already in progress and can\'t be cancelled here. Please call the helpline.',
      });
    }

    trip.status             = 'cancelled';
    trip.cancelledAt        = new Date();
    trip.closeAllOpenWaitSegments(trip.cancelledAt);
    trip.cancellationReason = reason || 'Cancelled by customer';
    await trip.save();

    if (trip.vehicle) {
      await Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' });
    }
    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, { 'availability.status': 'available' });
    }

    return res.json({
      success: true,
      message: 'Trip cancelled.',
      trip: { status: trip.status, cancelledAt: trip.cancelledAt },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/rate
// @desc    Customer rates the driver after completion — 1-5 stars +
//          optional feedback. Public/tripId-keyed, same trust model as
//          trackTrip/customer-cancel. One rating per trip, no edits:
//          rejects if trip.rating is already set. On success, atomically
//          $inc's the driver's User.ratingSum/ratingCount (single write,
//          no read-then-write race) — that's what powers the ratingAvg
//          trackTrip already exposes.
// @access  Public
// ============================================================
exports.rateTrip = async (req, res, next) => {
  try {
    const { rating, feedback } = req.body;
    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: 'rating must be an integer from 1 to 5.' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Only completed trips can be rated.' });
    }
    if (trip.rating != null) {
      return res.status(400).json({ success: false, message: 'This trip has already been rated.' });
    }

    trip.rating   = ratingNum;
    trip.feedback = feedback ? String(feedback).slice(0, 500) : undefined;
    trip.ratedAt  = new Date();
    await trip.save();

    if (trip.driver) {
      await User.findByIdAndUpdate(trip.driver, {
        $inc: { ratingSum: ratingNum, ratingCount: 1 },
      });
    }

    return res.json({
      success: true,
      message: 'Thanks for your feedback!',
      trip: { rating: trip.rating, feedback: trip.feedback, ratedAt: trip.ratedAt },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// In-trip chat — polling-based (see chatMessageSchema's comment in
// models/index.js for why: this codebase has zero WebSocket/Socket.io/
// Firebase infra anywhere, and every other "live" need already works via
// polling at 5-15s intervals). Customer side is public/tripId-keyed, same
// trust model as trackTrip/customer-cancel/rate; driver side is
// protect-gated and restricted to the trip's own assigned driver, same
// guard shape as completeTrip's "you can only complete your own trips."
// `sender` is always set server-side from which pair of routes was hit —
// never accepted from the request body.
// ============================================================

const MAX_MESSAGES_PER_POLL = 200;

// @route   GET /api/trips/:id/customer-messages
// @access  Public
exports.getCustomerMessages = async (req, res, next) => {
  try {
    const filter = { trip: req.params.id };
    if (req.query.since) filter.createdAt = { $gt: new Date(req.query.since) };
    const messages = await ChatMessage.find(filter).sort({ createdAt: 1 }).limit(MAX_MESSAGES_PER_POLL);
    return res.json({ success: true, messages });
  } catch (err) {
    next(err);
  }
};

// @route   POST /api/trips/:id/customer-messages
// @access  Public
exports.postCustomerMessage = async (req, res, next) => {
  try {
    const text = req.body?.text ? String(req.body.text).trim().slice(0, 500) : '';
    if (!text) return res.status(400).json({ success: false, message: 'text is required.' });

    const trip = await Trip.findById(req.params.id).select('status');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Cannot send messages on a ${trip.status} trip.` });
    }

    const message = await ChatMessage.create({ trip: trip._id, sender: 'customer', text });
    return res.status(201).json({ success: true, message });
  } catch (err) {
    next(err);
  }
};

// @route   GET /api/trips/:id/messages
// @access  Private [driver] — own trips only
exports.getDriverMessages = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id).select('driver');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only view messages on your own trips.' });
    }

    const filter = { trip: req.params.id };
    if (req.query.since) filter.createdAt = { $gt: new Date(req.query.since) };
    const messages = await ChatMessage.find(filter).sort({ createdAt: 1 }).limit(MAX_MESSAGES_PER_POLL);
    return res.json({ success: true, messages });
  } catch (err) {
    next(err);
  }
};

// @route   POST /api/trips/:id/messages
// @access  Private [driver] — own trips only
exports.postDriverMessage = async (req, res, next) => {
  try {
    const text = req.body?.text ? String(req.body.text).trim().slice(0, 500) : '';
    if (!text) return res.status(400).json({ success: false, message: 'text is required.' });

    const trip = await Trip.findById(req.params.id).select('status driver');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.driver?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only send messages on your own trips.' });
    }
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      return res.status(400).json({ success: false, message: `Cannot send messages on a ${trip.status} trip.` });
    }

    const message = await ChatMessage.create({ trip: trip._id, sender: 'driver', text });
    return res.status(201).json({ success: true, message });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   PUT /api/trips/:id/push-token
// @desc    Customer app registers/updates its Expo push token for this
//          trip. Public/tripId-keyed, same trust model as trackTrip —
//          there's no persistent customer identity to attach a token to
//          instead, so it's scoped to the trip's own lifetime.
// @access  Public
// ============================================================
exports.registerCustomerPushToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'token is required.' });

    const trip = await Trip.findByIdAndUpdate(req.params.id, { customerPushToken: token }, { new: true }).select('_id');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips
// @desc    Get all trips with filters (status, date range, vehicle, driver)
//          Drivers see ONLY their own trips.
// @access  Private [all roles]
// ============================================================
exports.getTrips = async (req, res, next) => {
  try {
    const { status, vehicleId, driverId, hospitalId, bookingSource, from, to, page = 1, limit = 20 } = req.query;

    const filter = {};

    // Drivers are restricted to their own trips
    if (req.user.role === 'driver') {
      filter.driver = req.user._id;
    } else {
      if (driverId)   filter.driver       = driverId;
      if (vehicleId)  filter.vehicle      = vehicleId;
      if (hospitalId) filter.dropHospital = hospitalId;
    }

    if (status)        filter.status        = status;
    if (bookingSource) filter.bookingSource  = bookingSource;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(new Date(to).setHours(23, 59, 59));
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Trip.countDocuments(filter);
    const trips = await Trip.find(filter)
      .populate('vehicle', 'registrationNumber model')
      .populate('driver',  'name phone')
      .populate('dropHospital', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Drivers get masked calling (POST /api/call/connect) instead of the
    // customer's raw number — owner/CRM still sees it for support/dispatch.
    const tripsOut = req.user.role === 'driver'
      ? trips.map(t => { const o = t.toObject(); delete o.patientPhone; return o; })
      : trips;

    return res.json({
      success: true,
      total,
      pages: Math.ceil(total / limit),
      currentPage: Number(page),
      trips: tripsOut,
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips/live
// @desc    Live dispatch board — active trips only (booked, dispatched, en_route)
// @access  Private [owner]
// ============================================================
exports.getLiveBoard = async (req, res, next) => {
  try {
    const activeTrips = await Trip.find({ status: { $in: ['booked', 'dispatched', 'en_route'] } })
      // trackingToken is select:false — the dispatch board asks for it
      // explicitly so operators can hand a caller their tracking link.
      .select('+trackingToken')
      .populate('vehicle',      'registrationNumber model gps status')
      .populate('ambulance',    'registrationNumber')
      .populate('driver',       'name phone availability')
      .populate('dropHospital', 'name address')
      .sort({ createdAt: 1 });

    const vehicles = await Vehicle.find({ status: 'available' })
      .populate('assignedDriver', 'name phone');
    const vehicleEntries = vehicles.map(v => ({
      _id               : v._id,
      registrationNumber: v.registrationNumber,
      assignedDriver    : v.assignedDriver,
      source            : 'vehicle',
    }));

    // Merge in on-duty, not-currently-mid-trip Ambulances — the same
    // "someone I can dispatch to" concept the legacy Vehicle list
    // already represents, just sourced from the newer Ambulance/
    // Assignment/Shift system (see ambulanceController.
    // listAmbulancesAdmin for the CRM's own read of this same data).
    const ambulances = await Ambulance.find({ status: 'assigned', isActive: true })
      .populate('assignedDriver', 'name phone availability');
    const ambulanceEntries = ambulances
      .filter(a => computeAmbulanceDisplayStatus(a) === 'available')
      .map(a => ({
        _id               : a._id,
        registrationNumber: a.registrationNumber,
        assignedDriver    : a.assignedDriver ? { name: a.assignedDriver.name, phone: a.assignedDriver.phone } : null,
        source            : 'ambulance',
      }));

    const availableVehicles = [...vehicleEntries, ...ambulanceEntries];

    // Drivers get masked calling (POST /api/call/connect) instead of the
    // customer's raw number — owner/CRM still sees it for support/dispatch.
    const liveTripsOut = req.user.role === 'driver'
      ? activeTrips.map(t => { const o = t.toObject(); delete o.patientPhone; return o; })
      : activeTrips;

    return res.json({
      success: true,
      liveTrips       : liveTripsOut,
      availableVehicles,
      counts: {
        active   : activeTrips.length,
        available: availableVehicles.length,
      },
    });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips/:id
// @desc    Get single trip with all details
// @access  Private [all]
// ============================================================
exports.getTripById = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .populate('vehicle',      'registrationNumber model type')
      .populate('driver',       'name phone licenseNumber')
      .populate('dropHospital', 'name address phone')
      .populate('bookedBy',     'name role')
      .populate('billId');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });

    // Driver guard
    if (req.user.role === 'driver' && trip.driver?._id?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const tripObj = trip.toObject();
    tripObj.waitState = trip.getLiveWaitState();

    // Drivers get masked calling (POST /api/call/connect) instead of the
    // customer's raw number — owner/CRM still sees it for support/dispatch.
    if (req.user.role === 'driver') delete tripObj.patientPhone;

    return res.json({ success: true, trip: tripObj });
  } catch (err) {
    next(err);
  }
};


// ============================================================
// @route   GET /api/trips/:id/track
// @desc    Public, minimal trip info for the customer app's tracking
//          screen — no login required. Deliberately exposes only
//          what's needed to show live status (driver name,
//          vehicle number, status) and nothing sensitive (fare,
//          OTP, internal notes, bookedBy, etc). Driver's raw phone is
//          NOT included — masked calling via POST /api/call/connect
//          is the only way to reach them.
// @access  Public
// ============================================================
// Rough straight-line ETA assumption for ambulance urban traffic — not
// routed (no Directions-API call from the backend, to avoid burning quota
// on every 5s poll from every active trip). Good enough for a "~6 min
// away" indicator; the app can layer a real routed polyline on top using
// its own existing Directions helper without needing this to be exact.
const ASSUMED_KMPH = 30;

// Vehicle identity for a customer-facing view. Ambulance-sourced dispatch
// (an owner/driver on duty via the mobile app) never sets trip.vehicle at
// all, only trip.ambulance, so those trips would otherwise read "details
// pending" forever. Shared by both tracking endpoints.
function trackedVehicleInfo(trip) {
  if (trip.ambulance) {
    return {
      registrationNumber: trip.ambulance.registrationNumber,
      type              : trip.ambulance.serviceType,
      typeLabel         : trip.ambulance.serviceTypeLabel,
      model             : trip.ambulance.vehicleModel,
    };
  }
  if (trip.vehicle) {
    return {
      registrationNumber: trip.vehicle.registrationNumber,
      type              : trip.vehicle.type,
    };
  }
  return null;
}

// Driver's last reported position plus a rough straight-line distance/ETA
// to the pickup point. Only meaningful before pickup is verified. Shared by
// both tracking endpoints so the number the app shows and the number the
// browser page shows are computed once, not twice.
function trackedDriverPosition(trip) {
  const lat = trip.driver?.availability?.lat;
  const lng = trip.driver?.availability?.lng;
  if (lat == null || lng == null) {
    return { driverLocation: null, distanceToPickupKm: null, etaMinutes: null };
  }

  const driverLocation = { lat, lng, updatedAt: trip.driver.availability.updatedAt };

  if (trip.pickupVerified || trip.pickup?.lat == null || trip.pickup?.lng == null) {
    return { driverLocation, distanceToPickupKm: null, etaMinutes: null };
  }

  const distanceToPickupKm =
    Math.round(haversineKm(lat, lng, trip.pickup.lat, trip.pickup.lng) * 10) / 10;
  const etaMinutes = Math.max(1, Math.round((distanceToPickupKm / ASSUMED_KMPH) * 60));
  return { driverLocation, distanceToPickupKm, etaMinutes };
}

// The one line a customer should read. Collapses the trip lifecycle plus
// its three milestone flags into plain language -- it does NOT change the
// state machine, and nothing branches on the string it returns.
function customerFacingStatus(trip) {
  if (trip.status === 'cancelled')  return 'Trip Cancelled';
  if (trip.status === 'completed')  return 'Trip Completed';
  if (trip.pickupVerified)          return 'On the way to hospital';
  if (trip.arrivedAtPickupAt)       return 'Ambulance has arrived';
  if (trip.status === 'en_route')   return 'Ambulance is on the way';
  if (trip.status === 'dispatched') return trip.driverConfirmed ? 'Driver Assigned' : 'Searching for ambulance';
  return 'Searching for ambulance';
}


// ============================================================
// @route   GET /api/trips/track/:token
// @desc    Public browser tracking, keyed on the random trackingToken
//          rather than the _id. Deliberately a narrower payload than the
//          legacy /:id/track: no pickupOtp, no bill, no payment
//          preference, no raw driver phone -- anyone holding the URL can
//          read this, and the URL travels over WhatsApp and SMS.
// @access  Public
// ============================================================
exports.trackTripByToken = async (req, res, next) => {
  try {
    const trip = await Trip.findOne({ trackingToken: req.params.token })
      .populate('vehicle',   'registrationNumber type')
      .populate('ambulance', 'registrationNumber serviceType serviceTypeLabel vehicleModel')
      .populate('driver',    'name availability ratingSum ratingCount completedTripsCount');

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Tracking link not found or expired.' });
    }

    // Same rule the legacy endpoint applies: a dispatched trip the driver
    // has not accepted yet is still "searching" to the customer, so the
    // driver and vehicle stay hidden rather than appearing prematurely.
    const showDriver = !(trip.status === 'dispatched' && !trip.driverConfirmed) && trip.driver;

    const { driverLocation, distanceToPickupKm, etaMinutes } =
      showDriver ? trackedDriverPosition(trip) : { driverLocation: null, distanceToPickupKm: null, etaMinutes: null };

    const ratingCount = trip.driver?.ratingCount || 0;

    return res.json({
      success: true,
      trip: {
        // Display-only, and the lookup key POST /api/call/connect accepts —
        // that is what lets the browser page place a masked call without
        // ever seeing the driver's number. Already shown to this customer
        // in every WhatsApp template, so it is not a new disclosure.
        tripNumber     : trip.tripNumber,
        status         : trip.status,
        customerStatus : customerFacingStatus(trip),
        driverConfirmed: !!trip.driverConfirmed,
        pickupVerified : !!trip.pickupVerified,
        arrivedAtPickupAt: trip.arrivedAtPickupAt || null,
        tripType       : trip.tripType,

        // Name and rating only. The raw phone is withheld here exactly as
        // it is on the legacy endpoint -- masked calling via
        // POST /api/call/connect is the only route to the driver.
        driver: showDriver ? {
          name               : trip.driver.name,
          ratingAvg          : ratingCount > 0 ? Math.round((trip.driver.ratingSum / ratingCount) * 10) / 10 : null,
          ratingCount,
          completedTripsCount: trip.driver.completedTripsCount || 0,
        } : null,

        vehicle: showDriver ? trackedVehicleInfo(trip) : null,

        pickup     : trip.pickup,
        dropAddress: trip.dropAddress,
        dropLat    : trip.dropLat,
        dropLng    : trip.dropLng,

        driverLocation,
        distanceToPickupKm,
        etaMinutes,

        estimatedDistanceKm : trip.estimatedDistanceKm,
        estimatedDurationSec: trip.estimatedDurationSec,
        estimatedFare       : trip.estimatedFare,

        waitState: trip.getLiveWaitState(),
      },
    });
  } catch (err) {
    next(err);
  }
};


exports.trackTrip = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .select('+pickupOtp')
      .populate('vehicle', 'registrationNumber type')
      .populate('ambulance', 'registrationNumber serviceType serviceTypeLabel vehicleModel year')
      .populate('driver', 'name availability ratingSum ratingCount completedTripsCount')
      .populate('billId');

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found.' });
    }

    // A 'dispatched' trip the driver hasn't tapped Accept on yet
    // (driverConfirmed) is still just "searching" from the customer's
    // point of view — keep reporting 'booked' and withhold driver/vehicle
    // details rather than showing "en route" prematurely. Does not touch
    // trip.status itself or the dispatched -> en_route lifecycle.
    const awaitingDriverAccept = trip.status === 'dispatched' && !trip.driverConfirmed;
    const showDriver = !awaitingDriverAccept && trip.driver;

    // Ambulance-sourced trips (an owner/driver on duty via the mobile
    // app's Ambulance/Assignment system — see ownerController.actAsDriver)
    // never set trip.vehicle at all, only trip.ambulance. Prefer it when
    // present so those trips don't show "Vehicle details pending" forever.
    const vehicleInfo = awaitingDriverAccept ? null : trackedVehicleInfo(trip);

    // Live driver position + a rough distance/ETA to the pickup point —
    // only meaningful pre-pickup (booked/dispatched/en_route-to-pickup).
    // trip.dropLat/dropLng now exist (added alongside the money-loss fix's
    // server-side distance verification, persisted as of this pass) but
    // are optional — older trips or a client that hasn't updated won't
    // have them — so a live ETA to the drop point stays deliberately
    // unbuilt here rather than assuming they're always present; the
    // fields themselves are still returned below for callers that can
    // use them when they exist (see the driver app's proximity gate).
    const { driverLocation, distanceToPickupKm, etaMinutes } = showDriver
      ? trackedDriverPosition(trip)
      : { driverLocation: null, distanceToPickupKm: null, etaMinutes: null };

    const ratingCount = trip.driver?.ratingCount || 0;

    // Full bill breakdown — only once completed, and only the fields
    // that are actually real: trafficWaitMinutes is a schema field never
    // computed anywhere today (no traffic-wait driver action exists), so
    // it's deliberately omitted here rather than shown as a fake ₹0 line.
    // pickupWaitMinutes/dropWaitMinutes/waitCharge ARE real (computed in
    // completeTrip) and included.
    let bill = null;
    if (trip.status === 'completed' && trip.billId) {
      bill = {
        baseFare         : trip.billId.baseFare,
        distanceKm       : trip.billId.distanceKm,
        pickupWaitMinutes: trip.pickupWaitMinutes,
        dropWaitMinutes  : trip.dropWaitMinutes,
        waitCharge       : trip.billId.waitCharge,
        additionalCharges: trip.billId.additionalCharges,
        gstAmount        : trip.billId.gstAmount,
        grandTotal       : trip.billId.grandTotal,
        paymentStatus    : trip.billId.paymentStatus,
        paymentMode      : trip.billId.paymentMode,
      };
    }

    return res.json({
      success: true,
      trip: {
        status        : awaitingDriverAccept ? 'booked' : trip.status,
        // Additive — the app can ignore these; the browser tracking page
        // needs them to tell "on the way" from "has arrived".
        customerStatus   : customerFacingStatus(trip),
        driverConfirmed  : !!trip.driverConfirmed,
        arrivedAtPickupAt: trip.arrivedAtPickupAt || null,
        pickupVerified: trip.pickupVerified,
        // Withheld once verified — no reason to keep displaying a
        // used/stale code (schema's own select:false intent: only the
        // customer ever sees this, and only while it's still needed).
        pickupOtp     : !trip.pickupVerified ? trip.pickupOtp : undefined,
        paymentPreference: trip.paymentPreference,
        driver        : showDriver ? {
          name               : trip.driver.name,
          ratingAvg          : ratingCount > 0 ? Math.round((trip.driver.ratingSum / ratingCount) * 10) / 10 : null,
          ratingCount,
          completedTripsCount: trip.driver.completedTripsCount || 0,
        } : null,
        vehicle       : vehicleInfo,
        pickup        : trip.pickup,
        dropAddress   : trip.dropAddress,
        dropLat       : trip.dropLat,
        dropLng       : trip.dropLng,
        driverLocation,
        distanceToPickupKm,
        etaMinutes,
        estimatedDistanceKm: trip.estimatedDistanceKm,
        estimatedFare      : trip.estimatedFare,
        bill,
        waitState: trip.getLiveWaitState(),
      },
    });
  } catch (err) {
    next(err);
  }
};