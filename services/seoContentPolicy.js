/**
 * services/seoContentPolicy.js
 * ============================================================
 * The editorial rules a public SEO article must satisfy, written once.
 *
 * Today there is one:
 *
 *     A PUBLIC SEO ARTICLE CARRIES NO EXACT PRICE.
 *
 * Not a fare, not a minimum, not a per-km rate, not a floor charge, not a
 * range, not a "from". Fares here move with the vehicle, the road distance,
 * the timing and what the trip needs, so any figure printed on a public page
 * is wrong sooner or later — and a reader who saw it reasonably believes they
 * were quoted. The page may explain HOW a fare is worked out. It may not say
 * what one is.
 *
 * WHY THIS MODULE EXISTS
 *
 * The rule has to reach three places that all write article text: the writer
 * prompt, the repair prompt, and the instruction a repair gets when it is
 * asked to clean an article that already carries fares. Three copies of a
 * policy is three chances for them to drift, and a policy that says something
 * slightly different depending on which call is running is not a policy. So
 * the words live here and every prompt interpolates them.
 *
 * WHAT THIS IS NOT
 *
 * It is not enforcement. This module only says what the rule is; nothing here
 * inspects an article. Detection stays entirely in seoPricingGuard, which runs
 * after the text exists and blocks approval regardless of what any prompt was
 * told. Instructions steer a model. The guard is what makes the rule true.
 *
 * TWO RULES THAT LOOK ALIKE AND ARE NOT
 *
 *   Content policy  — a public article must contain no exact price. Existing
 *                     fares are therefore content to be REMOVED.
 *   Repair safety   — a repair must never INTRODUCE a price, or swap one for
 *                     another. That lives in seoRepairGuard.
 *
 * Both hold at once. A repair may take fares out; it may never put one in.
 * ============================================================
 */
'use strict';

const { APPROVED_FARE_WORDING } = require('./seoPricingGuard');

/**
 * The rule, as every text-writing prompt states it. Interpolated into
 * WRITER_SYSTEM and REPAIR_SYSTEM so the two cannot disagree.
 */
const NO_EXACT_PRICING_RULE = [
  'PRICING — AN ABSOLUTE RULE, AND THE ONE MOST OFTEN BROKEN:',
  '- NEVER write an exact money figure. No fare, minimum, starting price, deposit, discount, package price, per-kilometre rate, per-hour or per-day rate, floor charge or service charge. Not as an example, not as "from", not as "starting at", not as a range, and not in a table.',
  '- This covers every currency form: ₹1,200, Rs 1,200, Rs. 1,200, INR 1200, "1200 per trip", "2500 minimum", "₹3/km". All of them are forbidden.',
  '- It covers every field a reader can see: the title, the meta description, the body, any table, every FAQ question and answer, and anything that ends up in structured data.',
  '- If a figure already appears in the article you are given, REMOVE it. It is not there because somebody approved it; it is there because it should not have got through. Do not preserve it, and do not swap it for a different figure.',
  '- You may explain HOW a fare is decided — the vehicle, the pickup and drop, the road distance actually travelled, the timing, and what the trip itself requires. Explaining the method is useful. Naming a number is not allowed.',
  `- Where a reader would expect a figure, the sentence is: "${APPROVED_FARE_WORDING}"`,
  '- Never invent a price range, a minimum, a discount, a night surcharge or a floor charge to fill the gap, and never write "cheapest", "lowest price", "best price" or any similar claim about cost.',
  '- Ordinary numbers are fine and must not be stripped: 24/7, distances in km, floor numbers, phone numbers, addresses, dates, vehicle and equipment specifications. The rule is about money, not about digits.',
].join('\n');

/**
 * The instruction handed to a repair that must clean fares out of an article
 * which already carries them.
 *
 * The offending phrases are quoted back verbatim, because "remove the prices"
 * against a 950-word article invites a rewrite of the whole thing, and a
 * wholesale rewrite is how a repair loses the parts that were fine.
 *
 * @param {string[]} prices  what seoPricingGuard found, verbatim
 */
function pricingRemovalInstruction(prices = []) {
  const listed = prices.length
    ? `The following appear in the article and must all be gone: ${prices.join(', ')}.`
    : 'The article carries one or more exact money figures and they must all be gone.';

  return [
    'REMOVE THE PUBLISHED PRICING.',
    listed,
    'Take out the figure itself and repair the sentence around it so it still reads naturally — do not leave a dangling dash, an empty table column or a half-sentence.',
    'If a table column exists only to carry fares, drop the column and keep the rest of the table.',
    'Replace the figure with what actually decides the fare: the vehicle, the pickup and drop points, the road distance travelled, the timing, and what the trip requires. Say that the applicable fare is confirmed before booking.',
    'Do NOT substitute a different figure, a range, a minimum or an approximation, and do NOT delete the surrounding explanation — a reader still needs to understand how the fare is worked out.',
  ].join('\n');
}

module.exports = {
  NO_EXACT_PRICING_RULE,
  pricingRemovalInstruction,
};
