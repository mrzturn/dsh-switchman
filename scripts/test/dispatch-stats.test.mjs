// Dispatch-result observability (refactor guide §4.5 pool statistics +
// §4.3 inputs, P2 pack B0): host/dispatch-stats.js. Covers:
// - lane attribution: exact route match against configured pools, first
//   lane wins, misses resolve null;
// - argument parsing: valid JSON target/route extraction, junk → {};
// - record folding: dispatches/successes/failures/emptyResults/rework,
//   latency sum+max, bounded key map with insertion-order eviction;
// - rework window: same target + same pool within k turns (time fallback
//   without turn numbers), different pool or target never counts;
// - getters: bounded snapshot shape, busiest-first sort, reset;
// - wiring: synthetic tool/call → subagent/start → child facts →
//   subagent/end sequence lands one attributed record (model from the
//   child's request/header, skill from the child's first skill tool call);
// - master switch OFF: zero capture even mid-stream flips (no stale
//   pending state — review F1);
// - fail-open: malformed events never throw and never poison the stats.
//
// Module-level tests per repo convention (no test mounts the full apply());
// the fake host mirrors constraints.test.mjs. Zero new dependencies. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DISPATCH_KEY_CAP,
	REWORK_TURN_WINDOW,
	applyDispatchStats,
	getDispatchStats,
	laneOfRoute,
	observeRework,
	parseToolArguments,
	recordSettledRun,
	resetDispatchStats,
} from "../../host/dispatch-stats.js";

/** Pool config stub: plain arrays (lanePools tolerates non-.get values). */
const POOLS = {
	poolEconomy: [{ provider: "prov-a", model: "fast-model" }],
	poolMain: [{ provider: "prov-a", model: "big-model" }],
};

/** Config stub with a live toggle; `enabled` may be mutated per test. */
const configWith = (enabled) => ({
	dispatchStatsEnabled: { get: () => enabled },
	...POOLS,
});

/** Fake host context: collects listeners (session/event two-arg convention;
 *  subagent lifecycle single-info-arg convention) + an info log. */
function fakeHost() {
	const listeners = new Map();
	const log = [];
	const ctx = {
		on: (name, fn) => {
			if (!listeners.has(name)) listeners.set(name, []);
			listeners.get(name).push(fn);
		},
		logger: { info: (m) => log.push(m), warn: () => {} },
	};
	return { ctx, listeners, log };
}
const emit = (listeners, name, ...args) => {
	for (const fn of listeners.get(name) ?? []) fn(...args);
};

/** Parent-side dispatch tool/call event. */
const DISPATCH_CALL = (argsJson, turn = 10) => ({
	type: "tool/call",
	data: { name: "subagent", arguments: argsJson, turn },
});
/** Child-side skill tool/call event. */
const SKILL_CALL = (name) => ({
	type: "tool/call",
	data: { name: "skill", arguments: JSON.stringify({ name }) },
});
/** Child-side resolved model route. */
const HEADER = (provider, model) => ({
	type: "request/header",
	data: { header: { config: { provider, model, reasoningEffort: "high" } } },
});
const PARENT = { session: { id: "s-parent" } };
const CHILD = { session: { id: "s-child" } };
const START = (runId = "r1", parent = "s-parent", child = "s-child") => ({
	runId,
	provider: "subagent-backend",
	parentSessionId: parent,
	id: child,
	local: true,
});
const END = (runId = "r1", stopReason = "completed", lastMessage = ["done"]) => ({
	runId,
	provider: "subagent-backend",
	parentSessionId: "s-parent",
	id: "s-child",
	local: true,
	stopReason,
	...(lastMessage === null ? {} : { lastAssistantMessage: lastMessage }),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("laneOfRoute: exact provider+model match, first lane in LANES order wins", () => {
	assert.equal(laneOfRoute({ provider: "prov-a", model: "fast-model" }, configWith(true)), "economy");
	assert.equal(laneOfRoute({ provider: "prov-a", model: "big-model" }, configWith(true)), "main");
	assert.equal(laneOfRoute({ provider: "prov-x", model: "fast-model" }, configWith(true)), null);
	assert.equal(laneOfRoute({ provider: "prov-a" }, configWith(true)), null);
	assert.equal(laneOfRoute(null, configWith(true)), null);
});

test("parseToolArguments: JSON object extracted; junk, oversize, non-string → {}", () => {
	assert.deepEqual(parseToolArguments(JSON.stringify({ name: "worker", model: "m" })), { name: "worker", model: "m" });
	assert.deepEqual(parseToolArguments("not json"), {});
	assert.deepEqual(parseToolArguments("[1,2]"), {});
	assert.deepEqual(parseToolArguments("null"), {});
	assert.deepEqual(parseToolArguments(42), {});
	assert.deepEqual(parseToolArguments("x".repeat(9000)), {});
});

test("recordSettledRun: counters and latency sum/max fold per key", () => {
	resetDispatchStats();
	const map = new Map();
	recordSettledRun(map, { pool: "main", model: "p/m", skill: "none", success: true, empty: false, rework: false, latencyMs: 120, at: 1 });
	recordSettledRun(map, { pool: "main", model: "p/m", skill: "none", success: false, empty: false, rework: true, latencyMs: 80.6, at: 2 });
	recordSettledRun(map, { pool: "main", model: "p/m", skill: "none", success: true, empty: true, rework: false, latencyMs: -5, at: 3 });
	assert.equal(map.size, 1);
	const record = map.get("main\0p/m\0none");
	assert.deepEqual(
		{ dispatches: record.dispatches, successes: record.successes, failures: record.failures, emptyResults: record.emptyResults, rework: record.rework },
		{ dispatches: 3, successes: 2, failures: 1, emptyResults: 1, rework: 1 },
	);
	assert.equal(record.latencySumMs, 201); // 120 + round(80.6)=81; -5 latency ignored
	assert.equal(record.latencyMaxMs, 120); // 80.6 rounds to 81 < 120
	assert.equal(record.lastAt, 3);
});

test("recordSettledRun: key map evicts oldest past DISPATCH_KEY_CAP", () => {
	const map = new Map();
	for (let i = 0; i < DISPATCH_KEY_CAP + 1; i += 1) {
		recordSettledRun(map, { pool: "main", model: `m${i}`, skill: "none", success: true, empty: false, rework: false, latencyMs: i, at: i });
	}
	assert.equal(map.size, DISPATCH_KEY_CAP);
	assert.equal(map.has("main\0m0\0none"), false); // oldest evicted
	assert.equal(map.has(`main\0m${DISPATCH_KEY_CAP}\0none`), true);
});

test("observeRework: same target+pool within the turn window counts once per repeat", () => {
	const windowMap = new Map();
	assert.equal(observeRework(windowMap, "p", "worker", 10, "main", 1000), false);
	assert.equal(observeRework(windowMap, "p", "worker", 12, "main", 2000), true); // Δ2 ≤ k vs turn 10
	assert.equal(observeRework(windowMap, "p", "worker", 16, "main", 3000), true); // Δ4 ≤ k vs turn 12
	assert.equal(observeRework(windowMap, "p", "other", 10, "main", 4000), false); // fresh target
	assert.equal(observeRework(windowMap, "p", "other", 10 + REWORK_TURN_WINDOW + 1, "main", 5000), false); // Δ>k
	assert.equal(observeRework(windowMap, "p", "worker", 20, "economy", 6000), false); // different pool
	assert.equal(observeRework(windowMap, "p", "", 22, "main", 7000), false); // no target: ignored
});

test("observeRework: falls back to the time window when turns are missing", () => {
	const windowMap = new Map();
	assert.equal(observeRework(windowMap, "p", "worker", null, "main", 1000), false);
	assert.equal(observeRework(windowMap, "p", "worker", null, "main", 1000 + 60_000), true); // ≤ 10 min
	const windowMap2 = new Map();
	observeRework(windowMap2, "p", "worker", null, "main", 1000);
	assert.equal(observeRework(windowMap2, "p", "worker", null, "main", 1000 + 11 * 60_000), false); // > 10 min
});

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

test("getDispatchStats: busiest-first sort across keys, reset clears everything", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	const run = (runId, model) => {
		emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: `w-${runId}`, provider: "prov-a", model }), 10));
		emit(listeners, "subagent/start", START(runId));
		emit(listeners, "subagent/end", END(runId));
	};
	run("r1", "fast-model");
	run("r2", "fast-model");
	run("r3", "fast-model");
	run("r4", "big-model");
	const { cap, entries } = getDispatchStats();
	assert.equal(cap, DISPATCH_KEY_CAP);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].pool, "economy"); // 3 dispatches first
	assert.equal(entries[0].dispatches, 3);
	assert.equal(entries[1].pool, "main");
	assert.equal(entries[1].dispatches, 1);
	resetDispatchStats();
	assert.deepEqual(getDispatchStats(), { cap: DISPATCH_KEY_CAP, entries: [] });
});

// ---------------------------------------------------------------------------
// Wiring (fake host)
// ---------------------------------------------------------------------------

test("ON: full synthetic sequence lands one attributed record (model/skill/outcome)", () => {
	resetDispatchStats();
	const { ctx, listeners, log } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" }), 10));
	emit(listeners, "session/event", CHILD, HEADER("prov-a", "fast-model"));
	emit(listeners, "session/event", CHILD, SKILL_CALL("db-query"));
	emit(listeners, "subagent/start", START());
	emit(listeners, "subagent/end", END());
	const snapshot = getDispatchStats();
	assert.equal(snapshot.entries.length, 1);
	const entry = snapshot.entries[0];
	assert.equal(entry.pool, "economy"); // explicit route matches poolEconomy
	assert.equal(entry.model, "prov-a/fast-model"); // from child request/header
	assert.equal(entry.skill, "db-query"); // from child skill tool call
	assert.deepEqual(
		{ dispatches: entry.dispatches, successes: entry.successes, failures: entry.failures, emptyResults: entry.emptyResults, rework: entry.rework },
		{ dispatches: 1, successes: 1, failures: 0, emptyResults: 0, rework: 0 },
	);
	assert.ok(entry.latencySumMs >= 0, "wall-clock latency recorded");
	assert.ok(Number.isFinite(entry.lastAt));
	assert.equal(log.length, 1, "one host log line per settled run");
	assert.match(log[0], /dispatch_stats: pool=economy/);
});

test("ON: stopReason mapping — completed=success, others=failure; empty output counted separately", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	const run = (runId, stopReason, lastMessage) => {
		emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker" }), 10));
		emit(listeners, "subagent/start", START(runId));
		emit(listeners, "subagent/end", END(runId, stopReason, lastMessage));
	};
	run("r-ok", "completed", ["done"]);
	run("r-err", "error", null);
	run("r-abort", "aborted", ["partial"]);
	run("r-empty", "completed", null); // continuable-style empty settlement
	const { entries } = getDispatchStats();
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.deepEqual(
		{ dispatches: entry.dispatches, successes: entry.successes, failures: entry.failures, emptyResults: entry.emptyResults },
		{ dispatches: 4, successes: 2, failures: 2, emptyResults: 1 },
	);
	// No child header/skill facts → unknown model, none skill, unattributed pool.
	assert.equal(entry.model, "unknown");
	assert.equal(entry.skill, "none");
	assert.equal(entry.pool, "unknown"); // no route seen at all
});

test("ON: rework — same target re-dispatched to the same lane within k turns", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	const args = JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" });
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(args, 10));
	emit(listeners, "subagent/start", START("r1"));
	emit(listeners, "subagent/end", END("r1"));
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(args, 12));
	emit(listeners, "subagent/start", START("r2"));
	emit(listeners, "subagent/end", END("r2"));
	const { entries } = getDispatchStats();
	assert.equal(entries.length, 1); // same pool×model×skill key
	assert.equal(entries[0].dispatches, 2);
	assert.equal(entries[0].rework, 1, "the repeat carries the rework signal");
});

test("ON: same target re-dispatched to a DIFFERENT lane is failover, not rework", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" }), 10));
	emit(listeners, "subagent/start", START("r1"));
	emit(listeners, "subagent/end", END("r1"));
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "big-model" }), 12));
	emit(listeners, "subagent/start", START("r2"));
	emit(listeners, "subagent/end", END("r2"));
	const { entries } = getDispatchStats();
	assert.equal(entries.length, 2); // two distinct keys
	assert.ok(entries.every((entry) => entry.rework === 0));
});

test("OFF: zero capture — and no stale pending state when flipped on mid-stream", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	let enabled = false;
	applyDispatchStats(ctx, { ...configWith(true), dispatchStatsEnabled: { get: () => enabled } });
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" }), 10));
	emit(listeners, "session/event", CHILD, HEADER("prov-a", "fast-model"));
	emit(listeners, "subagent/start", START());
	assert.deepEqual(getDispatchStats().entries, []);
	enabled = true;
	emit(listeners, "subagent/end", END()); // start was missed while off
	assert.deepEqual(getDispatchStats().entries, [], "no record without a tracked start");
});

test("fail-open: malformed events never throw and never poison the stats", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	assert.doesNotThrow(() => {
		emit(listeners, "session/event", { session: {} }, DISPATCH_CALL("not json", "NaN"));
		emit(listeners, "session/event", null, { type: "request/header", data: { header: { config: {} } } });
		emit(listeners, "session/event", PARENT, { type: "tool/call", data: { name: "skill", arguments: "{broken" } });
		emit(listeners, "session/event", PARENT, { type: "tool/call" });
		emit(listeners, "subagent/start", null);
		emit(listeners, "subagent/start", { noRunId: true });
		emit(listeners, "subagent/end", null);
		emit(listeners, "subagent/end", { runId: "ghost" });
		emit(listeners, "session/disposed", null);
	});
	assert.deepEqual(getDispatchStats().entries, []);
	// The healthy path still records after the garbage storm.
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" }), 10));
	emit(listeners, "session/event", CHILD, HEADER("prov-a", "fast-model"));
	emit(listeners, "subagent/start", START());
	emit(listeners, "subagent/end", END());
	assert.equal(getDispatchStats().entries.length, 1);
});

test("getter shape: every entry carries the documented plain-JSON fields", () => {
	resetDispatchStats();
	const { ctx, listeners } = fakeHost();
	applyDispatchStats(ctx, configWith(true));
	emit(listeners, "session/event", PARENT, DISPATCH_CALL(JSON.stringify({ name: "worker", provider: "prov-a", model: "fast-model" }), 10));
	emit(listeners, "subagent/start", START());
	emit(listeners, "subagent/end", END());
	const { cap, entries } = getDispatchStats();
	assert.equal(cap, DISPATCH_KEY_CAP);
	assert.equal(entries.length, 1);
	assert.deepEqual(Object.keys(entries[0]).sort(), [
		"dispatches",
		"emptyResults",
		"failures",
		"lastAt",
		"latencyMaxMs",
		"latencySumMs",
		"model",
		"pool",
		"rework",
		"skill",
		"successes",
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(entries[0])), entries[0]); // plain JSON
	resetDispatchStats();
	assert.deepEqual(getDispatchStats().entries, []);
});
