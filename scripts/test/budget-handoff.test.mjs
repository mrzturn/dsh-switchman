/** Guide §4.6 P1 item 4: compress-by-budget + handoff_min/handoff_full split.
 *
 *  Four groups:
 *  1. Budget formula units — min(pool_target, current × ratio), flooring,
 *     fail-open nulls on every unusable input.
 *  2. Trigger/nudge wiring on/off contrast — the budget tier fires only
 *     with a usable budgetTarget, and the advisory nudge text keeps its
 *     legacy bytes when the ratio is absent/default.
 *  3. Handoff instruction three-state snapshots — OFF = legacy bytes
 *     verbatim (zero diff), ON = handoff_min (required) + handoff_full
 *     (optional, skip-without-blocking) content spec.
 *  4. Promoted-field registration guard — the four promoted §4.6 fields
 *     (trimBudgetEnabled, compressBudgetRatio, wmHandoffSplit,
 *     costProfileEnabled) must stay declared in config.js, registered in
 *     routes.js, AND wired into client.js — the three lists move together
 *     (see settings-fields-parity.test.mjs for the routes ⊆ client direction).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPRESS_BUDGET_RATIO_DEFAULT, POOL_TARGET_TOKENS, budgetNudgePercent, compressBudgetTargetTokens } from "../../host/context-trim/budget.js";
import { evaluateTrigger } from "../../host/context-trim/trigger.js";
import { advisoryNudgeText } from "../../host/context-trim/index.js";
import { estimateTokensOf } from "../../host/context-trim/view.js";
import { handoverFillInstruction, taskStateLines } from "../../host/handoff-doc.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(repoRoot, file), "utf8");

// ---------------------------------------------------------------- 1. formula

test("compressBudgetRatio default is 0.5 (legacy nudge depth) and the pool constant sits below every default tier line", () => {
	assert.equal(COMPRESS_BUDGET_RATIO_DEFAULT, 0.5);
	// Conservative constant: below the 45% pressure line of a 200k window
	// (90k) and below the 100k hard watermark, so the budget tier can only
	// ever ADD a fold line, never delay an existing one.
	assert.equal(Number.isFinite(POOL_TARGET_TOKENS) && POOL_TARGET_TOKENS > 0, true);
	assert.ok(POOL_TARGET_TOKENS < 60_001, `pool constant ${POOL_TARGET_TOKENS} must stay conservative`);
});

test("budget target = min(pool_target, current × ratio), floored to whole tokens", () => {
	// Pool wins: 200k × 0.5 = 100k > 60k pool.
	assert.equal(compressBudgetTargetTokens({ currentTokens: 200_000, ratio: 0.5, poolTargetTokens: 60_000 }), 60_000);
	// Ratio wins: 100k × 0.5 = 50k < 60k pool.
	assert.equal(compressBudgetTargetTokens({ currentTokens: 100_000, ratio: 0.5, poolTargetTokens: 60_000 }), 50_000);
	// Flooring: 101_111 × 0.3 = 30_333.3 → 30_333 (pool does not bite).
	assert.equal(compressBudgetTargetTokens({ currentTokens: 101_111, ratio: 0.3, poolTargetTokens: 60_000 }), 30_333);
	// Defaults kick in when the optional fields are omitted.
	assert.equal(compressBudgetTargetTokens({ currentTokens: 100_000 }), Math.min(POOL_TARGET_TOKENS, 50_000));
});

 test("budget target fails open to null on any unusable input", () => {
 	for (const currentTokens of [null, undefined, NaN, 0, -1, "80000", Infinity]) {
 		assert.equal(compressBudgetTargetTokens({ currentTokens }), null, `current=${String(currentTokens)}`);
 	}
 	// ratio/pool `undefined` means "not provided" and takes the destructuring
 	// default (that is ordinary JS semantics, not a failure mode) — only
 	// EXPLICIT unusable values must yield the fail-open null.
 	for (const ratio of [null, NaN, 0, 1, 1.5, -0.5, "0.5", ""]) {
 		assert.equal(compressBudgetTargetTokens({ currentTokens: 100_000, ratio }), null, `ratio=${String(ratio)}`);
 	}
 	for (const poolTargetTokens of [null, NaN, 0, -1, Infinity]) {
 		assert.equal(compressBudgetTargetTokens({ currentTokens: 100_000, poolTargetTokens }), null, `pool=${String(poolTargetTokens)}`);
 	}
 	// No arguments at all is still a safe call.
 	assert.equal(compressBudgetTargetTokens(), null);
 });

test("budgetNudgePercent derives the fold-down depth and falls back on unusable ratios", () => {
	assert.equal(budgetNudgePercent(0.5), 50);
	assert.equal(budgetNudgePercent(0.3), 30);
	assert.equal(budgetNudgePercent(0.555), 56); // rounds
	assert.equal(budgetNudgePercent(NaN), 50);
	assert.equal(budgetNudgePercent(0), 50);
	assert.equal(budgetNudgePercent(1), 50);
	assert.equal(budgetNudgePercent(undefined, 45), 45); // custom fallback
});

// ------------------------------------------------- 2. trigger/nudge wiring

/** One message whose foldable range is worth ≥ `chars` text tokens. */
const foldInput = ({ viewTokens, budgetTarget }) => {
	const messages = [{ role: "user", content: [{ type: "text", text: "word ".repeat(4000) }] }];
	return {
		messages,
		foldable: { startIdx: 0, endIdx: 1 },
		viewTokens,
		windowTokens: null, // keep pressure/emergency tiers out of the picture
		thresholds: {
			incrementTokens: 500, // low gate: the folded increment always clears it
			growthTokens: 1_000_000_000, // growth tier disabled (finite, so the isFinite fallback can't restore 22.5k)
			...(budgetTarget === undefined ? {} : { budgetTarget }),
		},
		ledger: {},
		now: 3_600_000, // far above FOLD_MIN_INTERVAL_MS from lastFoldAt = 0
		lastFoldAt: 0,
		foldsThisHour: [],
		lastEmergencyAt: 0,
		ladderRuns: { t2: [], t3: [] },
	};
};

test("budget tier is wired between pressure and growth: fires above target, silent below or when absent (fail-open)", () => {
	const increment = estimateTokensOf(foldInput({ viewTokens: 80_000 }).messages, 0, 1);
	assert.ok(increment >= 500, `fixture increment ${increment} must clear the gate`);

	// ON + above target → the dedicated budget tier.
	const above = evaluateTrigger(foldInput({ viewTokens: 80_000, budgetTarget: 60_000 }));
	assert.equal(above.action, "fold");
	assert.equal(above.tier, "budget");
	assert.match(above.reason, /budget ~60[0-9]{3}/u);

	// ON + below target → no budget fold, growth disabled → nothing fires.
	const below = evaluateTrigger(foldInput({ viewTokens: 50_000, budgetTarget: 90_000 }));
	assert.equal(below.action, "none");

	// OFF (wiring passes budgetTarget: null) → identical to pre-feature.
	const off = evaluateTrigger(foldInput({ viewTokens: 80_000, budgetTarget: null }));
	assert.equal(off.action, "none");
	const absent = evaluateTrigger(foldInput({ viewTokens: 80_000 }));
	assert.equal(absent.action, "none");

	// Increment gate shared with growth: a tiny foldable range cannot
	// drive a budget fold alone.
	const thin = foldInput({ viewTokens: 80_000, budgetTarget: 60_000 });
	thin.thresholds.incrementTokens = 100_000;
	assert.equal(evaluateTrigger(thin).action, "none");
});

test("advisory nudge keeps legacy bytes at the default ratio and re-derives depth from the ratio when set", () => {
	// Legacy snapshot (pre-feature text, 7th argument omitted): the tiered
	// sentences must keep their exact bytes inside the full nudge document.
	const legacyNonCritical =
		"At 83% (fold line 50%): 50–59% → fold roughly half of the older history now; ≥60% → fold down to under ~50%.";
	const legacyCritical =
		"Pressure is CRITICAL (97% ≥ 80%): fold down to under ~50% of the context IN THIS TURN.";
	assert.ok(advisoryNudgeText(83, false).includes(legacyNonCritical), "non-critical sentence keeps legacy bytes");
	assert.ok(advisoryNudgeText(97, true).includes(legacyCritical), "critical sentence keeps legacy bytes");
	// Explicit 50 is byte-identical to omitting the argument entirely.
	assert.equal(advisoryNudgeText(83, false, 50, 80, null, 0, 50), advisoryNudgeText(83, false));
	assert.equal(advisoryNudgeText(97, true, 50, 80, null, 0, 50), advisoryNudgeText(97, true));

	// ON with a non-default ratio → both sentences re-derive the depth.
	const tighter = advisoryNudgeText(83, false, 50, 80, null, 0, 30);
	assert.match(tighter, /fold down to under ~30%\./u);
	const tighterCritical = advisoryNudgeText(97, true, 50, 80, null, 0, 30);
	assert.match(tighterCritical, /under ~30% of the context/u);
});

// ------------------------------------------ 3. handoff instruction snapshots

const LEGACY_TASK_STATE_LINES = [
	`## Task state (filled in by the agent right after the handover)`,
	``,
	`- goal / objective in flight:`,
	`- completed so far:`,
	`- in progress:`,
	`- next steps:`,
	`- files touched / key references:`,
	``,
];
const LEGACY_FILL_INSTRUCTION =
	"Using the compaction summary now in your context, fill in the handover document (goal, completed, in progress, next steps, files), then continue the unfinished task — do not wait for further instructions.";

test("handoff split OFF → legacy document bytes verbatim (zero diff)", () => {
	assert.deepEqual(taskStateLines(false), LEGACY_TASK_STATE_LINES);
	assert.equal(handoverFillInstruction(false), LEGACY_FILL_INSTRUCTION);
	// Fresh array each call (callers spread it into a document body).
	assert.notEqual(taskStateLines(false), taskStateLines(false));
});

test("handoff split ON → handoff_min (required, sync) + handoff_full (optional, skip-without-blocking)", () => {
	const lines = taskStateLines(true).join("\n");
	// handoff_min: required, synchronous, exactly the five §4.6 items.
	assert.match(lines, /## Task state — handoff_min \(REQUIRED/u);
	assert.match(lines, /- goal \/ objective in flight:/u);
	assert.match(lines, /- current status \(completed \/ in progress\):/u);
	assert.match(lines, /- next steps \(ordered, immediate\):/u);
	assert.match(lines, /- key files & commands \(exact paths, commands, names\):/u);
	assert.match(lines, /- background subagents: ids \+ report paths/u);
	// handoff_full: optional append-only extras, never blocking.
	assert.match(lines, /## Task context — handoff_full \(OPTIONAL/u);
	assert.match(lines, /- cost profile \(tokens \/ calls spent so far, if cheaply known\):/u);
	assert.match(lines, /- decision history \(the why behind key choices\):/u);
	assert.match(lines, /- open questions \/ unresolved risks:/u);
	assert.match(lines, /skipping any or all of it never blocks the handover/u);

	const fill = handoverFillInstruction(true);
	assert.match(fill, /handoff_min/u);
	assert.match(fill, /handoff_full/u);
	assert.match(fill, /skipping never blocks/u);
	assert.match(fill, /do not wait for further instructions\.$/u);
	// The continuation stays one sentence family: still names the summary
	// as the source of truth.
	assert.match(fill, /Using the compaction summary now in your context/u);
});

// ----------------------------------------- 4. promoted-field registration guard

test("the four promoted §4.6 fields are declared, routed, and client-wired", () => {
	const configSrc = read("host/config.js");
	const routesSrc = read("host/routes.js");
	const clientSrc = read("client.js");
	// 2026-11-20 promotion: the former config-only switches now have a client
	// settings-page row AND routes registration. All three lists must move
	// together or saves silently drop fields / 400 again (v1.11 bug class).
	for (const field of [
		"trimBudgetEnabled",
		"compressBudgetRatio",
		"wmHandoffSplit",
		"costProfileEnabled",
	]) {
		assert.match(configSrc, new RegExp(`^\\s*${field}: z\\..*volatile\\(\\),$`, "mu"), `${field} must be declared in host/config.js`);
		assert.match(routesSrc, new RegExp(`["']${field}["']`), `${field} must be registered in routes.js (client-page saves would silently drop it)`);
		assert.match(clientSrc, new RegExp(field), `${field} must be wired into client.js (ALL_FIELDS / payload / labels)`);
	}
	// Exact schema shapes: gray-release defaults stay false ×3, ratio 0.5.
	assert.match(configSrc, /^\ttrimBudgetEnabled: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/m);
	assert.match(configSrc, /^\twmHandoffSplit: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/m);
	assert.match(configSrc, /^\tcostProfileEnabled: z\.boolean\(\)\.default\(false\)\.volatile\(\),$/m);
	assert.match(configSrc, /^\tcompressBudgetRatio: z\.number\(\)\.min\(0\.1\)\.max\(0\.9\)\.default\(0\.5\)\.volatile\(\),$/m);
});
