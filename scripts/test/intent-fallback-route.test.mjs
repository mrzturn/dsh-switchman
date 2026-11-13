/** Route serialization for the effort-bearing routes (host/routes.js):
 *  trimSideModel, trimFoldFallbackModel and intentFallbackRoute keep an
 *  optional effort through coerceValues (POST) and snapshotOf (GET);
 *  intentClassifierRoute stays effort-free; the intent fallback's effort is
 *  selected independently of intentClassifierEffort. The runtime checks below
 *  drive host/intent.js's auto adapter through applyIntent with a mock llm
 *  service, so the forwarded reasoningEffort is what the route stream sees. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceValues, snapshotOf } from "../../host/routes.js";
import { applyIntent } from "../../host/intent.js";

/** Baseline POST body: the GET snapshot of an empty config is a coerce-valid
 * values object; each test overrides only the routes under test. */
function baseValues(overrides = {}) {
	return { ...snapshotOf({}), ...overrides };
}

test("baseline GET snapshot of an empty config is POST-coercible", () => {
	assert.notEqual(coerceValues(baseValues()), null);
});

test("POST keeps an optional effort on trimSideModel, trimFoldFallbackModel and intentFallbackRoute", () => {
	const coerced = coerceValues(baseValues({
		trimSideModel: { provider: "s", model: "sm", effort: "medium" },
		trimFoldFallbackModel: { provider: "f", model: "fm", effort: "high" },
		intentFallbackRoute: { provider: "i", model: "im", effort: "low" },
	}));
	assert.notEqual(coerced, null);
	assert.deepEqual(coerced.trimSideModel, { provider: "s", model: "sm", effort: "medium" });
	assert.deepEqual(coerced.trimFoldFallbackModel, { provider: "f", model: "fm", effort: "high" });
	assert.deepEqual(coerced.intentFallbackRoute, { provider: "i", model: "im", effort: "low" });
});

test("POST drops effort from intentClassifierRoute while the classifier's own effort field survives", () => {
	const coerced = coerceValues(baseValues({
		intentClassifierRoute: { provider: "c", model: "cm", effort: "high" },
		intentClassifierEffort: "low",
	}));
	assert.notEqual(coerced, null);
	assert.deepEqual(coerced.intentClassifierRoute, { provider: "c", model: "cm" });
	assert.equal(coerced.intentClassifierEffort, "low");
});

test("intent fallback effort is selected independently of the classifier effort", () => {
	const coerced = coerceValues(baseValues({
		intentClassifierRoute: { provider: "c", model: "cm" },
		intentClassifierEffort: "low",
		intentFallbackRoute: { provider: "i", model: "im", effort: "high" },
	}));
	assert.notEqual(coerced, null);
	assert.equal(coerced.intentFallbackRoute.effort, "high");
	assert.equal(coerced.intentClassifierEffort, "low");
	assert.equal(Object.hasOwn(coerced.intentClassifierRoute, "effort"), false);
});

test("blank effort pins are not persisted on effort-bearing routes", () => {
	const coerced = coerceValues(baseValues({
		trimSideModel: { provider: "s", model: "sm", effort: "   " },
		intentFallbackRoute: { provider: "i", model: "im", effort: "" },
	}));
	assert.notEqual(coerced, null);
	assert.deepEqual(coerced.trimSideModel, { provider: "s", model: "sm" });
	assert.deepEqual(coerced.intentFallbackRoute, { provider: "i", model: "im" });
});

test("GET snapshot exposes each route's effort, keeps the classifier effort-free, and round-trips", () => {
	const config = {
		trimSideModel: { get: () => ({ provider: "s", model: "sm", effort: "medium" }) },
		trimFoldFallbackModel: { get: () => ({ provider: "f", model: "fm", effort: "high" }) },
		intentFallbackRoute: { get: () => ({ provider: "i", model: "im", effort: "low" }) },
		intentClassifierRoute: { get: () => ({ provider: "c", model: "cm", effort: "high" }) },
	};
	const snapshot = snapshotOf(config);
	assert.deepEqual(snapshot.trimSideModel, { provider: "s", model: "sm", effort: "medium" });
	assert.deepEqual(snapshot.trimFoldFallbackModel, { provider: "f", model: "fm", effort: "high" });
	assert.deepEqual(snapshot.intentFallbackRoute, { provider: "i", model: "im", effort: "low" });
	assert.deepEqual(snapshot.intentClassifierRoute, { provider: "c", model: "cm" });
	assert.notEqual(coerceValues(snapshot), null, "GET snapshot is POST-coercible");
});

/** Volatile config field: the live readers unwrap `{ get }` like the real config. */
function vol(value) {
	return { get: () => value };
}

/** Mount applyIntent against a mock llm service and return the registered auto
 *  adapter plus the options it forwards to llm.stream (the real routing path:
 *  stream -> routeAutoRequest -> decideRoute -> forwarded call). */
function mountAutoAdapter(config) {
	const calls = [];
	const mount = { adapter: null, calls };
	const llm = {
		registerAdapter(_providers, adapter) {
			mount.adapter = adapter;
			return () => {};
		},
		prepareCall() {},
		async *stream(options) {
			calls.push(options);
		},
	};
	const llmCtx = {
		llm,
		get: (name) => (name === "llm" ? llm : undefined),
		effect() {},
		on() {},
	};
	applyIntent({ logger: { warn() {} }, inject: (_names, fn) => fn(llmCtx) }, config);
	return mount;
}

/** Stream one request through the auto adapter with routing enabled but no
 *  classifier route: classification is skipped, so the decision is the
 *  configured intentFallbackRoute and no classifier call is made. Returns the
 *  single options object forwarded to llm.stream. */
async function forwardedFromFallback(fallbackRoute, classifierEffort, options = {}) {
	const mount = mountAutoAdapter({
		intentEnabled: vol(true),
		intentCandidates: vol([{ provider: "x", model: "y" }]),
		intentClassifierRoute: vol({ provider: "", model: "" }),
		intentClassifierKind: vol("chat"),
		intentClassifierEffort: vol(classifierEffort),
		intentFallbackRoute: vol(fallbackRoute),
		intentCacheTtlSeconds: vol(300),
		intentSwitchConfidence: vol(80),
	});
	assert.notEqual(mount.adapter, null, "precondition: applyIntent registers the auto adapter");
	for await (const _chunk of mount.adapter.stream(options)) {
		// drain: the mock llm.stream yields nothing
	}
	assert.equal(mount.calls.length, 1, "precondition: exactly one forwarded llm.stream call");
	return mount.calls[0];
}

test("intent runtime path forwards the configured fallback effort as reasoningEffort", async () => {
	const forwarded = await forwardedFromFallback({ provider: "i", model: "im", effort: "high" }, "");
	assert.equal(forwarded.provider, "i");
	assert.equal(forwarded.model, "im");
	assert.equal(forwarded.reasoningEffort, "high");
});

test("intent runtime fallback effort is independent of the classifier effort", async () => {
	const forwarded = await forwardedFromFallback({ provider: "i", model: "im", effort: "high" }, "low");
	assert.equal(forwarded.reasoningEffort, "high");
	assert.notEqual(forwarded.reasoningEffort, "low");
});

test("intent runtime omits reasoningEffort when the fallback route has no effort", async () => {
	const forwarded = await forwardedFromFallback({ provider: "i", model: "im" }, "low", { reasoningEffort: "medium" });
	assert.equal(forwarded.provider, "i");
	assert.equal(forwarded.model, "im");
	assert.equal(Object.hasOwn(forwarded, "reasoningEffort"), false);
});
