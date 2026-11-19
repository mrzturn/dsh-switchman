/** Guide §5 P2 ① cost attribution profile tests.
 *
 * Covers the acceptance set: OFF byte-identity (legacy + split + fill-in
 * baselines captured verbatim BEFORE the change), ON synthetic usage series
 * → attribution numbers, injection caps (≤12 lines / ≤600 bytes), fail-open
 * behavior, LRU and model-bucket bounds, and the wiring gates.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COST_PROFILE_MODELS_CAP,
	PROFILE_MAX_BYTES,
	PROFILE_MAX_LINES,
	costProfileSection,
	foldCostTurn,
	mergeUsageTurn,
	recordCostTurn,
	resetCostProfiles,
} from "../../host/cost-profile.js";
import { handoverFillInstruction, taskStateLines } from "../../host/handoff-doc.js";
import { CACHE_TTL_MS } from "../../host/watermark-estimate.js";

const HOST = (p) => fileURLToPath(new URL(`../../host/${p}`, import.meta.url));
const sourceOf = (p) => readFileSync(HOST(p), "utf8");

// ---- Baselines: byte-exact handoff_full text as shipped BEFORE P2 ① ----

const BASELINE_LEGACY_LINES = [
	`## Task state (filled in by the agent right after the handover)`,
	``,
	`- goal / objective in flight:`,
	`- completed so far:`,
	`- in progress:`,
	`- next steps:`,
	`- files touched / key references:`,
	``,
];

const BASELINE_SPLIT_LINES = [
	`## Task state — handoff_min (REQUIRED: fill in right after the handover, before continuing)`,
	``,
	`- goal / objective in flight:`,
	`- current status (completed / in progress):`,
	`- next steps (ordered, immediate):`,
	`- key files & commands (exact paths, commands, names):`,
	`- background subagents: ids + report paths — use the "Live background subagents" section above; collect their results, never re-dispatch`,
	``,
	`## Task context — handoff_full (OPTIONAL: append below only what is readily available; skipping any or all of it never blocks the handover)`,
	``,
	`- cost profile (tokens / calls spent so far, if cheaply known):`,
	`- decision history (the why behind key choices):`,
	`- open questions / unresolved risks:`,
	``,
];

/** POST-change ON string: the P2 ① hint clause is INSERTED before the
 *  trailing "Then continue" sentence — nothing else moved (asserted below). */
const BASELINE_FILL_ON = `Using the compaction summary now in your context, fill in the handover document's handoff_min sections (goal, current status, next steps, key files & commands, background subagent ids + report paths) before continuing; its handoff_full sections (cost profile, decision history, open questions) are optional — append them only if readily available, skipping never blocks. Then continue the unfinished task — do not wait for further instructions.`;
const FILL_ON_PREFIX_PRE_P2 = BASELINE_FILL_ON.slice(0, BASELINE_FILL_ON.indexOf("Then continue"));
const BASELINE_FILL_OFF = `Using the compaction summary now in your context, fill in the handover document (goal, completed, in progress, next steps, files), then continue the unfinished task — do not wait for further instructions.`;

// ---- Fixtures ----

const ON_CONFIG = {
	costProfileEnabled: true,
	wmHandoffSplit: true,
	poolMain: [{ provider: "p-main", model: "m-main" }],
};
const OFF_CONFIG = { ...ON_CONFIG, costProfileEnabled: false };

const freshRecord = () => ({
	turns: 0,
	promptTokens: 0,
	cachedTokens: 0,
	outputTokens: 0,
	perPool: new Map(),
	perModel: new Map(),
	spikes: { count: 0, uncached: 0, idleCount: 0 },
	lastAt: null,
});

/** Hand-build the exact record the ON synthetic series must produce. */
function buildSyntheticRecord() {
	const record = freshRecord();
	const t0 = 1_000_000;
	foldCostTurn(record, { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 1000, cachedTokens: 9000, cacheWriteTokens: 500, outputTokens: 400 }, at: t0 }, ON_CONFIG);
	foldCostTurn(record, { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 800, cachedTokens: 11000, cacheWriteTokens: 200, outputTokens: 500 }, at: t0 + 10_000 }, ON_CONFIG);
	foldCostTurn(record, { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 12000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 600 }, at: t0 + 10_000 + CACHE_TTL_MS + 60_000 }, ON_CONFIG);
	foldCostTurn(record, { route: { provider: "p-other", model: "m-other" }, usage: { inputTokens: 2000, cachedTokens: 3000, cacheWriteTokens: 1000, outputTokens: 700 }, at: t0 + 10_000 + CACHE_TTL_MS + 70_000 }, ON_CONFIG);
	foldCostTurn(record, { route: null, usage: { inputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, at: t0 + 10_000 + CACHE_TTL_MS + 80_000 }, ON_CONFIG);
	return record;
}

// ---- 1. OFF byte-identity ----

test("OFF: task-state builders and fill instruction stay byte-identical to the pre-P2 baseline", () => {
	assert.deepEqual(taskStateLines(false), BASELINE_LEGACY_LINES, "legacy template must stay verbatim");
	assert.deepEqual(taskStateLines(true), BASELINE_SPLIT_LINES, "split template must stay verbatim when no profile is passed");
	assert.deepEqual(taskStateLines(true, []), BASELINE_SPLIT_LINES, "empty profile → verbatim");
	assert.deepEqual(taskStateLines(false, ["  - intruder line"]), BASELINE_LEGACY_LINES, "profile lines must be ignored when split is off");
	assert.deepEqual(taskStateLines(true, null), BASELINE_SPLIT_LINES, "null profile → verbatim");
	const fillOn = handoverFillInstruction(true, true);
	assert.ok(fillOn.startsWith(FILL_ON_PREFIX_PRE_P2), "ON branch keeps the pre-P2 prefix verbatim");
	assert.ok(fillOn.endsWith("Then continue the unfinished task — do not wait for further instructions."), "ON branch keeps the pre-P2 tail verbatim");
	assert.match(fillOn, /skipping never blocks\. The cost profile line may already carry dsh-switchman's measured session totals — treat them as given, do not re-derive them\. Then continue/u, "exactly the P2 ① hint clause is inserted");
	// Split + profile-off stays pre-P2 verbatim byte-for-byte: no instruction
	// about a measured block that will not be there.
	assert.equal(handoverFillInstruction(true), BASELINE_FILL_ON, "the measured clause is gated on the profile switch");
	assert.equal(handoverFillInstruction(false), BASELINE_FILL_OFF);
});

test("OFF: zero recording and zero rendering (master switch inside recordCostTurn)", () => {
	resetCostProfiles();
	assert.equal(recordCostTurn("s-off", { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 1 }, OFF_CONFIG), null);
	assert.deepEqual(costProfileSection("s-off", ON_CONFIG), [], "nothing was ever recorded");
	assert.deepEqual(costProfileSection("s-off", OFF_CONFIG), [], "master switch gates rendering too");
});

test("gates: split off / unknown session / empty id → zero bytes", () => {
	resetCostProfiles();
	const record = recordCostTurn("s-gate", { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 100, cachedTokens: 100, cacheWriteTokens: 0, outputTokens: 5 }, at: 1 }, ON_CONFIG);
	assert.equal(record.turns, 1);
	assert.deepEqual(costProfileSection("s-gate", { ...ON_CONFIG, wmHandoffSplit: false }), []);
	assert.deepEqual(costProfileSection("s-never-recorded", ON_CONFIG), []);
	assert.deepEqual(costProfileSection("", ON_CONFIG), []);
	assert.deepEqual(costProfileSection(null, ON_CONFIG), []);
});

// ---- 2. ON: synthetic series → attribution numbers ----

test("ON: synthetic usage series folds into exact attribution buckets", () => {
	resetCostProfiles();
	const record = buildSyntheticRecord();
	assert.equal(record.turns, 5);
	assert.equal(record.promptTokens, 41000); // 10500 + 12000 + 12000 + 6000 + 500
	assert.equal(record.cachedTokens, 23000); // 9000 + 11000 + 0 + 3000 + 0
	assert.equal(record.outputTokens, 2300); // 400 + 500 + 600 + 700 + 100
	assert.deepEqual(record.perPool.get("main"), { turns: 3, prompt: 34500, output: 1500 }); // laneOfRoute returns the lane LABEL ("main"), not the config field
	assert.deepEqual(record.perPool.get("unattributed"), { turns: 1, prompt: 6000, output: 700 });
	assert.deepEqual(record.perPool.get("unknown"), { turns: 1, prompt: 500, output: 100 });
	assert.deepEqual(record.perModel.get("p-main/m-main"), { turns: 3, prompt: 34500, output: 1500 });
	assert.deepEqual(record.spikes, { count: 1, uncached: 12000, idleCount: 1 });
});

test("ON: rendered block shows top contributors, ordered, with the honest scope line", () => {
	resetCostProfiles();
	recordCostTurn("s-render", { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 1000, cachedTokens: 9000, cacheWriteTokens: 500, outputTokens: 400 }, at: 1_000_000 }, ON_CONFIG);
	recordCostTurn("s-render", { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 800, cachedTokens: 11000, cacheWriteTokens: 200, outputTokens: 500 }, at: 1_010_000 }, ON_CONFIG);
	recordCostTurn("s-render", { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 12000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 600 }, at: 1_010_000 + CACHE_TTL_MS + 60_000 }, ON_CONFIG);
	recordCostTurn("s-render", { route: { provider: "p-other", model: "m-other" }, usage: { inputTokens: 2000, cachedTokens: 3000, cacheWriteTokens: 1000, outputTokens: 700 }, at: 1_010_000 + CACHE_TTL_MS + 70_000 }, ON_CONFIG);
	recordCostTurn("s-render", { route: null, usage: { inputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, at: 1_010_000 + CACHE_TTL_MS + 80_000 }, ON_CONFIG);
	assert.deepEqual(costProfileSection("s-render", ON_CONFIG), [
		`  - measured (dsh-switchman, session-to-date): 5 model turns, 41k prompt (56% cache hit), 2.3k output`,
		`  - by pool, share of prompt: main 84%, unattributed 15%, unknown 1%`,
		`  - by model, share of prompt: p-main/m-main 84%, p-other/m-other 15%`,
		`  - miss spikes: 1 turn re-paid 12k uncached input (1 after an idle gap over the cache window)`,
		`  - scope: stream-usage sampling only; per-tool-output cost is not separately recorded at this seam`,
	]);
});

test("shares use one honest denominator (prompt-less buckets read '<1%')", () => {
	resetCostProfiles();
	recordCostTurn("s-mix", { route: { provider: "p-a", model: "m-a" }, usage: { inputTokens: 8000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, at: 1 }, ON_CONFIG);
	recordCostTurn("s-mix", { route: { provider: "p-b", model: "m-b" }, usage: { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 900 }, at: 2 }, ON_CONFIG);
	const lines = costProfileSection("s-mix", ON_CONFIG);
	assert.ok(
		lines.some((line) => line.startsWith("  - by model, share of prompt:") && line.includes("p-a/m-a 100%") && line.includes("p-b/m-b <1%")),
		`model line must not mix denominators: ${lines.join(" | ")}`,
	);
});

test("ON: measured block splices under the cost-profile bullet in the split template", () => {
	const profile = [`  - measured (dsh-switchman, session-to-date): 1 model turns, 2.1k prompt (43% cache hit), 400 output`];
	const lines = taskStateLines(true, profile);
	const anchor = lines.findIndex((line) => line.startsWith("- cost profile"));
	assert.ok(anchor > 0, "cost-profile bullet must exist");
	assert.equal(lines.length, BASELINE_SPLIT_LINES.length + 1);
	assert.deepEqual(lines.slice(anchor + 1, anchor + 2), profile, "profile must sit immediately under the bullet");
});

// ---- 3. Spike classifier boundaries ----

test("spike: share floor, absolute floor, and first-turn (post-compaction) cases", () => {
	const r1 = foldCostTurn(freshRecord(), { route: null, usage: { inputTokens: 12000, cachedTokens: 30000, cacheWriteTokens: 0, outputTokens: 1 }, at: 1 }, ON_CONFIG);
	assert.equal(r1.spikes.count, 0, "28% uncached share is steady drift, not a spike");
	const r2 = foldCostTurn(freshRecord(), { route: null, usage: { inputTokens: 9000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 1 }, ON_CONFIG);
	assert.equal(r2.spikes.count, 0, "below the absolute floor is not a spike");
	const r3 = foldCostTurn(freshRecord(), { route: null, usage: { inputTokens: 12000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 1 }, ON_CONFIG);
	assert.deepEqual(r3.spikes, { count: 1, uncached: 12000, idleCount: 0 }, "first sampled turn may be a spike (post-compaction re-read) but never an idle one");
});

// ---- 4. mergeUsageTurn (multi-chunk per-stream samples) ----

test("mergeUsageTurn: later chunks fill nulls, never clobber known buckets", () => {
	const start = mergeUsageTurn(null, { inputTokens: 100, cachedTokens: null, cacheWriteTokens: 20, outputTokens: null });
	assert.deepEqual(start, { inputTokens: 100, cachedTokens: null, cacheWriteTokens: 20, outputTokens: null });
	const merged = mergeUsageTurn(start, { inputTokens: null, cachedTokens: 500, cacheWriteTokens: null, outputTokens: 50 });
	assert.deepEqual(merged, { inputTokens: 100, cachedTokens: 500, cacheWriteTokens: 20, outputTokens: 50 });
	const fixed = mergeUsageTurn({ inputTokens: Number.NaN, cachedTokens: null, cacheWriteTokens: null, outputTokens: null }, { inputTokens: 7, cachedTokens: null, cacheWriteTokens: null, outputTokens: 9 });
	assert.equal(fixed.inputTokens, 7, "NaN counts as missing and gets filled");
	assert.equal(fixed.outputTokens, 9);
});

// ---- 5. Caps and bounds ----

test("caps: rendered block never exceeds the line/byte budgets, totals line survives", () => {
	resetCostProfiles();
	const longRoute = { provider: "p".repeat(200), model: "m".repeat(200) };
	recordCostTurn("s-caps", { route: longRoute, usage: { inputTokens: 500, cachedTokens: 1500, cacheWriteTokens: 0, outputTokens: 900 }, at: 1 }, ON_CONFIG);
	const lines = costProfileSection("s-caps", ON_CONFIG);
	assert.ok(lines.length >= 1, "a folded session must render");
	assert.ok(lines.length <= PROFILE_MAX_LINES, `line cap (${PROFILE_MAX_LINES})`);
	const joined = lines.join("\n");
	assert.ok(joined.length <= PROFILE_MAX_BYTES, `byte cap (${PROFILE_MAX_BYTES}), got ${joined.length}`);
	assert.ok(lines[0].startsWith("  - measured"), "totals line must never be truncated away");
	assert.ok(joined.length > 100, "sanity: something real was rendered");
});

test("model buckets stay bounded; the overflow folds into 'other'", () => {
	const record = freshRecord();
	for (let i = 0; i < COST_PROFILE_MODELS_CAP + 2; i++) {
		foldCostTurn(record, { route: { provider: `p-${i}`, model: "m" }, usage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: i }, ON_CONFIG);
	}
	assert.equal(record.perModel.size, COST_PROFILE_MODELS_CAP + 1, "8 distinct + 'other'");
	assert.deepEqual(record.perModel.get("other"), { turns: 2, prompt: 20, output: 2 });
	assert.equal(record.turns, COST_PROFILE_MODELS_CAP + 2);
});

test("sessions are LRU-bounded; eviction is observable", () => {
	resetCostProfiles();
	for (let i = 0; i <= 200; i++) {
		recordCostTurn(`cap-probe-${i}`, { route: { provider: "p-main", model: "m-main" }, usage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: i }, ON_CONFIG);
	}
	assert.deepEqual(costProfileSection("cap-probe-0", ON_CONFIG), [], "oldest session evicted past the 200 cap");
	assert.ok(costProfileSection("cap-probe-200", ON_CONFIG).length > 0, "newest session still renders");
});

// ---- 6. Fail-open ----

test("fail-open: signal-less samples create no rendered bytes", () => {
	resetCostProfiles();
	const record = recordCostTurn("s-empty", { route: null, usage: { inputTokens: Number.NaN, cachedTokens: null, cacheWriteTokens: undefined, outputTokens: Number.POSITIVE_INFINITY }, at: 1 }, ON_CONFIG);
	assert.ok(record !== null && record.turns === 0, "record created but unchanged");
	assert.deepEqual(costProfileSection("s-empty", ON_CONFIG), [], "empty record renders nothing");
});

test("fail-open: corrupt records and hostile configs never throw", () => {
	const corrupt = { turns: 1, promptTokens: 5, cachedTokens: 0, outputTokens: 1, perPool: null, perModel: null, spikes: null, lastAt: null };
	assert.equal(foldCostTurn(corrupt, { route: null, usage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 1 }, ON_CONFIG), corrupt);
	assert.equal(foldCostTurn(null, { usage: {} }, ON_CONFIG), null);
	const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
	assert.equal(recordCostTurn("s-x", { usage: { inputTokens: 1 } }, hostile), null);
	assert.deepEqual(costProfileSection("s-x", hostile), []);
	assert.deepEqual(costProfileSection("s-x", null), []);
	resetCostProfiles();
	assert.deepEqual(costProfileSection("s-x", ON_CONFIG), []);
});

// ---- 7. Wiring pins (settings-fields-parity precedent) ----

test("wiring: stream seam folds merged usage; the doc builder consumes the section", () => {
	const trimSource = sourceOf("context-trim/index.js");
	assert.match(trimSource, /turnUsage = mergeUsageTurn\(turnUsage, usage\)/u, "usage chunks must merge at the metrics seam");
	assert.match(trimSource, /recordCostTurn\(/u, "one fold per stream at the end edge");
	const watchSource = sourceOf("context-watch.js");
	assert.match(watchSource, /costProfileSection\(sessionId,\s*config\)/u, "handoff_full builder must consume the section");
	const configSource = sourceOf("config.js");
	assert.match(configSource, /costProfileEnabled: z\.boolean\(\)\.default\(false\)\.volatile\(\)/u, "config key must default OFF");
});
