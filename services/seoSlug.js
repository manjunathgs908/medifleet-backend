/**
 * services/seoSlug.js
 * ============================================================
 * Find a free, readable slug for a draft whose chosen one is taken.
 *
 * A duplicate slug used to stop auto-repair dead: "needs a new slug, which is
 * an editorial decision". It was treated as a judgement call because renaming
 * a URL usually is one. For a DRAFT it is not — the draft has never been
 * public, nothing links to it, and no ranking depends on it. Picking a free
 * URL for a page that does not have one yet is bookkeeping, and it was
 * blocking every other repair on the article.
 *
 * WHAT THIS WILL NOT DO
 *
 * It never touches another article. The only query it makes is `exists`, and
 * the only document it changes is the one handed to it.
 *
 * It never renames a PUBLIC article. approved/published pages are live on
 * savelife.health; changing that slug moves the URL, breaks every inbound link
 * and loses the ranking the page has. If the article being repaired is public,
 * this refuses and says so — that one genuinely is an editorial decision.
 *
 * It never invents a differentiator out of nothing. Candidates are built from
 * what the article already says about itself — keyword, location, service,
 * title — so the slug that comes out still describes the page. Only when all
 * of those are taken does it fall back to a numeric suffix, and even that is
 * deterministic: the lowest free integer, so the same collision resolves the
 * same way every time.
 *
 * The schema's unique index on `slug` remains the last line of defence. This
 * reduces how often a save collides; it is not what makes collisions
 * impossible.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');

// How many numbered fallbacks to try once every descriptive candidate is
// taken. Bounded so a pathological state cannot spin: twenty near-identical
// slugs on one keyword is already a content problem, not a naming one.
const MAX_NUMBERED = 20;

/**
 * URL-safe, lowercase, hyphenated. Accents folded rather than dropped, so
 * "Bengalūru" does not become "bengalru".
 */
function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
}

/**
 * The slugs to try, best first.
 *
 * Order is the policy: the keyword-derived slug is what the page should have,
 * so it is tried first and only displaced when genuinely taken. After that the
 * differentiator is a real attribute of the article — its location, then its
 * service — because "…-whitefield" tells a reader something and "…-2" does
 * not. The numeric tail exists only so the function cannot run out of answers.
 */
function slugCandidates(article) {
  const keyword = slugify(article?.keyword);
  const location = slugify(article?.location);
  const service = slugify(article?.service);
  const title = slugify(article?.title);
  const current = slugify(article?.slug);

  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  // A differentiator the base already contains adds length and no meaning:
  // "…-whitefield-bangalore-whitefield" is not more distinguishing than
  // "…-whitefield-bangalore", it is just longer. Skip it and move on to one
  // that actually differentiates.
  const withTerm = (base, term) => {
    if (!base || !term) return null;
    return base.split('-').includes(term) || base.includes(`-${term}-`) || base.endsWith(`-${term}`)
      ? null
      : `${base}-${term}`;
  };

  push(keyword);
  push(withTerm(keyword, location));
  push(withTerm(keyword, service));
  push(withTerm(withTerm(keyword, service) || keyword, location));
  push(title);
  push(withTerm(title, location));

  // Numbered fallbacks hang off the keyword slug, or off the current one when
  // there is no keyword to work from.
  const base = keyword || current || title;
  if (base) for (let n = 2; n <= MAX_NUMBERED; n++) push(`${base}-${n}`);

  return out;
}

/** Is this slug already on some OTHER article? */
async function isTaken(slug, excludeId) {
  const q = { slug };
  if (excludeId) q._id = { $ne: excludeId };
  return Boolean(await SeoArticle.exists(q));
}

/**
 * Pick a free slug for this article, or refuse.
 *
 * @returns {Promise<{ok:boolean, slug?:string, from?:string, tried?:number, reason?:string}>}
 *          ok:false is a refusal to guess, not an error — the caller stops.
 */
async function findUniqueSlug(article) {
  // A live URL is not ours to move.
  if (SeoArticle.PUBLIC_STATUSES.includes(article?.status)) {
    return {
      ok: false,
      reason: `this article is ${article.status} and its URL is live; renaming it would break every link to it and is an editorial decision`,
    };
  }

  const candidates = slugCandidates(article);
  if (!candidates.length) {
    return { ok: false, reason: 'the article carries no keyword, title, service or location to build a slug from' };
  }

  for (const candidate of candidates) {
    if (!(await isTaken(candidate, article?._id))) {
      return { ok: true, slug: candidate, from: slugify(article?.slug), tried: candidates.indexOf(candidate) + 1 };
    }
  }

  return {
    ok: false,
    reason: `all ${candidates.length} candidate slugs are already taken; this keyword needs an editorial decision rather than another suffix`,
  };
}

module.exports = {
  slugify,
  slugCandidates,
  findUniqueSlug,
  MAX_NUMBERED,
};
