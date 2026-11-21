// Pool-differentiation layer (refactor guide §5 P2 ②, "分池/分 skill 的切换
// 置信度与思考强度差异化"): function-level coverage — fake host sections, no
// live sessions. Pins the P2 acceptance behaviors: ON + sufficient samples →
// hints follow the data; insufficient samples → fall back to the global
// defaults (lane omitted); switch OFF → zero bytes on every assembly; the
// MODEL-VISIBILITY policy (direction labels only — NO digits anywhere in the
// block); the free order slot (no conflicts with the existing sections); and
// the advice-only boundary (data-only bytes change with the telemetry).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyPoolDifferentiation,
	laneSummaries,
	laneVerdictOf,
	renderPoolDifferentiationBlock,
	POOL_DIFFERENTIATION_ORDER,
	MIN_LANE_SAMPLES,
	resetPoolDifferentiationAudit,
} from "../../host/pool-differentiation.js";
import { LANES } from "../../host/config.js";

/** One settled stats record with defaults (dispatch-stats.js record shape). */
const entry = (pool, overrides = {}) => ({
	pool,
	model: "p/m",
	skill: "none",
	dispatches: 1,
	successes: 0,
	failures: 0,
	emptyResults: 0,
	rework: 0,
	latencySumMs: 0,
	latencyMaxMs: 0,
	lastAt: 0,
	...overrides,
});

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

test("laneSummaries: aggregates per lane, skips non-LANES buckets and junk", () => {
	const perLane = laneSummaries([
		entry("mechanical", { dispatches: 4, failures: 1 }),
		entry("mechanical", { dispatches: 6, failures: 2, rework: 3 }),
		entry("unattributed", { dispatches: 99, failures: 99 }), // best-effort bucket → out
		entry("unknown", { dispatches: 99 }), // no route at all → out
		entry("not-a-lane", { dispatches: 99 }), // junk lane → out
		null, // junk entry → out
		{ pool: "main" }, // missing dispatches → out
	]);
	assert.equal(perLane.size, 1);
	const lane = perLane.get("mechanical");
	assert.equal(lane.total, 10);
	assert.equal(lane.failures, 3);
	assert.equal(lane.rework, 3);
});

test("laneVerdictOf: below the sample floor returns null (= global defaults)", () => {
	// Exactly MIN_LANE_SAMPLES - 1 → no statistical basis, no verdict.
	const thin = { pool: "main", total: MIN_LANE_SAMPLES - 1, failures: MIN_LANE_SAMPLES - 1, rework: 0, emptyResults: 0 };
	assert.equal(laneVerdictOf(thin), null);
});

test("laneVerdictOf: sample-floor boundary — exactly 5 samples decide", () => {
	const allBad = { pool: "main", total: MIN_LANE_SAMPLES, failures: MIN_LANE_SAMPLES, rework: 0, emptyResults: 0 };
	const verdict = laneVerdictOf(allBad);
	assert.notEqual(verdict, null);
	assert.equal(verdict.effort, "raise");
	assert.equal(verdict.confidence, "low");
});

test("laneVerdictOf: threshold boundaries — shares at the line count as bad, below stay healthy", () => {
	// failure 1/5 = 0.2 ≥ FAILURE_RATE_BAD → bad; rework 1/5 < 0.3; empty 1/5 < 0.3.
	const atFailureLine = { pool: "hard", total: 5, failures: 1, rework: 0, emptyResults: 0 };
	assert.deepEqual(laneVerdictOf(atFailureLine).reasons, ["failure-heavy"]);
	// 1/6 failure ≈ 0.167 < 0.2 → healthy lane → steady/high.
	const belowLine = { pool: "hard", total: 6, failures: 1, rework: 1, emptyResults: 1 };
	const healthy = laneVerdictOf(belowLine);
	assert.equal(healthy.reasons.length, 0);
	assert.equal(healthy.effort, "steady");
	assert.equal(healthy.confidence, "high");
	// rework 2/6 ≈ 0.333 ≥ 0.3 → bad; empty 2/7 ≈ 0.286 < 0.3 stays out.
	const reworkLine = { pool: "vision", total: 6, failures: 0, rework: 2, emptyResults: 0 };
	assert.deepEqual(laneVerdictOf(reworkLine).reasons, ["rework-heavy"]);
	const emptyBelow = { pool: "review", total: 7, failures: 0, rework: 0, emptyResults: 2 };
	assert.deepEqual(laneVerdictOf(emptyBelow).reasons, []);
});

// ---------------------------------------------------------------------------
// Render: ON + data → hints; insufficient samples → omitted; MODEL-VISIBILITY
// ---------------------------------------------------------------------------

const MIXED_STATS = [
	// mechanical lane aggregate (all skill rows folded in): 17 dispatches,
	// 5 failures (≈ 0.29 ≥ 0.2 → failure-heavy), 7 reworks (≈ 0.41 ≥ 0.3 →
	// rework-heavy) → raise/low.
	entry("mechanical", { dispatches: 5, failures: 3 }),
	entry("mechanical", { dispatches: 6, failures: 1, rework: 4 }),
	// main: 8 clean dispatches → steady/high.
	...Array.from({ length: 8 }, () => entry("main", { dispatches: 1, successes: 1 })),
	// hard: 4 dispatches only — below the floor → omitted entirely.
	...Array.from({ length: 4 }, () => entry("hard", { dispatches: 1, successes: 1 })),
	// db-query @ mechanical: 6 dispatches, 50% rework → per-skill raise row.
	entry("mechanical", { dispatches: 6, rework: 3, skill: "db-query", successes: 3 }),
];

test("renderPoolDifferentiationBlock: ON + sufficient samples — hints follow the data", () => {
	const block = renderPoolDifferentiationBlock(MIXED_STATS);
	assert.equal(
		block,
		"[SWITCHMAN:POOLS-DIFF] lane differentiation hints from recent dispatch outcomes (direction labels only; lanes below the sample floor keep the global defaults):\n" +
			"- mechanical: effort raise (failure-heavy, rework-heavy), switch-confidence low\n" +
			"- main: effort steady, switch-confidence high\n" +
			"- skills: db-query raise on mechanical (rework-heavy)",
	);
});

test("renderPoolDifferentiationBlock: lanes below the sample floor are omitted (fallback)", () => {
	// ONLY a thin lane → no lane row, no block at all = global defaults apply.
	const thin = Array.from({ length: MIN_LANE_SAMPLES - 1 }, () => entry("economy", { dispatches: 1, failures: 1 }));
	assert.equal(renderPoolDifferentiationBlock(thin), "");
});

test("renderPoolDifferentiationBlock: a thin (pool, skill) pair gets no skill row", () => {
	// Lane healthy, but a thin skill pair with a bad share stays silent
	// (same sample floor per (pool, skill) combination).
	const stats = [
		...Array.from({ length: 6 }, () => entry("main", { dispatches: 1, successes: 1 })),
		entry("main", { dispatches: 2, failures: 2, skill: "thin-skill" }), // 2 < 5 → out
	];
	const block = renderPoolDifferentiationBlock(stats);
	assert.equal(block.split("\n").length, 2, "only the lane row renders");
	assert.doesNotMatch(block, /thin-skill/u);
});

test("renderPoolDifferentiationBlock: MODEL-VISIBILITY — no digits in the whole block", () => {
	const block = renderPoolDifferentiationBlock([
		...MIXED_STATS,
		entry("review", { dispatches: 99, failures: 50, rework: 40, emptyResults: 99 }), // extreme counts
	]);
	assert.ok(block.length > 0, "precondition: a non-empty block");
	assert.doesNotMatch(block, /[0-9]/u, `differentiation block must carry direction labels only, got: ${block}`);
	const rowGrammar =
		/^- (economy|mechanical|main|hard|vision|review): effort (raise|steady)( \((failure-heavy|rework-heavy|empty-heavy)(, (failure-heavy|rework-heavy|empty-heavy))*\))?, switch-confidence (low|high)$/u;
	for (const row of block.split("\n").slice(1)) {
		if (row.startsWith("- skills:")) continue; // grammar checked below
		assert.match(row, rowGrammar, `lane row violates the label grammar: ${row}`);
	}
	const skillGrammar = /- skills: [a-z0-9-]+ raise on (economy|mechanical|main|hard|vision|review) \((failure-heavy|rework-heavy|empty-heavy)(\+(failure-heavy|rework-heavy|empty-heavy))*\)$/u;
	for (const row of block.split("\n").slice(1)) {
		if (!row.startsWith("- skills:")) continue;
		assert.match(row, skillGrammar, `skills row violates the label grammar: ${row}`);
	}
});

test("renderPoolDifferentiationBlock: lane order follows LANES, skill rows name-sorted", () => {
	const stats = [
		...Array.from({ length: 6 }, () => entry("review", { dispatches: 1, failures: 1 })), // bad → row
		...Array.from({ length: 6 }, () => entry("economy", { dispatches: 1, successes: 1 })), // healthy → row
		entry("vision", { dispatches: 6, rework: 4, skill: "zeta" }),
		entry("vision", { dispatches: 6, rework: 4, skill: "alpha" }),
	];
	const rows = renderPoolDifferentiationBlock(stats).split("\n").slice(1);
	assert.deepEqual(
		rows.map((row) => row.split(":")[0]),
		["- economy", "- vision", "- review", "- skills"],
		"LANES order (economy < vision < review) then the aggregated skills row",
	);
	assert.match(rows[3], /^- skills: alpha raise on vision \(rework-heavy\), zeta raise on vision \(rework-heavy\)$/u, "skill hints sort by name");
});

test("renderPoolDifferentiationBlock: junk shapes render zero bytes", () => {
	assert.equal(renderPoolDifferentiationBlock(null), "");
	assert.equal(renderPoolDifferentiationBlock(undefined), "");
	assert.equal(renderPoolDifferentiationBlock("junk"), "");
	assert.equal(renderPoolDifferentiationBlock([null, 42, {}]), "");
	assert.equal(renderPoolDifferentiationBlock([]), "", "empty telemetry → global defaults");
});

// ---------------------------------------------------------------------------
// Section wiring: fake host, off-by-default, fail-open, data dependency
// ---------------------------------------------------------------------------

function fakeHost() {
	const sections = [];
	const contexts = [];
	const infos = [];
	const warnings = [];
	const ctx = {
		logger: {
			info: (message) => infos.push(message),
			warn: (message) => warnings.push(message),
		},
		systemPrompt: {
			section: (spec) => sections.push(spec),
			context: (spec) => contexts.push(spec),
		},
	};
	return { ctx, sections, contexts, infos, warnings };
}

const configWith = (poolDifferentiationEnabled) => ({
	poolDifferentiationEnabled: { get: () => poolDifferentiationEnabled },
});

test("applyPoolDifferentiation: registers head doctrine and tail context entry", () => {
	const { ctx, sections, contexts } = fakeHost();
	applyPoolDifferentiation(ctx, configWith(false), []);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "switchman:pool-differentiation");
	assert.equal(sections[0].order, POOL_DIFFERENTIATION_ORDER);
	assert.equal(sections[0].interpolate, false);
	// Order-conflict pin: the existing session-level orders are 10200 (lang
	// head), 10250 (teams), 10300 (lang), 10400 (dispatch), 10405
	// (constraints), 10406 (pool-feedback), 10450 (context-trim), 10510
	// (ptc-guard). 10407 is the free slot right after the pool-feedback rows.
	assert.equal(POOL_DIFFERENTIATION_ORDER, 10407);
	const taken = new Set([10200, 10250, 10300, 10400, 10405, 10406, 10450, 10510]);
	assert.equal(taken.has(POOL_DIFFERENTIATION_ORDER), false, "order must not collide with an existing section");
	// Tail payload entry: constraints-live is 320, dispatch-route takes 350.
	assert.equal(contexts.length, 1);
	assert.equal(contexts[0].name, "switchman:pool-differentiation-live");
	assert.equal(contexts[0].order, 340);
	assert.equal(contexts[0].required, true);
	assert.equal(contexts[0].interpolate, false);
});

test("applyPoolDifferentiation: switch OFF (default) renders zero bytes on every assembly", () => {
	const { ctx, sections, contexts } = fakeHost();
	applyPoolDifferentiation(ctx, configWith(false), []);
	const spec = sections[0];
	// The master switch is checked BEFORE any stats read, so OFF is zero
	// computation too — "" regardless of what the telemetry holds, on BOTH
	// channels (head doctrine gated by the same master switch).
	assert.equal(spec.text({}), "");
	assert.equal(spec.text(undefined), "");
	assert.equal(spec.text({ agent: { session: { header: { cwd: "/tmp/w" } } } }), "");
	assert.equal(contexts[0].text({}), "");
	assert.equal(contexts[0].text(undefined), "");
	assert.equal(contexts[0].text({ agent: { session: { header: { cwd: "/tmp/w" } } } }), "");
});

test("applyPoolDifferentiation: config without the field renders zero bytes (no throw)", () => {
	const { ctx, contexts } = fakeHost();
	applyPoolDifferentiation(ctx, {}, []);
	assert.equal(contexts[0].text({}), "");
});

test("applyPoolDifferentiation: ON renders hints from the live telemetry, empty telemetry stays empty", () => {
	const { ctx, sections, contexts } = fakeHost();
	// Empty telemetry (dispatchStatsEnabled off / nothing captured yet) → "".
	applyPoolDifferentiation(ctx, configWith(true), () => null);
	assert.equal(contexts[0].text({}), "");
	// §5 P2 acceptance shape: ON + sufficient samples → the injected bytes are
	// a FUNCTION of the recorded outcomes, byte-identical to the pure render.
	applyPoolDifferentiation(ctx, configWith(true), () => ({ entries: MIXED_STATS }));
	assert.equal(contexts[1].text({}), renderPoolDifferentiationBlock(MIXED_STATS));
	// Head anchor: static, identical across both registrations.
	assert.equal(sections[0].text({}), sections[1].text({}));
	assert.match(sections[1].text({}), /Current runtime context snapshot/u);
});

test("applyPoolDifferentiation: head anchor constant while the stats change (cache stability)", () => {
	resetPoolDifferentiationAudit();
	const { ctx, sections, contexts } = fakeHost();
	applyPoolDifferentiation(ctx, configWith(true), () => ({ entries: MIXED_STATS }));
	const anchor = sections[0].text({});
	assert.match(contexts[0].text({}), /- mechanical: effort raise/u);
	// Telemetry heals; the payload changes but the head never does.
	const healed = MIXED_STATS.map((item) => (item.pool === "mechanical" ? { ...item, failures: 0, rework: 0 } : item));
	applyPoolDifferentiation(ctx, configWith(true), () => ({ entries: healed }));
	assert.match(contexts[1].text({}), /- mechanical: effort steady, switch-confidence high/u);
	assert.equal(sections[1].text({}), anchor);
	resetPoolDifferentiationAudit();
});

test("applyPoolDifferentiation: hints track the recorded outcomes (data-only bytes)", () => {
	// The render path is a pure function of getDispatchStats(); simulate the
	// loop-close check at the render level: a lane's verdict flips exactly
	// when its recorded outcomes do.
	const before = renderPoolDifferentiationBlock(MIXED_STATS);
	assert.match(before, /- mechanical: effort raise/u);
	const healed = MIXED_STATS.map((item) => (item.pool === "mechanical" ? { ...item, failures: 0, rework: 0 } : item));
	const after = renderPoolDifferentiationBlock(healed);
	assert.match(after, /- mechanical: effort steady, switch-confidence high/u);
	assert.notEqual(before, after, "the block must change when the telemetry changes");
});

test("applyPoolDifferentiation: audit log fires once per signature change, counts allowed", () => {
	resetPoolDifferentiationAudit();
	const { ctx, contexts, infos } = fakeHost();
	applyPoolDifferentiation(ctx, configWith(true), () => ({ entries: MIXED_STATS }));
	const first = contexts[0].text({});
	assert.notEqual(first, "", "precondition: a non-empty block");
	assert.equal(infos.length, 1);
	assert.match(infos[0], /pool differentiation updated:/u);
	assert.match(infos[0], /total=/u, "the HOST log carries exact counts (never model-injected)");
	// Same signature again → silent.
	contexts[0].text({});
	assert.equal(infos.length, 1);
	resetPoolDifferentiationAudit();
});

test("applyPoolDifferentiation: registration failure warns and disables the layer, never throws", () => {
	const { ctx, warnings } = fakeHost();
	ctx.systemPrompt.section = () => {
		throw new Error("section registry unavailable");
	};
	assert.doesNotThrow(() => applyPoolDifferentiation(ctx, configWith(true), []));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /switchman:pool-differentiation disabled/u);
});

// ---------------------------------------------------------------------------
// Structural pins
// ---------------------------------------------------------------------------

test("every LANES lane is an actionable advice target (config.js coupling)", () => {
	// The differentiation layer reads config.js LANES — the pools-table
	// order — so a lane added there is automatically covered.
	assert.deepEqual(LANES, ["economy", "mechanical", "main", "hard", "vision", "review"]);
});

test("skill names outside the strict shape are skipped (digit-free guarantee)", () => {
	// A digit-bearing skill name (straight from child tool-call arguments)
	// would puncture the no-digit promise; the guard drops the row instead.
	const block = renderPoolDifferentiationBlock([
		entry("main", { dispatches: 9, failures: 4, skill: "skill2" }),
		entry("main", { dispatches: 9, failures: 4, skill: "ok-skill" }),
	]);
	assert.doesNotMatch(block, /skill2/u);
	assert.match(block, /ok-skill/u);
});
