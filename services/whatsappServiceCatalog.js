/**
 * services/whatsappServiceCatalog.js
 * ============================================================
 * The 9 top-level services shown in the WhatsApp booking list, plus their
 * sub-types where they have any, each mapped (or not) to the backendCode
 * fareCalculator.compute()/findPricingDoc() accept.
 *
 * Key design rule: "bookable" is NEVER hand-typed -- it's derived from
 * whether a backendCode is present. A node with a backendCode has real
 * Pricing behind it and can go through the priced flow; a node without
 * one falls back to lead-capture. When pricing is added for e.g. Air
 * Cargo, the only change needed here is filling in its backendCode --
 * `bookable` flips to true automatically and whatsappFlow.js (built
 * next) branches on that flag, not on hardcoded service names.
 *
 * A service with subTypes never carries its own backendCode -- the
 * booking is only ever placed against a specific sub-type. Its own
 * `bookable` is true iff at least one of its sub-types is, which is what
 * tells the flow whether to bother showing the sub-type list at all.
 *
 * WhatsApp interactive-list row titles have a HARD 24-character limit
 * (Meta rejects the whole message with error 131009 otherwise, in every
 * language -- there's no separate per-script allowance). Every label
 * below MUST stay <= 24 per label.length (UTF-16 units, same as what
 * Meta counts) in all 4 languages -- verify with a length dump after any
 * edit here, don't eyeball Kannada/Telugu/Hindi string length. Section
 * titles (the service label shown atop a sub-type list) share the same
 * 24-char cap. whatsappService.js's sendList() also hard-truncates as a
 * second line of defense, but that's a safety net, not a substitute for
 * getting the source labels right.
 * ============================================================
 */
'use strict';

const RAW_CATALOG = [
  {
    id: 'svc_emergency',
    label: {
      en: 'Emergency Ambulance',
      hi: 'आपातकालीन एम्बुलेंस',
      kn: 'ತುರ್ತು ಆಂಬ್ಯುಲೆನ್ಸ್',
      te: 'అత్యవసర అంబులెన్స్',
    },
    backendCode: null,
    subTypes: [
      {
        id: 'sub_bls',
        label: { en: 'BLS (Maruti Eeco)', hi: 'BLS (Maruti Eeco)', kn: 'BLS (Maruti Eeco)', te: 'BLS (Maruti Eeco)' },
        backendCode: 'bls',
      },
      {
        id: 'sub_bls_tempo',
        label: { en: 'BLS (Tempo)', hi: 'BLS (Tempo)', kn: 'BLS (Tempo)', te: 'BLS (Tempo)' },
        backendCode: 'bls_tempo',
      },
      {
        id: 'sub_als_tempo',
        label: { en: 'ALS (Tempo)', hi: 'ALS (Tempo)', kn: 'ALS (Tempo)', te: 'ALS (Tempo)' },
        backendCode: 'als_tempo',
      },
      {
        id: 'sub_acls_tempo',
        label: { en: 'ACLS (Tempo)', hi: 'ACLS (Tempo)', kn: 'ACLS (Tempo)', te: 'ACLS (Tempo)' },
        backendCode: 'acls_tempo',
      },
      {
        id: 'sub_nicu_tempo',
        label: { en: 'NICU (Tempo)', hi: 'NICU (Tempo)', kn: 'NICU (Tempo)', te: 'NICU (Tempo)' },
        backendCode: 'nicu_tempo',
      },
    ],
  },

  {
    id: 'svc_dead_body',
    label: {
      en: 'Dead Body Transport',
      hi: 'शव परिवहन',
      kn: 'ಶವ ಸಾಗಣೆ',
      te: 'మృతదేహ రవాణా',
    },
    backendCode: null,
    subTypes: [
      {
        id: 'sub_body_mini',
        label: { en: 'Body Mini (Eeco)', hi: 'Body Mini (Eeco)', kn: 'Body Mini (Eeco)', te: 'Body Mini (Eeco)' },
        backendCode: 'body_mini',
      },
      {
        id: 'sub_body_tempo',
        label: { en: 'Body Shifting (Tempo)', hi: 'Body Shifting (Tempo)', kn: 'Body Shifting (Tempo)', te: 'Body Shifting (Tempo)' },
        backendCode: 'body_tempo',
      },
    ],
  },

  {
    id: 'svc_air_ambulance',
    label: {
      en: 'Air Ambulance',
      hi: 'एयर एम्बुलेंस',
      kn: 'ವಾಯು ಆಂಬ್ಯುಲೆನ್ಸ್',
      te: 'ఎయిర్ అంబులెన్స్',
    },
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_air_cargo',
    label: {
      en: 'Air Cargo',
      hi: 'एयर कार्गो',
      kn: 'ಏರ್ ಕಾರ್ಗೋ',
      te: 'ఎయిర్ కార్గో',
    },
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_freezer_box',
    label: {
      en: 'Freezer Box',
      hi: 'फ्रीजर बॉक्स',
      kn: 'ಫ್ರೀಜರ್ ಬಾಕ್ಸ್',
      te: 'ఫ్రీజర్ బాక్స్',
    },
    // Freezer Box has real pricing, but through a separate /api/freezer
    // durations+floors system, not fareCalculator.compute() -- so it has
    // no backendCode here and stays lead-capture for now, per instruction.
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_event_ambulance',
    label: {
      en: 'Event Ambulance',
      hi: 'इवेंट एम्बुलेंस',
      kn: 'ಈವೆಂಟ್ ಆಂಬ್ಯುಲೆನ್ಸ್',
      te: 'ఈవెంట్ అంబులెన్స్',
    },
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_antim_yatra',
    label: {
      en: 'Antim Yatra',
      hi: 'अंतिम यात्रा',
      kn: 'ಅಂತಿಮ ಯಾತ್ರೆ',
      te: 'అంతిమ యాత్ర',
    },
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_train_transport',
    label: {
      en: 'Train Transport',
      hi: 'ट्रेन परिवहन',
      kn: 'ರೈಲು ಸಾಗಣೆ',
      te: 'రైలు రవాణా',
    },
    backendCode: null,
    subTypes: [],
  },

  {
    id: 'svc_standby_ambulance',
    label: {
      en: 'Standby Ambulance',
      hi: 'स्टैंडबाय एम्बुलेंस',
      kn: 'ಸ್ಟ್ಯಾಂಡ್‌ಬೈ ಆಂಬುಲೆನ್ಸ್',
      te: 'స్టాండ్‌బై అంబులెన్స్',
    },
    backendCode: null,
    subTypes: [],
  },
];

// Derive `bookable` everywhere from backendCode presence -- never hand-set,
// so adding a backendCode above is the only edit ever needed to make a new
// service/sub-type bookable.
const CATALOG = RAW_CATALOG.map((service) => {
  const subTypes = service.subTypes.map((sub) => ({
    ...sub,
    bookable: Boolean(sub.backendCode),
  }));

  return {
    ...service,
    subTypes,
    bookable: Boolean(service.backendCode) || subTypes.some((sub) => sub.bookable),
  };
});

// Top-level list for the WhatsApp interactive list message. Returns the
// full catalog objects (id + label + subTypes + bookable) -- whatsappFlow.js
// picks whichever language's label to render.
function getServiceList() {
  return CATALOG;
}

function getService(serviceId) {
  return CATALOG.find((service) => service.id === serviceId);
}

function getSubTypes(serviceId) {
  const service = getService(serviceId);
  return service ? service.subTypes : [];
}

// Resolves the exact string fareCalculator.compute()/findPricingDoc() expect.
// - Service has sub-types: only a matching, bookable sub-type resolves;
//   the service itself never carries a bookable code directly.
// - Service has no sub-types: its own backendCode resolves (null if none).
// Returns null for any unknown id, missing sub-type, or non-bookable node --
// callers should treat null as "route to lead-capture", never as "retry".
function resolveBackendCode(serviceId, subTypeId) {
  const service = getService(serviceId);
  if (!service) return null;

  if (service.subTypes.length > 0) {
    if (!subTypeId) return null;
    const subType = service.subTypes.find((sub) => sub.id === subTypeId);
    return subType && subType.bookable ? subType.backendCode : null;
  }

  return service.bookable ? service.backendCode : null;
}

module.exports = {
  getServiceList,
  getService,
  getSubTypes,
  resolveBackendCode,
};
