/** dsh-switchman context-trim trigger tiers (pure decision logic).
 *
 * The trigger half of the port (design §4/§5): decides whether a fold
 * should run NOW. Called only at idle boundaries (agent/status idle) —
 * never inside llm/stream, never while a fold for the same session is in
 * flight. Three tiers, checked emergency-first:
 *
 * - emergency  : view usage >= trimEmergencyPercent of the context window.
 *                Forced MECHANICAL fold (no side-model round trip — at 95%
 *                the session cannot afford the latency or the failure).
 * - pressure   : view usage >= trimPressurePercent. Side-model fold.
 * - growth     : growth since the last fold's post-fold low (the anchor
 *                that keeps the gate armed after folds committing at high
 *                view points) > trimGrowthTokens AND the contiguous
 *                compressible increment >= trimIncrementTokens. The
 *                primary, cache-friendly gate (the bili heuristic).
 *
 * Side-model folds are additionally throttled by trimMaxFoldsPerHour and a
 * hard minimum interval between folds; emergency folds have their own
 * cooldown so a stuck-at-95% session folds at most once per window.
 * Everything is derived from measured inputs — no clock, no host access —
 * which keeps the decision unit-testable (golden thresholds).
 */

import { estimateTokensOf, refPositions, segmentBounds } from "./view.js";

/** Hard minimum wall-clock interval between side-model folds. */
export const FOLD_MIN_INTERVAL_MS = 60_000;

/** Minimum interval between emergency (mechanical) folds. */
export const EMERGENCY_COOLDOWN_MS = 90_000;

/** The foldable span of a captured messages array for one ledger: from the
 * first segment boundary strictly after the frontier to the last segment
 * end that still clears the protected tail. Returns { startIdx, endIdx }
 * or null when nothing is foldable (empty history, everything folded, or
 * protected tail covers it all). */
export function computeFoldableRange(messages, ledger, protectedTail) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const tail = Number.isInteger(protectedTail) && protectedTail > 0 ? protectedTail : 0;
	const tailStart = messages.length - tail;
	if (tailStart <= 0) return null;
	// first candidate segment start: strictly after the frontier message
	let startFrom = 0;
	if (typeof ledger?.frontier === "string" && ledger.frontier !== "") {
		const positions = refPositions(messages);
		const list = positions.get(ledger.frontier);
		if (list !== undefined && list.length > 0) startFrom = list[list.length - 1] + 1;
	}
	let best = null;
	for (const [start, end] of segmentBounds(messages)) {
		if (start < startFrom) continue; // behind the frontier
		if (end >= tailStart) break; // segment would cut into the protected tail
		if (best === null) best = { startIdx: start, endIdx: end };
		else best.endIdx = end; // extend the contiguous span
	}
	return best;
}

/** Evaluate the trigger. input: {
 *   foldable: { startIdx, endIdx } | null,  // computeFoldableRange result
 *   messages,        // captured raw messages (increment measurement)
 *   viewTokens,      // outbound-view token estimate of the current history
 *   windowTokens,    // context window size, or null when unknown
 *   thresholds: { growthTokens, incrementTokens, pressurePercent, emergencyPercent, maxFoldsPerHour },
 *   now, lastFoldAt, foldsThisHour, lastEmergencyAt,
 * }.
 * Returns { action: "none"|"fold"|"emergency", tier, reason, startIdx, endIdx, incrementTokens }. */
export function evaluateTrigger(input) {
	const none = { action: "none", tier: null, reason: "", startIdx: -1, endIdx: -1, incrementTokens: 0 };
	const foldable = input?.foldable ?? null;
	if (foldable === null) return { ...none, reason: "nothing-foldable" };
	const { startIdx, endIdx } = foldable;
	const thresholds = input?.thresholds ?? {};
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	const incrementTokens = estimateTokensOf(input?.messages ?? [], startIdx, endIdx);
	if (incrementTokens < 1) return { ...none, reason: "empty-increment" };

	// Tier c — emergency: window pressure, mechanical, cooldown-gated.
	const windowTokens = Number.isFinite(input?.windowTokens) && input.windowTokens > 0 ? input.windowTokens : null;
	const emergencyPercent = Number.isFinite(thresholds.emergencyPercent) && thresholds.emergencyPercent > 0 ? thresholds.emergencyPercent : 95;
	if (windowTokens !== null) {
		const usagePct = (input.viewTokens / windowTokens) * 100;
		if (usagePct >= emergencyPercent) {
			const lastEmergencyAt = Number.isFinite(input?.lastEmergencyAt) ? input.lastEmergencyAt : 0;
			if (now - lastEmergencyAt < EMERGENCY_COOLDOWN_MS) return { ...none, reason: "emergency-cooldown" };
			return { action: "emergency", tier: "emergency", reason: `usage ${usagePct.toFixed(1)}% >= ${emergencyPercent}%`, startIdx, endIdx, incrementTokens };
		}
	}

	// Side-model folds (pressure + growth) share the cadence gates.
	const lastFoldAt = Number.isFinite(input?.lastFoldAt) ? input.lastFoldAt : 0;
	const hourly = Array.isArray(input?.foldsThisHour) ? input.foldsThisHour.filter((ts) => now - ts < 3_600_000).length : 0;
	const maxFoldsPerHour = Number.isInteger(thresholds.maxFoldsPerHour) && thresholds.maxFoldsPerHour > 0 ? thresholds.maxFoldsPerHour : 6;
	if (hourly >= maxFoldsPerHour) return { ...none, reason: "hourly-cap" };
	if (now - lastFoldAt < FOLD_MIN_INTERVAL_MS) return { ...none, reason: "min-interval" };

	// Tier b — pressure: soft window threshold, side-model.
	const pressurePercent = Number.isFinite(thresholds.pressurePercent) && thresholds.pressurePercent > 0 ? thresholds.pressurePercent : 60;
	if (windowTokens !== null) {
		const usagePct = (input.viewTokens / windowTokens) * 100;
		if (usagePct >= pressurePercent) {
			return { action: "fold", tier: "pressure", reason: `usage ${usagePct.toFixed(1)}% >= ${pressurePercent}%`, startIdx, endIdx, incrementTokens };
		}
	}

	// Tier a — growth gate: the primary cache-friendly heuristic.
	const growthTokens = Number.isFinite(thresholds.growthTokens) && thresholds.growthTokens > 0 ? thresholds.growthTokens : 22_500;
	const incrementGate = Number.isFinite(thresholds.incrementTokens) && thresholds.incrementTokens > 0 ? thresholds.incrementTokens : 50_000;
	// Growth anchor: the post-fold low when known (keeps the gate armed
	// after folds that commit at high view points), else the pre-fold
	// view for ledgers written before lastFoldLowTokens existed.
	const anchor = Number.isFinite(input?.ledger?.lastFoldLowTokens) && input.ledger.lastFoldLowTokens > 0
		? input.ledger.lastFoldLowTokens
		: Number.isFinite(input?.ledger?.lastFoldViewTokens) ? input.ledger.lastFoldViewTokens : 0;
	const growth = input.viewTokens - anchor;
	if (growth > growthTokens && incrementTokens >= incrementGate) {
		return { action: "fold", tier: "growth", reason: `growth ~${Math.round(growth)} > ${growthTokens} and increment ~${incrementTokens} >= ${incrementGate}`, startIdx, endIdx, incrementTokens };
	}

	return { ...none, reason: "below-thresholds" };
}
