'use strict';
/**
 * services/aiCaller/language.js
 * ============================================================
 * An EXPLICIT request from the caller to change the call language —
 * "ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ", "English please", "Hindi mein boliye".
 *
 * Only a request counts: a language NAME plus an asking word in the same
 * turn. Which letters the transcript happens to use never does — real
 * calls had Kannada speech transcribed in Telugu letters. "I don't know
 * Kannada" is not a request for Kannada: it comes back as `cannot`, and
 * Sahana asks once which language to use.
 * ============================================================
 */

const LANGUAGES = {
  kn: { name: 'Kannada',   re: /kannada|ಕನ್ನಡ|కన్నడ|कन्नड|கன்னட|കന്നഡ/i },
  en: { name: 'English',   re: /english|inglish|ಇಂಗ್ಲಿಷ್|ಇಂಗ್ಲೀಷ್|ಇಂಗ್ಲಿಶ್|अंग्रेज़ी|अंग्रेजी|इंग्लिश|ఇంగ్లీష్|ఇంగ్లిష్|ஆங்கிலம்|இங்கிலீஷ்|ഇംഗ്ലീഷ്/i },
  hi: { name: 'Hindi',     re: /hindi|ಹಿಂದಿ|हिंदी|हिन्दी|హిందీ|ஹிந்தி|இந்தி|ഹിന്ദി/i },
  te: { name: 'Telugu',    re: /telugu|ತೆಲುಗು|తెలుగు|तेलुगु|தெலுங்கு|തെലുങ്ക്/i },
  ta: { name: 'Tamil',     re: /tamil|ತಮಿಳು|தமிழ்|तमिल|తమిళ|തമിഴ്/i },
  ml: { name: 'Malayalam', re: /malayalam|ಮಲಯಾಳ|മലയാളം|मलयालम|మలయాళ|மலையாளம்/i },
};

// Asking words / "in <language>" endings, in the call languages.
const ASK = /please|plz|pls|speak|talk|\bin\b|\bonly\b|mein|\bme\b|alli|dalli|\blo\b|ಮಾತಾಡಿ|ಮಾತನಾಡಿ|ಮಾತಾಡ್ತೀರಾ|ಮಾತಾಡು|ಹೇಳಿ|ದಲ್ಲಿ|ದಲ್ಲೇ|ಲ್ಲಿ|ಪ್ಲೀಸ್|ಮಾತ್ರ|बोलो|बोलिए|बात करो|बात कीजिए|में|మాట్లాడ|లో|చెప్ప|பேசு|ல பேச|ൽ|സംസാരി/i;
// "I don't know / understand <language>"
const CANNOT = /don'?t (know|understand|speak)|can'?t|not understand|ಬರಲ್ಲ|ಬರೋದಿಲ್ಲ|ಬರಲ್ಲಾ|ಗೊತ್ತಿಲ್ಲ|ಅರ್ಥ ಆಗಲ್ಲ|ಅರ್ಥ ಆಗ್ತಿಲ್ಲ|नहीं आती|नही आती|नहीं आता|समझ नहीं|nahi aati|nahi aata|samajh nahi|రాదు|అర్థం కాదు|தெரியாது|புரியல|വരില്ല|അറിയില്ല|മനസ്സിലാകുന്നില്ല/i;

// Words that contain a language name but are not one: places (Tamil Nadu,
// Dakshina Kannada) and Kannada words (ಹಿಂದಿನ "previous", ಹಿಂದಿಂದ "from
// behind", ಕನ್ನಡಕ "spectacles").
const NOT_A_LANGUAGE = /tamil ?nadu|ತಮಿಳು ?ನಾಡು|தமிழ் ?நாடு|तमिलनाडु|తమిళనాడు|(?:dakshina|uttara) kannada|(?:ದಕ್ಷಿಣ|ಉತ್ತರ) ಕನ್ನಡ|ಕನ್ನಡಕ|ಹಿಂದಿನ|ಹಿಂದಿಂದ/gi;

// { lang, name } for a clear request, { cannot: lang } for "I don't know
// <language>", or null.
function detectLanguageRequest(text) {
  const t = String(text || '').replace(NOT_A_LANGUAGE, ' ');
  const named = Object.entries(LANGUAGES).filter(([, l]) => l.re.test(t));
  if (named.length !== 1) return null; // none, or several: not clear enough to act on
  const [code, l] = named[0];
  if (CANNOT.test(t)) return { cannot: code, name: l.name };
  if (!ASK.test(t)) return null;
  return { lang: code, name: l.name };
}

const languageName = (code) => LANGUAGES[code]?.name || null;

module.exports = { detectLanguageRequest, languageName, LANGUAGES };
