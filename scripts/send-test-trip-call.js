/**
 * scripts/send-test-trip-call.js
 * ============================================================
 * One-off manual test: sends a single raw FCM data message straight to a
 * device token, using the exact same code path as utils/fcmService.js
 * (same payload shape, same data-only/no-notification-block message).
 * Bypasses the database and the real dispatch flow entirely — no trip
 * document is created or touched, no real driver is notified unless you
 * paste their token in, which you should never do for this test.
 *
 * Usage:
 *   node scripts/send-test-trip-call.js <fcmToken>
 *
 * Requires FIREBASE_SERVICE_ACCOUNT to be set in the environment (same as
 * production/utils/fcmService.js) — run this with your normal .env loaded,
 * e.g. via `node -r dotenv/config scripts/send-test-trip-call.js <token>`.
 * ============================================================
 */
'use strict';

require('dotenv').config();

const token = process.argv[2];
if (!token) {
  console.error('Usage: node scripts/send-test-trip-call.js <fcmToken>');
  process.exit(1);
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not set in the environment.');
  process.exit(1);
}

const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const serviceAccount = JSON.parse(raw);
initializeApp({ credential: cert(serviceAccount) });
const messaging = getMessaging();

// Same field shape utils/fcmService.js sends and IncomingTripScreen.js/
// modules/trip-call expect — tripId is the only field the app's handlers
// treat as required (index.js's task bails out early if it's missing).
const data = {
  tripId: 'test-' + Date.now(),
  tripNumber: 'TEST-0001',
  patientName: 'Test Patient',
  pickupAddress: '123 Test Street, Bengaluru',
  dropAddress: 'Test Hospital, Bengaluru',
  distanceKm: '4.2',
  fare: '450',
  selectedType: 'bls',
};

messaging
  .send({
    token,
    data,
    android: { priority: 'high' },
  })
  .then((messageId) => {
    console.log('Sent OK — messageId:', messageId);
    console.log('Payload:', data);
  })
  .catch((err) => {
    console.error('Send FAILED —', err.code || '', err.message);
    process.exit(1);
  });
