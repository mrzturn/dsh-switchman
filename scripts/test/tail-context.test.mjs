/** tail-context helper tests.
 *
 * Covers the registerTailContext contract for all six migrated modules:
 * (a) host with the runtime-context API → head section renders doctrine only
 *     and the tail context entry is registered with the payload closure;
 * (b) host without the API → head renders the legacy doctrine + "\n\n" +
 *     payload embedding, warn once, no context entry;
 * (c) context registration throwing → re-registration falls back to the
 *     legacy embedding;
 * (d) doctrine/payload closures throwing or returning non-strings → "" on
 *     both channels (fail-open);
 * (e) payload rendering "" → context entry still registered and renders zero
 *     bytes.
 * Registration flags (interpolate: false everywhere, required: true on the
 * context entry) and head-slot name/order pass-through are pinned too —
 * they are part of the cache-stability invariant.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { registerTailContext } from "../../host/tail-context.js";

/** Fake plugin context with both systemPrompt channels, recording every
 *  registration and every warning. `contextThrows` makes the context
 *  registration throw (case c). */
function fakeCtx({ withContextApi = true, contextThrows = false } = {}) {
	const sections = [];
	const contexts = [];
	const warnings = [];
	const ctx = {
		logger: { warn: (message) => warnings.push(message) },
		systemPrompt: {
			section: (section) => sections.push(section),
			...(withContextApi
				? {
						context: (entry) => {
							if (contextThrows) throw new Error("context registry exploded");
							contexts.push(entry);
						},
					}
				: {}),
		},
	};
	return { ctx, sections, contexts, warnings };
}

const ARGS = { agent: { id: "s1" }, scope: "root" };

test("with the context API: head renders doctrine only, tail entry carries the payload", () => {
	const { ctx, sections, contexts, warnings } = fakeCtx();
	registerTailContext(ctx, {
		sectionName: "switchman:constraints",
		sectionOrder: 10405,
		contextName: "switchman:constraints-live",
		contextOrder: 320,
		doctrine: () => "HEAD ANCHOR",
		payload: () => "LIVE PAYLOAD",
	});
	assert.equal(sections.length, 1);
	assert.equal(contexts.length, 1);
	assert.equal(warnings.length, 0);
	assert.deepEqual(
		{ name: sections[0].name, order: sections[0].order, interpolate: sections[0].interpolate },
		{ name: "switchman:constraints", order: 10405, interpolate: false },
	);
	assert.equal(sections[0].text(ARGS), "HEAD ANCHOR");
	assert.deepEqual(
		{ name: contexts[0].name, order: contexts[0].order, required: contexts[0].required, interpolate: contexts[0].interpolate },
		{ name: "switchman:constraints-live", order: 320, required: true, interpolate: false },
	);
	assert.equal(contexts[0].text(ARGS), "LIVE PAYLOAD");
});

test("without the context API: legacy embedding in the head, warn once, no context entry", () => {
	const { ctx, sections, contexts, warnings } = fakeCtx({ withContextApi: false });
	registerTailContext(ctx, {
		sectionName: "switchman:ptc-guard",
		sectionOrder: 10510,
		contextName: "switchman:ptc-ledger",
		contextOrder: 310,
		doctrine: () => "GUARD",
		payload: () => "LEDGER",
	});
	assert.equal(sections.length, 1);
	assert.equal(contexts.length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /systemPrompt\.context API unavailable/);
	assert.equal(sections[0].text(ARGS), "GUARD\n\nLEDGER");
});

test("without the context API and an empty payload: head renders doctrine alone", () => {
	const { ctx, sections, contexts } = fakeCtx({ withContextApi: false });
	registerTailContext(ctx, {
		sectionName: "switchman:pool-feedback",
		sectionOrder: 10406,
		contextName: "switchman:pool-feedback-live",
		contextOrder: 330,
		doctrine: () => "ANCHOR",
		payload: () => "",
	});
	assert.equal(contexts.length, 0);
	assert.equal(sections[0].text(ARGS), "ANCHOR");
});

test("context registration throwing: legacy embedding fallback via re-registration", () => {
	const { ctx, sections, contexts, warnings } = fakeCtx({ contextThrows: true });
	registerTailContext(ctx, {
		sectionName: "switchman:dispatch",
		sectionOrder: 10400,
		contextName: "switchman:dispatch-route",
		contextOrder: 350,
		doctrine: () => "POOLS",
		payload: () => "ROUTE LINE",
	});
	assert.equal(contexts.length, 0);
	assert.equal(sections.length, 2); // doctrine-only attempt + legacy re-registration
	assert.equal(sections[0].text(ARGS), "POOLS");
	assert.equal(sections[1].text(ARGS), "POOLS\n\nROUTE LINE");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /context entry registration failed/);
});

test("doctrine or payload closures throwing: empty string on both channels (fail-open)", () => {
	const { ctx, sections, contexts } = fakeCtx();
	registerTailContext(ctx, {
		sectionName: "switchman:teams",
		sectionOrder: 10250,
		contextName: "switchman:teams-hits",
		contextOrder: 360,
		doctrine: () => {
			throw new Error("doctrine exploded");
		},
		payload: () => "HIT DELTA",
	});
	registerTailContext(ctx, {
		sectionName: "switchman:lang",
		sectionOrder: 10300,
		contextName: "switchman:lang-ask",
		contextOrder: 370,
		doctrine: () => "LANG",
		payload: () => {
			throw new Error("payload exploded");
		},
	});
	assert.equal(sections[0].text(ARGS), "");
	assert.equal(contexts[0].text(ARGS), "HIT DELTA");
	assert.equal(sections[1].text(ARGS), "LANG");
	assert.equal(contexts[1].text(ARGS), "");
	// Legacy channel also fails open: a throwing payload contributes nothing.
	const legacy = fakeCtx({ withContextApi: false });
	registerTailContext(legacy.ctx, {
		sectionName: "switchman:lang",
		sectionOrder: 10300,
		contextName: "switchman:lang-ask",
		contextOrder: 370,
		doctrine: () => "LANG",
		payload: () => {
			throw new Error("payload exploded");
		},
	});
	assert.equal(legacy.sections[0].text(ARGS), "LANG");
});

test("non-string closure results normalize to empty strings", () => {
	const { ctx, sections, contexts } = fakeCtx();
	registerTailContext(ctx, {
		sectionName: "switchman:constraints",
		sectionOrder: 10405,
		contextName: "switchman:constraints-live",
		contextOrder: 320,
		doctrine: () => undefined,
		payload: () => 42,
	});
	assert.equal(sections[0].text(ARGS), "");
	assert.equal(contexts[0].text(ARGS), "");
});

test("empty payload: context entry stays registered and renders zero bytes", () => {
	const { ctx, sections, contexts } = fakeCtx();
	registerTailContext(ctx, {
		sectionName: "switchman:pool-differentiation",
		sectionOrder: 10407,
		contextName: "switchman:pool-diff-live",
		contextOrder: 340,
		doctrine: () => "ANCHOR",
		payload: () => "",
	});
	assert.equal(sections.length, 1);
	assert.equal(contexts.length, 1);
	assert.equal(contexts[0].text(ARGS), "");
});

test("section registration throwing warns and disables the layer without throwing", () => {
	const broken = {
		logger: { warn: (message) => broken.warnings.push(message) },
		warnings: [],
		systemPrompt: { section: () => { throw new Error("registry offline"); } },
	};
	assert.doesNotThrow(() =>
		registerTailContext(broken, {
			sectionName: "switchman:dispatch",
			sectionOrder: 10400,
			contextName: "switchman:dispatch-route",
			contextOrder: 350,
			doctrine: () => "POOLS",
			payload: () => "ROUTE",
		}),
	);
	// Legacy branch: capability warning first, then the registration failure.
	assert.equal(broken.warnings.length, 2);
	assert.match(broken.warnings[0], /systemPrompt\.context API unavailable/);
	assert.match(broken.warnings[1], /systemPrompt\.section registration failed/);
});

test("malformed call (non-function doctrine/payload) warns and mounts nothing", () => {
	const { ctx, sections, contexts, warnings } = fakeCtx();
	assert.doesNotThrow(() => registerTailContext(ctx, { doctrine: "nope", payload: () => "" }));
	assert.equal(sections.length, 0);
	assert.equal(contexts.length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /doctrine and payload must be functions/);
});

test("closures receive the assemble context verbatim (context?.agent reachability)", () => {
	const { ctx, sections, contexts } = fakeCtx();
	const seen = [];
	registerTailContext(ctx, {
		sectionName: "switchman:ptc-guard",
		sectionOrder: 10510,
		contextName: "switchman:ptc-ledger",
		contextOrder: 310,
		doctrine: (context) => {
			seen.push(context);
			return "G";
		},
		payload: (context) => {
			seen.push(context);
			return "P";
		},
	});
	sections[0].text(ARGS);
	contexts[0].text(ARGS);
	assert.deepEqual(seen, [ARGS, ARGS]);
});
