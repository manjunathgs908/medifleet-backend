/**
 * controllers/seoPublicController.js
 * ============================================================
 * The ONLY unauthenticated view of the SEO collection.
 *
 * Deliberately a separate file from seoController.js. That one lives behind
 * protect + authorize('owner') applied at the router; this one has no auth at
 * all, and keeping the two apart means no future reordering of middleware can
 * quietly expose a draft. If you are adding a route here, the question to
 * answer first is "would I be comfortable with this on a billboard".
 *
 * Only `approved` and `published` articles are visible -- see
 * SeoArticle.PUBLIC_STATUSES. Everything else is work a human has not signed
 * off, and on a YMYL medical site that is not a page.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');

// The one predicate for "this is a page". Both routes use it, which is what
// keeps the index and the article itself in agreement -- a listing that offers
// a link the detail route answers with 404 puts a dead URL in the sitemap.
//
// The content/title/h1 clauses are belt and braces: all three are required by
// the schema, so a document without them should not exist. Should-not-exist is
// not a guarantee, and the cost of checking is one index lookup.
const RENDERABLE = { $type: 'string', $ne: '' };
const PUBLIC = {
  status: { $in: SeoArticle.PUBLIC_STATUSES },
  slug: RENDERABLE,
  title: RENDERABLE,
  h1: RENDERABLE,
  content: RENDERABLE,
};

// Index cards. No body, no JSON-LD -- the listing renders neither, and
// shipping the full text of every guide to render a list of links is a
// payload nobody asked for.
const CARD_FIELDS = 'slug title metaDescription h1 cluster searchIntent publishedAt reviewedAt updatedAt';

// One article. `content` and `jsonLd` are the point; `shingles` is select:false
// already, and nothing else on the document is anyone's business.
const PAGE_FIELDS =
  'slug title metaDescription h1 content faqs internalLinks jsonLd status ' +
  'cluster searchIntent keyword publishedAt reviewedAt updatedAt createdAt';

// Cached at the edge as well as by Next's own revalidate. An approved article
// changes rarely, and the website is not the only thing that may fetch this.
const CACHE = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600';

// ============================================================
// @route   GET /api/guides
// @desc    Every publicly visible guide, newest first. Index + sitemap.
// @access  Public
// ============================================================
exports.list = async (req, res, next) => {
  try {
    const articles = await SeoArticle.find(PUBLIC)
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1, updatedAt: -1 })
      // A ceiling rather than pagination: the sitemap wants the whole set in
      // one call, and if this collection ever passes 1000 published guides the
      // right answer is a paginated sitemap index, not a bigger number here.
      .limit(1000)
      .lean();

    res.set('Cache-Control', CACHE);
    return res.json({ success: true, count: articles.length, articles });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/guides/:slug
// @desc    One publicly visible guide.
// @access  Public
// ============================================================
exports.getBySlug = async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(404).json({ success: false, message: 'Not found.' });

    // Status is part of the query, not a check after it. A missing article and
    // an unapproved one are the same answer to an anonymous caller: 404, with
    // nothing that would confirm a draft exists at that slug.
    // Spread order matters: PUBLIC carries its own `slug` clause (the
    // non-empty-string check), so the slug being looked up has to come last or
    // it is overwritten and the query matches any approved article at all.
    const article = await SeoArticle.findOne({ ...PUBLIC, slug })
      .select(PAGE_FIELDS)
      .lean();

    if (!article) return res.status(404).json({ success: false, message: 'Not found.' });

    res.set('Cache-Control', CACHE);
    return res.json({ success: true, article });
  } catch (err) {
    next(err);
  }
};
