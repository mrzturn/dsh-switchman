/** Subagent watermark tier scaling: scaleSubagentTiers must shrink force to
 *  windowTokens × ratio and shrink soft/hard by the same factor so tier
 *  spacing (soft < hard < force) survives; a null/tiny window or a cap at or
 *  above the static force must leave the tiers untouched (fail-open).
 *
 *  Regression guard for the v1.11 fix: renderWatermarkContext previously
 *  gated on the ROOT thresholds before the subagent branch, so a small-window
 *  child with scaled force (e.g. 24k) saw no watermark line until it crossed
 *  the root soft tier (~80k) — by which point it was 3× past its own force
 *  tier and the harness had already begun force-folding its context.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { scaleSubagentTiers } from "../../host/context-watch.js";

// Defaults mirroring readThresholds fallbacks (wmSoft=80k, wmHard=120k, wmForce=150k).
const BASE = { soft: 80000, hard: 120000, force: 150000 };

test("scaling caps force at window × ratio and shrinks soft/hard by the same factor", () => {
	// 24k window × 0.75 → cap 18000; factor 0.12 → soft 9600, hard 14400.
	const scaled = scaleSubagentTiers(BASE, 24000, 0.75);
	assert.deepEqual(scaled, { soft: 9600, hard: 14400, force: 18000 });
});

test("tier ordering and spacing survive the shrink", () => {
	const scaled = scaleSubagentTiers(BASE, 60000, 0.75);
	assert.ok(scaled.soft < scaled.hard && scaled.hard < scaled.force, "soft < hard < force");
	// Ratios of the tiers to force stay ~constant (floor rounding aside).
	assert.ok(Math.abs(scaled.soft / scaled.force - BASE.soft / BASE.force) < 0.01);
	assert.ok(Math.abs(scaled.hard / scaled.force - BASE.hard / BASE.force) < 0.01);
});

test("large window (cap ≥ static force) leaves tiers unchanged", () => {
	assert.deepEqual(scaleSubagentTiers(BASE, 400000, 0.75), BASE);
});

test("null window leaves tiers unchanged", () => {
	assert.deepEqual(scaleSubagentTiers(BASE, null, 0.75), BASE);
});

test("tiny window below the 3000 floor skips scaling (fail-open)", () => {
	assert.deepEqual(scaleSubagentTiers(BASE, 2000, 0.75), BASE);
});

test("floors keep soft/hard positive under extreme shrink", () => {
	const scaled = scaleSubagentTiers(BASE, 20000, 0.1); // cap 2000 < 3000 → unchanged
	assert.deepEqual(scaled, BASE);
	// A cap just above the floor: factor = 3150/150000 = 0.021.
	const near = scaleSubagentTiers(BASE, 4200, 0.75); // cap 3150
	assert.equal(near.force, 3150);
	assert.equal(near.soft, 1680);
	assert.equal(near.hard, 2520);
	assert.ok(near.soft < near.hard && near.hard < near.force);
	// Floors engage when the factor is tiny relative to the soft/hard values.
	const floored = scaleSubagentTiers({ soft: 1200, hard: 2500, force: 40000 }, 4000, 0.75);
	assert.deepEqual(floored, { soft: 1000, hard: 2000, force: 3000 });
});

test("custom subForce override still scales the soft/hard companions", () => {
	// wmSubagentForceTokens pre-set force to 30000; window 20000 × 0.75 → 15000 cap.
	const scaled = scaleSubagentTiers({ ...BASE, force: 30000 }, 20000, 0.75);
	assert.deepEqual(scaled, { soft: 40000, hard: 60000, force: 15000 });
});

test("does not mutate the input tiers", () => {
	const input = { ...BASE };
	scaleSubagentTiers(input, 24000, 0.75);
	assert.deepEqual(input, BASE);
});
