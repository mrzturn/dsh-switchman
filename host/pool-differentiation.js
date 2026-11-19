/** dsh-switchman pool-differentiation layer (refactor guide §5 P2 ②,
 *  "分池/分 skill 的切换置信度与思考强度差异化"; mechanisms §4.3 + §4.5).
 *
 *  Consumes the pack-B0 dispatch telemetry (host/dispatch-stats.js,
 *  getDispatchStats()) and turns per-pool × skill outcomes into TWO advisory
 *  differentiation hints rendered beside the pools table:
 *
 *  - switch confidence (guide §4.3): the stay/switch cost comparison carries
 *    an amortization factor as a pad against estimation error. A lane whose
 *    recent dispatch outcomes are unhealthy (rework / failure / empty
 *    results) makes the post-handoff continuation LESS predictable — the
 *    session will keep re-dispatching into the same lane after a switch — so
 *    the confidence in an early switch verdict drops ("low"); a healthy lane
 *    reads "high". This is ADVICE ONLY: the plugin holds no routing or
 *    watermark authority, so the numeric amortization path
 *    (wmDynamicAmortization → watermark-estimate.js) stays untouched and
 *    every hint lands in the model-visible text layer (the guide's own P1
 *    precedent: "自动降级默认关闭，仅输出建议").
 *  - thinking-effort differentiation (guide §4.3 ② "高 reasoning 档的输出
 *    成本按档位系数计入输出项"): a lane (or a specific skill inside a lane)
 *    whose outcomes are bad suggests RAISING the effort tier for future
 *    dispatches there; a healthy lane reads "steady". The static user pins
 *    (pool*Efforts) are never modified — the hint overlays them.
 *
 *  MODEL-VISIBILITY (same policy as pool-feedback.js / constraints.js): the
 *  injected block carries NO counts, NO rates, NO latencies, NO numeric
 *  watermark values — only direction labels (`raise` / `steady`,
 *  `high` / `low`) and cause labels (`failure-heavy` / `rework-heavy` /
 *  `empty-heavy`). Exact counters stay host-side (log line only).
 *
 *  Sample floor (guide §4.5 "最小样本量不足时不调整", same reasoning as
 *  watermark-estimate.js CACHE_P90_MIN_SAMPLES): a lane with fewer than
 *  MIN_LANE_SAMPLES dispatches has no real statistical basis — one bad run
 *  would decide the whole row — so below the floor the lane is OMITTED from
 *  the block entirely (= keep the global defaults). With no qualifying lane
 *  and no qualifying skill the section renders "" = zero prompt diff.
 *
 *  OFF by default (`poolDifferentiationEnabled`): the master switch is
 *  checked BEFORE any stats read, so OFF is zero computation, zero reads,
 *  zero bytes on every assembly. The DATA requires dispatchStatsEnabled
 *  (pack-B0 capture is gated behind it), so an on/off mismatch simply
 *  renders "" — no error, no partial block.
 *
 *  Fail-open everywhere: junk shapes, missing stats, or any throw inside
 *  the render render "" — the session keeps its prompt and only loses the
 *  hint lines. Zero new dependencies; ESM; same conventions as the other
 *  host/*.js layers.
 */

import { LANES } from "./config.js";
import { getDispatchStats } from "./dispatch-stats.js";

/** Final position of the differentiation section: right after the
 *  pool-feedback rows (10406) — both are footnotes of the pools table
 *  (10400) and the differentiation hints qualify the same lanes the
 *  feedback rows name. Free slot: 10200 (lang head), 10250 (teams), 10300
 *  (lang), 10400 (dispatch), 10405 (constraints), 10406 (pool-feedback),
 *  10450 (context-trim), 10510 (ptc-guard) are taken; a LATER order keeps
 *  every existing section the "last word" on its own topic. */
export const POOL_DIFFERENTIATION_ORDER = 10407;

/** Minimum settled dispatches per lane before its outcomes carry any
 *  statistical basis (guide §4.5 sample floor; mirrors the ≥5-sample
 *  convention of estimateCacheWindow). Below it the lane is omitted =
 *  global defaults apply. */
export const MIN_LANE_SAMPLES = 5;

/** Bad-outcome thresholds per lane summary (share of the lane's settled
 *  dispatches). Deliberately module constants, NOT user config: they shape
 *  an advisory text label, not a cost model or a behavior change — config
 *  surface would imply authority the layer does not have. Failure threshold
 *  is the strictest (a hard stop is the least ambiguous signal); empty
 *  results are the noisiest (healthy settlements legitimately omit closing
 *  text, see dispatch-stats.js), so they need the largest share to matter. */
export const FAILURE_RATE_BAD = 0.2;
export const REWORK_RATE_BAD = 0.3;
export const EMPTY_RATE_BAD = 0.3;

/** Cause labels in their fixed output order (byte-stable rows regardless of
 *  map iteration). */
const REASONS_ORDER = ["failure-heavy", "rework-heavy", "empty-heavy"];

/** The header line: one legend stating the label semantics. No digits, no
 *  thresholds — the numeric definitions stay host-side. */
const DIFF_HEADER =
	"[SWITCHMAN:POOLS-DIFF] lane differentiation hints from recent dispatch outcomes (direction labels only; lanes below the sample floor keep the global defaults):";

/** Aggregate one bounded stats entry list per lane: total settled dispatches,
 *  failures, rework repeats, empty results. Lanes outside LANES (the
 *  best-effort buckets "unattributed" / "unknown") are not actionable
 *  advice targets and stay out. Junk shapes contribute nothing. */
export function laneSummaries(entries) {
	const perLane = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const pool = entry?.pool;
		const dispatches = Number(entry?.dispatches);
		if (!LANES.includes(pool) || !Number.isFinite(dispatches) || dispatches <= 0) continue;
		let lane = perLane.get(pool);
		if (lane === undefined) {
			lane = { pool, total: 0, failures: 0, rework: 0, emptyResults: 0 };
			perLane.set(pool, lane);
		}
		lane.total += dispatches;
		const failures = Number(entry?.failures);
		const rework = Number(entry?.rework);
		const empty = Number(entry?.emptyResults);
		if (Number.isFinite(failures)) lane.failures += failures;
		if (Number.isFinite(rework)) lane.rework += rework;
		if (Number.isFinite(empty)) lane.emptyResults += empty;
	}
	return perLane;
}

/** Aggregate per (lane, skill) — the guide's per-skill differentiation
 *  dimension. "none" (a run that loaded no skill) is not a skill. */
export function skillSummaries(entries) {
	const perSkill = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const pool = entry?.pool;
		const skill = entry?.skill;
		const dispatches = Number(entry?.dispatches);
		if (!LANES.includes(pool) || typeof skill !== "string" || skill === "" || skill === "none") continue;
		if (!Number.isFinite(dispatches) || dispatches <= 0) continue;
		const key = `${pool}\0${skill}`;
		let record = perSkill.get(key);
		if (record === undefined) {
			record = { pool, skill, total: 0, failures: 0, rework: 0, emptyResults: 0 };
			perSkill.set(key, record);
		}
		record.total += dispatches;
		const failures = Number(entry?.failures);
		const rework = Number(entry?.rework);
		const empty = Number(entry?.emptyResults);
		if (Number.isFinite(failures)) record.failures += failures;
		if (Number.isFinite(rework)) record.rework += rework;
		if (Number.isFinite(empty)) record.emptyResults += empty;
	}
	return perSkill;
}

/** Cause labels whose share crosses its bad threshold; [] when the summary
 *  is healthy (or degenerate — total > 0 is guaranteed by the aggregators).
 *  Push order IS the fixed output order (REASONS_ORDER). */
function badReasonsOf(summary) {
	const total = summary.total;
	const reasons = [];
	if (Number.isFinite(total) && total > 0) {
		if (summary.failures / total >= FAILURE_RATE_BAD) reasons.push("failure-heavy");
		if (summary.rework / total >= REWORK_RATE_BAD) reasons.push("rework-heavy");
		if (summary.emptyResults / total >= EMPTY_RATE_BAD) reasons.push("empty-heavy");
	}
	return reasons;
}

/** Differentiation verdict for ONE lane: null below the sample floor (keep
 *  global defaults); otherwise effort direction + switch confidence. */
export function laneVerdictOf(summary) {
	if (!summary || !Number.isFinite(summary.total) || summary.total < MIN_LANE_SAMPLES) return null;
	const reasons = badReasonsOf(summary);
	return {
		pool: summary.pool,
		// Bad outcomes → raise the thinking tier there; healthy → keep as is.
		effort: reasons.length > 0 ? "raise" : "steady",
		// Unhealthy continuation → early-switch verdicts less trustworthy.
		confidence: reasons.length > 0 ? "low" : "high",
		reasons,
	};
}

/** The `[SWITCHMAN:POOLS-DIFF]` block, or "" when nothing qualifies.
 *  Byte-stable for a given observation state: lanes in LANES order, skill
 *  rows name-sorted. MODEL-VISIBILITY: labels only, never counts. */
export function renderPoolDifferentiationBlock(entries) {
	try {
		const rows = [];
		const perLane = laneSummaries(entries);
		for (const lane of LANES) {
			const summary = perLane.get(lane);
			if (summary === undefined) continue;
			const verdict = laneVerdictOf(summary);
			if (verdict === null) continue;
			const cause = verdict.reasons.length > 0 ? ` (${verdict.reasons.join(", ")})` : "";
			rows.push(`- ${verdict.pool}: effort ${verdict.effort}${cause}, switch-confidence ${verdict.confidence}`);
		}
		// Per-skill rows: only the bad (pool, skill) combinations — a healthy
		// skill adds no signal beyond its lane row. Same sample floor.
		const skillHints = [];
		for (const [, summary] of skillSummaries(entries)) {
			const verdict = laneVerdictOf(summary);
			if (verdict === null || verdict.reasons.length === 0) continue;
			const cause = verdict.reasons.join("+");
			// Gate the free-form skill name: it originates in child tool-call
			// arguments (arbitrary strings), while the block promises digit-free,
			// single-line rows. Anything outside the strict skill-name shape —
			// digits, control characters, overlong names — is skipped entirely.
			if (!/^[a-z][a-z-]{0,63}$/.test(summary.skill)) continue;
			skillHints.push({ skill: summary.skill, pool: summary.pool, cause });
		}
		if (skillHints.length > 0) {
			skillHints.sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0));
			rows.push(`- skills: ${skillHints.map((hint) => `${hint.skill} raise on ${hint.pool} (${hint.cause})`).join(", ")}`);
		}
		if (rows.length === 0) return "";
		return [DIFF_HEADER, ...rows].join("\n");
	} catch {
		return "";
	}
}

/** Host-side audit log: one line whenever the rendered hint signature
 *  changes (counts allowed — logs never reach the model). Module-level
 *  single string: the stats are plugin-global, so one last-signature slot
 *  is enough and stays bounded. */
let lastDiffSignature = "";
function logDiffChange(ctx, block, entries) {
	try {
		const signature = block.split("\n").slice(1).join("|");
		if (signature === lastDiffSignature) return;
		lastDiffSignature = signature;
		// Enrich each lane label with the exact settled counts of that lane.
		const perLane = laneSummaries(entries);
		const detail = [...perLane.values()]
			.map((lane) => `${lane.pool} total=${lane.total} fail=${lane.failures} rework=${lane.rework} empty=${lane.emptyResults}`)
			.join("; ");
		ctx.logger?.info?.(`dsh-switchman: pool differentiation updated: ${detail || "(no qualifying lane)"}`);
	} catch {
		/* fail open */
	}
}

/** Mount the pool-differentiation layer: one systemPrompt section. Records
 *  no state of its own (the stats live in dispatch-stats.js). `statsProvider`
 *  defaults to the real getDispatchStats(); tests inject a plain closure the
 *  same way pool-feedback.js accepts an annotated-skills array. Registration
 *  is defensive like every other layer; a failure warns and disables the
 *  layer, never throws. */
export function applyPoolDifferentiation(ctx, config, statsProvider = getDispatchStats) {
	const warn = (message) => ctx?.logger?.warn?.(`dsh-switchman: ${message}`);
	try {
		ctx.systemPrompt.section({
			name: "switchman:pool-differentiation",
			order: POOL_DIFFERENTIATION_ORDER,
			interpolate: false,
			text: () => {
				try {
					// Master switch FIRST: off renders "" on every assembly AND
					// skips the stats read entirely (zero computation while OFF).
					if (config?.poolDifferentiationEnabled?.get() !== true) return "";
					const stats = statsProvider();
					const block = renderPoolDifferentiationBlock(stats?.entries);
					if (block !== "") logDiffChange(ctx, block, stats?.entries);
					return block;
				} catch {
					return "";
				}
			},
		});
	} catch (error) {
		warn(`systemPrompt.section registration failed — pool-differentiation hints disabled: ${error?.message ?? error}`);
	}
}

/** Clear the audit-log signature slot (tests; mirrors resetDispatchStats). */
export function resetPoolDifferentiationAudit() {
	try {
		lastDiffSignature = "";
	} catch {
		/* fail open */
	}
}
