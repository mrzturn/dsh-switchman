/** dsh-switchman context-trim trigger tiers (pure decision logic).
 *
 * The trigger half of the port (design §4/§5): decides whether a fold
 * should run NOW. Called only at idle boundaries (agent/status idle) —
 * never inside llm/stream, never while a fold for the same session is in
 * flight. Tiers, checked emergency-first:
 *
 * - emergency  : view usage >= trimEmergencyPercent of the context window.
 *                Forced MECHANICAL T1 fold (no side-model round trip — at
 *                95% the session cannot afford the latency or the failure).
 * - pressure   : view usage >= trimPressurePercent. Side-model T1 fold.
 * - growth     : growth since the last fold's post-fold low (the anchor
 *                that keeps the gate armed after folds committing at high
 *                view points) > trimGrowthTokens AND the contiguous
 *                compressible increment >= trimIncrementTokens. The
 *                primary, cache-friendly gate (the bili heuristic).
 * - ladder T3  : active-T2 summary mass/count gates met (docs/ladder-fold.md).
 * - ladder T2  : active-T1 summary mass/count gates met.
 *
 * The ladder (T2/T3 distillation) is a MAINTENANCE path: raw T1 folds stay
 * the primary cadence and ladder folds only fire when the summary
 * population itself has grown worth reclaiming (mass gates — bili #379:
 * block count is not a need signal; the count floor only filters
 * degenerate runs). A ladder fold rewrites the wire from its first consumed
 * summary onward (bili #1249), so the mass gates keep it rare.
 *
 * Side-model folds are additionally throttled by trimMaxFoldsPerHour and a
 * hard minimum interval between folds; emergency folds have their own
 * cooldown so a stuck-at-95% session folds at most once per window; ladder
 * folds observe a longer interval (LADDER_MIN_INTERVAL_MS) after ANY fold.
 * Everything is derived from measured inputs — no clock, no host access —
 * which keeps the decision unit-testable (golden thresholds).
 */

import { estimateTokensOf, refPositions, segmentBounds } from "./view.js";

/** Hard minimum wall-clock interval between side-model folds. */
export const FOLD_MIN_INTERVAL_MS = 60_000;

/** Minimum interval between emergency (mechanical) folds. */
export const EMERGENCY_COOLDOWN_MS = 90_000;

/** Minimum wall-clock interval between ladder (T2/T3 distillation) folds,
 * measured from ANY fold: every fold rebuilds the serialized view, and
 * interleaving a distillation between raw folds would churn the tail twice
 * per minute for marginal reclaim. */
export const LADDER_MIN_INTERVAL_MS = 120_000;

/** The foldable span of a captured messages array for one ledger: from the
 * first segment boundary strictly after the frontier AND after the task
 * intent (the first user message — bili's protected zone: the session's
 * opening task statement is never folded) to the last segment end that
 * still clears the protected tail. Returns { startIdx, endIdx } or null
 * when nothing is foldable (empty history, everything folded, or
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
	// A leading system message is the frozen head of the wire array: a fold
	// anchored on it would put a surface replace op (and a view splice) over
	// the system prompt, which the host rejects outright
	// (assertSystemHeadRewrite — node 0 may be rewritten only by a
	// system/message over exactly that node). Covers both the frontier-null
	// first fold and any frontier-set fold that lands on the head.
	if (messages[0]?.role === "system") startFrom = Math.max(startFrom, 1);
	// Task-intent protection: the first user message states the task; the
	// segment containing it is never folded (its summary would become the
	// only carrier of the task for the rest of the session — the dominant
	// early-drift failure this guard prevents).
	const firstUserIdx = messages.findIndex((message) => message?.role === "user");
	if (firstUserIdx >= 0) {
		for (const [start, end] of segmentBounds(messages)) {
			if (start <= firstUserIdx && firstUserIdx <= end) {
				startFrom = Math.max(startFrom, end + 1);
				break;
			}
		}
	}
	let best = null;
	for (const [start, end] of segmentBounds(messages)) {
		if (start < startFrom) continue; // behind the frontier / intent
		if (end >= tailStart) break; // segment would cut into the protected tail
		if (best === null) best = { startIdx: start, endIdx: end };
		else best.endIdx = end; // extend the contiguous span
	}
	return best;
}

/** The best ladder RUN for one tier from precomputed runs
 * (index.js: ladderRunsOf — maximal ledger-consecutive runs of active
 * same-tier blocks with their summary mass). Picks the run with the
 * largest mass among those meeting the count floor; null when none does. */
function bestLadderRun(runs, minBlocks) {
	let best = null;
	for (const run of Array.isArray(runs) ? runs : []) {
		if (!Number.isFinite(run?.mass) || !Array.isArray(run?.consumes) || run.consumes.length === 0) continue;
		if (run.consumes.length < minBlocks) continue;
		if (best === null || run.mass > best.mass) best = run;
	}
	return best;
}

/** Evaluate the trigger. input: {
 *   foldable: { startIdx, endIdx } | null,  // computeFoldableRange result
 *   messages,        // captured raw messages (increment measurement)
 *   viewTokens,      // outbound-view token estimate of the current history
 *   windowTokens,    // context window size, or null when unknown
 *   thresholds: { growthTokens, incrementTokens, pressurePercent, emergencyPercent, maxFoldsPerHour,
 *                 ladderT2Tokens, ladderT2MinBlocks, ladderT3Tokens, ladderT3MinBlocks },
 *   now, lastFoldAt, foldsThisHour, lastEmergencyAt,
 *   ledger,          // the session ledger (growth anchor fields)
 *   ladderRuns: { t2: [{ consumes, mass, count }], t3: [...] },  // census runs
 * }.
 * Returns { action: "none"|"fold"|"emergency", kind: "raw"|"ladder", tier,
 * reason, startIdx, endIdx, incrementTokens, consumes? }. */
export function evaluateTrigger(input) {
	const none = { action: "none", kind: "raw", tier: null, reason: "", startIdx: -1, endIdx: -1, incrementTokens: 0, consumes: null };
	const thresholds = input?.thresholds ?? {};
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	const foldable = input?.foldable ?? null;
	const incrementTokens = foldable === null ? 0 : estimateTokensOf(input?.messages ?? [], foldable.startIdx, foldable.endIdx);

	// Side-model folds (pressure + growth + ladder) share the cadence gates.
	const lastFoldAt = Number.isFinite(input?.lastFoldAt) ? input.lastFoldAt : 0;
	const hourly = Array.isArray(input?.foldsThisHour) ? input.foldsThisHour.filter((ts) => now - ts < 3_600_000).length : 0;
	const maxFoldsPerHour = Number.isInteger(thresholds.maxFoldsPerHour) && thresholds.maxFoldsPerHour > 0 ? thresholds.maxFoldsPerHour : 6;
	const hourlyBlocked = hourly >= maxFoldsPerHour;

	if (foldable !== null && incrementTokens >= 1) {
		const { startIdx, endIdx } = foldable;
		// Tier c — emergency: window pressure, mechanical, cooldown-gated.
		const windowTokens = Number.isFinite(input?.windowTokens) && input.windowTokens > 0 ? input.windowTokens : null;
		const emergencyPercent = Number.isFinite(thresholds.emergencyPercent) && thresholds.emergencyPercent > 0 ? thresholds.emergencyPercent : 95;
		if (windowTokens !== null) {
			const usagePct = (input.viewTokens / windowTokens) * 100;
			if (usagePct >= emergencyPercent) {
				const lastEmergencyAt = Number.isFinite(input?.lastEmergencyAt) ? input.lastEmergencyAt : 0;
				if (now - lastEmergencyAt < EMERGENCY_COOLDOWN_MS) {
					// [2026-11-07]-[fix ladder starvation under sustained emergency
					// pressure]-[when usage stays above the emergency line the 90 s
					// cooldown returned "none" every boundary and the lower-priority
					// ladder never ran — the summary population grew unbounded,
					// defeating T2/T3's aging goal. During cooldown a READY ladder
					// is the only side-model path that can relieve pressure, so it
					// cuts in here; every other case keeps the exact
					// "emergency-cooldown" row. Inlined on purpose: the main ladder
					// section below keeps its original position and semantics.]
					const runs = input?.ladderRuns ?? {};
					const t3R = bestLadderRun(runs.t3, Number.isInteger(thresholds.ladderT3MinBlocks) && thresholds.ladderT3MinBlocks > 0 ? thresholds.ladderT3MinBlocks : 2);
					const t2R = bestLadderRun(runs.t2, Number.isInteger(thresholds.ladderT2MinBlocks) && thresholds.ladderT2MinBlocks > 0 ? thresholds.ladderT2MinBlocks : 3);
					const t3M = Number.isFinite(thresholds.ladderT3Tokens) && thresholds.ladderT3Tokens > 0 ? thresholds.ladderT3Tokens : 6_000;
					const t2M = Number.isFinite(thresholds.ladderT2Tokens) && thresholds.ladderT2Tokens > 0 ? thresholds.ladderT2Tokens : 8_000;
					const pick = t3R !== null && t3R.mass >= t3M && (t2R === null || t2R.mass < t2M || t3R.mass >= t2R.mass) ? t3R
						: (t2R !== null && t2R.mass >= t2M ? t2R : null);
					// The 120 s LADDER_MIN_INTERVAL_MS is NOT applied here on
					// purpose: the emergency fold that opened this cooldown just
					// advanced lastFoldAt, so the interval (120 s) always exceeds
					// the remaining cooldown (90 s) and the cut-in could never
					// fire — a structural starvation loop (observed live). Inside
					// the cooldown the hourly cap is the only cadence gate; the
					// cooldown itself is the spacing.
					if (pick !== null && !hourlyBlocked) {
						return {
							action: "fold",
							kind: "ladder",
							tier: pick === t3R ? "ladder-3" : "ladder-2",
							reason: `ladder mass ~${Math.round(pick.mass)} blocks=${pick.consumes.length} (emergency-cooldown cut-in)`,
							startIdx: -1,
							endIdx: -1,
							incrementTokens: 0,
							consumes: pick.consumes.slice(),
						};
					}
					return { ...none, reason: "emergency-cooldown" };
				}
				return { action: "emergency", kind: "raw", tier: "emergency", reason: `usage ${usagePct.toFixed(1)}% >= ${emergencyPercent}%`, startIdx, endIdx, incrementTokens, consumes: null };
			}
		}
		if (!hourlyBlocked && now - lastFoldAt >= FOLD_MIN_INTERVAL_MS) {
			// Tier b — pressure: soft window threshold, side-model.
			const pressurePercent = Number.isFinite(thresholds.pressurePercent) && thresholds.pressurePercent > 0 ? thresholds.pressurePercent : 60;
			if (windowTokens !== null) {
				const usagePct = (input.viewTokens / windowTokens) * 100;
				if (usagePct >= pressurePercent) {
					return { action: "fold", kind: "raw", tier: "pressure", reason: `usage ${usagePct.toFixed(1)}% >= ${pressurePercent}%`, startIdx, endIdx, incrementTokens, consumes: null };
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
				return { action: "fold", kind: "raw", tier: "growth", reason: `growth ~${Math.round(growth)} > ${growthTokens} and increment ~${incrementTokens} >= ${incrementGate}`, startIdx, endIdx, incrementTokens, consumes: null };
			}
		}
	}

	// Ladder maintenance tiers (T3 before T2 — the deeper distillation is
	// the larger reclaim when both are ready). Mass gates carry bili #198's
	// minimum-benefit idea: a sub-threshold distill never fires, so the
	// trigger cannot enter a zero-yield reset loop.
	const ladderRuns = input?.ladderRuns ?? {};
	const t3Blocks = Number.isInteger(thresholds.ladderT3MinBlocks) && thresholds.ladderT3MinBlocks > 0 ? thresholds.ladderT3MinBlocks : 2;
	const t3MassGate = Number.isFinite(thresholds.ladderT3Tokens) && thresholds.ladderT3Tokens > 0 ? thresholds.ladderT3Tokens : 6_000;
	const t2Blocks = Number.isInteger(thresholds.ladderT2MinBlocks) && thresholds.ladderT2MinBlocks > 0 ? thresholds.ladderT2MinBlocks : 3;
	const t2MassGate = Number.isFinite(thresholds.ladderT2Tokens) && thresholds.ladderT2Tokens > 0 ? thresholds.ladderT2Tokens : 8_000;
	const t3Run = bestLadderRun(ladderRuns.t3, t3Blocks);
	const t2Run = bestLadderRun(ladderRuns.t2, t2Blocks);
	if (t3Run !== null || t2Run !== null) {
		if (now - lastFoldAt < LADDER_MIN_INTERVAL_MS) return { ...none, reason: "ladder-min-interval" };
		if (hourlyBlocked) return { ...none, reason: "hourly-cap" };
		const run = t3Run !== null && (t2Run === null || t3Run.mass >= t2Run.mass) ? t3Run : t2Run;
		const tier = t3Run !== null && (t2Run === null || t3Run.mass >= t2Run.mass) ? "ladder-3" : "ladder-2";
		const gate = tier === "ladder-3" ? t3MassGate : t2MassGate;
		// The run passed its count floor; the mass gate decides readiness.
		if (run.mass < gate) return { ...none, reason: "below-thresholds" };
		return {
			action: "fold",
			kind: "ladder",
			tier,
			reason: `ladder mass ~${Math.round(run.mass)} >= ${gate} blocks=${run.consumes.length}`,
			startIdx: -1,
			endIdx: -1,
			incrementTokens: 0,
			consumes: run.consumes.slice(),
		};
	}

	if (foldable === null) return { ...none, reason: "nothing-foldable" };
	if (incrementTokens < 1) return { ...none, reason: "empty-increment" };
	if (hourlyBlocked) return { ...none, reason: "hourly-cap" };
	return { ...none, reason: "below-thresholds" };
}
