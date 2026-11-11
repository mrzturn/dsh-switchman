/** Routes settings round-trip tests: the trim fields the client page sends
 *  MUST survive coerceValues (POST) and appear in snapshotOf (GET).
 *
 *  Regression guard for the v1.11 fix: routes.js previously had ZERO trim
 *  fields, so every trim-settings edit from the client page was silently
 *  dropped server-side (the trim card was decorative). Any field added to
 *  host/config.js trim group must be added here, to routes.js coercion AND
 *  to the client page's ALL_FIELDS — the three lists move together.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceValues, sameValues, snapshotOf } from "../../host/routes.js";
import { mergeIntentCandidates } from "../../host/intent-presets.js";

/** A fully-populated values object (every field coerceValues requires). */
function fullValues(overrides = {}) {
	return {
		// strings
		langConversation: "",
		langComments: "",
		langDocs: "",
		intentClassifierEffort: "",
		intentClassifierEndpoint: "",
		intentClassifierSystemoneModel: "",
		trimStateDir: "",
		// pools
		poolEconomy: [], poolMechanical: [], poolMain: [], poolHard: [], poolVision: [], poolReview: [],
		modelRank: [],
		poolEconomyEfforts: [], poolMechanicalEfforts: [], poolMainEfforts: [], poolHardEfforts: [], poolVisionEfforts: [], poolReviewEfforts: [],
		// intent routes/candidates
		intentClassifierRoute: { provider: "", model: "" },
		intentFallbackRoute: { provider: "", model: "" },
		trimSideModel: { provider: "", model: "" },
		intentCandidates: [],
		trimFoldFallbackModel: { provider: "", model: "" },
		intentCacheTtlSeconds: 300,
		intentSwitchConfidence: 80,
		intentTimeoutMs: 60000,
		intentHistoryMessages: 6,
		intentHistoryMaxChars: 2400,
		intentContextWindow: 200000,
		intentClassifierKind: "chat",
		// enums
		uiLocale: "auto",
		langScope: "global",
		dispatchEnforce: "advice",
		trimMode: "auto",
		wmDenyMode: "cap",
		// numbers
		wmSoftTokens: 80000,
		wmHardTokens: 120000,
		wmForceTokens: 150000,
		wmReadBudgetTokens: 3000,
		wmSubagentForceTokens: 0,
		wmSubagentWindowRatio: 0.75,
		trimGrowthTokens: 22500,
		trimIncrementTokens: 50000,
		trimPressurePercent: 60,
		trimEmergencyPercent: 95,
		trimWindowTokens: 0,
		trimProtectedTail: 6,
		trimMaxFoldsPerHour: 6,
		trimLadderT2Tokens: 8000,
		trimLadderT2MinBlocks: 3,
		trimLadderT3Tokens: 6000,
		trimLadderT3MinBlocks: 2,
		// booleans
		wmAutoHandover: true,
		wmSubagentCap: true,
		poolEconomyManual: false,
		poolMechanicalManual: false,
		poolMainManual: false,
		poolHardManual: false,
		poolVisionManual: false,
		poolReviewManual: false,
		teamsMode: false,
		syncWhitelist: false,
		intentEnabled: false,
		trimEnabled: true,
		trimLadderEnabled: true,
		surfaceFold: true,
		...overrides,
	};
}

test("coerceValues round-trips every trim field the client page sends", () => {
	const values = fullValues();
	const coerced = coerceValues(values);
	assert.notEqual(coerced, null, "a full client payload must coerce");
	assert.equal(coerced.trimMode, "auto");
	assert.equal(coerced.trimEnabled, true);
	assert.equal(coerced.trimLadderEnabled, true);
	assert.equal(coerced.surfaceFold, true);
	assert.equal(coerced.trimStateDir, "");
	assert.deepEqual(coerced.trimSideModel, { provider: "", model: "" });
	assert.deepEqual(coerced.trimFoldFallbackModel, { provider: "", model: "" });
	assert.equal(coerced.trimGrowthTokens, 22500);
	assert.equal(coerced.trimIncrementTokens, 50000);
	assert.equal(coerced.trimPressurePercent, 60);
	assert.equal(coerced.trimEmergencyPercent, 95);
	assert.equal(coerced.trimWindowTokens, 0);
	assert.equal(coerced.trimProtectedTail, 6);
	assert.equal(coerced.trimMaxFoldsPerHour, 6);
	assert.equal(coerced.trimLadderT2Tokens, 8000);
	assert.equal(coerced.trimLadderT2MinBlocks, 3);
	assert.equal(coerced.trimLadderT3Tokens, 6000);
	assert.equal(coerced.trimLadderT3MinBlocks, 2);
	assert.equal(coerced.wmSubagentWindowRatio, 0.75);
	// Trim side routes keep their effort pin through coercion; intent routes
	// never gain one (cleanIntentRoute strips it).
	assert.deepEqual(
		coerceValues(fullValues({ trimFoldFallbackModel: { provider: "p", model: "m", effort: "high" } })).trimFoldFallbackModel,
		{ provider: "p", model: "m", effort: "high" },
	);
	assert.deepEqual(
		coerceValues(fullValues({ intentClassifierRoute: { provider: "p", model: "m", effort: "high" } })).intentClassifierRoute,
		{ provider: "p", model: "m" },
	);
});

test("trim field bounds reject out-of-schema values", () => {
	assert.equal(coerceValues(fullValues({ trimPressurePercent: 0 })), null, "pressure below the schema minimum");
	assert.equal(coerceValues(fullValues({ trimEmergencyPercent: 101 })), null, "emergency above 100");
	assert.equal(coerceValues(fullValues({ trimLadderT2MinBlocks: 1 })), null, "degenerate two-block distills are below the floor");
	assert.equal(coerceValues(fullValues({ trimMaxFoldsPerHour: 61 })), null, "hourly cap above the schema maximum");
	assert.equal(coerceValues(fullValues({ trimMode: "yolo" })), null, "unknown mode rejected");
	assert.equal(coerceValues(fullValues({ trimGrowthTokens: "many" })), null, "non-numeric rejected");
	assert.equal(coerceValues(fullValues({ wmSubagentWindowRatio: 0.05 })), null, "ratio below the schema floor");
	assert.equal(coerceValues(fullValues({ wmSubagentWindowRatio: 1.5 })), null, "ratio above 1 would loosen tiers");
});

test("a payload missing any trim field fails coercion (the client must send ALL fields)", () => {
	const missing = fullValues();
	delete missing.trimLadderEnabled;
	assert.equal(coerceValues(missing), null, "missing trimLadderEnabled fails — mirrors STRING/BOOL all-required contract");
});

test("snapshotOf exposes the trim fields with config-backed values", () => {
	const config = {
		trimMode: { get: () => "advisory" },
		trimEnabled: { get: () => false },
		trimLadderEnabled: { get: () => true },
		surfaceFold: { get: () => false },
		trimStateDir: { get: () => "/tmp/trim" },
		trimSideModel: { get: () => ({ provider: "p", model: "m" }) },
		trimGrowthTokens: { get: () => 1_000 },
		trimIncrementTokens: { get: () => 2_000 },
		trimPressurePercent: { get: () => 50 },
		trimEmergencyPercent: { get: () => 90 },
		trimWindowTokens: { get: () => 0 },
		trimProtectedTail: { get: () => 4 },
		trimMaxFoldsPerHour: { get: () => 5 },
		trimLadderT2Tokens: { get: () => 7_000 },
		trimLadderT2MinBlocks: { get: () => 4 },
		trimLadderT3Tokens: { get: () => 5_000 },
		trimLadderT3MinBlocks: { get: () => 3 },
	};
	const snapshot = snapshotOf(config);
	assert.equal(snapshot.trimMode, "advisory");
	assert.equal(snapshot.trimEnabled, false);
	assert.equal(snapshot.trimLadderEnabled, true);
	assert.equal(snapshot.surfaceFold, false);
	assert.equal(snapshot.trimStateDir, "/tmp/trim");
	assert.deepEqual(snapshot.trimSideModel, { provider: "p", model: "m" });
	assert.equal(snapshot.trimGrowthTokens, 1_000);
	assert.equal(snapshot.trimLadderT3MinBlocks, 3);
	// A coerced snapshot re-coerces cleanly (the fence compares coerced forms).
	assert.notEqual(coerceValues(snapshot), null, "GET snapshot is POST-coercible");
});

test("fence equality is key-order insensitive (2026-11-07 phantom-409)", () => {
	const config = {
		trimMode: { get: () => "advisory" },
		trimEnabled: { get: () => true },
		trimStateDir: { get: () => "/tmp/trim" },
		trimGrowthTokens: { get: () => 1_000 },
	};
	const snapshot = snapshotOf(config);
	const coerced = coerceValues(snapshot);
	assert.notEqual(coerced, null);
	// The two construction orders genuinely differ (trimStateDir: 7th vs
	// tail), which is exactly what broke the old stringify comparison.
	assert.notEqual(
		JSON.stringify(coerced),
		JSON.stringify(snapshot),
		"precondition: raw stringify distinguishes the shapes",
	);
	// …yet the fence predicate must accept — content is identical. Both
	// sides go through the SAME merge the PUT handler applies (routes.js
	// fence), which also normalizes the derived candidate labels.
	// Fence shape exactly as the PUT handler builds it: both sides re-merged
	// through mergeIntentCandidates before comparison.
	const fenceLeft = {
		...coerced,
		intentCandidates: mergeIntentCandidates(coerced.intentCandidates),
	};
	const fenceRight = {
		...snapshot,
		intentCandidates: mergeIntentCandidates(snapshot.intentCandidates),
	};
	assert.equal(sameValues(fenceLeft, fenceRight), true, "fence accepts key-order delta");
	// Order-insensitivity must not weaken the guard: real content deltas
	// still conflict.
	assert.equal(sameValues({ ...coerced, wmHardTokens: (coerced.wmHardTokens ?? 0) + 1 }, snapshot), false, "fence rejects value delta");
	assert.equal(sameValues({ ...coerced, trimEnabled: !coerced.trimEnabled }, snapshot), false, "fence rejects boolean delta");
	// The current side of the PUT handler always carries intentCandidates,
	// so a payload missing the field is a genuine conflict.
	const mergedLeft = { ...coerced, intentCandidates: undefined, wmHardTokens: coerced.wmHardTokens };
	delete mergedLeft.intentCandidates;
	assert.equal(sameValues(mergedLeft, snapshot), false, "missing field still conflicts");
	// Pinned guard properties (reviewer 2026-11-07): canonicalJson must keep
	// arrays order-sensitive and compare nested fields — relaxing either
	// would let real edits through the fence. Built on the merged baseline
	// (fenceLeft ≙ fenceRight) so the ONLY delta is the one under test; the
	// raw coerced/snapshot candidate arrays differ in content (derived
	// labels) and would make these asserts vacuously false.
	assert.ok(fenceLeft.intentCandidates.length >= 2, "precondition: at least two candidates");
	const reordered = {
		...fenceLeft,
		intentCandidates: [
			fenceLeft.intentCandidates[1],
			fenceLeft.intentCandidates[0],
			...fenceLeft.intentCandidates.slice(2),
		],
	};
	assert.equal(sameValues(reordered, fenceRight), false, "fence rejects candidate order delta");
	const nested = {
		...fenceLeft,
		intentCandidates: fenceLeft.intentCandidates.map((c, i) => (i === 0 ? { ...c, id: c.id + "-renamed" } : c)),
	};
	assert.equal(sameValues(nested, fenceRight), false, "fence rejects nested field delta");
});
