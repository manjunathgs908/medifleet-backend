/**
 * services/seoMedia.js
 * ============================================================
 * Media validation. Images on an SEO article are OPTIONAL; anything actually
 * supplied is checked strictly.
 *
 * Optional, deliberately
 * ----------------------
 * There is no quota here: no banner requirement, no minimum image count, no
 * ratio of images to words. An image added to clear a threshold is decoration
 * that costs a reader bandwidth and tells them nothing, and a rule that
 * demands one is a rule that gets satisfied with a stock photo of an ambulance.
 * Zero, one or several in-article images are all correct answers, and so is an
 * article with no media at all.
 *
 * Strict about what IS supplied
 * -----------------------------
 * Half an image is worse than none: it ships a broken <img>, or an empty alt,
 * to a public page on a YMYL medical site. Alt text is the only description a
 * screen-reader user or an image crawler ever gets, and "image", "ambulance
 * photo" and "img1" are not descriptions -- they are the field being filled in
 * to make a form go away, which is worse than an empty alt, because an empty
 * alt at least tells a screen reader to skip a decorative image instead of
 * reading a lie about it.
 *
 * Advisory, not blocking
 * ----------------------
 * Everything returned here is shown to the reviewer and none of it sets
 * checks.passed to false. See the note at the media block in seoGenerator.js.
 *
 * Nothing here calls Claude. Media is supplied by a human in SEO Studio, and
 * the generator has no image URLs to give -- inventing one would be a
 * fabrication, not a shortcut.
 *
 * Everything is deterministic, so the same article and the same media always
 * produce the same verdict, and a reviewer can tell from the message alone
 * what to change.
 * ============================================================
 */
'use strict';

const { slugify } = require('./seoSlug');

// Alt text has to survive being read aloud on its own, with no article
// around it. Three real words is the floor at which that starts to be true:
// "ambulance interior" is a category, "BLS ambulance interior with oxygen
// cylinder and stretcher" is a description.
const MIN_ALT_LENGTH = 15;
const MIN_ALT_WORDS = 3;
// Long alt text is read out in full and gets truncated by some crawlers.
const MAX_ALT_LENGTH = 160;

// Words that carry no information about what is in the image. These are not
// banned -- "photo" inside a real sentence is fine -- they simply do not
// COUNT towards the descriptive-word floor above. That is what makes
// "ambulance image" fail (one descriptive word) while "photo of the BLS
// ambulance interior at night" passes (five).
const GENERIC_ALT_WORDS = new Set([
  'image', 'images', 'img', 'imgs', 'photo', 'photos', 'photograph',
  'picture', 'pictures', 'pic', 'pics', 'banner', 'banners', 'header',
  'graphic', 'graphics', 'illustration', 'screenshot', 'thumbnail', 'thumb',
  'icon', 'logo', 'file', 'untitled', 'default', 'placeholder', 'alt', 'text',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif',
  // Articles, prepositions and the handful of verbs that survive every
  // caption. Dropping them stops "a photo of an image" scoring three.
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'its', 'showing', 'shows', 'show',
]);

// Belt and braces over the word count above. Anything whose whole normalised
// value is one of these is rejected by name, so the reason a reviewer reads
// is "generic" rather than an arithmetic complaint about word counts.
const GENERIC_ALT_PHRASES = new Set([
  'image', 'photo', 'picture', 'banner', 'img', 'pic', 'graphic', 'icon',
  'logo', 'thumbnail', 'screenshot', 'illustration', 'header image',
  'banner image', 'article image', 'ambulance image', 'ambulance photo',
  'ambulance picture', 'ambulance banner', 'ambulance', 'image of ambulance',
  'photo of ambulance', 'alt text', 'alt', 'untitled', 'placeholder',
  'default image', 'stock image', 'stock photo', 'no description',
]);

// "img1", "image_2", "photo-03", "DSC0041" -- a filename with the extension
// taken off, which is the single most common thing to find in an alt slot.
const FILENAME_ALT = /^(img|image|photo|pic|picture|banner|graphic|screenshot|dsc|dcim|mvimg|pxl|shutterstock|istock|unsplash)[\s._-]*\d*$/i;
// An actual filename, extension and all.
const BARE_FILENAME = /^[\w\s.-]+\.(jpe?g|png|webp|gif|svg|avif|bmp|tiff?)$/i;

// Where an in-article image may sit. Reserved anchors are always available;
// every H2 and H3 in the body is an anchor too, so a placement is a promise
// the article can actually keep. See resolvePlacement().
const RESERVED_PLACEMENTS = Object.freeze(['after-intro', 'before-faqs', 'end']);

// Absolute http(s), or a site-relative path. Deliberately NOT "any string":
// this value ends up in an <img src> on a public page, so `javascript:`,
// `data:` and protocol-relative `//host` are refused here rather than being
// somebody else's problem at render time.
function urlProblem(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return 'no URL';
  if (raw.startsWith('//')) return 'protocol-relative URLs are not allowed — use https://';
  if (raw.startsWith('/')) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'not a valid URL — use https://… or a site path beginning with /';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${parsed.protocol.replace(':', '')} URLs are not allowed — use https://`;
  }
  return null;
}

/**
 * Why this alt text is not a description, or null if it is one.
 *
 * Whitespace is only the first of six tests, on purpose: a whitespace check
 * alone passes "photo", which is the case that actually happens.
 */
function altTextProblem(alt) {
  const text = String(alt == null ? '' : alt).replace(/\s+/g, ' ').trim();
  if (!text) return 'no alt text';

  const normalised = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (GENERIC_ALT_PHRASES.has(normalised)) return `alt text "${text}" is generic — describe what is in the image`;
  if (BARE_FILENAME.test(text)) return `alt text "${text}" is a filename, not a description`;
  if (FILENAME_ALT.test(text)) return `alt text "${text}" is generic — describe what is in the image`;
  if (text.length > MAX_ALT_LENGTH) return `alt text is ${text.length} characters — keep it under ${MAX_ALT_LENGTH}`;
  if (text.length < MIN_ALT_LENGTH) return `alt text "${text}" is too short to describe the image (want ${MIN_ALT_LENGTH}+ characters)`;

  const descriptive = normalised
    .split(' ')
    .filter((w) => w && w.length > 1 && !/^\d+$/.test(w) && !GENERIC_ALT_WORDS.has(w));
  if (descriptive.length < MIN_ALT_WORDS) {
    return `alt text "${text}" is too generic — describe what is in the image (want ${MIN_ALT_WORDS}+ descriptive words)`;
  }
  return null;
}

/**
 * Every anchor an in-article image may be placed at, for this article's body.
 *
 * The reserved anchors plus the slug of every H2/H3 the renderer will emit.
 * Deriving them from the markdown rather than storing a free-text position is
 * what makes "meaningful placement" checkable: a placement that names a
 * heading is a placement the renderer can find.
 */
function contentAnchors(content) {
  const anchors = new Set(RESERVED_PLACEMENTS);
  const headings = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = /^(#{2,3})\s+(.+?)\s*#*$/.exec(line.trim());
    if (!m) continue;
    const slug = slugify(m[2]);
    if (!slug) continue;
    anchors.add(slug);
    headings.push({ heading: m[2].trim(), anchor: slug, level: m[1].length === 2 ? 'h2' : 'h3' });
  }
  return { anchors, headings };
}

// A placement matches if it names a reserved anchor or a heading, in either
// direction -- the reviewer may type the heading itself or its slug.
function resolvePlacement(placement, anchors) {
  const raw = String(placement == null ? '' : placement).trim();
  if (!raw) return { ok: false, reason: 'no placement' };
  const slug = slugify(raw);
  if (!slug) return { ok: false, reason: 'no placement' };
  if (anchors.has(slug)) return { ok: true, anchor: slug };
  return { ok: false, reason: 'unknown', anchor: slug };
}

/**
 * Validate an article's media against its body.
 *
 * @param  {object} media    article.media, or undefined
 * @param  {object} opts     { content } — the markdown body, for placements
 * @return {{ ok: boolean, errors: string[], anchors: string[] }}
 *
 * An article with no media returns no errors: absence is a valid answer, not a
 * defect. Errors describe only things that were supplied and are wrong, one
 * sentence per defect, written for the person who has to fix them.
 */
function validateMedia(media, { content = '' } = {}) {
  const errors = [];
  const { anchors } = contentAnchors(content);
  const doc = media && typeof media === 'object' ? media : {};

  // ── Banner, if there is one ───────────────────────────────
  // "Supplied" means the reviewer put something in either field. A banner with
  // a URL and no alt text is supplied-and-wrong; a banner with neither is an
  // article that does not have one, which is allowed.
  const banner = doc.banner && typeof doc.banner === 'object' ? doc.banner : null;
  const bannerUrl = String(banner && banner.url != null ? banner.url : '').trim();
  const bannerAlt = String(banner && banner.alt != null ? banner.alt : '').trim();
  if (banner && (bannerUrl || bannerAlt)) {
    const urlErr = urlProblem(bannerUrl);
    if (urlErr) errors.push(`Banner image: ${urlErr}.`);
    const altErr = altTextProblem(banner.alt);
    if (altErr) errors.push(`Banner image: ${altErr}.`);
  }

  // ── In-article images, however many there are ─────────────
  // Zero, one or several. No quota and no minimum: see the header.
  const images = Array.isArray(doc.images) ? doc.images : [];
  images
    .filter((img) => img && typeof img === 'object')
    .forEach((img, i) => {
      const label = `In-article image ${i + 1}`;
      const url = String(img.url == null ? '' : img.url).trim();
      const alt = String(img.alt == null ? '' : img.alt).trim();
      const placement = String(img.placement == null ? '' : img.placement).trim();
      // A row with nothing in any field is one the reviewer added and
      // abandoned, not a broken image. normalizeMedia drops these before they
      // are stored; this is the same judgement for unstored input.
      if (!url && !alt && !placement) return;

      const urlErr = urlProblem(url);
      if (urlErr) errors.push(`${label}: ${urlErr}.`);
      const altErr = altTextProblem(img.alt);
      if (altErr) errors.push(`${label}: ${altErr}.`);
      const placed = resolvePlacement(img.placement, anchors);
      if (!placed.ok) {
        errors.push(placed.reason === 'no placement'
          ? `${label}: no placement — say where in the article it belongs.`
          : `${label}: placement "${placement}" does not match anything in the article — use a section heading or one of: ${RESERVED_PLACEMENTS.join(', ')}.`);
      }
    });

  return { ok: errors.length === 0, errors, anchors: [...anchors] };
}

/**
 * Coerce whatever the editor sent into the stored shape.
 *
 * Trims strings, drops entries that are empty in every field (an editor row
 * the reviewer added and abandoned is not a missing image), and keeps numbers
 * only when they are positive. It does NOT judge quality -- validateMedia is
 * the only thing that decides whether media is good enough, so there is one
 * answer to that question rather than two that can disagree.
 */
function normalizeMedia(input) {
  const src = input && typeof input === 'object' ? input : {};
  const str = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const dim = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  };

  const out = {};
  const b = src.banner && typeof src.banner === 'object' ? src.banner : null;
  if (b && (str(b.url) || str(b.alt))) {
    out.banner = { url: str(b.url), alt: str(b.alt), width: dim(b.width), height: dim(b.height) };
  }

  out.images = (Array.isArray(src.images) ? src.images : [])
    .filter((i) => i && typeof i === 'object')
    .map((i) => ({
      url: str(i.url),
      alt: str(i.alt),
      placement: str(i.placement),
      width: dim(i.width),
      height: dim(i.height),
    }))
    .filter((i) => i.url || i.alt || i.placement);

  return out;
}

module.exports = {
  validateMedia,
  normalizeMedia,
  altTextProblem,
  urlProblem,
  contentAnchors,
  resolvePlacement,
  RESERVED_PLACEMENTS,
  MIN_ALT_LENGTH,
  MIN_ALT_WORDS,
  MAX_ALT_LENGTH,
};
