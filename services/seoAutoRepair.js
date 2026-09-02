/**
 * services/seoAutoRepair.js
 * ============================================================
 * Drive repair -> recheck automatically, up to a cap, for the gate failures
 * that a repair can actually fix.
 *
 * This orchestrates; it implements nothing. repairArticle() rewrites,
 * recheckArticle() re-runs the gates, and both already exist. Nothing here
 * fact-checks, evaluates a gate, or decides what "passed" means — doing any
 * of that a second time is how two implementations start disagreeing about
 * whether an article is safe to publish.
 *
 * WHY THIS IS NOT INSIDE generateDraft
 *
 * A generation already spends up to 183s of its 255s budget, against a 300s
 * client timeout. A single auto-repair cycle is two more Claude calls, and
 * two cycles is four; folding that into the generation request would blow the
 * timeout and the operator would watch a good draft get abandoned mid-flight.
 * So this is a separate, explicitly triggered request: generation returns a
 * draft, and the loop runs afterwards on its own clock.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * Approval. The loop can leave an article clean and ready, and that is where
 * it stops — checks.passed true, status exactly where it found it, a human
 * still pressing Approve. It also refuses to start on an article whose
 * failures need judgement rather than rewriting: a duplicate keyword, a
 * cannibalisation score, a schema error. Those are decisions, and a loop that
 * "fixed" them would be overruling somebody.
 *
 * A price already on the article is NOT one of those. It is repairable: the
 * loop removes it, because a public article carries no exact price at all.
 * See classifyFailures and services/seoContentPolicy.js.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const {
  repairArticle, recheckArticle, isBlocking,
  TITLE_MIN, TITLE_MAX, META_MIN, META_MAX,
} = require('./seoGenerator');
// The second look. repairArticle's own validation is cheap and deterministic
// but blind to anything only a real fact check can see, so the gates are
// compared before and after the recheck too.
const { isWorse } = require('./seoRepairGuard');

// Two, matching the generation loop's cap. What survives two passes is a
// claim the fact sheet genuinely cannot support, and the answer to that is a
// person rather than a third prompt.
const MAX_AUTO_REPAIR_ATTEMPTS = Number(process.env.SEO_MAX_AUTO_REPAIR_ATTEMPTS || 2);

/** Another loop already holds this article. */
class AutoRepairBusyError extends Error {
  constructor() {
    super('An automatic repair is already running on this article. Wait for it to finish.');
    this.name = 'AutoRepairBusyError';
  }
}

/**
 * Split a failing checks object into what a repair can fix and what it must
 * not touch.
 *
 * Two outcomes:
 *
 *   repairable — what repairArticle() acts on: blocking claims, the two length
 *                gates, and published fares (which it removes).
 *   blocked    — a judgement call the loop must not make. It refuses to start.
 *
 * Pricing is repairable. A price introduced BY a repair is still a regression
 * and is still rejected — that check lives in seoRepairGuard and runs on the
 * proposal, after the fact.
 */
function classifyFailures(checks = {}) {
  const repairable = [];
  const blocked = [];

  const blockingClaims = (checks.unverifiedClaims || []).filter(isBlocking).length;
  if (blockingClaims) repairable.push(`${blockingClaims} blocking claim(s)`);

  const metaLen = checks.metaLength ?? 0;
  if (metaLen < META_MIN || metaLen > META_MAX) repairable.push(`meta ${metaLen} chars, want ${META_MIN}-${META_MAX}`);

  const titleLen = checks.titleLength ?? 0;
  if (titleLen < TITLE_MIN || titleLen > TITLE_MAX) repairable.push(`title ${titleLen} chars, want ${TITLE_MIN}-${TITLE_MAX}`);

  // Published fares are REPAIRABLE, and repairing them means taking them out.
  //
  // This has moved twice, and the reasoning matters. It was `blocked`, which
  // stopped the loop before attempt 1 and meant an article with eleven fares
  // could not have a single claim or a broken title fixed. It was then
  // `carried` — run, but leave the fares alone — which fixed that but left
  // exact prices sitting permanently on a public page. Under the content
  // policy in seoContentPolicy.js a public article carries no exact price at
  // all, so the fares are the defect and removing them is the repair.
  //
  // Introducing a price is still forbidden, and still caught: that check lives
  // in seoRepairGuard and runs on the proposal after the fact.
  if ((checks.pricingClaims || []).length) {
    repairable.push(`${checks.pricingClaims.length} exact price(s) to remove — a public article carries none`);
  }

  // ── Not repairable, each for its own reason ────────────────
  if (checks.duplicateSlug) blocked.push('duplicate slug — needs a new slug, which is an editorial decision');
  if ((checks.similarityScore ?? 0) >= 0.55) blocked.push(`draft similarity ${Number(checks.similarityScore).toFixed(2)} — rewording to dodge a similarity score is not a repair`);
  if ((checks.livePageSimilarity ?? 0) >= 0.55) blocked.push(`live-page similarity ${Number(checks.livePageSimilarity).toFixed(2)} — cannibalisation is an editorial call`);
  if ((checks.schemaErrors || []).length) blocked.push(`${checks.schemaErrors.length} schema error(s) — structural, not wording`);
  if ((checks.wordCount ?? 0) < 700) blocked.push(`${checks.wordCount} words — padding to a word count is how unsupported claims get written`);
  if ((checks.internalLinks ?? null) === null && false) { /* links live on the doc, checked by the caller */ }

  return { repairable, blocked };
}

/**
 * Claim the article for this loop, atomically.
 *
 * findOneAndUpdate with the not-running condition IS the lock: two requests
 * racing both issue it, MongoDB serialises them, and exactly one gets a
 * document back. A read-then-write would let both see "free" and proceed.
 */
async function claim(articleId) {
  return SeoArticle.findOneAndUpdate(
    { _id: articleId, 'generation.autoRepair.running': { $ne: true } },
    { $set: { 'generation.autoRepair.running': true, 'generation.autoRepair.startedAt': new Date() } },
    { new: true },
  );
}

async function release(article, patch = {}) {
  article.generation = article.generation || {};
  article.generation.autoRepair = {
    ...(article.generation.autoRepair?.toObject?.() || article.generation.autoRepair || {}),
    running: false,
    lastRunAt: new Date(),
    ...patch,
  };
  await article.save();
}

/**
 * Record where the loop has got to, on the article itself.
 *
 * A run is one long HTTP request -- up to four Claude calls -- so without
 * this the Studio has nothing to show but a spinner for minutes at a time.
 * The Studio polls the article while `running` is true and renders `phase`
 * and `timeline`, which is why these are written as the loop advances rather
 * than assembled at the end.
 *
 * Written through the same in-memory document that repairArticle and
 * recheckArticle save, so their writes and these cannot clobber each other.
 * It reports progress and nothing else: no gate is evaluated here, and
 * `passed` is never set from this function.
 */
async function progress(article, phase, timeline, attempts, maxAttempts, targets = []) {
  article.generation = article.generation || {};
  article.generation.autoRepair = {
    ...(article.generation.autoRepair?.toObject?.() || article.generation.autoRepair || {}),
    running: true,
    phase,
    attempts,
    maxAttempts,
    // What this attempt is actually repairing. One call fixes the claims, the
    // title and the meta together, so these are listed rather than staged --
    // showing "Repairing title" as a separate step would describe a call that
    // does not exist.
    targets: [...targets],
    timeline: [...timeline],
  };
  await article.save();
}

/** Everything a rollback has to put back, including the gate result. */
function snapshotOf(article) {
  return {
    title: article.title,
    metaDescription: article.metaDescription,
    h1: article.h1,
    content: article.content,
    faqs: (article.faqs || []).map((f) => ({ q: f.q, a: f.a })),
    checks: article.checks?.toObject?.() || { ...(article.checks || {}) },
  };
}

/**
 * Put the article back exactly as it was before an attempt.
 *
 * The checks go back too. Restoring the text but keeping the failed recheck
 * would leave the article describing itself with gate results belonging to
 * text that no longer exists — which is the same class of lie the repair was
 * called to remove.
 */
function rollbackTo(article, snap) {
  article.title = snap.title;
  article.metaDescription = snap.metaDescription;
  article.h1 = snap.h1;
  article.content = snap.content;
  article.faqs = snap.faqs.map((f) => ({ q: f.q, a: f.a }));
  article.checks = snap.checks;
}

/**
 * Repair and recheck until the gates pass, the failures stop being
 * repairable, or the attempt cap is reached.
 *
 * @returns {object} { passed, attempts, stoppedReason, timeline, article }
 */
async function autoRepairArticle(articleId, { maxAttempts = MAX_AUTO_REPAIR_ATTEMPTS } = {}) {
  const article = await claim(articleId);
  if (!article) throw new AutoRepairBusyError();

  const timeline = [];
  let attempts = 0;
  let reverted = 0;
  let revertReasons = [];
  let stoppedReason = null;

  try {
    // Already clean: nothing to do, and nothing to change. An article that
    // passes is waiting for a human, not for this.
    if (article.checks?.passed) {
      timeline.push('already passing — no repair attempted');
      await release(article, { attempts: 0, maxAttempts, stoppedReason: 'already-passing', timeline, phase: 'passed' });
      return { passed: true, attempts: 0, stoppedReason: 'already-passing', timeline, article };
    }

    await progress(article, 'detecting', timeline, 0, maxAttempts);

    while (attempts < maxAttempts) {
      const { repairable, blocked } = classifyFailures(article.checks);

      if (blocked.length) {
        stoppedReason = `needs human review: ${blocked.join('; ')}`;
        timeline.push(`stopped before attempt ${attempts + 1} — ${stoppedReason}`);
        break;
      }
      if (!repairable.length) {
        stoppedReason = 'no repairable failure found — the article fails on something a repair cannot fix';
        timeline.push(stoppedReason);
        break;
      }

      attempts += 1;
      timeline.push(`attempt ${attempts}/${maxAttempts}: repairing — ${repairable.join('; ')}`);
      console.log(`[SEO] auto-repair attempt ${attempts}/${maxAttempts} — slug="${article.slug}" ${repairable.join('; ')}`);
      await progress(article, 'repairing', timeline, attempts, maxAttempts, repairable);

      // Taken before the repair touches anything. If the recheck comes back
      // worse than this, the attempt is undone rather than left standing.
      const snapshot = snapshotOf(article);

      const rep = await repairArticle(article, { attempt: attempts, automatic: true });
      if (!rep.repaired) {
        // Two different outcomes, and the operator needs to tell them apart:
        // the model declined to edit, or it proposed something worse and every
        // proposal was thrown away. Neither wrote anything.
        stoppedReason = rep.rejected
          ? `the repair produced nothing safe to keep: ${(rep.rejections || []).map((r) => r.detail).join('; ')}`
          : 'the repair returned no changes — the article is unchanged and needs a person';
        timeline.push(`attempt ${attempts}: ${rep.rejected ? 'proposal rejected and discarded' : 'no changes returned'}`);
        break;
      }
      timeline.push(`attempt ${attempts}: rewrote ${rep.repairedFields.join(', ')}`
        + ((rep.unmetTargets || []).length ? ` — still failing: ${rep.unmetTargets.map((u) => u.detail).join('; ')}` : ''));
      await progress(article, 'rechecking', timeline, attempts, maxAttempts, repairable);

      // The existing gate run. Nothing here decides whether it passed.
      const rc = await recheckArticle(article);
      timeline.push(`attempt ${attempts}: recheck ${rc.passed ? 'PASSED' : `failed — ${rc.failedChecks.join('; ')}`}`);

      // The authoritative second look. A repair that cleared some claims but
      // introduced a price, a new claim or a schema error has not helped, and
      // leaving it in place would hand the reviewer a worse article than the
      // one they started with.
      if (!rc.passed) {
        const verdict = isWorse(snapshot.checks, article.checks);
        if (verdict.worse) {
          rollbackTo(article, snapshot);
          reverted += 1;
          revertReasons = verdict.reasons;
          timeline.push(`attempt ${attempts}: REVERTED — ${verdict.reasons.join('; ')}`);
          console.log(`[SEO] auto-repair attempt ${attempts} reverted — ${verdict.reasons.join('; ')}`);
          await progress(article, 'repairing', timeline, attempts, maxAttempts, repairable);
          // Fall through to the next attempt, if the cap allows one. The
          // article is back to its original text, so the next attempt starts
          // from the same place this one did rather than compounding a bad
          // rewrite.
          continue;
        }
      }

      if (rc.passed) {
        // Clean, and that is where it stops. Status is untouched; Approve is
        // still a human pressing a button.
        await release(article, { attempts, maxAttempts, stoppedReason: null, timeline, phase: 'passed' });
        console.log(`[SEO] auto-repair: PASSED after ${attempts} attempt(s) — status=${article.status}, human approval still required`);
        return { passed: true, attempts, stoppedReason: null, timeline, article };
      }
    }

    if (!stoppedReason) {
      stoppedReason = reverted
        ? `max-attempts: ${attempts} automatic repair(s), of which ${reverted} made the article worse and were undone (${revertReasons.join('; ')}). It is back to the text it started with and needs a person.`
        : `max-attempts: still failing after ${attempts} automatic repair(s)`;
      timeline.push(stoppedReason);
    }

    await release(article, { attempts, maxAttempts, stoppedReason, timeline, phase: 'stopped' });
    console.log(`[SEO] auto-repair stopped — ${stoppedReason}`);
    return { passed: Boolean(article.checks?.passed), attempts, stoppedReason, timeline, article };
  } catch (err) {
    // Fail closed: the lock is released and the reason recorded, so a crashed
    // loop cannot leave an article permanently unrepairable.
    //
    // An API-side stop -- an exhausted balance, an expired key, a rate limit --
    // is recorded in the API's own words. It says nothing about the article,
    // which is left exactly as the last completed step wrote it: repairArticle
    // and recheckArticle both save only after their call returns, so a throw
    // mid-call writes nothing at all.
    // Matched on name rather than instanceof: this runs inside a catch, and
    // an `instanceof undefined` here would throw away the very error it is
    // trying to report.
    const reason = err?.name === 'ClaudeApiError'
      ? `stopped by the Anthropic API (${err.code}): ${err.message}`
      : `error: ${err.message}`;
    timeline.push(reason);
    try {
      await release(article, { attempts, maxAttempts, stoppedReason: reason, timeline, phase: 'stopped' });
    } catch { /* the original error is the one worth reporting */ }
    throw err;
  }
}

module.exports = {
  autoRepairArticle,
  classifyFailures,
  AutoRepairBusyError,
  MAX_AUTO_REPAIR_ATTEMPTS,
};
