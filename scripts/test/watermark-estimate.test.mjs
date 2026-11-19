/** Unit tests for the dynamic watermark estimator (P0-3 of the 2026-11-19
 *  refactor guide, §4.3). Covers tier severity, growth-rate estimation,
 *  the turns-expected heuristic, growth extrapolation, the incremental
 *  cost comparison (including the guide §2.3 magnitude claim: at the 1:50
 *  cache price ratio a short horizon must NOT trigger), and the
 *  advance-is-never-below-soft cap for the cost signal. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	costStay,
	costSwitch,
	estimateGrowthRate,
	estimateMissProbability,
	estimateTurnsExpected,
	evaluateDynamicWatermark,
	maxTier,
	turnsToThreshold,
} from "../../host/watermark-estimate.js";

function series(tokens, stepMs = 60_000) {
	return tokens.map((tokens_, i) => ({ t: 1_000_000 + i * stepMs, tokens: tokens_ }));
}

const TH = { soft: 80_000, hard: 100_000, force: 200_000 };
// Guide §2.3 prices: hit 0.02 ¥/M, miss 1 ¥/M, blended output 8 ¥/M.
const PRICES = { hitPerM: 0.02, missPerM: 1, outPerM: 8, amortization: 1.75, turnsExpected: 0, lookback: 6 };

test("maxTier severity order", () => {
	assert.equal(maxTier("ok", "soft"), "soft");
	assert.equal(maxTier("soft", "force"), "force");
	assert.equal(maxTier("hard", "soft"), "hard");
	assert.equal(maxTier("force", "force"), "force");
	assert.equal(maxTier("ok", "ok"), "ok");
	assert.equal(maxTier("bogus", "hard"), "hard");
});

test("estimateGrowthRate: linear series, negative floor, unsorted input, too few samples", () => {
	const rising = estimateGrowthRate(series([50_000, 52_000, 54_000, 56_000]), 6);
	assert.equal(rising.growthRate, 2000);
	assert.equal(rising.samplesUsed, 4);
	// Folds outpacing growth floor at 0 (never projects earlier tiers).
	const shrinking = estimateGrowthRate(series([100_000, 90_000, 80_000]), 6);
	assert.equal(shrinking.growthRate, 0);
	// Unordered input is sorted by t first.
	const unsorted = estimateGrowthRate([{ t: 3, tokens: 30_000 }, { t: 1, tokens: 10_000 }, { t: 2, tokens: 20_000 }]);
	assert.equal(unsorted.growthRate, 10_000);
	// Below MIN_GROWTH_SAMPLES → null.
	assert.equal(estimateGrowthRate([{ t: 1, tokens: 1 }]).growthRate, null);
	assert.equal(estimateGrowthRate(null).growthRate, null);
	// Lookback window keeps only the last lookback+1 points.
	const long = estimateGrowthRate(series([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]), 3);
	assert.equal(long.samplesUsed, 4);
	assert.equal(long.growthRate, 1000);
});

test("estimateTurnsExpected: config wins, cadence heuristic clamped, fallback", () => {
	assert.equal(estimateTurnsExpected([], 42), 42);
	assert.equal(estimateTurnsExpected(null, 0), 25);
	// 60s cadence → 300s TTL / 60s = 5 turns (floor).
	assert.equal(estimateTurnsExpected(series([1, 2, 3, 4], 60_000), 0), 5);
	// 5s cadence → 60 turns by formula, clamped to ceil 100 → stays 60.
	assert.equal(estimateTurnsExpected(series([1, 2, 3, 4], 5_000), 0), 60);
	// Identical timestamps → no usable gaps → fallback.
	assert.equal(estimateTurnsExpected(series([1, 2, 3], 0), 0), 25);
});

test("estimateMissProbability: cadence share of gaps ≥ TTL/2, fail-closed", () => {
	// 60s cadence: no gap reaches 150s → 0.
	assert.equal(estimateMissProbability(series([1, 2, 3, 4], 60_000)), 0);
	// 200s cadence: every gap ≥ 150s → 1.
	assert.equal(estimateMissProbability(series([1, 2, 3, 4], 200_000)), 1);
	// Mixed cadence: half the gaps cold.
	const mixed = [
		{ t: 0, tokens: 1 },
		{ t: 200_000, tokens: 2 },
		{ t: 260_000, tokens: 3 },
	];
	assert.equal(estimateMissProbability(mixed), 0.5);
	assert.equal(estimateMissProbability(null), 0);
	assert.equal(estimateMissProbability([{ t: 1, tokens: 1 }]), 0);
});
test("turnsToThreshold basics", () => {
	assert.equal(turnsToThreshold(50_000, 5_000, 100_000), 10);
	assert.equal(turnsToThreshold(100_000, 5_000, 100_000), 0);
	assert.equal(turnsToThreshold(50_000, 0, 100_000), null);
	assert.equal(turnsToThreshold(50_000, null, 100_000), null);
	assert.equal(turnsToThreshold(50_000, 49_999, 100_000), 2);
});

test("growth signal: extrapolation past hard/force advances within horizon", () => {
	// used 60k, g 5k, N 10 → 110k ≥ hard 100k → hard (force at 200k needs 28 turns).
	const hard = evaluateDynamicWatermark({
		samples: series([45_000, 50_000, 55_000, 60_000]),
		used: 60_000,
		thresholds: TH,
		dynamic: { ...PRICES, turnsExpected: 10 },
	});
	assert.equal(hard.advance, "hard");
	assert.equal(hard.reason, "dynamic_growth");
	assert.equal(hard.turnsTo.hard, 8);
	// used 150k, g 6k, N 10 → 210k ≥ force → force.
	const force = evaluateDynamicWatermark({
		samples: series([135_000, 141_000, 147_000, 150_000]),
		used: 150_000,
		thresholds: TH,
		dynamic: { ...PRICES, turnsExpected: 10 },
	});
	assert.equal(force.advance, "force");
	assert.equal(force.reason, "dynamic_growth");
	// Slow growth never crosses within horizon → none.
	const calm = evaluateDynamicWatermark({
		samples: series([50_000, 50_500, 51_000]),
		used: 51_000,
		thresholds: TH,
		dynamic: { ...PRICES, turnsExpected: 10 },
	});
	assert.equal(calm.advance, "none");
	assert.equal(calm.reason, null);
});

test("cost signal: guide §2.3 magnitude — default prices stay structurally silent", () => {
	// used 95k (below hard), g 150 (hard needs 34 turns > N 25 → growth
	// silent), 60s cadence (missProbability 0), default 1:50 prices: the
	// symmetric streams plus the 1.75 amortization pad make staying
	// structurally cheaper — the signal stays silent.
	const short = evaluateDynamicWatermark({
		samples: series([93_550, 93_700, 93_850, 94_000]),
		used: 95_000,
		thresholds: TH,
		dynamic: { ...PRICES, turnsExpected: 25 },
	});
	assert.equal(short.advance, "none");
	assert.equal(short.cost, null);
	// Hand-verified cost decomposition at these numbers.
	const hit = 0.02 / 1e6;
	const out = (600 * 8) / 1e6;
	const stay = costStay({ used: 200_000, growthRate: 1000, turns: 25, hitPrice: hit, outputCostPerTurn: out });
	const sw = costSwitch({ used: 200_000, growthRate: 1000, turns: 25, hitPrice: hit, outputCostPerTurn: out, missPrice: 1 / 1e6, outPrice: 8 / 1e6 });
	assert.ok(Math.abs(stay - 0.226) < 1e-6, `stay ${stay}`);
	assert.ok(Math.abs(sw.handoff - 0.112) < 1e-6, `handoff ${sw.handoff}`);
	assert.ok(Math.abs(sw.total - 0.288) < 1e-6, `switch ${sw.total}`);
});

test("cost signal: cold cadence + cheap output fires and caps at soft", () => {
	// used 90k (below every fixed tier), g 200 (hard needs 50 turns > N 25 →
	// growth silent), 200s cadence (missProbability 1 → stay carries the
	// expected full-prefix repay), output 0.5 ¥/M (weakens the shared stream
	// that otherwise always favors staying): stay ~0.089 > switch
	// ~0.0461×1.75 ~ 0.081. Cost advances exactly one tier, soft.
	const fired = evaluateDynamicWatermark({
		samples: series([89_400, 89_600, 89_800, 90_000], 200_000),
		used: 90_000,
		thresholds: TH,
		dynamic: { ...PRICES, outPerM: 0.5, turnsExpected: 25 },
	});
	assert.equal(fired.advance, "soft");
	assert.equal(fired.reason, "dynamic_cost");
	assert.ok(fired.cost, "cost verdict recorded");
	assert.equal(fired.cost.missProbability, 1);
	assert.ok(fired.cost.stay > fired.cost.switch * 1.75);
	// Even when the cost verdict is positive, growth-driven hard/force wins.
	// g 4500 → force in exactly 25 turns; miss 5 ¥/M makes the stay-side
	// expected repay (0.445) beat the amortized switch (~0.49): both fire.
	const both = evaluateDynamicWatermark({
		samples: series([75_500, 80_000, 84_500, 89_000], 200_000),
		used: 89_000,
		thresholds: TH,
		dynamic: { hitPerM: 0.02, missPerM: 5, outPerM: 0.5, amortization: 1.75, turnsExpected: 25, lookback: 6 },
	});
	assert.equal(both.advance, "force");
	assert.equal(both.reason, "dynamic_growth");
	assert.ok(both.cost, "cost verdict still recorded alongside");
});

test("evaluateDynamicWatermark: degenerate inputs stay harmless", () => {
	const empty = evaluateDynamicWatermark({ samples: [], used: 50_000, thresholds: TH, dynamic: PRICES });
	assert.equal(empty.advance, "none");
	assert.equal(empty.growthRate, null);
	assert.equal(empty.turnsExpected, 25);
	const broken = evaluateDynamicWatermark({ samples: undefined, used: NaN, thresholds: null, dynamic: null });
	assert.equal(broken.advance, "none");
});
