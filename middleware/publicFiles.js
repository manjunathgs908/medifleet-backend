'use strict';
/**
 * middleware/publicFiles.js
 * ============================================================
 * Serves public/ at the site root (server.js, before the API routes):
 *
 *   public/welcome-banner.png -> https://api.savelife.health/welcome-banner.png
 *     the 1200x628 header image of the "savelife_welcome" WhatsApp template
 *     (WA_WELCOME_IMAGE_URL, services/callWelcome.js) — WhatsApp's servers
 *     fetch it on every send, so it must stay at this URL.
 *
 * Deliberately public, no auth: only images meant for anyone belong in
 * public/. Only an exact existing file name matches — no directory index,
 * no dotfiles — and everything else falls through to the API untouched.
 * Cross-Origin-Resource-Policy: cross-origin (helmet's default is
 * same-origin) so the CRM and website may show these images too.
 * ============================================================
 */
const path = require('path');
const express = require('express');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

module.exports = express.static(PUBLIC_DIR, {
  index: false,
  dotfiles: 'ignore',
  fallthrough: true,
  maxAge: '1d',
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
});
module.exports.PUBLIC_DIR = PUBLIC_DIR;
