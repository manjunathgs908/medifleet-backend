'use strict';
/**
 * services/aiCaller/spokenLanguage.js
 * ============================================================
 * Which language the caller is SPEAKING — not which letters the
 * transcriber wrote it in. Real calls had Kannada speech transcribed in
 * Telugu letters ("మనెల్లిదరే", "బేకిదె"), so the script alone says
 * nothing.
 *
 * How: Devanagari, Tamil, Telugu, Kannada and Malayalam share one Unicode
 * layout (the ISCII order), so every letter is moved onto the Kannada
 * block by its offset — "మాడి" (Telugu letters) becomes "ಮಾಡಿ", the
 * Kannada word it is. Each turn is then scored against short lists of
 * everyday words that are distinctive for each language (also in Latin
 * letters, for romanised transcripts). A turn counts for a language only
 * with at least MIN_HITS words and twice as many as any other language;
 * session.js switches only when two turns in a row agree.
 * ============================================================
 */

const BLOCKS = [0x0900, 0x0B80, 0x0C00, 0x0C80, 0x0D00]; // Devanagari, Tamil, Telugu, Kannada, Malayalam
const KANNADA = 0x0C80;
const MIN_HITS = 2;

// Any of the five scripts -> Kannada letters (same position in the block).
function canonical(text) {
  let out = '';
  for (const ch of String(text || '').toLowerCase()) {
    const cp = ch.codePointAt(0);
    const base = BLOCKS.find((b) => cp >= b && cp < b + 0x80);
    out += base != null ? String.fromCodePoint(cp - base + KANNADA) : ch;
  }
  return out;
}

// Distinctive everyday words. A word of 3+ letters also matches as the
// start of a longer word ("ಮನೆ" -> "ಮನೆಲ್ಲಿದರೆ"). Words two languages
// share (ಇಲ್ಲ / ഇല്ല, ಸರಿ) are left out on purpose.
const LEXICON = {
  kn: {
    native: 'ಬೇಕು ಬೇಕಾ ಬೇಕಿದ ಬೇಡ ಇದೆ ಇದ್ದಾರೆ ಇದಾರೆ ಮಾಡಿ ಮಾಡ್ ಹೌದು ಏನು ಎಲ್ಲಿ ಎಷ್ಟು ನಮ್ಮ ನಿಮ್ಮ ನನಗೆ ನಂಗೆ ನಮಗೆ ಅವರಿಗೆ ಹೋಗ ಬನ್ನಿ ಆಗುತ್ತೆ ಆಯ್ತು ಅಲ್ವಾ ಗೊತ್ತಿಲ್ಲ ಸ್ವಲ್ಪ ನಾಳೆ ಇವತ್ತು ಈವತ್ತು ಮನೆ ಹೇಳಿ ತುಂಬಾ ಸಂಜೆ ಗಂಟೆ ಬೆಳಿಗ್ಗೆ ಯಾವಾಗ ಆಸ್ಪತ್ರೆ ಬರುತ್ತೆ ಹೇಳ್ತೀನಿ',
    latin: 'beku beda bekagide maadi madi houdu howdu ivattu naale swalpa gottilla ide idhe yelli eshtu namge nange heli banni aagutte alva tumba sanje gante mane',
  },
  te: {
    native: 'కావాలి కావాల ఉంది ఉందా లేదు అండి చేయండి చెప్పండి చెప్ప ఎక్కడ ఇప్పుడు రేపు ఎంత వద్దు అవును మాకు నాకు మీరు నేను ఏమిటి ఇంటికి ఇల్లు దగ్గర వస్తారా',
    latin: 'kavali kaavali undi ledu andi cheyandi cheppandi ekkada ippudu repu enta vaddu avunu maaku naaku meeru nenu emiti',
  },
  ta: {
    native: 'வேண்டும் வேணும் இருக்கு இருக்கா இல்லை எங்கே எங்க எவ்வளவு சொல்லுங்க ஆமா வீடு நாளைக்கு இப்போ வாங்க போகணும் எனக்கு உங்க',
    latin: 'venum vendum irukku illai enga evvalavu sollunga aama veedu naalaiku ippo vaanga enakku unga',
  },
  ml: {
    native: 'വേണം ഉണ്ട് എവിടെ എത്ര പറയൂ അതെ വീട് നാളെ ഇപ്പോൾ എനിക്ക് നിങ്ങൾ ആണ് ചെയ്യണം വരണം',
    latin: 'venam undu evide ethra parayu athe veedu naale ippol enikku ningal aanu cheyyanam',
  },
  hi: {
    native: 'है हैं नहीं चाहिए क्या कहाँ कहां कितना मुझे हमें आप अभी कल घर बताइए कीजिए करो जाना होगा',
    latin: 'hai hain nahi nahin chahiye kya kahan kitna mujhe hume humein aap abhi ghar bataiye kijiye karo jaana',
  },
};

const COMPILED = Object.fromEntries(Object.entries(LEXICON).map(([lang, l]) => [
  lang,
  [...l.native.split(/\s+/).map(canonical), ...l.latin.split(/\s+/)].filter(Boolean),
]));

const letters = (w) => [...w].length;
const hit = (token, word) => token === word || (letters(word) >= 3 && token.startsWith(word));

// { lang: 'kn' | 'te' | 'ta' | 'ml' | 'hi' | null, hits }
function detect(text) {
  const tokens = canonical(text).split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const hits = {};
  for (const [lang, list] of Object.entries(COMPILED)) {
    hits[lang] = tokens.filter((t) => list.some((w) => hit(t, w))).length;
  }
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const [[top, n], [, second]] = ranked;
  const lang = n >= MIN_HITS && n >= 2 * second ? top : null;
  return { lang, hits };
}

const NAMES = { kn: 'Kannada', te: 'Telugu', ta: 'Tamil', ml: 'Malayalam', hi: 'Hindi', en: 'English' };

module.exports = { detect, canonical, NAMES, MIN_HITS };
