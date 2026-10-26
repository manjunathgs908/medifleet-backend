/**
 * scripts/plivo-setup.js
 * ============================================================
 * One-time Plivo wiring for incoming calls:
 *
 *   1. Finds (or creates) the Plivo Application "SaveLife CRM" and points
 *      it at this backend:
 *        answer_url  POST https://api.savelife.health/api/calls/incoming
 *        hangup_url  POST https://api.savelife.health/api/calls/events
 *   2. Links PLIVO_NUMBER (918065591088) to that application, so a
 *      customer calling the company number reaches /api/calls/incoming.
 *
 * Outbound click-to-call needs none of this — it passes its own URLs on
 * every call. Safe to re-run: it updates rather than duplicates.
 *
 * Run where the PLIVO_* variables are set (the Render shell):
 *   node scripts/plivo-setup.js            # apply
 *   node scripts/plivo-setup.js --dry-run  # show what it would do
 * ============================================================
 */
'use strict';
require('dotenv').config();
const plivo = require('plivo');

const APP_NAME = 'SaveLife CRM';
const BASE = (process.env.PUBLIC_API_BASE_URL || 'https://api.savelife.health').replace(/\/+$/, '');
const ANSWER_URL = `${BASE}/api/calls/incoming`;
const HANGUP_URL = `${BASE}/api/calls/events`;
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_NUMBER } = process.env;
  if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !PLIVO_NUMBER) {
    throw new Error('Set PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_NUMBER first.');
  }
  const number = String(PLIVO_NUMBER).replace(/\D/g, '');
  const client = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);

  const apps = await client.applications.list({ limit: 20 });
  const existing = (apps || []).find((a) => a.appName === APP_NAME);
  const settings = { answerUrl: ANSWER_URL, answerMethod: 'POST', hangupUrl: HANGUP_URL, hangupMethod: 'POST' };

  console.log(`Application "${APP_NAME}": ${existing ? `found (${existing.appId})` : 'not found, will create'}`);
  console.log(`  answer_url ${ANSWER_URL}\n  hangup_url ${HANGUP_URL}`);
  console.log(`Number ${number} -> this application`);
  if (dryRun) { console.log('Dry run: nothing changed.'); return; }

  let appId = existing?.appId;
  if (existing) {
    await client.applications.update(appId, settings);
  } else {
    const created = await client.applications.create(APP_NAME, settings);
    appId = created.appId;
  }
  await client.numbers.update(number, { appId });
  console.log(`Done. Application ${appId} answers ${number}.`);
}

main().catch((err) => {
  console.error('Plivo setup failed:', err?.message || err);
  process.exit(1);
});
