/**
 * models/SeoLivePage.js
 * ============================================================
 * A fingerprint of every page already published on savelife.health.
 *
 * These are the curated, hand-written pages -- the ones that took months to
 * write and that currently rank. They are protected canonical content: a
 * generated article is never allowed to compete with one, and this collection
 * is what makes that checkable.
 *
 * Same fingerprint as SeoArticle: a normalised word-trigram set, compared by
 * Jaccard. Deliberately the same representation and the same threshold, so
 * "how similar is this draft to an existing page" and "how similar is this
 * draft to another draft" are one question with one answer, not two systems
 * that could disagree.
 *
 * Nothing here is authored. Every row is fetched from the live site by
 * services/seoLivePages.js, which is why `fetchedAt` matters: a stale index
 * is a gate comparing against a page that no longer says what it used to.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const seoLivePageSchema = new Schema(
  {
    // Path, not full URL: '/ambulance-whitefield'. Matches how LIVE_PAGES in
    // services/seoFacts.js and internalLinks on SeoArticle refer to pages, so
    // the three can be joined without normalising hosts.
    path: { type: String, required: true, unique: true, trim: true, lowercase: true },

    title: { type: String, trim: true },
    h1: { type: String, trim: true },

    // Visible body text, stripped of markup. Stored so a reviewer looking at
    // a similarity flag can read what the draft was found similar TO, rather
    // than being told a number and left to guess.
    text: { type: String },
    wordCount: { type: Number, default: 0 },

    // The trigram set. Not indexed -- read in bulk during a generation, never
    // queried by value. Not select:false, unlike SeoArticle.shingles: there is
    // no route that returns these to anyone, and the only reader wants them.
    shingles: { type: [String], default: [] },

    // When the live page was last read. The refresh job uses this to decide
    // what is stale; the generator uses it to say how old the index was when
    // it made a decision.
    fetchedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('SeoLivePage', seoLivePageSchema);
