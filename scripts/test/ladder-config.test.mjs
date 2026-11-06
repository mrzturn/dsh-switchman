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
import { coerceValues, snapshotOf } from "../../host/routes.js";

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
});

test("trim field bounds reject out-of-schema values", () => {
	assert.equal(coerceValues(fullValues({ trimPressurePercent: 0 })), null, "pressure below the schema minimum");
	assert.equal(coerceValues(fullValues({ trimEmergencyPercent: 101 })), null, "emergency above 100");
	assert.equal(coerceValues(fullValues({ trimLadderT2MinBlocks: 1 })), null, "degenerate two-block distills are below the floor");
	assert.equal(coerceValues(fullValues({ trimMaxFoldsPerHour: 61 })), null, "hourly cap above the schema maximum");
	assert.equal(coerceValues(fullValues({ trimMode: "yolo" })), null, "unknown mode rejected");
	assert.equal(coerceValues(fullValues({ trimGrowthTokens: "many" })), null, "non-numeric rejected");
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
