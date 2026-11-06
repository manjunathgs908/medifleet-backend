'use strict';
/**
 * services/callCapture/extract.js
 * ============================================================
 * LIVE CALL CAPTURE — booking details from the transcript so far, with
 * gpt-6-astra (AI_EXTRACT_MODEL) in strict JSON. The model is told to
 * leave anything not clearly said blank; THIS file then checks what it
 * returned rather than trusting it:
 *
 *   - a phone number counts only if those 10 digits were actually said
 *   - a service code must be a bookable Pricing serviceType
 *   - a time must be a real 'YYYY-MM-DD HH:mm', and only for 'later'
 *
 * merge(): a later blank never erases a value already captured (a model
 * run that missed it is not the caller taking it back); a later different
 * value replaces it (the caller corrected themselves).
 * ============================================================
 */
const { extractJson } = require('../openaiService');
const { bookableServices } = require('../aiCaller/tools');
const { normalisePhone } = require('../../utils/phone');
const config = require('./config');

const isMobile = (ten) => /^[6-9]\d{9}$/.test(ten);

const INSTRUCTIONS = `You read a live phone call between a customer and a SaveLife Health Services operator (an ambulance and medical transport company in Bengaluru) and fill in a booking form.
The call may be in Kannada, English, Hindi, Tamil, Telugu or a mix. Write every field in English letters.

RULES:
- Fill a field ONLY if the customer said it, or clearly confirmed it when the operator read it back. Otherwise leave it as "" (empty).
- NEVER guess, assume or invent anything. A wrong value is worse than a blank one.
- patient_name: the patient's name (or the caller's, if they are the patient).
- patient_phone: a contact number as digits only, exactly as said. Blank if not said in full.
- pickup / drop: the places as said — area, street, landmark or hospital name. Not a guess at the full address.
- service_code: one of the codes given, ONLY if the kind of ambulance/service is clear from the call.
- when: "now" if they need it immediately, "later" if they gave a future time, else "".
- scheduled_time: only for "later": India time as YYYY-MM-DD HH:mm, worked out from the current India time given. Else "".
- summary: one or two lines for the team: what the caller needs and what was agreed. Facts from the call only — no medical advice, opinion or assessment. "" unless asked for.
- If the caller changes a detail, use the latest one.`;

function schemaFor(services) {
  const str = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['patient_name', 'patient_phone', 'pickup', 'drop', 'service_code', 'when', 'scheduled_time', 'summary'],
    properties: {
      patient_name  : str,
      patient_phone : str,
      pickup        : str,
      drop          : str,
      service_code  : { type: 'string', enum: ['', ...services.map((s) => s.code)] },
      when          : { type: 'string', enum: ['', 'now', 'later'] },
      scheduled_time: str,
      summary       : str,
    },
  };
}

const LABEL = { customer: 'Customer', operator: 'Operator' };
const transcriptText = (transcript) => transcript.map((t) => `${LABEL[t.role] || t.role}: ${t.text}`).join('\n');

// India time now, as the model needs it to turn "tomorrow 9 am" into a date.
function indiaNow(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The model's answer -> fields we trust, '' for anything that fails a check.
function validate(raw, transcript, services = bookableServices()) {
  const said = transcript.map((t) => t.text).join(' ').replace(/\D/g, '');
  const phone = normalisePhone(clean(raw?.patient_phone, 30));
  const when = ['now', 'later'].includes(raw?.when) ? raw.when : '';
  const time = clean(raw?.scheduled_time, 20).replace('T', ' ');
  const validTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time) && !Number.isNaN(Date.parse(time.replace(' ', 'T')));
  return {
    patientName : clean(raw?.patient_name, 80),
    patientPhone: isMobile(phone) && said.includes(phone) ? phone : '',
    pickupText  : clean(raw?.pickup),
    dropText    : clean(raw?.drop),
    serviceType : services.some((s) => s.code === raw?.service_code) ? raw.service_code : '',
    scheduleType: when,
    scheduleAt  : when === 'later' && validTime ? time.replace(' ', 'T') : '',
    summary     : clean(raw?.summary, 400),
  };
}

const FIELDS = ['patientName', 'patientPhone', 'pickupText', 'dropText', 'serviceType', 'scheduleType', 'scheduleAt'];

// Returns the merged fields and which of them changed.
function merge(current = {}, next = {}) {
  const merged = { ...current };
  const changed = [];
  for (const k of FIELDS) {
    if (next[k] && next[k] !== current[k]) { merged[k] = next[k]; changed.push(k); }
  }
  if (merged.scheduleType === 'now' && merged.scheduleAt) { merged.scheduleAt = ''; changed.push('scheduleAt'); }
  return { merged, changed };
}

async function extractFields(transcript, { final = false, now = new Date() } = {}) {
  const services = bookableServices();
  const raw = await extractJson({
    model: config.extractModel(),
    name: 'call_booking',
    instructions: INSTRUCTIONS,
    schema: schemaFor(services),
    input: `Current India time: ${indiaNow(now)}\n`
      + `Service codes: ${services.map((s) => `${s.code} = ${s.label}`).join('; ')}\n`
      + `Write a summary: ${final ? 'yes' : 'no'}\n\n`
      + `TRANSCRIPT SO FAR:\n${transcriptText(transcript)}`,
  });
  return validate(raw, transcript, services);
}

module.exports = { extractFields, validate, merge, transcriptText, indiaNow, INSTRUCTIONS, FIELDS };
