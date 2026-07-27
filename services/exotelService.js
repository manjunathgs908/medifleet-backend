const axios = require('axios');

const SID = process.env.EXOTEL_SID;
const KEY = process.env.EXOTEL_API_KEY;
const TOKEN = process.env.EXOTEL_API_TOKEN;
const SUBDOMAIN = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
const CALLER_ID = process.env.EXOTEL_CALLER_ID;

const BASE = `https://${SUBDOMAIN}/v1/Accounts/${SID}`;
const auth = { username: KEY, password: TOKEN };

function normalize(num) {
  if (!num) return null;
  let n = String(num).replace(/[^\d+]/g, '');
  if (n.startsWith('+91')) return n;
  if (n.startsWith('91') && n.length === 12) return '+' + n;
  if (n.length === 10) return '+91' + n;
  if (n.startsWith('0') && n.length === 11) return '+91' + n.slice(1);
  return n;
}

/**
 * Masked call. Exotel dials `from` first; once answered it dials `to`
 * and bridges them. Both parties only ever see CallerId (our ExoPhone).
 */
async function connectCall({ from, to, callerId, statusCallbackUrl, timeLimit = 3600 }) {
  const params = new URLSearchParams();
  params.append('From', normalize(from));
  params.append('To', normalize(to));
  params.append('CallerId', callerId || CALLER_ID);
  params.append('CallType', 'trans');
  params.append('TimeLimit', String(timeLimit));
  params.append('TimeOut', '30');
  if (statusCallbackUrl) params.append('StatusCallback', statusCallbackUrl);

  const res = await axios.post(`${BASE}/Calls/connect.json`, params, {
    auth,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return res.data?.Call;
}

async function getCallDetails(callSid) {
  const res = await axios.get(`${BASE}/Calls/${callSid}.json`, { auth, timeout: 15000 });
  return res.data?.Call;
}

module.exports = { connectCall, getCallDetails, normalize };
