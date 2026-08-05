'use strict';
const { sendText } = require('./whatsappService');

// Stub only -- logs the incoming message and echoes it back so the
// webhook <-> Cloud API round trip can be verified end to end. The real
// booking flow (step machine driven by WhatsAppSession) replaces this.
async function handleMessage(message) {
  console.log('[whatsappFlow] Received message:', JSON.stringify(message));

  const from = message?.from;
  const text = message?.text?.body || `[${message?.type || 'unknown'} message]`;

  if (!from) {
    console.warn('[whatsappFlow] Message had no from field, cannot reply:', message?.id);
    return;
  }

  await sendText(from, `Echo: ${text}`);
}

module.exports = { handleMessage };
