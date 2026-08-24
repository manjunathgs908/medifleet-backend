/**
 * models/SeoArticle.js
 * ============================================================
 * Generated SEO articles, always as drafts.
 *
 * Nothing in this collection is public. The website renders its live pages
 * from lib/seo*Pages.js in savelife-web; this is the staging area that feeds
 * that, and a document only leaves it when a human moves it through
 * review -> approved -> published. `published` here means "a human signed
 * off", not "it is on the internet" -- the site does not read this
 * collection yet, by design. Phase 1 stops at approval.
 *
 * The similarity guard lives on `contentHash` + `shingles`: every draft
 * stores a normalised trigram fingerprint so a new generation can be
 * compared against every existing one before it is saved. See
 * services/seoGenerator.js.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const faqSchema = new Schema(
  { q: { type: String, required: true }, a: { type: String, required: true } },
  { _id: false },
);

const linkSchema = new Schema(
  {
    label: { type: String, required: true },
    href: { type: String, required: true },
    // Why the generator chose this link. Kept so a reviewer can see whether
    // the relevance is real or the model reaching.
    reason: { type: String },
  },
  { _id: false },
);

const seoArticleSchema = new Schema(
  {
    // ── Keyword layer ────────────────────────────────────────
    keyword: { type: String, required: true, trim: true, index: true },
    cluster: { type: String, trim: true, index: true },
    searchIntent: {
      type: String,
      enum: ['informational', 'commercial', 'transactional', 'navigational'],
      default: 'informational',
    },
    location: { type: String, trim: true },
    service: { type: String, trim: true },

    // ── Page layer ───────────────────────────────────────────
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    title: { type: String, required: true, trim: true },
    metaDescription: { type: String, required: true, trim: true },
    h1: { type: String, required: true, trim: true },
    content: { type: String, required: true },
    faqs: { type: [faqSchema], default: [] },
    internalLinks: { type: [linkSchema], default: [] },

    // Article / Service / BreadcrumbList / FAQPage, assembled at generation
    // time so a reviewer sees exactly what would ship.
    schema: { type: Schema.Types.Mixed },

    // ── Workflow ─────────────────────────────────────────────
    // draft      -> just generated, nobody has looked
    // in_review  -> a human has opened it
    // approved   -> signed off, cleared to be turned into a page
    // published  -> a human published it
    // rejected   -> failed review; kept so the same keyword is not retried blind
    status: {
      type: String,
      enum: ['draft', 'in_review', 'approved', 'published', 'rejected'],
      default: 'draft',
      index: true,
    },
    reviewNotes: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    publishedAt: { type: Date },

    // ── Quality gates ────────────────────────────────────────
    // Populated by the generator. A draft can be saved while failing a
    // check -- the reviewer needs to see WHY it failed, not just that it
    // vanished. Nothing with a failed check can reach `approved`.
    checks: {
      similarityScore: { type: Number, default: 0 }, // 0..1 against nearest existing draft
      similarTo: { type: Schema.Types.ObjectId, ref: 'SeoArticle' },
      duplicateSlug: { type: Boolean, default: false },
      // Phrases the fact checker flagged as unverifiable against the fact
      // sheet. Empty is the only acceptable state for approval.
      unverifiedClaims: { type: [String], default: [] },
      wordCount: { type: Number, default: 0 },
      passed: { type: Boolean, default: false },
    },

    // Normalised trigram set, for the similarity guard. Not indexed: it is
    // read in bulk during a generation, never queried by value.
    shingles: { type: [String], default: [], select: false },

    // ── Provenance ───────────────────────────────────────────
    // Which model produced this and against which fact sheet. When a page
    // turns out to be wrong months later, this is how you find every other
    // page generated the same way.
    generation: {
      model: { type: String },
      effort: { type: String },
      factSheetHash: { type: String },
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      generatedAt: { type: Date },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }, // gives createdAt / updatedAt
);

// The two queries the admin list actually makes.
seoArticleSchema.index({ status: 1, updatedAt: -1 });
seoArticleSchema.index({ cluster: 1, status: 1 });

module.exports = mongoose.model('SeoArticle', seoArticleSchema);
