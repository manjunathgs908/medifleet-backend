/**
 * utils/pushService.js
 * ============================================================
 * Thin wrapper around expo-server-sdk. Every call site in
 * tripController.js treats this as fire-and-forget — a push failure
 * (invalid/stale token, Expo outage, etc.) must never break the actual
 * trip-lifecycle action it's attached to, so every failure is caught
 * and logged here, never thrown back to the caller.
 * ============================================================
 */
'use strict';

const { Expo } = require('expo-server-sdk');

const expo = new Expo();

// title/body shown in the OS notification; data is delivered to the app
// for tap-to-navigate (e.g. { tripId }). token may be null/undefined
// (no token registered yet) — silently no-ops rather than erroring,
// since not having registered for push is a completely normal state.
//
// priority:'high' + channelId — without these, Android can defer delivery
// under Doze until the screen turns back on (arrives late, or all bunched
// up at once instead of when dispatched). channelId must match the
// 'trip-alerts' channel medifleet-app creates via setNotificationChannelAsync
// (App.js) — Android routes a push to the app's default/low-importance
// channel if the two don't match, silently losing the heads-up behavior
// even with priority:'high' set here.
exports.sendPush = async (token, title, body, data = {}) => {
  try {
    if (!token || !Expo.isExpoPushToken(token)) return;
    await expo.sendPushNotificationsAsync([{
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'trip-alerts',
    }]);
  } catch (err) {
    console.error('Push send failed:', err.message);
  }
};
