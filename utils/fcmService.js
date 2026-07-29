/**
 * utils/fcmService.js
 * ============================================================
 * Raw FCM send path for the full-screen incoming-trip card (Phase 2).
 * Fully separate from utils/pushService.js's Expo-relay sendPush — this
 * sends data-only messages directly via firebase-admin so
 * messaging().setBackgroundMessageHandler (medifleet-app's index.js) is
 * what receives it, not Android's own auto-displayed tray notification.
 * If a `notification` block were present, Android would show its own tray
 * notification and the app's background handler would never run to build
 * the full-screen card — so this message deliberately has none.
 *
 * Additive and independent: if this module fails to initialise (missing/
 * invalid FIREBASE_SERVICE_ACCOUNT), it logs one warning at startup and
 * every subsequent send is a silent no-op. It must never affect server
 * boot or utils/pushService.js's Expo push path, which is untouched.
 *
 * Uses firebase-admin's modern modular API (verified against the actually
 * installed v14 package — the old `admin.credential.cert()`/
 * `admin.messaging()` namespaced API from earlier major versions no longer
 * exists on the top-level `firebase-admin` export).
 * ============================================================
 */
'use strict';

let messaging = null;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    console.warn('[fcmService] FIREBASE_SERVICE_ACCOUNT is not set — full-screen trip pushes will be a no-op. Expo push (utils/pushService.js) is unaffected.');
  } else {
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');

    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessaging();
  }
} catch (err) {
  console.warn(`[fcmService] Could not initialise firebase-admin (${err.message}) — full-screen trip pushes will be a no-op. Expo push (utils/pushService.js) is unaffected.`);
}

// fcmToken/trip may be missing or incomplete — always no-ops rather than
// throwing, same fire-and-forget contract as sendPush. FCM data payloads
// only accept strings, so every field is coerced explicitly.
//
// Logs one line per attempt, every branch — not just failures. Render logs
// otherwise give no way to tell "this was never called", "it was called
// but skipped (no messaging/token/trip)", and "it was called and actually
// sent" apart from each other.
exports.sendFullScreenTrip = async (fcmToken, trip) => {
  const tripId = trip?._id?.toString() || '(no trip)';

  if (!messaging) {
    console.log(`[fcmService] sendFullScreenTrip skipped for trip ${tripId} — firebase-admin not initialised.`);
    return;
  }
  if (!fcmToken) {
    console.log(`[fcmService] sendFullScreenTrip skipped for trip ${tripId} — no fcmToken on driver.`);
    return;
  }
  if (!trip) {
    console.log('[fcmService] sendFullScreenTrip skipped — no trip provided.');
    return;
  }

  try {
    const fare = (trip.baseFare || 0) + (trip.additionalCharges || 0);

    const messageId = await messaging.send({
      token: fcmToken,
      // No `notification` field — see file header. Data-only.
      data: {
        tripId       : trip._id?.toString() || '',
        tripNumber   : trip.tripNumber || '',
        patientName  : trip.patientName || '',
        pickupAddress: trip.pickup?.address || '',
        dropAddress  : trip.dropAddress || '',
        distanceKm   : String(trip.distanceKm ?? ''),
        fare         : String(fare),
        selectedType : trip.selectedType || '',
      },
      android: {
        priority: 'high',
      },
    });

    console.log(`[fcmService] sendFullScreenTrip OK for trip ${tripId} — messageId: ${messageId}`);
  } catch (err) {
    console.error(`[fcmService] sendFullScreenTrip FAILED for trip ${tripId} — ${err.code || ''} ${err.message}`);
  }
};
