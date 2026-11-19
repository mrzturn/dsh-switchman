/** Dynamic watermark estimator (refactor guide 2026-11-19 §4.3, P0 item 3).
 *
 *  Pure math, no I/O. Two signals, growth-rate extrapolation (primary) and an
 *  incremental stay/switch cost comparison (secondary):
 *
 *  - growth: g ≈ net context growth per turn over the last k sampled turns.
 *    When `used + g × N_expected` projects past the hard/force threshold, the
 *    caller advances into that intervention tier EARLY. Growth never advances
 *    into soft — soft tightening is the cost signal's job alone.
 *  - cost: compare staying for N more turns against handing over now. Both
 *    sides keep paying cached-hit input + per-turn output after the switch, so
 *    the comparison is INCREMENTAL: only the one-time handoff cost (compressed
 *    context re-read at miss price + summary output) is extra. Under the
 *    guide's 1:50 cache price ratio the symmetric streams make staying
 *    structurally cheaper, so the stay side carries the guide §4.3 ② term:
 *    the EXPECTED full-prefix miss repay after an idle gap crosses the cache
 *    TTL, with the miss probability estimated from the recent turn cadence
 *    (share of gaps ≥ TTL/2). Even so the verdict stays rare by construction
 *    and ONLY ever advances into soft (early read-budget tightening) — it
 *    never replaces the fixed force tier.
 *
 *  KNOWN LIMITATION: samples arrive per agent-loop step (each model call),
 *  not per conversational turn; turnsToThreshold counts steps while
 *  turnsExpected defaults to turns (3), so the dynamic lead-in
 *  under-triggers in tool-loop-heavy sessions — conservative direction,
 *  documented as a known limitation.
 *  The caller combines the result with the fixed ladder via maxTier, so a
 *  dynamic verdict can only ADVANCE the intervention tier — it can never
 *  delay or weaken the fixed soft/hard/force thresholds (guide §4.3: "动态
 *  触发只能提前、不能延后于固定 force").
 */

// Internal model constants. The guide requires PRICE/WINDOW parameters to be
// config-injected (see host/config.js wm*Dynamic keys); these remaining
// constants shape the cost model and are deliberately not user-facing.
const OUTPUT_TOKENS_PER_TURN = 600; // blended per-turn model output estimate
const SUMMARY_OUTPUT_TOKENS = 1500; // handover document/summary output cost
const COMPRESS_RATIO = 0.5; // post-handoff waterline ≈ current × ratio
const MIN_GROWTH_SAMPLES = 2; // fewer samples → growth signal unavailable
const CACHE_TTL_MS = 300_000; // provider cache window (~5 min)
const TURNS_EXPECTED_FLOOR = 5;
const TURNS_EXPECTED_CEIL = 100;
const DEFAULT_TURNS_EXPECTED = 25; // fallback when cadence is unknowable
export const DEFAULT_AMORTIZATION = 1.75; // conservative pad (guide: 1.5–2)

const TIER_ORDER = ["ok", "soft", "hard", "force"];

/** Severity order: ok < soft < hard < force. Unknown values count as "ok". */
export function maxTier(a, b) {
	const ai = TIER_ORDER.indexOf(a);
	const bi = TIER_ORDER.indexOf(b);
	return TIER_ORDER[Math.max(Number.isFinite(ai) ? ai : 0, Number.isFinite(bi) ? bi : 0)];
}

/** Net token growth per turn over the last `lookback` sampled turns.
 *  samples: [{ t: epochMs, tokens }] in any order; sorted internally.
 *  Negative net growth (folds outpacing new material) floors at 0 for
 *  extrapolation — a shrinking session never projects earlier tiers.
 *  Returns { growthRate: number|null, samplesUsed: n }; growthRate is null
 *  with fewer than MIN_GROWTH_SAMPLES usable samples. */
export function estimateGrowthRate(samples, lookback = 6) {
	try {
		if (!Array.isArray(samples)) return { growthRate: null, samplesUsed: 0 };
		const points = samples
			.filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.tokens))
			.sort((a, b) => a.t - b.t)
			.slice(-(Math.max(1, Math.floor(lookback)) + 1));
		if (points.length < MIN_GROWTH_SAMPLES) return { growthRate: null, samplesUsed: points.length };
		const first = points[0];
		const last = points[points.length - 1];
		const span = points.length - 1;
		const raw = (last.tokens - first.tokens) / span;
		return { growthRate: Math.max(0, raw), samplesUsed: points.length };
	} catch {
		return { growthRate: null, samplesUsed: 0 };
	}
}

/** Expected remaining turns for the cost horizon. An explicit configured
 *  value (> 0) always wins. Otherwise estimate from the recent turn cadence:
 *  roughly how many more turns could still land inside one cache window at
 *  the current pace (ceil(TTL / median interval)), clamped to
 *  [TURNS_EXPECTED_FLOOR, TURNS_EXPECTED_CEIL]. No usable cadence →
 *  DEFAULT_TURNS_EXPECTED. */
export function estimateTurnsExpected(samples, configured = 0) {
	const cfg = Number(configured);
	if (Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg);
	try {
		if (!Array.isArray(samples)) return DEFAULT_TURNS_EXPECTED;
		const points = samples.filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
		if (points.length < MIN_GROWTH_SAMPLES) return DEFAULT_TURNS_EXPECTED;
		const gaps = [];
		for (let i = 1; i < points.length; i++) {
			const gap = points[i].t - points[i - 1].t;
			if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
		}
		if (gaps.length === 0) return DEFAULT_TURNS_EXPECTED;
		gaps.sort((a, b) => a - b);
		const median = gaps[Math.floor(gaps.length / 2)];
		const est = Math.ceil(CACHE_TTL_MS / median);
		return Math.min(TURNS_EXPECTED_CEIL, Math.max(TURNS_EXPECTED_FLOOR, est));
	} catch {
		return DEFAULT_TURNS_EXPECTED;
	}
}

/** Probability that an idle gap inside the horizon crosses the provider
 *  cache TTL (full-prefix miss on the stay side): the share of recent turn
 *  gaps ≥ TTL/2, clamped to [0,1]. Fewer than two usable samples → 0
 *  (fail-closed: an advisory-only signal stays silent without cadence). */
export function estimateMissProbability(samples, ttlMs = CACHE_TTL_MS) {
	try {
		if (!Array.isArray(samples)) return 0;
		const points = samples.filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
		if (points.length < MIN_GROWTH_SAMPLES) return 0;
		let gaps = 0;
		let cold = 0;
		for (let i = 1; i < points.length; i++) {
			const gap = points[i].t - points[i - 1].t;
			if (!Number.isFinite(gap) || gap <= 0) continue;
			gaps++;
			if (gap >= ttlMs / 2) cold++;
		}
		if (gaps === 0) return 0;
		return Math.min(1, cold / gaps);
	} catch {
		return 0;
	}
}

/** Incremental cost of staying: N turns of cached-hit input over a growing
 *  waterline plus N turns of output. Prices are per-token. */
export function costStay({ used, growthRate = 0, turns, hitPrice, outputCostPerTurn }) {
	let input = 0;
	for (let i = 0; i < turns; i++) input += (used + i * growthRate) * hitPrice;
	return input + turns * outputCostPerTurn;
}

/** Incremental cost of switching now: the one-time handoff cost (compressed
 *  context re-read at MISS price + summary output at the per-token output
 *  price) plus the same per-turn stream computed over the compressed
 *  waterline. */
export function costSwitch({ used, growthRate = 0, turns, hitPrice, outputCostPerTurn, missPrice, outPrice, compressRatio = COMPRESS_RATIO }) {
	const compressed = Math.round(used * compressRatio);
	const handoff = compressed * missPrice + SUMMARY_OUTPUT_TOKENS * (outPrice ?? outputCostPerTurn / OUTPUT_TOKENS_PER_TURN);
	let input = 0;
	for (let i = 0; i < turns; i++) input += (compressed + i * growthRate) * hitPrice;
	return { total: handoff + input + turns * outputCostPerTurn, handoff, compressed };
}

/** Turn at which the extrapolated waterline reaches `threshold`; null when
 *  the projection never gets there (no/zero growth). */
export function turnsToThreshold(used, growthRate, threshold) {
	if (!Number.isFinite(growthRate) || growthRate <= 0) return null;
	if (used >= threshold) return 0;
	return Math.ceil((threshold - used) / growthRate);
}

/** Evaluate both signals against the current session state.
 *  samples: per-turn [{ t, tokens }] series (see estimateGrowthRate);
 *  used: current measured tokens; thresholds: { soft, hard, force };
 *  dynamic: resolved config { lookback, turnsExpected, amortization,
 *  hitPerM, missPerM, outPerM } (prices per million tokens).
 *  Returns { advance: "none"|"soft"|"hard"|"force", reason, growthRate,
 *  turnsExpected, samplesUsed, turnsTo: { hard, force }, cost } — cost is
 *  null when the signal is unavailable or was evaluated but not positive. */
export function evaluateDynamicWatermark({ samples, used, thresholds, dynamic }) {
	const out = {
		advance: "none",
		reason: null,
		growthRate: null,
		turnsExpected: null,
		samplesUsed: 0,
		turnsTo: { hard: null, force: null },
		cost: null,
	};
	try {
		if (!Number.isFinite(used) || !thresholds || !dynamic) return out;
		const cfg = dynamic;
		const { growthRate, samplesUsed } = estimateGrowthRate(samples, cfg.lookback);
		out.growthRate = growthRate;
		out.samplesUsed = samplesUsed;
		const nExpected = estimateTurnsExpected(samples, cfg.turnsExpected);
		out.turnsExpected = nExpected;

		// Primary: growth extrapolation. Advance into hard/force early when the
		// projection reaches the tier within the expected horizon.
		if (growthRate !== null && growthRate > 0) {
			out.turnsTo.hard = turnsToThreshold(used, growthRate, thresholds.hard);
			out.turnsTo.force = turnsToThreshold(used, growthRate, thresholds.force);
			if (out.turnsTo.force !== null && out.turnsTo.force <= nExpected) {
				out.advance = "force";
				out.reason = "dynamic_growth";
			} else if (out.turnsTo.hard !== null && out.turnsTo.hard <= nExpected) {
				out.advance = "hard";
				out.reason = "dynamic_growth";
			}
		}

		// Secondary: incremental stay/switch cost comparison with the stay-side
		// expected TTL-miss repay (guide §4.3 ②). Positive verdicts only ever
		// advance into soft (early read-budget tightening).
		const hitPrice = (Number(cfg.hitPerM) || 0) / 1e6;
		const missPrice = (Number(cfg.missPerM) || 0) / 1e6;
		const outPrice = (Number(cfg.outPerM) || 0) / 1e6;
		const outputCostPerTurn = OUTPUT_TOKENS_PER_TURN * outPrice;
		const growth = growthRate ?? 0;
		const amortization = Number(cfg.amortization) > 1 ? Number(cfg.amortization) : DEFAULT_AMORTIZATION;
		const missProbability = estimateMissProbability(samples);
		const stay =
			costStay({ used, growthRate: growth, turns: nExpected, hitPrice, outputCostPerTurn }) +
			missProbability * used * missPrice;
		const sw = costSwitch({ used, growthRate: growth, turns: nExpected, hitPrice, outputCostPerTurn, missPrice, outPrice });
		if (Number.isFinite(stay) && Number.isFinite(sw.total) && stay > sw.total * amortization) {
			out.cost = { stay, switch: sw.total, handoff: sw.handoff, compressed: sw.compressed, turns: nExpected, missProbability };
			if (TIER_ORDER.indexOf(out.advance) < TIER_ORDER.indexOf("soft")) {
				out.advance = "soft";
				out.reason = "dynamic_cost";
			}
		}
		return out;
	} catch {
		return out;
	}
}
