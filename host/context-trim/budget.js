/** dsh-switchman context-trim budget helpers (guide §4.6 — compress by
 *  budget, P1 item 4).
 *
 * The compress target is min(pool_target, current_context × ratio). The
 * plugin has no live pool-budget field to read (the pool* settings carry
 * routes, not token budgets), so the pool target is a conservative
 * module constant: below the default pressure line (45% of a 200k window
 * = 90k) and the hard watermark (100k), above typical post-fold lows —
 * it only ever ADDS a fold line, never delays an existing tier.
 *
 * Two consumption points (both fail-open — any unusable input degrades to
 * "no budget constraint", exactly the pre-feature behavior):
 * - trigger.js reads thresholds.budgetTarget (absolute token line) as an
 *   extra side-model fold tier between pressure and growth;
 * - index.js parameterizes the advisory nudge's fold-down depth with the
 *   ratio-derived percent (default 50 = the hard-coded "~50%" of today).
 *
 * Pure helpers: no clock, no host access — unit-testable.
 */

/** Conservative pool budget constant (tokens). See the module comment for
 *  the derivation; P2 may replace this with a live pool-config read. */
export const POOL_TARGET_TOKENS = 60_000;

/** Default compressBudgetRatio: the guide's formula with today's nudge
 *  depth — "fold down to under ~50%" is exactly ratio 0.5, so the default
 *  ON state keeps the advisory depth text byte-identical. */
export const COMPRESS_BUDGET_RATIO_DEFAULT = 0.5;

/** min(pool_target, current × ratio), floored to whole tokens.
 *  Null on ANY unusable input (fail-open = no budget constraint). */
export function compressBudgetTargetTokens({ currentTokens, poolTargetTokens = POOL_TARGET_TOKENS, ratio = COMPRESS_BUDGET_RATIO_DEFAULT } = {}) {
	if (!Number.isFinite(currentTokens) || currentTokens <= 0) return null;
	if (!Number.isFinite(poolTargetTokens) || poolTargetTokens <= 0) return null;
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
	return Math.floor(Math.min(poolTargetTokens, currentTokens * ratio));
}

/** Advisory-nudge depth percent derived from the ratio, e.g. 0.5 → 50.
 *  Falls back to `fallbackPercent` (default 50 = today's hard-coded text)
 *  on any unusable input (fail-open). */
export function budgetNudgePercent(ratio, fallbackPercent = 50) {
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return fallbackPercent;
	const percent = Math.round(ratio * 100);
	return percent > 0 && percent < 100 ? percent : fallbackPercent;
}
