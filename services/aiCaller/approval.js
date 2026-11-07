'use strict';
/**
 * services/aiCaller/approval.js
 * ============================================================
 * Was the caller's answer to the booking read-back a clear YES?
 *
 * The backend decides this from what the caller actually said (the
 * transcript), not from the model's customer_confirmed flag. Deliberately
 * one-sided: anything that sounds like "no / not yet / wait / don't" wins
 * over a yes in the same answer, and anything that is neither is
 * 'unclear' — Sahana then asks once more. A wrong 'unclear' costs one
 * extra question; a wrong 'yes' costs a booking nobody wanted.
 *
 * Covers Kannada, English, Hindi, Telugu, Tamil, Malayalam — and Kannada
 * words transcribed in Telugu letters (seen on real calls: "మాడి" for
 * "ಮಾಡಿ", "బేడ" for "ಬೇಡ").
 * ============================================================
 */

// Letters of one Indic script on either side = not a whole word.
const word = (w, block) => new RegExp(`(?<![${block}])(?:${w})(?![${block}])`);
const KN = '\\u0C80-\\u0CFF';
const TE = '\\u0C00-\\u0C7F';

const NO = [
  /\b(no|nope|not now|not yet|wait|later|don'?t|do not|hold on|stop|cancel|never ?mind)\b/i,
  // Kannada: ಬೇಡ / ಬೇಡಿ / ಮಾಡಬೇಡಿ, ಆಮೇಲೆ (later), ಸ್ವಲ್ಪ ಇರಿ (wait), ಕಾಯಿರಿ, ತಡೆಯಿರಿ, ಮಾಡಿಲ್ಲ
  /ಬೇಡ|ಆಮೇಲೆ|ಆಮೇಲ್|ಸ್ವಲ್ಪ ಇರಿ|ಒಂದು ನಿಮಿಷ ಇರಿ|ಕಾಯಿರಿ|ತಡೆಯಿರಿ|ತಡಿರಿ|ಕ್ಯಾನ್ಸಲ್|ಮಾಡಿಲ್ಲ/,
  word('ಇಲ್ಲ|ಇಲ್ಲಾ', KN),
  // Hindi
  /नहीं|नही|रुको|रुकिए|बाद में|\b(nahi|nahin|nai|mat karo|ruko|baad mein)\b/i,
  word('मत', '\\u0900-\\u097F'), // not "मतलब"
  // Telugu (and Kannada in Telugu letters)
  /వద్దు|ఆగండి|తర్వాత|బేడ/,
  word('లేదు|ఇల్ల', TE),
  // Tamil
  /வேண்டாம்|இல்லை|அப்புறம்|காத்திருங்க/,
  // Malayalam
  /വേണ്ട|ഇല്ല|പിന്നെ മതി/,
];

const YES = [
  /\b(yes|yeah|yep|ok|okay|sure|go ahead|confirm(ed)?|book it|please book|do it|fine|correct|done)\b/i,
  /ಹೌದು|ಹೌದ|ಓಕೆ|ಸರಿ|ಮಾಡಿ|ಆಗ್ಲಿ|ಆಗಲಿ|ಆಯ್ತು|ಕನ್ಫರ್ಮ್|ಬುಕ್ ಮಾಡಿ/,
  /हाँ|हां|ठीक|कर दो|कर दीजिए|कर लीजिए|बुक कर|करो|बुक करो|जी हाँ|\b(haan|han|ha|theek|thik|kar do|karo)\b/i,
  /అవును|సరే|చేయండి|ఓకే|హౌదు|హావుద|మాడి|సరి/,
  /ஆமா|ஆமாம்|சரி|பண்ணுங்க|ஓகே/,
  /അതെ|ശരി|ചെയ്യൂ|ചെയ്തോ|ഓക്കെ/,
];

// "Book only if you give a discount" — a yes with a condition is NOT a yes.
// Recorded for staff; nothing is booked.
const CONDITIONAL = [
  /(only if|if you (give|can)|provided|on condition|as long as)/i,
  /discount|ಡಿಸ್ಕೌಂಟ್|ರಿಯಾಯಿತಿ|कम करो|कम कर|डिस्काउंट|छूट|తగ్గింపు|డిస్కౌంట్|தள்ளுபடி|ഡിസ്കൗണ്ട്/i,
  /ಕೊಟ್ರೆ ಮಾತ್ರ|ಆದ್ರೆ ಮಾತ್ರ|ಮಾಡಿದ್ರೆ ಮಾತ್ರ|ಕಡಿಮೆ ಮಾಡಿದ್ರೆ|ಕಡಿಮೆ ಮಾಡಿ|अगर .* तो|तभी|तो ही/,
];

const saysNo = (text) => NO.some((re) => re.test(String(text || '')));
const saysConditional = (text) => CONDITIONAL.some((re) => re.test(String(text || '')));
const saysYes = (text) => YES.some((re) => re.test(String(text || '')));

// 'yes' | 'no' | 'conditional' | 'unclear'
function classify(text) {
  const t = String(text || '').trim();
  if (!t) return 'unclear';
  if (saysNo(t)) return 'no';
  if (saysConditional(t)) return 'conditional';
  if (saysYes(t)) return 'yes';
  return 'unclear';
}

module.exports = { classify, saysNo, saysYes, saysConditional };
