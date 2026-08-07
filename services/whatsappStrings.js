/**
 * services/whatsappStrings.js
 * ============================================================
 * All customer-facing copy for the WhatsApp booking flow, in the 4
 * supported languages. Nothing here computes anything (no fare/distance
 * logic) -- purely message templates keyed by [language][messageKey],
 * with {placeholder} tokens filled in by t() below. whatsappFlow.js
 * (built next) is the only thing that decides WHICH key to send and
 * WHAT values to interpolate.
 *
 * English is the fallback for both a missing language and a missing key
 * within a language -- a translation gap must never mean silence to the
 * customer, it means they see English for that one line instead.
 * ============================================================
 */
'use strict';

const STRINGS = {
  en: {
    chooseLanguage : 'Please choose your language:',
    chooseService  : 'Please select the service you need:',
    chooseSubType  : 'Please select a type:',
    askPickup      : 'Please share your pickup location (send your location, or type the address):',
    askDrop        : 'Please share the drop location (send your location, or type the address):',
    bookingSummary : 'Service: {service}\nPickup: {pickup}\nDrop: {drop}\nDistance: {distance} km\nFare: ₹{fare}',
    confirmPrompt  : 'Confirm this booking?',
    bookingConfirmed: 'Your booking is confirmed! Booking ID: {bookingId}. An ambulance will be dispatched shortly.',
    driverAssigned : 'A driver has been assigned to your trip.',
    tripStarted    : 'Your ambulance is on the way.',
    tripCompleted  : 'Your trip has been completed. Thank you for choosing SaveLife.',
    leadCaptured   : 'Thank you. Our team will call you shortly with a quote for this service.',
    invalidInput   : "Sorry, I didn't understand that. Please try again.",
    sessionExpired : "Your session has expired. Please send 'Hi' to start again.",
    cancelled      : 'Your booking has been cancelled.',
    placeNotFound  : "Sorry, I couldn't find that place. Please share your location using the button below.",
    placeConfirmed : 'Found: {place}',
    chooseLocationFromList: 'I found multiple matching places. Please choose the correct one:',
    bookingFailed  : 'Sorry, something went wrong creating your booking. Please try again or call us.',
  },

  hi: {
    chooseLanguage : 'कृपया अपनी भाषा चुनें:',
    chooseService  : 'कृपया वह सेवा चुनें जिसकी आपको आवश्यकता है:',
    chooseSubType  : 'कृपया एक प्रकार चुनें:',
    askPickup      : 'कृपया पिकअप स्थान भेजें (अपना लोकेशन भेजें, या पता टाइप करें):',
    askDrop        : 'कृपया ड्रॉप स्थान भेजें (अपना लोकेशन भेजें, या पता टाइप करें):',
    bookingSummary : 'सेवा: {service}\nपिकअप: {pickup}\nड्रॉप: {drop}\nदूरी: {distance} किमी\nकिराया: ₹{fare}',
    confirmPrompt  : 'क्या आप इस बुकिंग की पुष्टि करना चाहते हैं?',
    bookingConfirmed: 'आपकी बुकिंग की पुष्टि हो गई है! बुकिंग आईडी: {bookingId}। एम्बुलेंस जल्द ही भेजी जाएगी।',
    driverAssigned : 'आपकी ट्रिप के लिए एक ड्राइवर नियुक्त किया गया है।',
    tripStarted    : 'आपकी एम्बुलेंस रास्ते में है।',
    tripCompleted  : 'आपकी ट्रिप पूरी हो गई है। SaveLife चुनने के लिए धन्यवाद।',
    leadCaptured   : 'धन्यवाद। इस सेवा के लिए हमारी टीम जल्द ही आपको कॉल करके कीमत बताएगी।',
    invalidInput   : 'क्षमा करें, मुझे यह समझ नहीं आया। कृपया फिर से कोशिश करें।',
    sessionExpired : "आपका सेशन समाप्त हो गया है। कृपया 'Hi' भेजकर फिर से शुरू करें।",
    cancelled      : 'आपकी बुकिंग रद्द कर दी गई है।',
    placeNotFound  : 'क्षमा करें, वह स्थान नहीं मिला। कृपया नीचे दिए गए बटन से अपना स्थान साझा करें।',
    placeConfirmed : 'मिला: {place}',
    chooseLocationFromList: 'कई मिलते-जुलते स्थान मिले। कृपया सही वाला चुनें:',
    bookingFailed  : 'क्षमा करें, आपकी बुकिंग बनाने में कुछ गड़बड़ हुई। कृपया फिर से प्रयास करें या हमें कॉल करें।',
  },

  kn: {
    chooseLanguage : 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ:',
    chooseService  : 'ದಯವಿಟ್ಟು ನಿಮಗೆ ಬೇಕಾದ ಸೇವೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ:',
    chooseSubType  : 'ದಯವಿಟ್ಟು ಒಂದು ಪ್ರಕಾರವನ್ನು ಆಯ್ಕೆಮಾಡಿ:',
    askPickup      : 'ದಯವಿಟ್ಟು ಪಿಕಪ್ ಸ್ಥಳವನ್ನು ಕಳುಹಿಸಿ (ನಿಮ್ಮ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ, ಅಥವಾ ವಿಳಾಸ ಟೈಪ್ ಮಾಡಿ):',
    askDrop        : 'ದಯವಿಟ್ಟು ಡ್ರಾಪ್ ಸ್ಥಳವನ್ನು ಕಳುಹಿಸಿ (ನಿಮ್ಮ ಲೊಕೇಶನ್ ಕಳುಹಿಸಿ, ಅಥವಾ ವಿಳಾಸ ಟೈಪ್ ಮಾಡಿ):',
    bookingSummary : 'ಸೇವೆ: {service}\nಪಿಕಪ್: {pickup}\nಡ್ರಾಪ್: {drop}\nದೂರ: {distance} ಕಿಮೀ\nದರ: ₹{fare}',
    confirmPrompt  : 'ಈ ಬುಕಿಂಗ್ ಅನ್ನು ಖಚಿತಪಡಿಸುತ್ತೀರಾ?',
    bookingConfirmed: 'ನಿಮ್ಮ ಬುಕಿಂಗ್ ಖಚಿತವಾಗಿದೆ! ಬುಕಿಂಗ್ ಐಡಿ: {bookingId}. ಆಂಬ್ಯುಲೆನ್ಸ್ ಅನ್ನು ಶೀಘ್ರದಲ್ಲೇ ಕಳುಹಿಸಲಾಗುವುದು.',
    driverAssigned : 'ನಿಮ್ಮ ಟ್ರಿಪ್‌ಗೆ ಚಾಲಕರನ್ನು ನಿಯೋಜಿಸಲಾಗಿದೆ.',
    tripStarted    : 'ನಿಮ್ಮ ಆಂಬ್ಯುಲೆನ್ಸ್ ದಾರಿಯಲ್ಲಿದೆ.',
    tripCompleted  : 'ನಿಮ್ಮ ಟ್ರಿಪ್ ಪೂರ್ಣಗೊಂಡಿದೆ. SaveLife ಆಯ್ಕೆಮಾಡಿದ್ದಕ್ಕಾಗಿ ಧನ್ಯವಾದಗಳು.',
    leadCaptured   : 'ಧನ್ಯವಾದಗಳು. ಈ ಸೇವೆಗಾಗಿ ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ನಿಮಗೆ ಕರೆ ಮಾಡಿ ದರ ತಿಳಿಸುತ್ತದೆ.',
    invalidInput   : 'ಕ್ಷಮಿಸಿ, ಅದು ನನಗೆ ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    sessionExpired : "ನಿಮ್ಮ ಸೆಷನ್ ಮುಗಿದಿದೆ. ದಯವಿಟ್ಟು 'Hi' ಕಳುಹಿಸಿ ಮತ್ತೆ ಪ್ರಾರಂಭಿಸಿ.",
    cancelled      : 'ನಿಮ್ಮ ಬುಕಿಂಗ್ ಅನ್ನು ರದ್ದುಗೊಳಿಸಲಾಗಿದೆ.',
    placeNotFound  : 'ಕ್ಷಮಿಸಿ, ಆ ಸ್ಥಳ ಸಿಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಕೆಳಗಿನ ಬಟನ್ ಬಳಸಿ ನಿಮ್ಮ ಸ್ಥಳವನ್ನು ಹಂಚಿಕೊಳ್ಳಿ.',
    placeConfirmed : 'ಸಿಕ್ಕಿದೆ: {place}',
    chooseLocationFromList: 'ಹಲವಾರು ಹೊಂದಾಣಿಕೆಯ ಸ್ಥಳಗಳು ಸಿಕ್ಕಿವೆ. ದಯವಿಟ್ಟು ಸರಿಯಾದುದನ್ನು ಆಯ್ಕೆಮಾಡಿ:',
    bookingFailed  : 'ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ಬುಕಿಂಗ್ ಮಾಡುವಲ್ಲಿ ಏನೋ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ನಮಗೆ ಕರೆ ಮಾಡಿ.',
  },

  te: {
    chooseLanguage : 'దయచేసి మీ భాషను ఎంచుకోండి:',
    chooseService  : 'దయచేసి మీకు అవసరమైన సేవను ఎంచుకోండి:',
    chooseSubType  : 'దయచేసి ఒక రకాన్ని ఎంచుకోండి:',
    askPickup      : 'దయచేసి పికప్ స్థానాన్ని పంపండి (మీ లొకేషన్ పంపండి, లేదా చిరునామా టైప్ చేయండి):',
    askDrop        : 'దయచేసి డ్రాప్ స్థానాన్ని పంపండి (మీ లొకేషన్ పంపండి, లేదా చిరునామా టైప్ చేయండి):',
    bookingSummary : 'సేవ: {service}\nపికప్: {pickup}\nడ్రాప్: {drop}\nదూరం: {distance} కి.మీ\nధర: ₹{fare}',
    confirmPrompt  : 'ఈ బుకింగ్‌ను నిర్ధారించాలా?',
    bookingConfirmed: 'మీ బుకింగ్ నిర్ధారించబడింది! బుకింగ్ ఐడీ: {bookingId}. అంబులెన్స్ త్వరలో పంపబడుతుంది.',
    driverAssigned : 'మీ ట్రిప్ కోసం ఒక డ్రైవర్‌ను నియమించారు.',
    tripStarted    : 'మీ అంబులెన్స్ దారిలో ఉంది.',
    tripCompleted  : 'మీ ట్రిప్ పూర్తయింది. SaveLife ఎంచుకున్నందుకు ధన్యవాదాలు.',
    leadCaptured   : 'ధన్యవాదాలు. ఈ సేవ కోసం మా బృందం త్వరలో మీకు కాల్ చేసి ధర తెలియజేస్తుంది.',
    invalidInput   : 'క్షమించండి, అది నాకు అర్థం కాలేదు. దయచేసి మళ్ళీ ప్రయత్నించండి.',
    sessionExpired : "మీ సెషన్ ముగిసింది. దయచేసి 'Hi' పంపి మళ్ళీ ప్రారంభించండి.",
    cancelled      : 'మీ బుకింగ్ రద్దు చేయబడింది.',
    placeNotFound  : 'క్షమించండి, ఆ స్థలం కనుగొనబడలేదు. దయచేసి క్రింది బటన్ ఉపయోగించి మీ లొకేషన్‌ను పంపండి.',
    placeConfirmed : 'కనుగొనబడింది: {place}',
    chooseLocationFromList: 'అనేక సరిపోలిన స్థలాలు కనుగొనబడ్డాయి. దయచేసి సరైనదాన్ని ఎంచుకోండి:',
    bookingFailed  : 'క్షమించండి, మీ బుకింగ్ చేయడంలో ఏదో తప్పు జరిగింది. దయచేసి మళ్ళీ ప్రయత్నించండి లేదా మాకు కాల్ చేయండి.',
  },
};

const FALLBACK_LANG = 'en';

// vars values are interpolated via simple {name} token replacement -- not
// full i18n pluralization/formatting, deliberately: every message here is
// a single flat line/block, not a sentence assembled from multiple
// grammatically-ordered parts, so this is sufficient without pulling in
// an i18n library.
//
// Unmatched {name} tokens (missing from vars) are left as-is rather than
// blanked out -- an empty gap in a sent message would look like a
// formatting bug and be harder to notice than the literal placeholder
// text during testing.
function t(lang, key, vars = {}) {
  const langStrings = STRINGS[lang] || STRINGS[FALLBACK_LANG];
  const template = langStrings[key] ?? STRINGS[FALLBACK_LANG][key];
  if (template == null) return '';

  return template.replace(/\{(\w+)\}/g, (match, name) => (
    vars[name] != null ? String(vars[name]) : match
  ));
}

module.exports = { STRINGS, t };
