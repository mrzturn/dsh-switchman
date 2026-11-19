// Wiring tests for the dynamic watermark tier (refactor guide 2026-11-19 §4.3):
// internal function-level coverage — no live sessions, fake state objects only.
// Fixed-ladder behavior must stay byte-identical whenever the dynamic signal is
// off, silent, or failing (fail-open).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	combineTier,
	dynamicVerdictOf,
	recordSample,
	rootTierOf,
} from "../../host/context-watch.js";

const TH = { soft: 80000, hard: 100000, force: 200000 };

function fakeConfig(overrides = {}) {
	return {
		wmDynamicEnabled: true,
		wmDynamicTurnsExpected: 2,
		wmDynamicLookback: 6,
		wmDynamicOutPerM: 4,
		wmDynamicAmortization: 1.75,
		...overrides,
	};
}

function fakeState() {
	return { samples: new Map(), paused: new Set() };
}

test("recordSample: dedups within the min interval and caps capacity", () => {
	const t0 = 1_000_000;
	let buf = recordSample([], 1000, t0, 4);
	assert.equal(buf.length, 1);
	// same reading within the interval → no duplicate point
	buf = recordSample(buf, 1000, t0 + 1000, 4);
	assert.equal(buf.length, 1);
	// moved reading → appended
	buf = recordSample(buf, 1200, t0 + 1000, 4);
	assert.equal(buf.length, 2);
	// capacity trims the oldest
	for (let i = 0; i < 6; i++) buf = recordSample(buf, 1300 + i, t0 + 2000 + i * 60_000, 4);
	assert.ok(buf.length <= 4);
	// garbage readings leave the buffer content unchanged (fresh copy, no append)
	assert.deepEqual(recordSample(buf, Number.NaN, t0, 4), buf);
	assert.deepEqual(recordSample(buf, -5, t0, 4), buf);
	assert.deepEqual(recordSample("junk", 5, t0, 4), [{ t: t0, tokens: 5 }]); // fresh buffer from valid reading
});

test("combineTier: dynamic verdict lifts the tier and carries its reason", () => {
	// growth lifts soft → hard, reason passes through
	assert.deepEqual(combineTier("soft", { advance: "hard", reason: "dynamic_growth" }), {
		level: "hard",
		reason: "dynamic_growth",
	});
	// ok → force lift
	assert.deepEqual(combineTier("ok", { advance: "force", reason: "dynamic_growth" }).level, "force");
	// tie keeps the fixed wording (reason dropped)
	assert.deepEqual(combineTier("hard", { advance: "hard", reason: "dynamic_growth" }), {
		level: "hard",
		reason: null,
	});
	// fixed dominance keeps the fixed tier and wording
	assert.deepEqual(combineTier("force", { advance: "hard", reason: "dynamic_growth" }), {
		level: "force",
		reason: null,
	});
	// no verdict / garbage verdict → fixed tier, fail-open
	assert.deepEqual(combineTier("soft", null), { level: "soft", reason: null });
	assert.deepEqual(combineTier("soft", { advance: 42 }), { level: "soft", reason: null });
});

test("dynamicVerdictOf: silent on no-signal inputs, fail-open on estimator errors", () => {
	// no samples yet / no reading / no config → null (fixed ladder only)
	assert.equal(dynamicVerdictOf({ samples: [], used: 50000, th: TH, dynamic: fakeConfig() }), null);
	assert.equal(dynamicVerdictOf({ samples: [], used: null, th: TH, dynamic: fakeConfig() }), null);
	assert.equal(dynamicVerdictOf({ samples: [], used: 50000, th: TH, dynamic: null }), null);
	// estimator throwing internally → null, never a crash
	const hostile = new Proxy([], { get() { throw new Error("boom"); } });
	assert.equal(dynamicVerdictOf({ samples: hostile, used: 50000, th: TH, dynamic: fakeConfig() }), null);
});

test("fixed ladder is untouched: flat samples and disabled switch both no-op", () => {
	const state = fakeState();
	const config = fakeConfig();
	// flat history → estimator silent → exact fixed tier
	assert.deepEqual(rootTierOf(state, config, "s", 50000, TH, false), { level: "ok", reason: null });
	assert.deepEqual(rootTierOf(state, config, "s", 90000, TH, false), { level: "soft", reason: null });
	// disabled switch → no computation AND no sample recorded
	const off = fakeState();
	const offCfg = fakeConfig({ wmDynamicEnabled: false });
	assert.deepEqual(rootTierOf(off, offCfg, "s", 90000, TH), { level: "soft", reason: null });
	assert.equal(off.samples.size, 0);
	// paused session behaves like the fixed-only ladder too
	const paused = fakeState();
	paused.paused.add("s");
	assert.deepEqual(rootTierOf(paused, config, "s", 90000, TH, false), { level: "soft", reason: null });
});

test("growth signal lifts fixed ok/soft into hard/force with the dynamic reason", () => {
	const config = fakeConfig({ wmDynamicTurnsExpected: 2 });
	const state = fakeState();
	// ~20k tokens per sampled turn → hard is 1 turn away from 90k (fixed soft)
	state.samples.set("s1", [
		{ t: 1000000, tokens: 60000 },
		{ t: 1060000, tokens: 80000 },
		{ t: 1120000, tokens: 100000 },
	]);
	const lifted = rootTierOf(state, config, "s1", 90000, TH, false);
	assert.deepEqual(lifted, { level: "hard", reason: "dynamic_growth" });

	// huge per-turn growth reaches force from an ok fixed tier
	const state2 = fakeState();
	state2.samples.set("s2", [
		{ t: 1000000, tokens: 40000 },
		{ t: 1060000, tokens: 150000 },
	]);
	const forced = rootTierOf(state2, config, "s2", 50000, TH, false);
	assert.equal(forced.level, "force");
	assert.equal(forced.reason, "dynamic_growth");
});

test("fail-open: hostile state degrades to the fixed ladder", () => {
	const state = fakeState();
	state.samples = new Proxy(new Map(), { get() { throw new Error("boom"); } });
	assert.deepEqual(rootTierOf(state, fakeConfig(), "s", 90000, TH, false), { level: "soft", reason: null });
});
