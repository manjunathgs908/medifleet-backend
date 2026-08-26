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
 * cannibalisation score, a published price. Those are decisions, and a loop
 * that "fixed" them would be overruling somebody.
 * ============================================================
 */
'use strict';

const SeoArticle = require('../models/SeoArticle');
const {
  repairArticle, recheckArticle, isBlocking,
  TITLE_MIN, TITLE_MAX, META_MIN, META_MAX,
} = require('./seoGenerator');

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
 * The repairable set is exactly what repairArticle() acts on: blocking claims
 * and the two length gates. Everything else is either a judgement call or a
 * signal that something went wrong enough to want a person.
 *
 * Note pricing sits firmly in `blocked`. The repair prompt forbids
 * introducing a price, so a price appearing after a repair is a regression,
 * not a fixable defect — the loop stops and says so rather than trying again.
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

  // ── Not repairable, each for its own reason ────────────────
  if ((checks.pricingClaims || []).length) {
    blocked.push(`${checks.pricingClaims.length} fixed price(s) — a repair must never produce one; this needs a person`);
  }
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
  let stoppedReason = null;

  try {
    // Already clean: nothing to do, and nothing to change. An article that
    // passes is waiting for a human, not for this.
    if (article.checks?.passed) {
      timeline.push('already passing — no repair attempted');
      await release(article, { attempts: 0, stoppedReason: 'already-passing', timeline });
      return { passed: true, attempts: 0, stoppedReason: 'already-passing', timeline, article };
    }

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

      const rep = await repairArticle(article, { attempt: attempts, automatic: true });
      if (!rep.repaired) {
        stoppedReason = 'the repair returned no changes — the article is unchanged and needs a person';
        timeline.push(`attempt ${attempts}: no changes returned`);
        break;
      }
      timeline.push(`attempt ${attempts}: rewrote ${rep.repairedFields.join(', ')}`);

      // The existing gate run. Nothing here decides whether it passed.
      const rc = await recheckArticle(article);
      timeline.push(`attempt ${attempts}: recheck ${rc.passed ? 'PASSED' : `failed — ${rc.failedChecks.join('; ')}`}`);

      if (rc.passed) {
        // Clean, and that is where it stops. Status is untouched; Approve is
        // still a human pressing a button.
        await release(article, { attempts, stoppedReason: null, timeline });
        console.log(`[SEO] auto-repair: PASSED after ${attempts} attempt(s) — status=${article.status}, human approval still required`);
        return { passed: true, attempts, stoppedReason: null, timeline, article };
      }
    }

    if (!stoppedReason) {
      stoppedReason = `max-attempts: still failing after ${attempts} automatic repair(s)`;
      timeline.push(stoppedReason);
    }

    await release(article, { attempts, stoppedReason, timeline });
    console.log(`[SEO] auto-repair stopped — ${stoppedReason}`);
    return { passed: Boolean(article.checks?.passed), attempts, stoppedReason, timeline, article };
  } catch (err) {
    // Fail closed: the lock is released and the reason recorded, so a crashed
    // loop cannot leave an article permanently unrepairable.
    try {
      await release(article, { attempts, stoppedReason: `error: ${err.message}`, timeline });
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
