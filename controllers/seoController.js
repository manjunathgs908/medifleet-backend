/**
 * controllers/seoController.js
 * ============================================================
 * Admin API for the SEO draft pipeline. Every route is behind protect +
 * authorize('owner') in routes/seo.js — nothing here is public, and no
 * endpoint puts anything on the website.
 *
 * The only state change that matters is the status ladder:
 *   draft -> in_review -> approved -> published
 * with `rejected` available from any point. A draft that failed its quality
 * checks cannot be approved; the reviewer has to fix or reject it.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const { generateDraft } = require('../services/seoGenerator');
const { buildFactSheet } = require('../services/seoFacts');

// ============================================================
// @route   POST /api/seo/generate
// @desc    Keyword in, DRAFT out. Slow by design — two Claude calls and a
//          similarity sweep — so the client should expect ~30-90s.
// @access  Private [owner]
// ============================================================
exports.generate = async (req, res, next) => {
  try {
    const { keyword, service, location, notes } = req.body;
    if (!keyword?.trim()) {
      return res.status(400).json({ success: false, message: 'A keyword is required.' });
    }

    const article = await generateDraft({ keyword, service, location, notes }, req.user);
    return res.status(201).json({ success: true, article });
  } catch (err) {
    // A missing API key or a Claude refusal is an operator-facing answer,
    // not a 500 with a stack trace.
    if (/ANTHROPIC_API_KEY|declined this request/.test(err.message)) {
      return res.status(503).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ============================================================
// @route   GET /api/seo/articles?status=&cluster=&q=
// @access  Private [owner]
// ============================================================
exports.list = async (req, res, next) => {
  try {
    const { status, cluster, q } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (cluster) filter.cluster = cluster;
    if (q) filter.$or = [
      { keyword: new RegExp(q, 'i') },
      { title: new RegExp(q, 'i') },
      { slug: new RegExp(q, 'i') },
    ];

    // Content is deliberately excluded — the list view renders hundreds of
    // rows and does not need the article bodies.
    const articles = await SeoArticle.find(filter)
      .select('-content -schema')
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    const counts = await SeoArticle.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);

    return res.json({
      success: true,
      articles,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/seo/articles/:id
// @access  Private [owner]
// ============================================================
exports.getById = async (req, res, next) => {
  try {
    const article = await SeoArticle.findById(req.params.id).lean();
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });
    return res.json({ success: true, article });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/seo/articles/:id
// @desc    Reviewer edits. Editing the body re-opens the article: a human
//          rewrite invalidates the fact check that ran on the old text.
// @access  Private [owner]
// ============================================================
exports.update = async (req, res, next) => {
  try {
    const EDITABLE = ['title', 'metaDescription', 'h1', 'content', 'faqs', 'internalLinks', 'cluster', 'searchIntent', 'reviewNotes'];
    const patch = {};
    for (const k of EDITABLE) if (k in req.body) patch[k] = req.body[k];

    const article = await SeoArticle.findById(req.params.id);
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });

    const bodyChanged = 'content' in patch && patch.content !== article.content;
    Object.assign(article, patch);

    if (bodyChanged && article.status === 'approved') {
      // Approval was granted for text that no longer exists.
      article.status = 'in_review';
      article.checks.passed = false;
    }

    await article.save();
    return res.json({ success: true, article });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   PUT /api/seo/articles/:id/status
// @desc    Move an article along the ladder. Approval is gated on the
//          quality checks: a draft carrying unverified claims, a duplicate
//          slug or a near-identical twin cannot be waved through, because
//          the whole point of the checks is that they are not advisory.
// @access  Private [owner]
// ============================================================
exports.setStatus = async (req, res, next) => {
  try {
    const { status, reviewNotes } = req.body;
    const ALLOWED = ['draft', 'in_review', 'approved', 'published', 'rejected'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${ALLOWED.join(', ')}` });
    }

    const article = await SeoArticle.findById(req.params.id);
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });

    if ((status === 'approved' || status === 'published') && !article.checks?.passed) {
      const reasons = [];
      if (article.checks?.unverifiedClaims?.length) reasons.push(`${article.checks.unverifiedClaims.length} unverified claim(s)`);
      if (article.checks?.duplicateSlug) reasons.push('duplicate slug');
      if (article.checks?.similarityScore >= 0.55) reasons.push(`too similar to an existing draft (${Math.round(article.checks.similarityScore * 100)}%)`);
      if ((article.checks?.wordCount || 0) < 700) reasons.push(`too short (${article.checks?.wordCount} words)`);
      return res.status(422).json({
        success: false,
        message: `This draft has not passed its checks: ${reasons.join(', ') || 'checks not run'}. Fix it or reject it.`,
      });
    }

    // Publishing here records a human decision. It does not put anything on
    // savelife.health — the site still renders from lib/seo*Pages.js, and
    // wiring this collection into it is the next phase, deliberately.
    article.status = status;
    if (reviewNotes !== undefined) article.reviewNotes = reviewNotes;
    if (status === 'published') article.publishedAt = new Date();
    article.reviewedBy = req.user?._id;
    article.reviewedAt = new Date();
    await article.save();

    return res.json({ success: true, article });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   DELETE /api/seo/articles/:id
// @access  Private [owner]
// ============================================================
exports.remove = async (req, res, next) => {
  try {
    const article = await SeoArticle.findByIdAndDelete(req.params.id);
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });
    return res.json({ success: true, message: 'Draft deleted.' });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// @route   GET /api/seo/facts
// @desc    The exact fact sheet the generator is given. Exposed so an
//          operator can see what the model is allowed to know before
//          blaming it for what it wrote.
// @access  Private [owner]
// ============================================================
exports.facts = async (req, res, next) => {
  try {
    return res.json({ success: true, facts: await buildFactSheet() });
  } catch (err) {
    next(err);
  }
};
