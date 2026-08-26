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
const {
  generateDraft, recheckArticle, repairArticle,
  DuplicateKeywordError, NothingToRepairError,
  SIMILARITY_BLOCK, MIN_WORDS, TITLE_MIN, TITLE_MAX, META_MIN, META_MAX,
} = require('../services/seoGenerator');
const { buildFactSheet } = require('../services/seoFacts');
const { autoRepairArticle, AutoRepairBusyError } = require('../services/seoAutoRepair');

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
    // The keyword already has an article. 409, with the row itself, so the
    // Studio can offer "open it" rather than leaving the operator to search.
    // No Claude call was made and no draft was created.
    if (err instanceof DuplicateKeywordError) {
      const e = err.existing;
      return res.status(409).json({
        success: false,
        duplicate: true,
        existing: { id: e._id, slug: e.slug, title: e.title, status: e.status, keyword: e.keyword },
        message: `This keyword already has an article: "${e.title}" (${e.status}). Open it instead of generating another — nothing was generated and nothing was charged.`,
      });
    }
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
    // rows and does not need the article bodies. Both field names are
    // excluded because pre-rename documents still store the JSON-LD under
    // the old key, and a projection only knows about the name it is given.
    const articles = await SeoArticle.find(filter)
      .select('-content -jsonLd -schema')
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
// @route   POST /api/seo/articles/:id/recheck
// @desc    Re-run every quality gate over an edited article.
//
//          Editing the body of an approved article demotes it to in_review
//          with checks.passed false — approval belonged to text that no
//          longer exists. This is the only way back: the SAME gates that
//          cleared it the first time, run again over what is there now.
//
//          A clean recheck sets checks.passed true and STOPS. It does not
//          approve: status stays in_review and a human still has to press
//          Approve. The gate has never had the authority to publish, and
//          this does not give it any.
// @access  Private [owner]
// ============================================================
exports.recheck = async (req, res, next) => {
  try {
    const article = await SeoArticle.findById(req.params.id);
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });

    // Nothing to re-check on a rejected article. Rechecking one would be a
    // way to walk a rejection back without anyone re-reading it.
    if (article.status === 'rejected') {
      return res.status(422).json({
        success: false,
        message: 'This article was rejected. Reject is a decision about the article, not a failed check — edit it and move it back to draft first.',
      });
    }

    const { passed, failedChecks } = await recheckArticle(article);

    return res.json({
      success: true,
      passed,
      failedChecks,
      // Spelled out so the Studio never has to infer what happens next.
      message: passed
        ? 'All checks passed. The article is still in review — press Approve to publish it.'
        : `Checks failed: ${failedChecks.join('; ')}`,
      article,
    });
  } catch (err) {
    // Same operator-facing handling as generate: a missing key or a refusal
    // is an answer, not a stack trace.
    if (/ANTHROPIC_API_KEY|declined this request/.test(err.message)) {
      return res.status(503).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ============================================================
// @route   POST /api/seo/articles/:id/repair
// @desc    Rewrite the blocking claims the checker already raised, plus a
//          meta description outside its length band.
//
//          Repair does not fact-check and does not run the gates. Recheck
//          produces the claims, this consumes them, and Recheck runs again
//          afterwards to find out whether it worked — which is why this sets
//          checks.passed false and leaves it there.
//
//          It never approves and never publishes. Status is untouched in
//          both directions.
// @access  Private [owner]
// ============================================================
exports.repair = async (req, res, next) => {
  try {
    const article = await SeoArticle.findById(req.params.id);
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });

    // Same rule as recheck: a rejection is a decision about the article, and
    // repairing one would be a way to walk it back without a re-read.
    if (article.status === 'rejected') {
      return res.status(422).json({
        success: false,
        message: 'This article was rejected. Move it back to draft first if you want to work on it.',
      });
    }

    const result = await repairArticle(article);

    return res.json({
      success: true,
      repaired: result.repaired,
      repairedFields: result.repairedFields,
      claimsTargeted: result.claimsTargeted,
      metaBefore: result.metaBefore,
      metaAfter: result.metaAfter,
      metaFixed: result.metaFixed,
      message: result.summary,
      article: result.article,
    });
  } catch (err) {
    // Asking to repair a clean article is an answer, not a failure.
    if (err instanceof NothingToRepairError) {
      return res.status(422).json({ success: false, message: err.message });
    }
    if (/ANTHROPIC_API_KEY|declined this request/.test(err.message)) {
      return res.status(503).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ============================================================
// @route   POST /api/seo/articles/:id/auto-repair
// @desc    Run repair -> recheck automatically until the gates pass, the
//          failures stop being repairable, or the attempt cap is reached.
//
//          Orchestration only: it calls the same repairArticle() and
//          recheckArticle() the manual buttons call. It cannot approve and
//          cannot publish — a clean result leaves the article exactly where
//          it was, with checks.passed true and a human still to press
//          Approve.
// @access  Private [owner]
// ============================================================
exports.autoRepair = async (req, res, next) => {
  try {
    const article = await SeoArticle.findById(req.params.id).select('_id status');
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });
    if (article.status === 'rejected') {
      return res.status(422).json({
        success: false,
        message: 'This article was rejected. Move it back to draft first if you want to work on it.',
      });
    }

    const r = await autoRepairArticle(req.params.id);

    return res.json({
      success: true,
      passed: r.passed,
      attempts: r.attempts,
      stoppedReason: r.stoppedReason,
      timeline: r.timeline,
      message: r.passed
        ? `All checks passed after ${r.attempts} automatic repair${r.attempts === 1 ? '' : 's'}. The article is still in ${r.article.status} — press Approve to publish it.`
        : `Stopped after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}: ${r.stoppedReason}`,
      article: r.article,
    });
  } catch (err) {
    // Another loop holds this article. Not an error the operator caused.
    if (err instanceof AutoRepairBusyError) {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (/ANTHROPIC_API_KEY|declined this request/.test(err.message)) {
      return res.status(503).json({ success: false, message: err.message });
    }
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
      // These have to mirror the generator's gate exactly. Told "checks not
      // run" when the real problem is a 63-character title, a reviewer goes
      // looking in the wrong place.
      const c = article.checks || {};
      const reasons = [];
      // Phrasing notes are advisory and do not block, so they must not be
      // counted here either.
      const blocking = (c.unverifiedClaims || []).filter((x) => x.severity !== 'phrasing');
      if (blocking.length) reasons.push(`${blocking.length} unverified claim(s)`);
      if (c.duplicateSlug) reasons.push('duplicate slug');
      if (c.similarityScore >= SIMILARITY_BLOCK) reasons.push(`too similar to an existing draft (${Math.round(c.similarityScore * 100)}%)`);
      if (c.livePageSimilarity >= SIMILARITY_BLOCK) {
        reasons.push(`too similar to the live page ${c.similarToLivePage || '(unknown)'} (${Math.round(c.livePageSimilarity * 100)}%)`);
      }
      if (c.schemaErrors?.length) reasons.push(`${c.schemaErrors.length} structured-data error(s)`);
      if ((c.wordCount || 0) < MIN_WORDS) reasons.push(`too short (${c.wordCount} words)`);
      if (c.titleLength < TITLE_MIN || c.titleLength > TITLE_MAX) reasons.push(`title is ${c.titleLength} characters (must be ${TITLE_MIN}-${TITLE_MAX})`);
      if (c.metaLength < META_MIN || c.metaLength > META_MAX) reasons.push(`meta description is ${c.metaLength} characters (must be ${META_MIN}-${META_MAX})`);
      if ((article.internalLinks || []).length < 2) reasons.push('fewer than 2 internal links');
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
