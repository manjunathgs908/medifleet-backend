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

// A link the generator produced that does not exist on the site. Recorded
// rather than silently discarded: a draft that quietly lost three of its four
// links looks like a model that only found one, which sends the reviewer
// hunting in the wrong place.
const droppedLinkSchema = new Schema(
  {
    label: { type: String },
    href: { type: String, required: true },
    reason: { type: String },
  },
  { _id: false },
);

// One flagged claim from the fact checker.
//
//   fabricated  — a business fact that is simply invented (a price, a response
//                 time, a partnership). Always blocks.
//   unsupported — a claim about the business, a service, or a location that
//                 the fact sheet does not establish. Blocks: on a YMYL site
//                 "probably true" is not a standard.
//   phrasing    — wording only. Advisory, because blocking approval on an
//                 adjective trains reviewers to wave failures through.
//
// action is what the reviewer should DO, which is the part a bare "unverified"
// never told them: pull the figure from the fact sheet, delete the sentence,
// or reword it so it stops asserting.
const claimSchema = new Schema(
  {
    claim: { type: String, required: true },
    severity: {
      type: String,
      enum: ['fabricated', 'unsupported', 'phrasing'],
      default: 'unsupported',
    },
    action: {
      type: String,
      enum: ['source', 'remove', 'rewrite'],
      default: 'rewrite',
    },
  },
  { _id: false },
);

// One pass of the fact-repair loop in services/seoGenerator.js. Kept as
// history rather than a counter: when a page turns out to be wrong later,
// "the checker raised four blocking claims and one survived two repairs" is
// the detail that explains how it got as far as a reviewer.
//
// claimsBefore/After count BLOCKING claims only -- the same set the gate
// uses. A phrasing note is advisory and never triggered a repair, so
// counting it here would suggest the loop ignored something it was never
// asked to fix.
const repairSchema = new Schema(
  {
    attempt: { type: Number, required: true },
    claimsBefore: { type: Number, required: true },
    claimsAfter: { type: Number, required: true },
    // Which of title/metaDescription/h1/content/faqs the repair rewrote.
    // Anything absent is byte-identical to the first draft.
    repairedFields: { type: [String], default: [] },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Another page in the same cluster targeting the same search intent.
//
// Advisory, and deliberately so. Body similarity is a measured quantity with
// an agreed cutoff (SIMILARITY_BLOCK); "these two pages are going after the
// same searcher" is a judgement, and this project has no threshold for it.
// Recording the collision and showing it to the reviewer is honest. Inventing
// a number at which it starts blocking approval would not be.
const intentCollisionSchema = new Schema(
  {
    source: { type: String, enum: ['article', 'livePage'], default: 'article' },
    // Slug for an article, path for a live page.
    ref: { type: String, required: true },
    cluster: { type: String },
    searchIntent: { type: String },
    // Word-bigram Jaccard over the two titles. Reported, never gated.
    titleSimilarity: { type: Number, default: 0 },
  },
  { _id: false },
);

// A recorded editorial correction. An approved article that turns out to
// carry something it should not — a stale fare, a claim that aged badly — is
// corrected, not quietly overwritten: the previous text is kept here so
// "what did this page say when it was approved" always has an answer.
const correctionSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    reason: { type: String, required: true },
    fields: { type: [String], default: [] },
    // The values as they stood before the correction. Kept whole rather than
    // as a diff: a page that was live is evidence, and evidence is not
    // reconstructed from a patch.
    previous: { type: Schema.Types.Mixed },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const seoArticleSchema = new Schema(
  {
    // ── Keyword layer ────────────────────────────────────────
    keyword: { type: String, required: true, trim: true, index: true },
    // The keyword reduced to its comparable form: trimmed, lowercased,
    // internal whitespace collapsed. Two operators typing "BLS Ambulance
    // Bengaluru" and "bls  ambulance bengaluru" mean one page, and each
    // generation is a paid Claude call plus a draft nobody asked for.
    //
    // Unique at the database, not only in the pre-flight check: two clicks
    // landing together both read "no existing article" and both proceed, and
    // only the index can say no to the second one. Sparse so documents
    // written before this field existed are simply not in the index rather
    // than all colliding on null.
    normalizedKeyword: {
      type: String,
      trim: true,
      index: { unique: true, sparse: true },
    },
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
    //
    // Stored as `jsonLd`, NOT `schema`. `schema` is a reserved name on a
    // Mongoose document — Document.prototype.schema is how a document finds
    // its own definition — so a path of that name shadows it, and every
    // property access on a hydrated document throws
    // "Cannot read properties of undefined (reading Symbol(mongoose#Document#scope))".
    // That took out exactly the routes that load a document rather than a
    // lean object: update and setStatus — approve and reject.
    //
    // Documents written before the rename still carry the value under
    // `schema`. Nothing rewrites them on read: see normaliseLegacy below,
    // and scripts/migrateSeoJsonLd.js for the one-shot cleanup.
    jsonLd: { type: Schema.Types.Mixed },

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
      // Claims the fact checker could not establish against the fact sheet,
      // each with a severity and the action a reviewer should take. Only
      // `phrasing` is survivable: anything fabricated or unsupported blocks.
      unverifiedClaims: { type: [claimSchema], default: [] },
      // Length gates. These are mechanical, not a matter of judgement, and
      // they are the two fields that silently truncate in search results.
      titleLength: { type: Number, default: 0 },
      metaLength: { type: Number, default: 0 },
      // Links the generator invented that are not live on the site.
      droppedLinks: { type: [droppedLinkSchema], default: [] },

      // ── Against the pages that already rank ────────────────
      // The curated pages on savelife.health are protected canonical
      // content. livePageSimilarity is compared against the same
      // SIMILARITY_BLOCK as similarityScore, and blocks approval the same
      // way: a generated article that duplicates a live page would compete
      // with it for the same query and cost a ranking the site already has.
      livePageSimilarity: { type: Number, default: 0 },
      similarToLivePage: { type: String },
      // How many live pages the comparison actually ran against. A zero here
      // means the index was empty, not that the draft is unique.
      livePagesIndexed: { type: Number, default: 0 },

      // Same cluster, same intent, different words. Advisory — see
      // intentCollisionSchema above.
      intentCollisions: { type: [intentCollisionSchema], default: [] },

      // Shape errors in the assembled JSON-LD. Blocks: the renderer drops
      // invalid nodes, so approving one of these ships a page with no
      // structured data and no indication that anything went wrong.
      schemaErrors: { type: [String], default: [] },
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
      // Totals across every Claude call the generation made: the writer, each
      // fact check and each repair. Documents written before the repair loop
      // existed hold the writer call alone, so they under-report by history
      // rather than by error.
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      generatedAt: { type: Date },
      // Wall-clock for the whole generation, which is what the time budget in
      // seoGenerator.js is tuned against.
      durationMs: { type: Number },

      // ── Fact-repair loop ─────────────────────────────────────
      // How many times the independent checker ran. 1 means it came back
      // clean, or came back dirty with no repair attempted.
      factCheckAttempts: { type: Number, default: 1 },
      repairs: { type: [repairSchema], default: [] },
      // Why the loop stopped with blocking claims outstanding:
      // 'max-attempts' or 'time-budget'. Null when it stopped because the
      // article came back clean.
      repairStoppedReason: { type: String, default: null },

      // ── Recheck ──────────────────────────────────────────────
      // Set by POST /api/seo/articles/:id/recheck after a human edit. The
      // generation record above is never overwritten: this records that the
      // same gates were run again over changed text, and what they said.
      recheckedAt: { type: Date },
      recheckResult: { type: String, enum: ['passed', 'failed'] },
      // Human-readable gate failures from the last recheck, in the same
      // wording the generator logs. Empty on a pass.
      failedChecks: { type: [String], default: [] },
    },

    // Editorial corrections, oldest first. Empty for an article nobody has
    // had to correct.
    corrections: { type: [correctionSchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }, // gives createdAt / updatedAt
);

// ── Backward compatibility ───────────────────────────────────
//
// Two older shapes are still sitting in the collection, and both are fixed on
// read rather than by rewriting anything:
//
//   1. checks.unverifiedClaims held plain strings, before claims carried a
//      severity. Casting a string to the subdocument above throws on
//      hydration, which would make an existing draft impossible to open.
//   2. The JSON-LD blocks lived under `schema`, before that path was found to
//      be a reserved name.
//
// Normalising on read means a document is corrected as it is loaded, nothing
// stored is touched, and the migration script is a cleanup you can run
// whenever — not a prerequisite for the API to work. A legacy claim reads as
// `unsupported`, the conservative choice: it was blocking before severities
// existed, so it keeps blocking now.
function normaliseLegacy(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const claims = raw.checks?.unverifiedClaims;
  if (Array.isArray(claims)) {
    raw.checks.unverifiedClaims = claims.map((c) =>
      typeof c === 'string'
        ? { claim: c, severity: 'unsupported', action: 'rewrite' }
        : c,
    );
  }

  // Only when jsonLd is genuinely absent. A migrated document that still
  // carries a stale `schema` key must not have it clobber the real value.
  if (raw.jsonLd === undefined && raw.schema !== undefined) raw.jsonLd = raw.schema;

  return raw;
}

seoArticleSchema.statics.normaliseLegacy = normaliseLegacy;

// The only two states that may be served to the public. Defined here, next to
// the enum it is drawn from, so the public API and the website cannot drift
// from the model's idea of what "signed off" means. A draft, an in_review or a
// rejected article is not a page -- it is work in progress, and serving one
// would publish text no human has approved.
// One definition of "the same keyword", used by the pre-flight check, the
// generator and the tests. Anywhere that compares keywords must call this;
// two normalisers would eventually disagree and let a duplicate through.
seoArticleSchema.statics.normaliseKeyword = (k) =>
  String(k || '').trim().toLowerCase().replace(/\s+/g, ' ');

seoArticleSchema.statics.PUBLIC_STATUSES = Object.freeze(['approved', 'published']);

// Hydrated documents. pre('init') runs before casting, so the raw object is
// corrected while it is still a plain object; strict mode then drops the
// now-copied `schema` key instead of trying to cast it to a path that no
// longer exists.
seoArticleSchema.pre('init', function preInitNormalise(raw) {
  normaliseLegacy(raw);
});

// Lean reads skip init entirely — list, getById and the similarity sweep all
// use .lean() — so the same normalisation is applied to query results. Only
// plain objects are touched: a hydrated document has already been through
// pre('init'), and mutating it here would mark clean paths as modified.
const isLean = (d) => d && typeof d === 'object' && !d.$__;

function leanCompat(doc) {
  if (!isLean(doc)) return;
  normaliseLegacy(doc);
  // API compatibility: callers written against the old field go on reading
  // `schema`. It mirrors jsonLd on the way out, and since it is no longer a
  // path, nothing can write to it by accident.
  if (doc.jsonLd !== undefined) doc.schema = doc.jsonLd;
}

seoArticleSchema.statics.applyLeanCompat = leanCompat;

seoArticleSchema.post('find', function (docs) {
  if (Array.isArray(docs)) docs.forEach(leanCompat);
});
seoArticleSchema.post(['findOne', 'findOneAndUpdate'], function (doc) {
  leanCompat(doc);
});

// The same mirror for hydrated documents, which reach the client through
// res.json -> toJSON. `ret` is a plain object by this point, so a key named
// `schema` is harmless here: the reserved-name problem is about paths on a
// document, not keys on its serialised form.
seoArticleSchema.set('toJSON', {
  transform(doc, ret) {
    if (ret.jsonLd !== undefined) ret.schema = ret.jsonLd;
    return ret;
  },
});

// The two queries the admin list actually makes.
seoArticleSchema.index({ status: 1, updatedAt: -1 });
seoArticleSchema.index({ cluster: 1, status: 1 });

module.exports = mongoose.model('SeoArticle', seoArticleSchema);
