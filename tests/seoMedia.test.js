/**
 * tests/seoMedia.test.js
 * ============================================================
 * Media on an SEO article.
 *
 * The policy, which these tests exist to hold in place:
 *
 *   Media is OPTIONAL. No banner, no in-article images, or neither, is a
 *   complete article. There is no quota, no minimum and no ratio, and nothing
 *   anywhere may require an image for its own sake.
 *
 *   Anything actually supplied is checked STRICTLY -- a usable URL, alt text
 *   that describes the picture, a placement the article can honour -- because
 *   half an image ships a broken <img> to a public medical page.
 *
 *   Those findings are ADVISORY. They are shown to the reviewer and they never
 *   set checks.passed to false.
 *
 * Four parts:
 *
 *   A  media is optional, and supplied media is validated
 *   B  what counts as alt text
 *   C  URLs, placement, and the storage shape
 *   D  the gate: media never blocks approval, and every other gate still does
 *
 * The database and the live-page index are stubbed. Everything else -- the
 * JSON-LD builder, the pricing guard, the similarity fingerprint, the media
 * validator -- runs for real, because a gate test that mocks the gate proves
 * nothing.
 * ============================================================
 */
'use strict';

jest.mock('../services/seoLivePages', () => ({
  isIndexStale: jest.fn(async () => false),
  loadLivePageIndex: jest.fn(async () => []),
  refreshLivePageIndex: jest.fn(async () => {}),
}));

const {
  validateMedia,
  normalizeMedia,
  altTextProblem,
  urlProblem,
  contentAnchors,
  RESERVED_PLACEMENTS,
} = require('../services/seoMedia');
const { evaluateGates } = require('../services/seoGenerator');
const { classifyFailures } = require('../services/seoAutoRepair');
const SeoArticle = require('../models/SeoArticle');

// ── Fixtures ────────────────────────────────────────────────

const BANNER = {
  url: 'https://cdn.savelife.health/guides/bls-ambulance-bangalore/banner.jpg',
  alt: 'BLS ambulance parked outside a Bengaluru hospital entrance at night',
  width: 1600,
  height: 900,
};

const IMAGE = {
  url: 'https://cdn.savelife.health/guides/bls-ambulance-bangalore/interior.jpg',
  alt: 'Oxygen cylinder and stretcher secured inside a basic life support ambulance',
  placement: 'what-a-bls-ambulance-carries',
  width: 1200,
  height: 800,
};

const SECOND_IMAGE = {
  url: '/images/guides/dispatch-desk.jpg',
  alt: 'Dispatch coordinator taking an emergency call at the Bengaluru control desk',
  placement: 'how-dispatch-decides-what-to-send',
};

// A body long enough to clear the 700-word floor, so the "everything passes"
// case in D exercises the real gate rather than a shortened stand-in. The word
// count is asserted below so this cannot drift under the floor unnoticed and
// quietly turn that test into a different test.
const SECTIONS = [
  ['What a BLS ambulance carries',
    `A basic life support ambulance is the vehicle most families in Bengaluru
     actually need. It is staffed by a trained driver and carries the equipment
     required to keep a stable patient stable on the way to hospital. That means
     oxygen, suction, a stretcher that locks to the floor, a scoop stretcher for
     spinal precautions, and a basic airway kit. It does not carry a ventilator
     and it is not staffed by a doctor, which is the line between this vehicle
     and an advanced life support one. Knowing which of the two you are asking
     for saves the dispatcher a round of questions at the worst possible moment,
     and it means the vehicle that arrives is the vehicle that helps.`],
  ['How dispatch decides what to send',
    `When a call comes in, the coordinator is listening for a small number of
     things: whether the patient is breathing normally, whether they are
     conscious, whether there has been a fall or a collision, and whether any
     equipment is already attached to them. Those answers decide the vehicle.
     A stable transfer between two hospitals is a different journey from a
     collapse at home, even when the distance is identical. Describing the
     situation plainly is more useful than naming a vehicle type, because the
     coordinator does this every day and will tell you what the situation needs
     and what can reach you soonest.`],
  ['What happens between the call and the arrival',
    `The minutes after the call are not dead time. Keep the phone line open,
     because dispatch may ring back for directions that a map cannot give. Unlock
     the gate, switch on an outside light, and send someone to the street to flag
     the vehicle down. Move furniture out of any corridor a stretcher has to pass
     through, and think about the lift: many buildings in Bengaluru have lifts a
     stretcher will not fit into flat, which changes how the crew has to work.
     Gather the patient current medication, any discharge summary from a recent
     admission, and identification. Somebody should be ready to travel with the
     patient.`],
  ['Getting a patient down from an upper floor',
    `This is the part families rarely plan for and it is often the slowest part
     of the whole journey. A crew arriving at a fourth-floor flat with a narrow
     staircase and no service lift has to move a patient by hand, and how long
     that takes depends almost entirely on what is in the way. Clearing the
     landing, propping the doors open and having a second adult available makes a
     measurable difference. If the building has a service lift, find out in
     advance who holds the key, because tracking down a caretaker while a crew
     waits is time nobody gets back.`],
  ['Interhospital transfers and what they need',
    `A transfer between hospitals is a planned journey, and planning is exactly
     what makes it go well. The sending hospital should confirm that the
     receiving one has a bed, and the referral paperwork should be ready before
     the vehicle is booked rather than after it arrives. If the patient is on
     oxygen, that has to be said at the time of booking, because it determines
     the vehicle. If a nurse or attendant is travelling, say so, since seating is
     limited and a crew that knows in advance can plan the loading. Discharge
     summaries and imaging travel with the patient.`],
  ['Night journeys and traffic',
    `Bengaluru traffic is the single biggest variable in any estimate anyone
     gives you, and no honest answer to how long will it take ignores it. A
     journey across the city at nine in the morning and the same journey at
     eleven at night are not the same journey. Dispatch will tell you what is
     realistic from where the nearest vehicle actually is, not from a straight
     line on a map. At night the constraints change rather than disappear: fewer
     vehicles are on the road, but gates are locked, security desks are
     unattended and lifts are sometimes switched off.`],
  ['Death care and body shifting',
    `Moving a body is a different service from an emergency transfer and it has
     its own requirements. A freezer box is needed when a family is waiting for
     relatives to travel, and the vehicle has to be suitable for the journey
     ahead, which for an intercity trip means something quite different from a
     crossing of the city. The paperwork matters here more than anywhere else,
     because a death certificate and, for longer journeys, a no-objection
     certificate are what allow the journey to proceed at all. Asking about this
     early avoids a delay at the worst possible time.`],
  ['What to ask before you book',
    `Ask what vehicle is being sent and what is on board. Ask where it is coming
     from, because that is what determines when it will reach you rather than any
     general promise about response times. Ask whether the crew has been told
     about stairs, a lift or a narrow gate. Ask how the fare is worked out, and
     expect the answer to be based on the actual road distance rather than a flat
     number quoted before anyone knows where you are going. Ask whether you can
     travel with the patient. A dispatcher who answers all of these plainly is
     one worth booking with.`],
];

const CONTENT = SECTIONS.map(([h, body]) =>
  `## ${h}\n\n${body.replace(/\s*\n\s*/g, ' ').trim()}`).join('\n\n');

const FACTS = {
  business: { name: 'SaveLife Health Services', website: 'https://www.savelife.health' },
  livePages: [
    { href: '/bls-ambulance-bangalore' },
    { href: '/icu-ambulance-bangalore' },
    { href: '/book' },
  ],
};

// Title and meta are MEASURED, never counted by eye: a fixture one character
// outside the band silently turns a media test into a title test. Asserted in
// D as well, so drift is caught rather than absorbed.
const TITLE = 'BLS Ambulance in Bangalore: What It Carries and When to Call';
const META =
  'A plain guide to basic life support ambulances in Bengaluru: what the vehicle '
  + 'carries, how dispatch chooses one, and what to have ready before it arrives.';

const article = (over = {}) => ({
  cluster: 'bls',
  searchIntent: 'informational',
  slug: 'bls-ambulance-bangalore-guide',
  title: TITLE,
  metaDescription: META,
  h1: 'BLS ambulance in Bangalore',
  content: CONTENT,
  faqs: [{ q: 'What does a BLS ambulance carry?', a: 'Oxygen, suction, a stretcher and a basic airway kit.' }],
  internalLinks: [
    { label: 'BLS ambulance', href: '/bls-ambulance-bangalore' },
    { label: 'ICU ambulance', href: '/icu-ambulance-bangalore' },
  ],
  // Deliberately NO media by default. The common case is an article without
  // any, and it has to be the default the rest of these tests are written
  // against, or "optional" is only optional in the tests that say so.
  ...over,
});

const check = (media, content = CONTENT) => validateMedia(media, { content });
const joined = (media, content) => check(media, content).errors.join(' | ');

// ============================================================
describe('A. media is optional; supplied media is checked', () => {
  // 1
  test('no media at all is clean — no errors, nothing to report', () => {
    const r = check(undefined);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // 2
  test('an empty media object is equally clean', () => {
    expect(check({}).errors).toEqual([]);
    expect(check({ images: [] }).errors).toEqual([]);
    expect(check({ banner: {}, images: [] }).errors).toEqual([]);
    expect(check({ banner: null, images: null }).errors).toEqual([]);
  });

  test('an abandoned empty editor row is not a broken image', () => {
    expect(check({ images: [{ url: '', alt: '', placement: '' }] }).errors).toEqual([]);
  });

  // 3
  test('a banner on its own is allowed', () => {
    const r = check({ banner: { ...BANNER }, images: [] });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // 4
  test('an in-article image on its own is allowed', () => {
    const r = check({ images: [{ ...IMAGE }] });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // 5
  test('a banner plus one in-article image is allowed', () => {
    expect(check({ banner: { ...BANNER }, images: [{ ...IMAGE }] }).errors).toEqual([]);
  });

  // 6
  test('a banner plus two in-article images is allowed', () => {
    expect(check({ banner: { ...BANNER }, images: [{ ...IMAGE }, { ...SECOND_IMAGE }] }).errors).toEqual([]);
  });

  test('there is no quota — 0, 1 and 2 images are all equally correct', () => {
    const counts = [0, 1, 2].map((n) => check({
      banner: { ...BANNER },
      images: [{ ...IMAGE }, { ...SECOND_IMAGE }].slice(0, n),
    }).errors);
    expect(counts).toEqual([[], [], []]);
  });

  // 7
  test('a supplied banner with no URL is reported', () => {
    expect(joined({ banner: { alt: BANNER.alt } })).toMatch(/Banner image: no URL/);
  });

  test('a supplied image with no URL is reported', () => {
    const media = { images: [{ alt: IMAGE.alt, placement: IMAGE.placement }] };
    expect(joined(media)).toMatch(/In-article image 1: no URL/);
  });

  test.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/a.jpg', 'not a url'])(
    'a supplied URL that must never reach an img src is reported: %p',
    (url) => {
      expect(joined({ banner: { url, alt: BANNER.alt } })).toMatch(/Banner image:/);
    },
  );

  // 8
  test('a supplied banner with no alt text is reported', () => {
    expect(joined({ banner: { url: BANNER.url } })).toMatch(/Banner image: no alt text/);
  });

  test('whitespace alt text is reported the same way', () => {
    expect(joined({ banner: { url: BANNER.url, alt: '   \n\t ' } })).toMatch(/Banner image: no alt text/);
  });

  test('a supplied image with no alt text is reported', () => {
    const media = { images: [{ url: IMAGE.url, placement: IMAGE.placement }] };
    expect(joined(media)).toMatch(/In-article image 1: no alt text/);
  });

  test.each([
    'image', 'photo', 'ambulance image', 'banner', 'picture', 'img1',
    'IMG_2043', 'photo-03', 'pic', 'Untitled', 'placeholder', 'stock photo',
    'ambulance-interior.jpg',
  ])('generic alt text %p is reported', (alt) => {
    expect(joined({ banner: { ...BANNER, alt } })).toMatch(/Banner image: alt text/);
  });

  // 9
  test('a supplied image with no placement is reported', () => {
    const media = { images: [{ url: IMAGE.url, alt: IMAGE.alt }] };
    expect(joined(media)).toMatch(/In-article image 1: no placement/);
  });

  test('a placement naming nothing in the article is reported', () => {
    const media = { images: [{ ...IMAGE, placement: 'somewhere-in-the-middle' }] };
    expect(joined(media)).toMatch(/does not match anything in the article/);
  });

  test('one bad image among good ones is reported, and names which one', () => {
    const media = {
      banner: { ...BANNER },
      images: [{ ...IMAGE }, { ...SECOND_IMAGE, alt: 'photo' }, { ...IMAGE, placement: 'end' }],
    };
    const r = check(media);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/In-article image 2: alt text/);
    expect(r.errors.join(' ')).not.toMatch(/In-article image 1:/);
    expect(r.errors.join(' ')).not.toMatch(/In-article image 3:/);
  });

  test('nothing anywhere asks for a banner or an image', () => {
    // The regression that matters most. If a quota is ever reintroduced it
    // will show up here first, whatever wording it arrives in.
    for (const media of [undefined, {}, { images: [] }, { banner: { ...BANNER } }, { images: [{ ...IMAGE }] }]) {
      expect(check(media).errors.join(' ')).not.toMatch(/required|must have|at least one/i);
    }
  });
});

// ============================================================
describe('B. alt text has to describe the image, not fill the field', () => {
  test('whitespace alone is not the only thing rejected', () => {
    // The point of the whole rule. A trim-and-check passes every one of these.
    for (const alt of ['image', 'photo', 'banner', 'picture', 'img1', 'ambulance image']) {
      expect(altTextProblem(alt)).not.toBeNull();
    }
  });

  test.each([
    'BLS ambulance parked outside a Bengaluru hospital entrance at night',
    'Oxygen cylinder and stretcher secured inside a basic life support ambulance',
    'Paramedic guiding a stretcher through a narrow apartment stairwell',
    'Photo of the dispatch desk during a night shift in Bengaluru',
  ])('a real description is accepted: %p', (alt) => {
    expect(altTextProblem(alt)).toBeNull();
  });

  test('a generic word inside a real sentence does not condemn it', () => {
    // "photo" is not banned; it just does not count towards the description.
    expect(altTextProblem('Photo of the dispatch desk during a night shift in Bengaluru')).toBeNull();
    expect(altTextProblem('photo of ambulance')).not.toBeNull();
  });

  test('the primary keyword is not required — this is not a stuffing gate', () => {
    // No mention of "BLS", "ambulance" or "Bangalore" anywhere in it.
    expect(altTextProblem('Stretcher being lifted through a narrow stairwell by two crew members')).toBeNull();
  });

  test('alt text too long to be read out is rejected', () => {
    expect(altTextProblem('A '.repeat(120) + 'stretcher in a stairwell')).toMatch(/characters/);
  });

  test('a description of two real words is still too thin', () => {
    expect(altTextProblem('ambulance interior')).not.toBeNull();
    expect(altTextProblem('ambulance interior with stretcher')).toBeNull();
  });
});

// ============================================================
describe('C. URLs, placement and the stored shape', () => {
  test('https and site-relative URLs are accepted', () => {
    expect(urlProblem('https://cdn.savelife.health/a.jpg')).toBeNull();
    expect(urlProblem('/images/a.jpg')).toBeNull();
  });

  test('placement anchors come from the article own headings', () => {
    const { anchors } = contentAnchors(CONTENT);
    for (const reserved of RESERVED_PLACEMENTS) expect(anchors.has(reserved)).toBe(true);
    expect(anchors.has('what-a-bls-ambulance-carries')).toBe(true);
    expect(anchors.has('night-journeys-and-traffic')).toBe(true);
  });

  test('a placement naming the heading itself works as well as its slug', () => {
    expect(check({ images: [{ ...IMAGE, placement: 'Night journeys and traffic' }] }).ok).toBe(true);
  });

  test('editing the body out from under an image invalidates its placement', () => {
    // The association is re-resolved against the CURRENT text every time,
    // which is the whole reason placement is not just a stored string.
    const media = { images: [{ ...IMAGE }] };
    expect(check(media, CONTENT).ok).toBe(true);
    expect(check(media, '## A completely different heading\n\nWords.').ok).toBe(false);
  });

  test('normalizeMedia trims, drops abandoned rows and refuses junk dimensions', () => {
    const out = normalizeMedia({
      banner: { url: '  https://x.test/a.jpg  ', alt: '  a   described   banner  ', width: '1600', height: -4 },
      images: [{ url: '', alt: '', placement: '' }, { ...IMAGE, width: 'abc' }],
    });
    expect(out.banner).toEqual({ url: 'https://x.test/a.jpg', alt: 'a described banner', width: 1600, height: undefined });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].width).toBeUndefined();
  });

  test('normalizeMedia judges nothing — that is validateMedia job alone', () => {
    const out = normalizeMedia({ banner: { url: 'javascript:alert(1)', alt: 'photo' }, images: [] });
    expect(out.banner.alt).toBe('photo');           // stored, so the reviewer can see it
    expect(check(out).ok).toBe(false);              // and reported by the validator
  });

  test('removing the banner actually removes it', () => {
    // normalizeMedia omits `banner` entirely when the reviewer clears it, so
    // this depends on Mongoose REPLACING the media path rather than merging
    // into it. If that ever changed, a cleared banner would silently survive.
    const doc = new SeoArticle({
      keyword: 'k', slug: 's', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      media: { banner: { ...BANNER }, images: [{ ...IMAGE }] },
    });
    expect(doc.toObject().media.banner).toBeDefined();

    Object.assign(doc, { media: normalizeMedia({ banner: { url: '', alt: '' }, images: [{ ...IMAGE }] }) });

    expect(doc.toObject().media.banner).toBeUndefined();
    expect(doc.toObject().media.images).toHaveLength(1);
    // ...and removing it is not an error, because a banner was never required.
    expect(validateMedia(doc.media, { content: CONTENT }).errors).toEqual([]);
  });

  test('media and mediaErrors are declared paths, so they survive a save', () => {
    // The pricingClaims lesson: an undeclared path is dropped by strict mode
    // on every write, and mediaErrors is read off a STORED document to render
    // the Media panel.
    expect(SeoArticle.schema.path('checks.mediaErrors')).toBeDefined();
    expect(SeoArticle.schema.path('media.images')).toBeDefined();
    const doc = new SeoArticle({
      keyword: 'k', slug: 's', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      media: { banner: { ...BANNER }, images: [{ ...IMAGE }] },
      checks: { mediaErrors: ['In-article image 1: no alt text.'] },
    });
    expect(doc.toObject().checks.mediaErrors).toEqual(['In-article image 1: no alt text.']);
    expect(doc.toObject().media.banner.alt).toBe(BANNER.alt);
    expect(doc.toObject().media.images[0].placement).toBe(IMAGE.placement);
  });

  test('a half-filled image is still storable — it is reported, it does not vanish', () => {
    // Nothing in the media subtree is `required` at the schema, on purpose.
    const doc = new SeoArticle({
      keyword: 'k', slug: 's', title: 't', metaDescription: 'm', h1: 'h', content: 'c',
      media: { banner: { url: 'https://x.test/a.jpg' }, images: [{ url: 'https://x.test/b.jpg' }] },
    });
    expect(doc.validateSync()).toBeUndefined();
  });
});

// ============================================================
describe('D. the gate: media never blocks, everything else still does', () => {
  let exists;
  let find;

  beforeEach(() => {
    exists = jest.spyOn(SeoArticle, 'exists').mockResolvedValue(null);
    find = jest.spyOn(SeoArticle, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
  });
  afterEach(() => { exists.mockRestore(); find.mockRestore(); });

  const gate = (over) => evaluateGates(article(over), { facts: FACTS, claims: [] });

  test('the fixture really does clear every other gate', async () => {
    // If this drifts, every assertion below turns into a test of something
    // else. Measured, not eyeballed.
    const g = await gate();
    expect(g.checks.wordCount).toBeGreaterThanOrEqual(700);
    expect(TITLE.length).toBeGreaterThanOrEqual(55);
    expect(TITLE.length).toBeLessThanOrEqual(60);
    expect(META.length).toBeGreaterThanOrEqual(150);
    expect(META.length).toBeLessThanOrEqual(160);
    expect(g.failedChecks).toEqual([]);
    expect(g.passed).toBe(true);
  });

  // 1 + 2
  test('an article with no media passes', async () => {
    const g = await gate();
    expect(g.checks.mediaErrors).toEqual([]);
    expect(g.passed).toBe(true);
  });

  test('an article with an empty media object passes', async () => {
    const g = await gate({ media: { images: [] } });
    expect(g.checks.mediaErrors).toEqual([]);
    expect(g.passed).toBe(true);
  });

  // 3-6
  test.each([
    ['banner only', { banner: { ...BANNER }, images: [] }],
    ['one in-article image only', { images: [{ ...IMAGE }] }],
    ['banner and one image', { banner: { ...BANNER }, images: [{ ...IMAGE }] }],
    ['banner and two images', { banner: { ...BANNER }, images: [{ ...IMAGE }, { ...SECOND_IMAGE }] }],
  ])('%s passes', async (_label, media) => {
    const g = await gate({ media });
    expect(g.checks.mediaErrors).toEqual([]);
    expect(g.passed).toBe(true);
  });

  // 7, 8, 9 — reported, never blocking
  test.each([
    ['a broken URL', { banner: { url: 'javascript:alert(1)', alt: BANNER.alt } }],
    ['no alt text', { banner: { url: BANNER.url } }],
    ['generic alt text', { banner: { ...BANNER, alt: 'ambulance image' } }],
    ['no placement', { images: [{ url: IMAGE.url, alt: IMAGE.alt }] }],
    ['a placement naming nothing', { images: [{ ...IMAGE, placement: 'nowhere-at-all' }] }],
  ])('%s is reported but does not block approval', async (_label, media) => {
    const g = await gate({ media });
    expect(g.checks.mediaErrors.length).toBeGreaterThan(0);
    expect(g.passed).toBe(true);
    // ...and it stays out of failedChecks, which enumerates the terms of
    // `passed`. A media note there would report the article as failed while
    // passed is true.
    expect(g.failedChecks).toEqual([]);
  });

  // 12
  test('an approved article with no media keeps its approval', async () => {
    // The article as it stands today: written before media existed, live, and
    // carrying none. Nothing about the new field may take that away.
    const g = await gate({ media: undefined });
    expect(g.passed).toBe(true);
    expect(g.failedChecks).toEqual([]);
    expect(g.checks.mediaErrors).toEqual([]);
    // Still fully evaluated in every other respect.
    expect(g.checks.wordCount).toBeGreaterThanOrEqual(700);
    expect(g.internalLinks).toHaveLength(2);
    expect(g.jsonLd.length).toBeGreaterThan(0);
  });

  test('an approved article with BROKEN media also keeps its approval', async () => {
    const g = await gate({ media: { banner: { url: BANNER.url, alt: 'photo' } } });
    expect(g.passed).toBe(true);
    expect(g.checks.mediaErrors.length).toBeGreaterThan(0);
  });

  // 11
  test('auto-repair never tries to invent or fix an image', () => {
    const { repairable, blocked } = classifyFailures({
      mediaErrors: [
        'Banner image: no alt text.',
        'In-article image 1: no placement — say where in the article it belongs.',
      ],
      metaLength: 154, titleLength: 57, wordCount: 900,
    });
    // Not repairable: Claude must never write an image URL into an article.
    expect(repairable.join(' ')).not.toMatch(/media|image|alt/i);
    // Not blocked either: a thin caption must not stop the loop fixing a title.
    expect(blocked.join(' ')).not.toMatch(/media|image|alt/i);
    expect(blocked).toEqual([]);
  });

  test('broken media does not stop text auto-repair from starting', () => {
    const { repairable, blocked } = classifyFailures({
      mediaErrors: ['Banner image: no alt text.'],
      unverifiedClaims: [{ claim: 'x', severity: 'fabricated', action: 'remove' }],
      metaLength: 200, titleLength: 57, wordCount: 900,
    });
    expect(blocked).toEqual([]);
    expect(repairable.join(' ')).toMatch(/blocking claim/);
    expect(repairable.join(' ')).toMatch(/meta/);
  });
});

// ============================================================
// 10
describe('E. nothing that already blocked an approval has been loosened', () => {
  let exists;
  let find;

  beforeEach(() => {
    exists = jest.spyOn(SeoArticle, 'exists').mockResolvedValue(null);
    find = jest.spyOn(SeoArticle, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
  });
  afterEach(() => { exists.mockRestore(); find.mockRestore(); });

  const gate = (over) => evaluateGates(article(over), { facts: FACTS, claims: [] });

  // Each of the ten terms of `passed`, still failing on its own. Media is
  // valid (or absent) in every one, so a pass here could only mean the term
  // itself had been loosened.
  test('a blocking fact-check claim still fails', async () => {
    const g = await evaluateGates(article(), {
      facts: FACTS,
      claims: [{ claim: 'x', severity: 'fabricated', action: 'remove' }],
    });
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/blocking claim/);
  });

  test('an exact price still fails', async () => {
    const g = await gate({ content: `${CONTENT}\n\nThe fare is Rs 1,200 for this trip.` });
    expect(g.passed).toBe(false);
    expect(g.checks.pricingClaims.length).toBeGreaterThan(0);
  });

  test('a duplicate slug still fails', async () => {
    exists.mockResolvedValue({ _id: 'someone-else' });
    const g = await gate();
    expect(g.passed).toBe(false);
    expect(g.failedChecks).toContain('duplicate slug');
  });

  test('a near-identical existing draft still fails', async () => {
    find.mockReturnValue({
      select: () => ({
        lean: async () => [{
          _id: 'twin', slug: 'twin', status: 'approved',
          shingles: require('../services/seoGenerator').shingle(`BLS ambulance in Bangalore ${CONTENT}`),
        }],
      }),
    });
    const g = await gate();
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/draft similarity/);
  });

  test('a near-identical live page still fails', async () => {
    const live = require('../services/seoLivePages');
    live.loadLivePageIndex.mockResolvedValueOnce([{
      path: '/bls-ambulance-bangalore',
      shingles: require('../services/seoGenerator').shingle(`BLS ambulance in Bangalore ${CONTENT}`),
    }]);
    const g = await gate();
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/live-page similarity/);
  });

  test('a short article still fails', async () => {
    const g = await gate({ content: '## A heading\n\nToo short by a mile.' });
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/words </);
  });

  test('fewer than two valid internal links still fails', async () => {
    const g = await gate({ internalLinks: [{ label: 'BLS', href: '/bls-ambulance-bangalore' }] });
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/internal link/);
  });

  test('a title outside the band still fails', async () => {
    const g = await gate({ title: 'Too short' });
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/title \d+ chars, want/);
  });

  test('a meta description outside the band still fails', async () => {
    const g = await gate({ metaDescription: 'Too short.' });
    expect(g.passed).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/meta \d+ chars, want/);
  });

  test('invalid structured data still fails', async () => {
    const g = await gate({ h1: '' });
    expect(g.passed).toBe(false);
    expect(g.checks.schemaErrors.length).toBeGreaterThan(0);
  });

  test('perfect media cannot rescue an article that fails another gate', async () => {
    const g = await gate({
      content: '## Heading\n\nShort.',
      media: { banner: { ...BANNER }, images: [{ ...IMAGE, placement: 'end' }] },
    });
    expect(g.checks.mediaErrors).toEqual([]);
    expect(g.passed).toBe(false);
  });
});
