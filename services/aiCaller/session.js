'use strict';
/**
 * services/aiCaller/session.js
 * ============================================================
 * AI TELECALLER — PILOT. One live call's conversation: Plivo's two-way
 * audio stream (8 kHz mu-law) bridged to an OpenAI GPT-Live session
 * (wss://api.openai.com/v1/live/sessions) — a voice model (gpt-live-1)
 * that delegates tool work to a Responses model (AI_DELEGATE_MODEL).
 *
 * GPT-Live protocol (not the older /v1/realtime one):
 *   -> session.start { session: { model, instructions, audio: { format:
 *        audio/pcmu 8000, output: { voice } }, delegation: { type:
 *        'responses', responses: { model, tools, ... } } } }   (strict:
 *        unknown fields are rejected)
 *   <- session.started                          ready; only then send audio
 *   -> session.input_audio.append { audio }     Plivo media, as-is
 *   <- session.output_audio.delta { delta }     -> Plivo playAudio
 *   <- session.input_transcript.delta / session.output_transcript.delta
 *                                               fragments; joined into turns
 *   <- response.event { event: response.output_item.done function_call }
 *   -> response.item.create function_call_output, then response.create
 *   -> session.commentary.append                 text it should say aloud
 *   -> session.close / <- session.closed { usage }
 *
 * Every handshake rejection, error event and close (code + reason) is
 * logged with [aiCaller] and stored on the AiCall (openaiClose /
 * openaiErrors) so a failed call explains itself.
 *
 * Hard rules enforced here, not left to the model:
 *   - the first thing said is the opening: hello, the disclosure
 *     (automated assistant, call recorded) Kannada then English, then
 *     "ambulance ಬೇಕಾ?";
 *   - no medical advice (instructions) — and words of a real medical
 *     emergency from the caller (DISTRESS: unconscious, not breathing...)
 *     hand the call to a person at once. "Urgent" alone never does;
 *   - a hard time limit (config.maxCallSeconds): booked already -> a
 *     goodbye and hang up; otherwise a person ('time_limit');
 *   - GPT-Live dropping mid-call reconnects (MAX_AI_RECONNECTS) with the
 *     conversation so far, and the call carries on;
 *   - BARGE-IN: GPT-Live has no "cancel response" event and audio already
 *     sent to Plivo keeps playing, so the bridge does it: caller speech
 *     (energy of the inbound mu-law, AI_BARGE_IN_RMS for AI_BARGE_IN_MS —
 *     longer than a "ಹೂಂ") while Sahana is audible sends Plivo clearAudio,
 *     and her audio is held back until the caller has been quiet for
 *     AI_CALLER_DONE_MS. The opening (the recording notice) is never cut;
 *   - LANGUAGE: an explicit request ("ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ", "English please")
 *     locks the language at once (session.instructions.append) until the
 *     caller asks again — never inferred from transcript letters;
 *   - CLAIM GUARDS: a price before get_quote, "link sent" without a
 *     successful WhatsApp send, or "booked" before create_booking
 *     succeeded is cut off mid-sentence (clearAudio) and corrected;
 *   - BOOKING APPROVAL: create_booking asks the session (ctx.approval)
 *     whether the caller's own words after the read-back were a clear yes;
 *   - ANY failure hands off to a person. The session never transfers or
 *     hangs up through Plivo's REST API: it records the next step on the
 *     AiCall and closes the stream, and Plivo's <Redirect> after <Stream>
 *     fetches it (calls.nextXml).
 * ============================================================
 */
const WebSocket = require('ws');
const AiCall = require('../../models/AiCall');
const config = require('./config');
const calls = require('./calls');
const tools = require('./tools');
const prompt = require('./prompt');
const styleExamples = require('./styleExamples');
const servicesKnowledge = require('./servicesKnowledge');
const approvalWords = require('./approval');
const { detectLanguageRequest } = require('./language');
const spokenLanguage = require('./spokenLanguage');

const OPENAI_CONNECT_TIMEOUT_MS = 10000; // socket open + session.started
const HANGUP_AFTER_GOODBYE_MS = 8000;    // if Plivo never confirms the goodbye finished playing
const SESSION_CLOSE_WAIT_MS = 3000;      // for session.closed (final usage) after session.close
const TURN_IDLE_MS = 1500;               // a speaker's transcript fragments -> one turn after this quiet
const MAX_AI_RECONNECTS = 2;             // a GPT-Live drop mid-call: reconnect and carry on, up to this many times
const RECENT_TURNS = 40;                 // conversation kept in memory, handed to a reconnected session
const TIME_UP_GOODBYE_MS = 7000;         // time limit after a booking: the goodbye plays, then the call ends
const MAX_TRANSCRIPT = 200;
const VOICE_GAP_MS = 250;      // a gap this short inside caller speech does not end it
const MAX_HOLD_MS = 8000;      // noise that never stops (traffic, a siren) cannot mute Sahana for longer
const STRETCH_GAP_MS = 800;    // Sahana's audio closer together than this is one stretch of speech
const OPENING_PROTECT_MAX_MS = 20000;
const APPROVAL_WAIT_MS = 2500; // the caller's "yes" transcript may land just after the tool call
const ACK_SILENCE_MS = 350;    // a short sound followed by this much quiet was an acknowledgement ("ಹೂಂ", "हाँ")
const STRETCH_BREAK_VOICE_MS = 200; // any real caller speech ends Sahana's current stretch of speech
const TAIL_GRACE_MS = 1800;    // cut within the last 1.8 s ("ಬುಕ್ ಮಾಡಲಾ?", "ಧನ್ಯವಾದ"): the read-back still counts as heard
const ANSWER_OVERLAP_MS = 1500; // a "yes" over the closing question counts as the answer
const HANDOFF_AFTER_LINE_MS = 6000;
// Words that are only an acknowledgement — they never cut Sahana off.
// Includes the dialect forms real callers use ("ಆವದು" for ಹೌದು, "ಮೇಡ"),
// "ಹಲೋ" (checking the line), and Kannada heard in Telugu letters.
const ACK_WORDS = /^(?:ಹೂಂ|ಹೂ|ಹಾ|ಹಾಂ|ಹ|ಆ|ಆಂ|ಓ|ಜಿ|ಜೀ|ಹೌದು|ಹೌದಾ|ಆವದು|ಆವುದು|ಆವದಾ|ಆವುದಾ|ಸರಿ|ಸರೀ|ಓಕೆ|ಓಕೇ|ಮೇಡ|ಮೇಡಮ್|ಮೇಡಂ|ಮ್ಯಾಡಮ್|ಸರ್|ಸಾರ್|ಆಯ್ತು|ಆಯ್ತಾ|ಹಲೋ|ಹೆಲೋ|ಹೇಳಿ|ok|okk|okay|haan|han|ha|hmm|hm|ji|yes|yeah|hello|helo|madam|sir|accha|achha|theek|thik|हाँ|हां|हा|हम्म|जी|ठीक|है|अच्छा|हैलो|हेलो|हलो|అవును|సరే|ఆ|హా|ఆవదు|హలో|మేడమ్|మేడం|ம்ம்|சரி|ஆமா|ஹலோ|ശരി|അതെ|ഉം|ഹലോ)$/i;
// One or two Indic letters on their own ("ಹ", "ಆ", "ಓ") are a sound, not a word.
const TINY_INDIC = /^[\u0900-\u0D7F]{1,2}$/;
const isOnlyAck = (text) => String(text || '').toLowerCase().replace(/[.,!?।\-–—]/g, ' ').split(/\s+/).filter(Boolean).every((w) => ACK_WORDS.test(w) || TINY_INDIC.test(w));
// Acknowledgements are never a reason to cut her off, however long they go
// on — only this much continuous sound with nothing else heard.
const ACK_MAX_MS = 4000;
// The booking watchdog (see watchBooking).
const BOOK_NUDGE_MS = 3000;   // caller approved / asked: remind the model to book
const BOOK_SELF_MS = 8000;    // approved read-back still not booked: the server books it
const BOOK_STUCK_MS = 25000;  // asked to book, no booking step at all: a person takes over with the details
// Signs a booking is stuck: she stalls, or the caller asks again / asks if it is done.
const STALL_WORDS = /ಮುಂದುವರಿಸ್ತ|ಮುಂದುವರಿಸುತ್ತ|ಪ್ರಕ್ರಿಯೆ|ಲೈನ್‌?ನಲ್ಲಿ ಇರಿ|ಸ್ವಲ್ಪ ಸಮಯ ಕೊಡಿ|ಮುಗಿಸುತ್ತಿದ್ದೀನಿ|ದೃಢಪಡಿಸ್ತಿದ್ದ|processing|please wait|hold on|stay on the line|प्रोसेस|रुकिए|लाइन पर रहिए/i;
const ASKED_AGAIN = /ಆಯ್ತಾ|ಆಗಿಲ್ಲ|ಎಷ್ಟೊತ್ತ|ಜಾಸ್ತಿ ಟೈಮ್|ಮಾಡಿ ಮೇಡಮ್|ಬೇಗ|is it done|how long|हो गया क्या|कितना टाइम/i;
const BOOK_REQUEST = /ಬುಕ್ ಮಾಡಿ|ಬುಕ್ ಮಾಡ್ಕೊಡಿ|ಬುಕ್ ಮಾಡ್ಕ|ಬುಕ್ಕಿಂಗ್ ಮಾಡಿ|ಬುಕ್ ಮಾಡ್ಬಿಡಿ|\bbook (it|now|pannunga|cheyandi)\b|please book|बुक कर|बुकिंग कर|బుక్ చేయ|புக் பண்ண|ബുക്ക് ചെയ്യ/i;
const MAX_CALLER_FRAGMENTS = 400;

// The opening, said as soon as the call connects: hello, the disclosure
// (automated assistant, call recorded) in Kannada then English, then the
// question — quick and natural. (Kannada wording to be checked by a native
// speaker before widening the pilot.)
// She is Sahana (ಸಹನ).
// ONE short line (callers are often panicked), then the question at once.
// A caller who answers in another language hears the disclosure once in
// theirs (instructions) — DISCLOSURE_EN is that line in English.
const DISCLOSURE_KN = 'ನಮಸ್ಕಾರ, ನಾನು ಸಹನ, SaveLife automated assistant, ಕರೆ ದಾಖಲಾಗ್ತಿದೆ.';
const DISCLOSURE_EN = "I'm Sahana, SaveLife's automated assistant; this call is recorded.";
const OPENING_QUESTION = 'Ambulance ಬೇಕಾ?';
const OPENING = `${DISCLOSURE_KN} ${OPENING_QUESTION}`;
// After GPT-Live reconnected mid-call, and when the time limit ends a call
// that is already booked.
const RESUME_LINE = 'ಕ್ಷಮಿಸಿ, ಲೈನ್ ಸ್ವಲ್ಪ ಕಟ್ ಆಯ್ತು.';

// NEVER A GUESSED PRICE. A rupee amount may only be said after get_quote
// returned a real one in this call (s.state.quote). If the assistant starts
// saying one before that, its audio is cut at once (Plivo clearAudio) and
// it says PRICE_HOLD_LINE instead — a test call once said "₹5000" with no
// quote and had to retract it. Rupee words in the call languages; plain
// numbers (times, km, trip numbers) are not prices and are left alone.
const PRICE_WORDS = /₹|\brs\.?\s*\d|rupee|rupay|ರೂಪಾಯ|ರೂ\.|रुपय|रुपए|रुपये|రూపాయ|ரூபாய்|രൂപ/i;
const PRICE_HOLD_LINE = 'ಒಂದು ನಿಮಿಷ, ನಿಖರ ದರ ಹೇಳ್ತೀನಿ.';
const saysPrice = (text) => PRICE_WORDS.test(String(text || ''));
const TIME_UP_BOOKED_LINE = 'ನಿಮ್ಮ ಬುಕ್ಕಿಂಗ್ ಆಗಿದೆ, ನಮ್ಮ ತಂಡ ಸ್ವಲ್ಪ ಹೊತ್ತಲ್ಲಿ ಕರೆ ಮಾಡುತ್ತಾರೆ. ಧನ್ಯವಾದಗಳು!';

// "Link sent" only after send_location_request really sent it (tools set
// state.whatsapp). After a failed / switched-off send, not even "I'll send
// it" — Sahana asks for the address on the call instead.
const WA_WORD = '(?:whats ?app|ವಾಟ್ಸ್ ?ಆ?ಪ್|ವಾಟ್ಸಾಪ್|ವಾಟ್ಸಪ್|ಲಿಂಕ್|\\blink\\b|ಮೆಸೇಜ್|व्हाट्सएप|व्हाट्सऐप|लिंक|వాట్సాప్|లింక్|வாட்ஸ்அப்|லிங்க்|വാട്സ്ആപ്പ്|ലിങ്ക്)';
const WA_SENT = '(?:ಕಳಿಸಿದ್ದ|ಕಳುಹಿಸಿದ್ದ|ಕಳಿಸಿದೆ|ಕಳುಹಿಸಿದೆ|ಕಳಿಸಿದೀನಿ|ಕಳ್ಸಿದ್ದೀನಿ|ಕಳ್ಸಿದೀನಿ|\\bsent\\b|भेज दिया|भेजा है|भेज दी|పంపాను|పంపించాను|அனுப்பிட்டேன்|அனுப்பியிருக்கேன்|അയച്ചിട്ടുണ്ട്|അയച്ചു)';
const WA_WILL = '(?:ಕಳಿಸ್ತೀನಿ|ಕಳಿಸುತ್ತೇನೆ|ಕಳುಹಿಸುತ್ತೇನೆ|ಕಳಿಸ್ತೇನೆ|ಕಳ್ಸ್ತೀನಿ|\\bsend\\b|\\bsending\\b|भेज रही|भेजती|పంపిస్తాను|పంపుతాను|அனுப்புறேன்|അയയ്ക്കാം)';
const near = (a, b) => new RegExp(`${a}[^.?!।]{0,60}${b}|${b}[^.?!।]{0,30}${a}`, 'i');
const WA_SENT_CLAIM = near(WA_WORD, WA_SENT);
const WA_PROMISE = near(WA_WORD, WA_WILL);
// "Booked" only after create_booking returned ok.
const BOOKED_CLAIM = /ಬುಕ್ಕಿಂಗ್ ಆ(?:ಯ್ತು|ಗಿದೆ|ಯಿತು)|ಬುಕ್ ಆ(?:ಯ್ತು|ಗಿದೆ|ಯಿತು)|ಬುಕ್ ಮಾಡಿದ್ದ(?:ೀನಿ|ೇನೆ)|ಬುಕ್ಕಿಂಗ್ ಕನ್ಫರ್ಮ್ ಆ|booking (?:is )?(?:done|confirmed|complete)|(?:is|been|have) booked|booked (?:it|your|the)|बुकिंग हो गई|बुक हो गया|बुक हो गई|बुक कर दिया|బుక్ అయ్యింది|బుక్ చేశాను|బుకింగ్ అయింది|புக் ஆயிடுச்சு|புக் பண்ணிட்டேன்|ബുക്ക് ചെയ്തു|ബുക്കിംഗ് ആയി/i;
const HOLD_LINE = 'ಕ್ಷಮಿಸಿ, ಲಿಂಕ್ ಇನ್ನೂ ಕಳಿಸಿಲ್ಲ.';
const WHATSAPP_FAILED_LINE = 'ಕ್ಷಮಿಸಿ, WhatsApp ಕಳಿಸೋಕೆ ಆಗ್ಲಿಲ್ಲ. ನಿಮ್ಮ address ಅಥವಾ ಹತ್ತಿರದ landmark ಹೇಳಿ.';
const NOT_BOOKED_LINE = 'ಬುಕ್ಕಿಂಗ್ ಇನ್ನೂ ಖಚಿತ ಆಗಿಲ್ಲ.';
// The fixed lines, in the language the caller asked for (Kannada default;
// Telugu / Tamil / Malayalam get the English text, which the voice model
// says in the locked language).
const LINES = {
  kn: {
    price: PRICE_HOLD_LINE, hold: HOLD_LINE, waFailed: WHATSAPP_FAILED_LINE, notBooked: NOT_BOOKED_LINE, resume: RESUME_LINE, timeUp: TIME_UP_BOOKED_LINE,
    booked: 'ಬುಕ್ಕಿಂಗ್ ಆಯ್ತು. ಟ್ರಿಪ್ ನಂಬರ್ {trip}. ನಮ್ಮ ತಂಡ ಸ್ವಲ್ಪ ಹೊತ್ತಲ್ಲಿ ಕರೆ ಮಾಡಿ ವಾಹನವನ್ನು ಖಚಿತಪಡಿಸ್ತಾರೆ.',
    stuck: 'ಕ್ಷಮಿಸಿ, ನಮ್ಮ ತಂಡದವರು ಈಗಲೇ ನಿಮ್ಮ ಬುಕ್ಕಿಂಗ್ ಖಚಿತಪಡಿಸ್ತಾರೆ.',
  },
  hi: {
    price: 'एक मिनट, सही किराया बताती हूँ।',
    hold: 'माफ़ कीजिए, लिंक अभी भेजा नहीं गया है।',
    waFailed: 'माफ़ कीजिए, WhatsApp नहीं जा पाया। अपना पता या पास का कोई landmark बता दीजिए।',
    notBooked: 'बुकिंग अभी पक्की नहीं हुई है।',
    resume: 'माफ़ कीजिए, लाइन थोड़ी कट गई थी।',
    timeUp: 'आपकी बुकिंग हो गई है, हमारी टीम थोड़ी देर में कॉल करेगी। धन्यवाद!',
    booked: 'बुकिंग हो गई। ट्रिप नंबर {trip}। हमारी टीम थोड़ी देर में कॉल करके गाड़ी पक्की करेगी।',
    stuck: 'माफ़ कीजिए, हमारी टीम अभी आपकी बुकिंग पक्की करेगी।',
  },
  en: {
    price: "One moment, I'll tell you the exact fare.",
    hold: 'Sorry, the link has not been sent yet.',
    waFailed: 'Sorry, the WhatsApp could not be sent. Please tell me your address or a nearby landmark.',
    notBooked: 'The booking is not confirmed yet.',
    resume: 'Sorry, the line dropped for a moment.',
    timeUp: 'Your booking is done; our team will call you shortly. Thank you!',
    booked: 'Your booking is done. Trip number {trip}. Our team will call shortly to confirm the vehicle.',
    stuck: 'Sorry — a team member will confirm your booking with you right now.',
  },
};
const linesFor = (lang) => LINES[lang] || (lang ? LINES.en : LINES.kn);
const waFailed = (st) => st.whatsapp === 'off' || st.whatsapp === 'failed';

// Things Sahana must never say before they are true. Checked on her own
// words as they are spoken; the first hit in a spoken turn cuts her audio
// (Plivo clearAudio) and she says the line instead.
const GUARDS = [
  {
    id: 'price', what: 'a price said before get_quote', counter: 'priceGuardStops',
    active: (st) => !st.quote, test: (t) => saysPrice(t), line: (st, L) => L.price,
  },
  {
    id: 'whatsapp', what: 'a WhatsApp link claimed without a successful send', counter: 'claimGuardStops',
    active: (st) => st.whatsapp !== 'sent' && st.whatsapp !== 'received',
    test: (t, st) => WA_SENT_CLAIM.test(t) || (waFailed(st) && WA_PROMISE.test(t)),
    line: (st, L) => (waFailed(st) ? L.waFailed : L.hold),
    hint: 'No WhatsApp has been sent: send_location_request has not succeeded. Never say a link was sent. Ask for the address and a landmark on the call.',
  },
  {
    id: 'booked', what: 'a booking claimed before create_booking succeeded', counter: 'claimGuardStops',
    active: (st) => !st.booked, test: (t) => BOOKED_CLAIM.test(t), line: (st, L) => L.notBooked,
    hint: 'Nothing is booked: create_booking has not returned ok. Never say it is booked until it does.',
  },
];

const BARGE_IN_NOTE = 'The caller started talking over you, so your audio was stopped — they did not hear the rest. Let them finish, then answer what they said, briefly, one question at a time. Do not repeat what they already told you.';

// Decoded G.711 mu-law -> 16-bit linear, for the caller's speech level.
const MULAW = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  const u = ~i & 0xff;
  const mag = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
  MULAW[i] = u & 0x80 ? -mag : mag;
}
function frameLevel(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) return { rms: 0, ms: 0 };
  let sum = 0;
  for (const b of buf) sum += MULAW[b] * MULAW[b];
  return { rms: Math.sqrt(sum / buf.length), ms: buf.length / 8 }; // 8 kHz, one byte a sample
}
const audioMs = (b64) => Buffer.from(String(b64 || ''), 'base64').length / 8;

// The base rules (prompt.BASE_INSTRUCTIONS); each call's instructions add
// today's IST date with every relative day resolved, and the style
// examples — prompt.buildInstructions, at session.start.
const INSTRUCTIONS = prompt.BASE_INSTRUCTIONS;

// For the delegated Responses model, which runs the tools.
const DELEGATE_INSTRUCTIONS = `
NEVER state any price, fare or rupee amount that did not come from get_quote in this call — no estimate, no "around", no range.
You run the tools for SaveLife's phone assistant. Use only these tools; never answer medical questions — use handoff_to_human for those, for a real medical emergency, or when the caller asks for a person. Never hand off just because the caller says "urgent".
get_quote is the only source of prices; any change to the route (pickup, hospital or branch, service, round trip, wait) needs a new get_quote. To book: read_back_booking, the assistant reads it back and asks; create_booking ONLY after the caller's clear yes to that read-back (the server checks the caller's words) — never after "not yet" / "ಇನ್ನೂ ಬುಕ್ ಮಾಡಬೇಡಿ", never twice. Never say it is booked unless create_booking returned ok. Never say a WhatsApp link was sent unless send_location_request returned status sent. A freezer box kept at home is never priced: freezer_box_request (address, start time, how long), then end_call follow_up.
Round trip / up and down / the ambulance must wait: get_quote with round_trip true and wait_hours — quote it, never hand off for it.
Call get_quote as soon as service, pickup and drop are known; pass patient_at when known (hospital = no helper). Say the price its "say" gives (for a home pickup: without and with helper in one go). Answer extra-charge questions from that quote; do not repeat a question already answered.
BOOKING — never stall: when the caller says to book, call read_back_booking at once (if not done), and after their yes call create_booking at once. Never answer with text like "please wait / processing" instead of calling the tool. patient_name is optional: never hold a booking for it, never ask it again after the read-back.
BODY TRANSPORT (body_mini / body_tempo) and freezer box: never ask about a nurse, oxygen, a helper or the medical condition — those are only for living patients.
Nurse: pass nurse_needed; never quote a nurse charge (the team confirms it) — ALS/ACLS/NICU include a nurse. Over 1000 km: two drivers are assigned.
Vehicles and inclusions only from service_info / get_quote: Body Shifting — Tempo includes the freezer (never a separate charge); Body Mini — Eeco has none (offer the Tempo; new get_quote only if chosen). Eeco over 800 km: recommend a Tempo Traveller, never switch it yourself. A vague place (a whole state) is refused: ask the town and exact place. Discount / advance / settlement / conditional yes: record_question, never promise, never book on a condition. A clear no: no booking, a polite close, end_call not_needed.
Dates: take them from the DATE AND TIME list in the instructions; never ask the caller for a month or year.
Reply briefly in plain words the phone assistant can say aloud.
`.trim();

// Distress words in the caller's own speech -> a person, immediately.
// English, Hindi (Devanagari + romanised), Kannada (+ romanised). A safety
// net behind the model's own instruction, so deliberately broad on the
// acute signs and silent on ordinary booking words ("emergency ambulance").
const DISTRESS = [
  /not breathing|can'?t breathe|unconscious|no pulse|heart attack|chest pain|heavy bleeding|bleeding (a lot|heavily)|seizure|\bfits\b|stroke|collapsed|dying|suicide|poison/i,
  /बेहोश|सांस नहीं|साँस नहीं|खून बह|दौरा पड़|दिल का दौरा|saans nahi|behosh/i,
  /ಉಸಿರಾಡುತ್ತಿಲ್ಲ|ಉಸಿರು ಇಲ್ಲ|ಪ್ರಜ್ಞೆ ಇಲ್ಲ|ಪ್ರಜ್ಞೆ ತಪ್ಪಿ|ಹೃದಯಾಘಾತ|ರಕ್ತಸ್ರಾವ|usiru illa|prajne illa/i,
  /ఊపిరి ఆడటం లేదు|ఊపిరి ఆడట్లేదు|స్పృహ లేదు|స్పృహ తప్పి|గుండెపోటు|రక్తస్రావం/,
  // Tamil (+ romanised)
  /மூச்சு விடவில்லை|மூச்சு இல்லை|மயக்கம்|சுயநினைவு இல்லை|மாரடைப்பு|நெஞ்சு வலி|ரத்தப்போக்கு|இரத்தப்போக்கு|வலிப்பு|moochu illa|mayakkam/i,
  // Malayalam (+ romanised)
  /ശ്വാസമില്ല|ശ്വാസം കിട്ടുന്നില്ല|ബോധമില്ല|ബോധം പോയി|ഹൃദയാഘാതം|നെഞ്ചുവേദന|രക്തസ്രാവം|അപസ്മാരം|bodham illa|shwasam illa/i,
];
const isDistress = (text) => DISTRESS.some((re) => re.test(String(text || '')));

// Sent the moment the caller asks for a language (and on a reconnect).
const LANGUAGE_NAMES = { kn: 'Kannada', en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', ml: 'Malayalam' };
const languageLock = (code) => {
  const name = LANGUAGE_NAMES[code] || code;
  return `LANGUAGE: the caller asked for ${name}. From now on speak ONLY ${name} — every sentence, including prices, the read-back and the goodbye — until the caller clearly asks for another language. Do not switch because of a few words in another language or how a transcript is spelled.`;
};

const SCRIPTS = [[/[ಀ-೿]/, 'kn'], [/[ऀ-ॿ]/, 'hi'], [/[ఀ-౿]/, 'te'], [/[஀-௿]/, 'ta'], [/[ഀ-ൿ]/, 'ml']];
const scriptLanguage = (text) => (SCRIPTS.find(([re]) => re.test(text)) || [null, 'en'])[1];

function defaultConnectOpenAI() {
  return new WebSocket(config.liveUrl(), {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
}

// GPT-Live's usage shape is newer than ours: take what matches, keep the rest raw.
function usageFields(u = {}) {
  const inD = u.input_token_details || u.input_tokens_details || {};
  const outD = u.output_token_details || u.output_tokens_details || {};
  return {
    audioIn : inD.audio_tokens || 0,
    textIn  : inD.text_tokens || 0,
    cachedIn: inD.cached_tokens || 0,
    audioOut: outD.audio_tokens || 0,
    textOut : outD.text_tokens || 0,
  };
}

const active = new Map(); // callId -> session (one per call)

async function createSession({ callId, plivoWs, connectOpenAI = defaultConnectOpenAI, now = Date.now, approvalWaitMs = APPROVAL_WAIT_MS }) {
  if (active.has(callId)) { plivoWs.close(); return null; }
  const call = await AiCall.findById(callId).select('+phone status');
  if (!call || call.status !== 'in_progress') { plivoWs.close(); return null; }

  const s = {
    callId, phone: call.phone, plivoWs, openai: null,
    streamId: null, socketOpen: false, ready: false, ended: false, ending: false,
    state: {}, timers: [], scriptNoted: false, guarded: new Set(),
    recent: [], everReady: false, reconnects: 0,
    turns: { caller: '', assistant: '' }, turnTimer: { caller: null, assistant: null }, turnStart: { caller: 0, assistant: 0 }, turnSeq: 0,
    // Language the caller explicitly asked for (null = Kannada default / model's choice).
    language: null, cannotNoted: null, langFrom: 0,
    // 'requested' (the caller asked) or 'detected' (spoken in 2 turns running).
    languageSource: null, spokenTurns: [],
    // Playback clock: when Sahana's audio already sent to Plivo finishes
    // playing, and her stretches of speech (for the read-back check).
    playUntil: 0, stretches: [], stretchBreak: false, bargeIns: 0, pendingBarge: null,
    // The opening (recording notice) is never cut by barge-in.
    protect: false, openingHeard: false, protectSince: 0,
    // Caller speech detector (in audio time, from the frames themselves).
    vad: { voiced: 0, silence: 0, talking: false, holdMs: 0, capped: false },
    callerFrags: [], // { at, text } — what the caller said and when (approval)
    bookWatch: null, lastToolAt: 0, // the booking watchdog
  };
  active.set(callId, s);
  // This call's instructions: today's IST date (server time) and the real
  // SaveLife calls to copy the style of. Built before connecting, so
  // session.start can go the moment the socket opens.
  // ...and SaveLife's real services (active Pricing docs + the catalog).
  const [examples, services] = await Promise.all([styleExamples.loadForPrompt(), servicesKnowledge.load()]);
  s.instructions = prompt.buildInstructions({ now: new Date(), examples, services: servicesKnowledge.block(services) });
  s.servicesFromDb = services.fromDb;
  if (services.notes.length) console.warn(`[aiCaller] services list: ${services.notes.join('; ')}`);
  s.styleExamples = examples.length;

  const sendPlivo = (msg) => { try { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.send(JSON.stringify(msg)); } catch { /* caller gone */ } };
  const sendAI = (msg) => { try { if (s.openai?.readyState === WebSocket.OPEN) s.openai.send(JSON.stringify(msg)); } catch { /* handled by close */ } };

  const note = (role, text) => {
    if (!text || !String(text).trim()) return;
    if (role !== 'system') {
      s.recent.push({ role, text: String(text).trim().slice(0, 500) });
      if (s.recent.length > RECENT_TURNS) s.recent.shift();
    }
    AiCall.updateOne({ _id: callId }, { $push: { transcript: { $each: [{ role, text: String(text).trim().slice(0, 2000), at: new Date() }], $slice: -MAX_TRANSCRIPT } } })
      .catch((err) => console.error('[aiCaller] transcript write failed:', err.message));
  };
  const recordOpenAIError = (code, message) => {
    console.error(`[aiCaller] OpenAI error on ${callId}: ${code || ''} ${message || ''}`);
    AiCall.updateOne({ _id: callId }, { $push: { openaiErrors: { $each: [{ at: new Date(), code: String(code || ''), message: String(message || '').slice(0, 500) }], $slice: -20 } } }).catch(() => {});
  };

  // Transcript fragments -> turns: a turn is written when THAT speaker has
  // been quiet for TURN_IDLE_MS. The other speaker's fragments no longer
  // end it — a "ಹೂಂ" or "ಮೇಡಮ್" over the top used to split a sentence
  // mid-word ("ಎಬ್ಬ" / "ಳ ಆಸ್ಪತ್ರ" / "ೆಯಿಂದ" on a real call), which also
  // hid distress words split across the pieces.
  const flushTurn = (who) => {
    clearTimeout(s.turnTimer[who]);
    s.turnTimer[who] = null;
    const text = s.turns[who];
    s.turns[who] = '';
    noteStallSign(who, text);
    if (who === 'assistant') s.guarded.clear(); // claim guards are per spoken turn
    else { s.langFrom = 0; if (text && !s.ended) onCallerTurnDone(text); }
    note(who, text);
  };
  const addFragment = (who, delta) => {
    if (!delta) return '';
    if (!s.turns[who]) s.turnStart[who] = ++s.turnSeq; // order the open turns started in
    s.turns[who] += delta;
    clearTimeout(s.turnTimer[who]);
    s.turnTimer[who] = setTimeout(() => flushTurn(who), TURN_IDLE_MS);
    return s.turns[who];
  };

  // End the conversation. The Plivo stream closes LAST, after the next step
  // is on the AiCall — Plivo's <Redirect> then asks /plivo/next for it.
  const closeOpenAI = () => {
    if (!s.openai || s.openai.readyState !== WebSocket.OPEN) return;
    if (s.ready) {
      sendAI({ type: 'session.close', event_id: 'event_close' });
      setTimeout(() => { try { s.openai.close(1000); } catch { /* gone */ } }, SESSION_CLOSE_WAIT_MS);
    } else {
      try { s.openai.close(1000); } catch { /* gone */ }
    }
  };
  const cleanup = () => {
    if (s.ended) return;
    s.ended = true;
    s.timers.forEach(clearTimeout);
    // Open turns, oldest first.
    ['caller', 'assistant'].sort((a, b) => s.turnStart[a] - s.turnStart[b]).forEach(flushTurn);
    active.delete(callId);
    closeOpenAI();
    try { plivoWs.close(); } catch { /* already closed */ }
  };

  // Anything wrong, or the model asked: a person. Once.
  const handOff = async (reason) => {
    if (s.ended || s.ending) return;
    s.ending = true;
    note('system', `Handoff to a person (${reason})`);
    await calls.handOff(callId, reason);
    cleanup();
  };
  const fallback = async (why) => {
    if (s.ended || s.ending) return;
    await AiCall.updateOne({ _id: callId }, { $set: { error: String(why).slice(0, 500) } }).catch(() => {});
    await handOff(why);
  };

  const endCall = async ({ outcome, summary }) => {
    if (s.ended || s.ending) return;
    s.ending = true;
    note('system', `Call ended by assistant (${outcome})${summary ? `: ${summary}` : ''}`);
    const $set = { summary: String(summary || '').slice(0, 1000) };
    if (!s.state.booked) {
      if (outcome === 'follow_up') $set.outcome = 'follow_up';
      else if (outcome === 'not_needed') $set.outcome = 'ended';
    }
    await AiCall.updateOne({ _id: callId }, { $set });
    await calls.requestEnd(callId);
    if (outcome === 'follow_up' && !s.state.booked) await calls.queueFollowUp(callId, summary).catch(() => {});
    // Let the goodbye finish playing, then close the stream (-> /next -> hang up).
    sendPlivo({ event: 'checkpoint', streamId: s.streamId, name: 'goodbye' });
    s.timers.push(setTimeout(cleanup, HANGUP_AFTER_GOODBYE_MS));
  };

  // ── Barge-in ──────────────────────────────────────────────
  // Sahana's audio is "audible" until the playback clock runs out (each
  // delta is bytes/8 ms of 8 kHz mu-law). Caller speech over her for
  // AI_BARGE_IN_MS makes a barge-in PENDING: her new audio is queued, not
  // dropped. It becomes real — Plivo clearAudio, queue discarded, her audio
  // held until the caller finishes — when they keep talking for
  // AI_BARGE_IN_CONFIRM_MS or their words are more than an acknowledgement.
  // A "ಹೂಂ" / "हाँ" / "ಜಿ" followed by quiet cancels it and the queue plays
  // on: brief acknowledgements never cut her off.
  const audible = () => now() < s.playUntil;
  const forward = (delta) => {
    const t = now();
    const ms = audioMs(delta);
    const last = s.stretches[s.stretches.length - 1];
    s.playUntil = Math.max(t, s.playUntil) + ms;
    if (!last || s.stretchBreak || t > last.end + STRETCH_GAP_MS) {
      s.stretches.push({ start: t, end: s.playUntil, interrupted: false });
      if (s.stretches.length > 100) s.stretches.shift();
      s.stretchBreak = false;
    } else {
      last.end = s.playUntil;
    }
    if (s.protect) s.openingHeard = true;
    sendPlivo({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: delta } });
  };
  const bargeIn = () => {
    const t = now();
    sendPlivo({ event: 'clearAudio', streamId: s.streamId });
    const last = s.stretches[s.stretches.length - 1];
    // Remember how much was still to play: a cut in the last moment (the
    // closing question) does not void a read-back (judgeApproval).
    if (last && last.end > t) { last.plannedEnd = last.end; last.end = t; last.interrupted = true; }
    s.playUntil = t;
    s.bargeIns += 1;
    AiCall.updateOne({ _id: callId }, { $inc: { bargeIns: 1 } }).catch(() => {});
    note('system', 'Caller interrupted — assistant audio stopped');
    sendAI({ type: 'session.thinking.append', event_id: `event_barge_${s.bargeIns}`, delegation_id: null, content: BARGE_IN_NOTE });
  };
  const startHold = () => {
    s.vad.talking = true;
    s.vad.holdMs = 0;
    s.stretchBreak = true;
  };
  const confirmBarge = () => {
    s.pendingBarge = null;
    bargeIn();
    startHold();
  };
  const cancelBarge = () => {
    const { queue } = s.pendingBarge;
    s.pendingBarge = null;
    queue.forEach(forward);
  };
  const onCallerAudio = (payload) => {
    const { rms, ms } = frameLevel(payload);
    if (!ms) return;
    const v = s.vad;
    if (s.protect && ((s.openingHeard && !audible()) || now() - s.protectSince > OPENING_PROTECT_MAX_MS)) s.protect = false;
    if (rms >= config.bargeInRms()) {
      v.voiced += ms;
      v.silence = 0;
      // The caller spoke in a gap: her next words are a new stretch. (Over
      // her, only a confirmed barge-in splits it — a "ಹೂಂ" does not.)
      if (v.voiced >= STRETCH_BREAK_VOICE_MS && !audible() && !s.pendingBarge) s.stretchBreak = true;
    } else {
      v.silence += ms;
      if (v.silence > VOICE_GAP_MS) v.voiced = 0;
    }
    const done = v.silence >= config.callerDoneMs();
    if (v.talking) {
      v.holdMs += ms;
      if (done) v.talking = false;
      else if (v.holdMs >= MAX_HOLD_MS) { v.talking = false; v.capped = true; }
      return;
    }
    if (v.capped) { if (done) v.capped = false; return; }
    if (s.pendingBarge) {
      s.pendingBarge.voiced += rms >= config.bargeInRms() ? ms : 0;
      // Only acknowledgements heard so far: never a cut for how long it lasts.
      const onlyAcks = s.pendingBarge.text.trim() && isOnlyAck(s.pendingBarge.text);
      if (s.pendingBarge.voiced >= (onlyAcks ? ACK_MAX_MS : config.bargeInConfirmMs())) confirmBarge();
      else if (v.silence >= ACK_SILENCE_MS) cancelBarge(); // just an acknowledgement
      return;
    }
    if (v.voiced >= config.bargeInMs()) {
      if (!s.protect && audible()) s.pendingBarge = { at: now(), voiced: v.voiced, queue: [], text: '' };
      else startHold();
    }
  };
  // Caller words while a barge-in is pending: more than "ಹೂಂ / हाँ" = real.
  const onCallerWordsDuringBarge = (delta) => {
    const pb = s.pendingBarge;
    if (!pb) return;
    pb.text += delta;
    if (!isOnlyAck(pb.text)) confirmBarge();
  };
  // Sahana's audio -> Plivo, unless the caller is mid-sentence.
  const onAssistantAudio = (delta) => {
    if (s.vad.talking && !s.protect) return; // let the caller finish
    if (s.pendingBarge) { s.pendingBarge.queue.push(delta); return; } // maybe just a "ಹೂಂ": keep it
    forward(delta);
  };

  // ── Claim guards (GUARDS) on Sahana's own words ───────────
  const checkClaims = (said) => {
    for (const g of GUARDS) {
      if (s.guarded.has(g.id) || !g.active(s.state) || !g.test(said, s.state)) continue;
      s.guarded.add(g.id);
      sendPlivo({ event: 'clearAudio', streamId: s.streamId });
      s.playUntil = now();
      note('system', `Stopped ${g.what}: "${said.trim().slice(0, 200)}"`);
      console.warn(`[aiCaller] ${g.what} on ${callId} — audio cleared`);
      AiCall.updateOne({ _id: callId }, { $inc: { [g.counter]: 1 } }).catch(() => {});
      if (g.hint) sendAI({ type: 'session.thinking.append', event_id: `event_${g.id}_hint_${Date.now()}`, delegation_id: null, content: g.hint });
      sendAI({ type: 'session.commentary.append', event_id: `event_${g.id}_hold_${Date.now()}`, delegation_id: null, content: g.line(s.state, linesFor(s.language)) });
      return;
    }
  };

  // ── Language: only an explicit request changes it ─────────
  // Looks only at what the caller said since the last request acted on in
  // this turn, so "ಕನ್ನಡದಲ್ಲಿ... no, English please" switches twice.
  const onCallerTurnText = (turn) => {
    const r = detectLanguageRequest(turn.slice(s.langFrom));
    if (!r) return;
    s.langFrom = turn.length;
    if (r.lang && (r.lang !== s.language || s.languageSource !== 'requested')) {
      s.language = r.lang;
      s.languageSource = 'requested';
      note('system', `Caller asked for ${r.name} — language locked`);
      AiCall.updateOne({ _id: callId }, { $set: { language: r.lang, languageSource: 'requested' } }).catch(() => {});
      sendAI({ type: 'session.instructions.append', event_id: `event_lang_${r.lang}_${Date.now()}`, delegation_id: null, content: languageLock(r.lang) });
    } else if (r.cannot && s.cannotNoted !== r.cannot && r.cannot === (s.language || 'kn')) {
      s.cannotNoted = r.cannot;
      sendAI({ type: 'session.instructions.append', event_id: `event_lang_unclear_${Date.now()}`, delegation_id: null, content: `The caller says they do not understand ${r.name}. Ask ONCE, briefly, which language they want — then keep to it.` });
    }
  };

  // ── Language the caller SPEAKS (spokenLanguage.js), turn by turn ──
  // Two finished caller turns in a row in the same language (judged by the
  // words, never the transcript's letters) and Sahana replies in it. An
  // explicit request ("ಕನ್ನಡ ಮಾತಾಡಿ", "English please") always wins and is
  // never overridden by detection.
  function onCallerTurnDone(text) {
    const { lang } = spokenLanguage.detect(text);
    if (!lang) return;
    s.spokenTurns.push(lang);
    if (s.spokenTurns.length > 4) s.spokenTurns.shift();
    if (s.languageSource === 'requested') return;
    const [a, b] = s.spokenTurns.slice(-2);
    if (s.spokenTurns.length < 2 || a !== b || lang === (s.language || 'kn')) return;
    s.language = lang;
    s.languageSource = 'detected';
    const name = spokenLanguage.NAMES[lang];
    note('system', `Caller is speaking ${name} — replying in ${name}`);
    AiCall.updateOne({ _id: callId }, { $set: { language: lang, languageSource: 'detected' } }).catch(() => {});
    sendAI({
      type: 'session.instructions.append', event_id: `event_lang_detected_${lang}_${Date.now()}`, delegation_id: null,
      content: `LANGUAGE: the caller is speaking ${name}. REPLY in ${name} from now on — every sentence, the quote, the read-back and the goodbye — not just understand it. Switch again only if they ask, or consistently speak another language.`,
    });
  }

  // ── Was the read-back answered with a clear yes? (tools: create_booking)
  // The read-back is Sahana's first COMPLETE stretch of speech after
  // read_back_booking returned: played to the end, or cut only in its last
  // TAIL_GRACE_MS (the closing "ಬುಕ್ ಮಾಡಲಾ?" or a courtesy word — the
  // material details were heard). Approval = the caller's words from just
  // before it ended (ANSWER_OVERLAP_MS — a yes over the closing question)
  // are a clear yes, and nothing said since it was prepared is a no or a
  // condition. A stretch cut earlier reports which details went unheard,
  // so only those are repeated.
  const complete = (st) => !st.interrupted || (st.plannedEnd - st.end) <= TAIL_GRACE_MS;
  const unheardPart = (p, st) => {
    const parts = String(p.summary || '').split(/(?<=\.)\s+/).filter(Boolean);
    const played = st.plannedEnd > st.start ? (st.end - st.start) / (st.plannedEnd - st.start) : 0;
    const heard = Math.max(0, Math.min(parts.length - 1, Math.floor(played * parts.length)));
    return parts.slice(heard).join(' ');
  };
  const judgeApproval = () => {
    const p = s.state.pending;
    if (!p) return { status: 'not_read_back' };
    const after = s.stretches.filter((st) => st.start >= p.at);
    if (!after.length) return { status: 'not_read_back' };
    const rb = after.find(complete);
    if (!rb) return { status: 'read_back_interrupted', unheard: unheardPart(p, after[after.length - 1]) };
    if (now() < rb.end - ANSWER_OVERLAP_MS) return { status: 'not_read_back' }; // the details are still being read out
    const since = s.callerFrags.filter((f) => f.at >= p.at).map((f) => f.text).join(' ');
    if (approvalWords.saysNo(since)) return { status: 'no', heard: since };
    if (approvalWords.saysConditional(since)) return { status: 'conditional', heard: since };
    const answer = s.callerFrags.filter((f) => f.at >= rb.end - ANSWER_OVERLAP_MS).map((f) => f.text).join(' ');
    return { status: approvalWords.classify(answer), heard: answer };
  };
  const approval = async () => {
    const until = Date.now() + approvalWaitMs;
    let v = judgeApproval();
    while (!['yes', 'no', 'conditional', 'read_back_interrupted'].includes(v.status) && Date.now() < until) {
      await new Promise((r) => { setTimeout(r, 100); });
      if (s.ended) break;
      v = judgeApproval();
    }
    return v;
  };

  // ── Booking watchdog: an approved booking always completes ─
  // A real call: the caller said "ಬುಕ್ ಮಾಡಿ" three times, the model never
  // called create_booking, said "ಬುಕ್ಕಿಂಗ್ ಮುಂದುವರಿಸ್ತಿದ್ದೀನಿ" for five
  // minutes and the time limit handed the call off unbooked. Now:
  //   - the caller's clear yes to a read-back (judgeApproval) -> after
  //     BOOK_NUDGE_MS the model is told to book; after BOOK_SELF_MS, if it
  //     still has not, the SERVER calls create_booking itself (the same
  //     tool, the same approval and duplicate checks) and she says it;
  //   - "ಬುಕ್ ಮಾಡಿ" with a quote but no read-back yet -> the model is told
  //     to read back now; if no booking step happens for BOOK_STUCK_MS, a
  //     person takes over WITH the details — never minutes of "processing".
  const toolCtx = () => ({ callId, phone: s.phone, state: s.state, approval, now, language: s.language });
  const watchActive = (w) => s.bookWatch === w && !s.state.booked && !s.ended && !s.ending;
  function watchBooking(turn) {
    if (s.state.booked || s.ending || s.ended || s.bookWatch) return;
    let kind = null;
    if (s.state.pending) { if (judgeApproval().status === 'yes') kind = 'approved'; }
    else if (s.state.quote && BOOK_REQUEST.test(turn) && !approvalWords.saysNo(turn) && !approvalWords.saysConditional(turn)) kind = 'asked';
    if (!kind) return;
    // callerTurn: the turn that started the watch never counts as a stall sign.
    const w = { kind, at: now(), toolAt: s.lastToolAt, signs: 0, callerTurn: s.turnStart.caller };
    s.bookWatch = w;
    s.timers.push(setTimeout(() => {
      if (!watchActive(w)) return;
      sendAI({
        type: 'session.instructions.append', event_id: `event_book_nudge_${Date.now()}`, delegation_id: null,
        content: kind === 'approved'
          ? 'The caller has APPROVED the read-back. Call create_booking NOW (customer_confirmed true). No more questions, no "please wait".'
          : 'The caller asked to book. Call read_back_booking NOW with the pickup time they gave (ask only if it is truly missing), read it back once, then create_booking after their yes. Never say "processing" or "please wait".',
      });
      sendAI({ type: 'response.create', event_id: `event_book_nudge_go_${Date.now()}` });
    }, BOOK_NUDGE_MS));
    if (kind === 'approved') s.timers.push(setTimeout(() => { if (watchActive(w) && !s.state.bookingInFlight) selfBook(w); }, BOOK_SELF_MS));
    else {
      // Stuck = no booking step at all AND a sign of it (she stalls, or the
      // caller asks again). Still asking for the time or a name is not stuck.
      const check = () => {
        if (!watchActive(w) || s.lastToolAt > w.toolAt) return;
        if (w.signs > 0) bookingStuck();
        else s.timers.push(setTimeout(check, 10000));
      };
      s.timers.push(setTimeout(check, BOOK_STUCK_MS));
    }
  }
  // Stall signs for the open watch (assistant turns, caller fragments).
  const noteStallSign = (who, text) => {
    const w = s.bookWatch;
    if (!w || w.kind !== 'asked' || !text) return;
    if (who === 'caller' && s.turnStart.caller === w.callerTurn) return;
    if ((who === 'assistant' && STALL_WORDS.test(text)) || (who === 'caller' && (ASKED_AGAIN.test(text) || BOOK_REQUEST.test(text)))) w.signs += 1;
  };
  async function selfBook(w) {
    let out;
    try { out = await tools.HANDLERS.create_booking({ customer_confirmed: true }, toolCtx()); } catch (err) { out = { ok: false, reason: `error: ${err.message}` }; }
    note('system', `create_booking (by the server — the caller approved, the assistant had not booked) -> ${out.ok ? 'ok' : out.reason}`);
    if (s.bookWatch === w) s.bookWatch = null;
    if (out.ok) {
      sendAI({ type: 'session.thinking.append', event_id: `event_selfbook_${Date.now()}`, delegation_id: null, content: `create_booking has ALREADY succeeded: trip ${out.trip_number}. Never call it again. Say goodbye after this.` });
      sendAI({ type: 'session.commentary.append', event_id: `event_selfbook_say_${Date.now()}`, delegation_id: null, content: linesFor(s.language).booked.replace('{trip}', out.trip_number) });
    } else if (out.handoff || !['already_booked', 'booking_in_progress'].includes(out.reason)) {
      bookingStuck();
    }
  }
  async function bookingStuck() {
    if (s.state.booked || s.ended || s.ending) return;
    const q = s.state.quote;
    const summary = s.state.pending?.summary
      || (q ? `Pickup: ${q.pickup.address}. Drop: ${q.drop.address}. Vehicle: ${q.service.label}. Quoted: ₹${q.quotes.plain.fare.grandTotal + (q.waitCharge || 0)}. Pickup time: ask the caller.` : 'No quote yet.');
    note('system', 'Booking did not complete — handing to a person with the details');
    await AiCall.updateOne({ _id: callId }, { $set: { pendingBooking: { summary: summary.slice(0, 1000), reason: 'booking_stuck', at: new Date() } } }).catch(() => {});
    sendAI({ type: 'session.commentary.append', event_id: `event_stuck_${Date.now()}`, delegation_id: null, content: linesFor(s.language).stuck });
    s.timers.push(setTimeout(() => handOff('booking_stuck'), HANDOFF_AFTER_LINE_MS));
  }

  // ── OpenAI ────────────────────────────────────────────────
  // GPT-Live dropping AFTER the session started (OpenAI closed the socket,
  // a network error) does not end the call: a fresh session is opened —
  // up to MAX_AI_RECONNECTS times — with the same instructions plus the
  // conversation so far, and the call's tool state (quote, booking) stays
  // in s.state. Only a session that never started, or a drop after the
  // reconnects are used up, hands off to a person.
  const resumeInstructions = () => [
    s.instructions,
    'THE LINE DROPPED FOR A MOMENT AND YOU ARE BACK ON THE SAME CALL. Do NOT say the opening again. '
      + 'You have just said a short sorry; continue exactly where the conversation stopped and never ask again for anything already answered.'
      + (s.state.quote ? ' A quote was already given (get_quote ok) — read it back again if needed.' : '')
      + (s.state.booked ? ` The booking is ALREADY made (${s.state.booked}) — do not book again; just say goodbye if nothing else is needed.` : '')
      + (s.language ? ` ${languageLock(s.language)}` : ''),
    `CONVERSATION SO FAR:\n${s.recent.map((t) => `${t.role === 'caller' ? 'Caller' : 'You'}: ${t.text}`).join('\n') || '(nothing yet)'}`,
  ].join('\n\n');

  // The AI side is gone (this socket). Mid-call: reconnect; else a person.
  function aiLost(ws, why) {
    if (s.ended || s.ending || ws?.lost) return;
    if (ws) {
      ws.lost = true;
      try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* gone */ }
    }
    if (!s.everReady || s.reconnects >= MAX_AI_RECONNECTS) {
      fallback(s.reconnects ? `${why} (after ${s.reconnects} reconnect${s.reconnects === 1 ? '' : 's'})` : why);
      return;
    }
    s.reconnects += 1;
    s.ready = false;
    // What was being said goes into the conversation handed to the new session.
    ['caller', 'assistant'].filter((w) => s.turns[w]).sort((a, b) => s.turnStart[a] - s.turnStart[b]).forEach(flushTurn);
    console.warn(`[aiCaller] OpenAI dropped on ${callId}: ${why} — reconnecting (${s.reconnects}/${MAX_AI_RECONNECTS})`);
    note('system', `AI line dropped (${why}) — reconnecting`);
    AiCall.updateOne({ _id: callId }, { $inc: { aiReconnects: 1 } }).catch(() => {});
    s.timers.push(setTimeout(() => { if (!s.ended && !s.ending) connectAI({ resume: true }); }, 300 * s.reconnects));
  }

  function connectAI({ resume = false } = {}) {
    let ws;
    try {
      ws = connectOpenAI();
    } catch (err) {
      aiLost(null, `AI could not ${resume ? 'reconnect' : 'start'} (${err.message})`);
      return;
    }
    s.openai = ws;
    s.socketOpen = false;
    const mine = () => s.openai === ws && !ws.lost; // a replaced socket's events are ignored

    s.timers.push(setTimeout(() => {
      if (mine() && !s.ready) aiLost(ws, s.socketOpen ? 'AI session did not start in time' : 'AI did not connect in time');
    }, OPENAI_CONNECT_TIMEOUT_MS));

    // A refused handshake (wrong URL -> 404, bad key -> 401, no access -> 403):
    // log OpenAI's own answer — this is the line to look for in the logs.
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 1000) body += c; });
      res.on('end', () => {
        if (!mine()) return;
        console.error(`[aiCaller] OpenAI handshake rejected on ${callId}: HTTP ${res.statusCode} ${body}`);
        AiCall.updateOne({ _id: callId }, { $set: { openaiClose: { code: res.statusCode, reason: body.slice(0, 500), at: new Date() } } }).catch(() => {});
        aiLost(ws, `AI handshake rejected: HTTP ${res.statusCode} ${body.slice(0, 300)}`);
      });
    });

    ws.on('open', () => {
      if (!mine()) return;
      s.socketOpen = true;
      sendAI({
        type: 'session.start',
        event_id: resume ? `event_start_${s.reconnects}` : 'event_start',
        session: {
          model: config.realtimeModel(),
          instructions: resume ? resumeInstructions() : s.instructions,
          audio: {
            format: { type: 'audio/pcmu', rate: 8000 },
            output: { voice: config.realtimeVoice() },
          },
          delegation: {
            type: 'responses',
            responses: {
              model: config.delegateModel(),
              instructions: DELEGATE_INSTRUCTIONS,
              tools: tools.definitions(),
              tool_choice: 'auto',
              parallel_tool_calls: false,
            },
          },
        },
      });
    });

    ws.on('message', (raw) => { if (mine()) onAIMessage(ws, raw, { resume }); });
    ws.on('error', (err) => {
      if (!mine()) return;
      console.error(`[aiCaller] OpenAI socket error on ${callId}:`, err.message);
      aiLost(ws, `AI connection error (${err.message})`);
    });
    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      console.info(`[aiCaller] OpenAI socket closed on ${callId}: code=${code} reason=${reason || '(none)'}`);
      if (!mine() || s.ended || s.ending) return;
      AiCall.updateOne({ _id: callId }, { $set: { openaiClose: { code, reason: reason.slice(0, 500), at: new Date() } } }).catch(() => {});
      aiLost(ws, `AI connection closed (code ${code}${reason ? `: ${reason}` : ''})`);
    });
  }

  async function onAIMessage(ws, raw, { resume }) {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    const type = ev.type || '';
    try {
      switch (type) {
        case 'session.started':
          s.ready = true;
          s.everReady = true;
          if (resume) {
            note('system', `AI reconnected (${s.reconnects}/${MAX_AI_RECONNECTS}) — call continues`);
            // A short sorry, then it carries on from the conversation so far.
            sendAI({ type: 'session.commentary.append', event_id: `event_resume_${s.reconnects}`, delegation_id: null, content: linesFor(s.language).resume });
          } else {
            note('system', `AI session started (${config.realtimeModel()} + ${config.delegateModel()}, ${s.styleExamples} style example${s.styleExamples === 1 ? '' : 's'})`);
            // The opening — disclosure, then "ambulance ಬೇಕಾ?": the first thing it
            // says, and never cut off by barge-in (it is the recording notice).
            s.protect = true;
            s.protectSince = now();
            sendAI({ type: 'session.commentary.append', event_id: 'event_disclosure', delegation_id: null, content: OPENING });
          }
          break;
        case 'session.output_audio.delta':
          if (ev.delta) onAssistantAudio(ev.delta);
          break;
        case 'session.output_transcript.delta': {
          const said = addFragment('assistant', ev.delta);
          if (said) checkClaims(said); // a price / "link sent" / "booked" that is not true yet: stop it mid-sentence
          break;
        }
        case 'session.input_transcript.delta': {
          const turn = addFragment('caller', ev.delta);
          if (ev.delta) {
            s.callerFrags.push({ at: now(), text: ev.delta });
            if (!audible() && !s.pendingBarge) s.stretchBreak = true;
            onCallerWordsDuringBarge(ev.delta);
            watchBooking(turn);
            if (s.callerFrags.length > MAX_CALLER_FRAGMENTS) s.callerFrags.shift();
          }
          // Which letters the transcript used — kept for diagnosis only; the
          // call language changes only on an explicit request.
          if (!s.scriptNoted && turn.trim()) {
            s.scriptNoted = true;
            AiCall.updateOne({ _id: callId }, { $set: { transcriptScript: scriptLanguage(turn) } }).catch(() => {});
          }
          onCallerTurnText(turn);
          if (isDistress(turn)) { flushTurn('caller'); await handOff('distress'); }
          break;
        }
        case 'response.event':
          await onResponseEvent(ev);
          break;
        case 'session.closed': {
          const u = ev.usage || ev.session?.usage;
          console.info(`[aiCaller] OpenAI session closed on ${callId}: ${ev.reason || 'no reason given'}`);
          const update = { usageRaw: u || null };
          if (ev.reason) update.openaiClose = { code: null, reason: String(ev.reason).slice(0, 500), at: new Date() };
          if (u) {
            const f = usageFields(u);
            Object.entries(f).forEach(([k, v]) => { if (v) update[`usage.${k}`] = v; });
          }
          AiCall.updateOne({ _id: callId }, { $set: update }).catch(() => {});
          break;
        }
        case 'error':
          recordOpenAIError(ev.error?.code || ev.code, ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 300));
          if (!s.ready) aiLost(ws, `AI refused the session: ${ev.error?.code || ''} ${ev.error?.message || ''}`.trim());
          break;
        default:
          break;
      }
    } catch (err) {
      await fallback(`assistant error (${err.message})`);
    }
  }

  // The time limit (AI_CALL_MAX_SECONDS). Plivo's own stream timeout is set
  // later than this (aiCallerController), so the call always ends HERE,
  // cleanly: booked already -> a short goodbye and hang up; otherwise a
  // person takes over ('time_limit').
  const timeUp = () => {
    if (s.ended || s.ending) return;
    if (s.state.booked) {
      note('system', 'Time limit reached after booking — goodbye');
      sendAI({ type: 'session.commentary.append', event_id: 'event_time_up', delegation_id: null, content: linesFor(s.language).timeUp });
      s.timers.push(setTimeout(() => endCall({ outcome: 'booked', summary: `Booked ${s.state.booked}; call reached the time limit.` }), TIME_UP_GOODBYE_MS));
      return;
    }
    handOff('time_limit');
  };
  s.timers.push(setTimeout(timeUp, config.maxCallSeconds() * 1000));

  connectAI();

  // Delegated work: function calls from the Responses model, usage.
  async function onResponseEvent(ev) {
    const inner = ev.event || {};
    // What the tool model SAID (not just did): logged, so a booking that
    // never happens explains itself.
    if (inner.type === 'response.completed') {
      const said = (inner.response?.output || []).filter((o) => o.type === 'message')
        .flatMap((o) => o.content || []).map((c) => c.text || '').join(' ').trim();
      if (said) note('system', `delegate: ${said.slice(0, 300)}`);
    }
    if (inner.type === 'response.completed' && inner.response?.usage) {
      const f = usageFields(inner.response.usage);
      const textIn = inner.response.usage.input_tokens || f.textIn;
      const textOut = inner.response.usage.output_tokens || f.textOut;
      AiCall.updateOne({ _id: callId }, { $inc: { 'usage.textIn': textIn || 0, 'usage.textOut': textOut || 0 } }).catch(() => {});
      return undefined;
    }
    if (inner.type === 'response.failed' || inner.type === 'error') {
      recordOpenAIError(inner.error?.code || inner.response?.error?.code, inner.error?.message || inner.response?.error?.message || inner.type);
      return undefined;
    }
    if (inner.type !== 'response.output_item.done' || inner.item?.type !== 'function_call') return undefined;

    const item = inner.item;
    let args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
    if (item.name === 'handoff_to_human') return handOff(args.reason || 'other');
    if (item.name === 'end_call') return endCall(args);

    const handler = tools.HANDLERS[item.name];
    s.lastToolAt = now();
    if (item.name === 'read_back_booking' || item.name === 'create_booking') s.bookWatch = null; // the model is booking
    const output = handler
      ? await handler(args, toolCtx())
      : { ok: false, reason: 'unknown_tool' };
    // The read-back is the NEXT thing she says: start a fresh stretch of speech.
    if (item.name === 'read_back_booking' && output.ok) s.stretchBreak = true;
    note('system', `${item.name} -> ${output.ok ? 'ok' : output.reason}`);
    sendAI({ type: 'response.item.create', event_id: `event_out_${item.call_id}`, item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    sendAI({ type: 'response.create', event_id: `event_continue_${item.call_id}` });
    // The tool asked for a person (approval could not be verified twice):
    // she says one line, then the call goes to the team with the details.
    if (output.handoff) s.timers.push(setTimeout(() => handOff(output.handoff), HANDOFF_AFTER_LINE_MS));
    return undefined;
  }

  // ── Plivo ─────────────────────────────────────────────────
  plivoWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === 'start') {
      s.streamId = msg.start?.streamId || msg.streamId || null;
    } else if (msg.event === 'media' && msg.media?.payload) {
      if (s.ready && !s.ending) sendAI({ type: 'session.input_audio.append', audio: msg.media.payload });
      if (!s.ending) onCallerAudio(msg.media.payload);
    } else if (msg.event === 'playedStream' && msg.name === 'goodbye') {
      cleanup();
    } else if (msg.event === 'stop') {
      cleanup();
    }
  });
  plivoWs.on('close', () => cleanup()); // the caller hung up, or Plivo moved on
  plivoWs.on('error', () => cleanup());

  return s;
}

module.exports = {
  createSession, INSTRUCTIONS, DELEGATE_INSTRUCTIONS, DISCLOSURE_KN, DISCLOSURE_EN, OPENING, RESUME_LINE, TIME_UP_BOOKED_LINE,
  PRICE_HOLD_LINE, saysPrice, HOLD_LINE, LINES, isOnlyAck, TAIL_GRACE_MS, BOOK_REQUEST, WHATSAPP_FAILED_LINE, NOT_BOOKED_LINE, BARGE_IN_NOTE, languageLock, frameLevel,
  MAX_AI_RECONNECTS, isDistress, scriptLanguage, _active: active,
};
