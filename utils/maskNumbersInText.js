'use strict';

// Phone numbers said on a call end up in its transcript. Like every other
// customer number (utils/customerPhone.js), they go out masked —
// "••••••4442" — to everyone except a signed-in CRM owner
// (utils/phoneViewer.js). Catches 10 digits with or without +91 / 0 and
// spaces or dashes between them ("98450 12345", "+91-98450-12345").
const { revealPhones } = require('./phoneViewer');

const NUMBER = /(?<!\d)(?:\+?91[\s-]?|0)?(?:\d[\s-]?){9}\d(?!\d)/g;

function maskNumbersInText(text) {
  if (!text || revealPhones()) return text;
  return String(text).replace(NUMBER, (m) => `••••••${m.replace(/\D/g, '').slice(-4)}`);
}

module.exports = { maskNumbersInText };
