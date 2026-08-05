'use strict';
const axios = require('axios');

const WA_TOKEN           = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API_VERSION     = process.env.WA_API_VERSION || 'v25.0';

const BASE_URL = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
  console.warn('[whatsappService] WA_TOKEN/WA_PHONE_NUMBER_ID not set -- sends will fail until .env is filled in.');
}

// Every send function below builds a payload and funnels through here --
// one place that actually calls the API, wraps errors, and logs, rather
// than five copies of the same try/catch. Never throws: a WhatsApp send
// failure (bad token, invalid template, rate limit) must not crash
// whatever flow step triggered it -- callers check the return value
// (null on failure) instead of relying on a caught exception.
async function sendMessage(payload) {
  try {
    const res = await axios.post(BASE_URL, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    console.error('[whatsappService] Send failed:', err.response?.data || err.message);
    return null;
  }
}

async function sendText(to, body) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

// buttons: [{id, title}], max 3 -- WhatsApp's own limit for interactive
// reply buttons; sliced defensively here rather than letting the API
// reject an oversized array outright.
async function sendButtons(to, bodyText, buttons) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: (buttons || []).slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// sections: [{ title, rows: [{ id, title, description }] }]
async function sendList(to, bodyText, buttonLabel, sections) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections: sections || [],
      },
    },
  });
}

async function sendTemplate(to, templateName, languageCode, components) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components || [],
    },
  });
}

async function sendDocument(to, link, filename) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { link, filename },
  });
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, sendDocument };
