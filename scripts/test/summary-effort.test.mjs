/** Regression tests for summary side-model effort selection in
 *  host/context-trim/summarizer.js: the lowest thinking-enabled tier wins when
 *  several tiers are enabled, a single on/off toggle or off-only model pins
 *  thinking off, metadata-less models leave the adapter default untouched,
 *  explicit pins are honored, and an unsupported-effort retry never turns an
 *  explicit "off" into enabled reasoning. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendedReasoningEffort, summarizeWithModel } from "../../host/context-trim/summarizer.js";

const ROUTE = { provider: "p", model: "m" };

/** Fake dsh llm service: resolveModelInfo returns info (or throws infoError);
 * prepareCall records each proposal and rejects with the next queued error. */
function fakeLlm({ info, infoError = null, rejections = [] } = {}) {
	const proposals = [];
	const queue = [...rejections];
	const llm = {
		resolveModelInfo: async () => {
			if (infoError) throw infoError;
			return info;
		},
		prepareCall: async (proposal) => {
			proposals.push(proposal);
			if (queue.length > 0) throw queue.shift();
			return { config: {}, stream: async function* () {
				yield { type: "text-delta", text: "Summary." };
				yield { type: "finish", reason: { kind: "stop" } };
			} };
		},
	};
	return { llm, proposals };
}

const unsupported = () => Object.assign(new Error("UNSUPPORTED_REASONING_EFFORT"), { code: "UNSUPPORTED_REASONING_EFFORT" });
const withEfforts = (efforts) => ({ context: { contextWindow: 100_000 }, reasoning: { efforts } });

test("recommendedReasoningEffort picks the lowest enabled tier when several are enabled", () => {
	assert.equal(recommendedReasoningEffort(withEfforts([{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }])), "low");
	assert.equal(recommendedReasoningEffort(withEfforts(["off", "medium", "max"])), "medium");
});

test("recommendedReasoningEffort pins off for a single on/off toggle, off-only, or no metadata", () => {
	assert.equal(recommendedReasoningEffort(withEfforts([{ id: "off" }, { id: "max" }])), "off", "single thinking toggle");
	assert.equal(recommendedReasoningEffort(withEfforts(["off", "max"])), "off", "single thinking toggle (string form)");
	assert.equal(recommendedReasoningEffort(withEfforts([{ id: "off" }])), "off", "off-only model");
	assert.equal(recommendedReasoningEffort(undefined), null, "no metadata");
	assert.equal(recommendedReasoningEffort({ context: { contextWindow: 1 } }), null, "no reasoning key");
	assert.equal(recommendedReasoningEffort(withEfforts([])), null, "empty efforts");
});

test("recommendedReasoningEffort ignores malformed effort entries", () => {
	assert.equal(recommendedReasoningEffort(withEfforts([{ name: "no id" }, "", { id: "low" }, { id: "high" }])), "low");
	assert.equal(recommendedReasoningEffort(withEfforts([{ name: "no id" }, "", { id: "off" }, { id: "max" }])), "off");
});

test("summary with no pin sends the model's lowest enabled tier", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "low" }, { id: "high" }]) });
	assert.equal(await summarizeWithModel(llm, ROUTE, "material"), "Summary.");
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0].reasoningEffort, "low");
	assert.equal(proposals[0].provider, "p");
	assert.equal(proposals[0].model, "m");
});

test("summary on a single thinking toggle leaves thinking off", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "max" }]) });
	await summarizeWithModel(llm, ROUTE, "material");
	assert.equal(proposals[0].reasoningEffort, "off");
});

test("summary with no reasoning metadata sends no effort at all", async () => {
	const { llm, proposals } = fakeLlm({ info: { context: { contextWindow: 100_000 } } });
	await summarizeWithModel(llm, ROUTE, "material");
	assert.equal(Object.hasOwn(proposals[0], "reasoningEffort"), false);
});

test("summary whose metadata lookup throws still summarizes, without effort", async () => {
	const { llm, proposals } = fakeLlm({ infoError: new Error("metadata offline") });
	assert.equal(await summarizeWithModel(llm, ROUTE, "material"), "Summary.");
	assert.equal(Object.hasOwn(proposals[0], "reasoningEffort"), false);
});

test("summary on an off-only model pins off, never a higher tier", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }]) });
	await summarizeWithModel(llm, ROUTE, "material");
	assert.equal(proposals[0].reasoningEffort, "off");
});

test("an explicit pin wins over the model's automatic tier", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "low" }, { id: "high" }]) });
	await summarizeWithModel(llm, { ...ROUTE, effort: "high" }, "material");
	assert.equal(proposals[0].reasoningEffort, "high");
});

test("an explicit off pin is honored, not replaced by the automatic tier", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "low" }]) });
	await summarizeWithModel(llm, { ...ROUTE, effort: "off" }, "material");
	assert.equal(proposals[0].reasoningEffort, "off");
});

test("an unsupported explicit pin retries once at the automatic minimum", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "low" }, { id: "high" }]), rejections: [unsupported()] });
	assert.equal(await summarizeWithModel(llm, { ...ROUTE, effort: "max" }, "material"), "Summary.");
	assert.deepEqual(proposals.map((p) => p.reasoningEffort), ["max", "low"]);
});

test("an unsupported explicit pin with no automatic tier retries without effort", async () => {
	const { llm, proposals } = fakeLlm({ info: undefined, rejections: [unsupported()] });
	assert.equal(await summarizeWithModel(llm, { ...ROUTE, effort: "max" }, "material"), "Summary.");
	assert.equal(proposals[0].reasoningEffort, "max");
	assert.equal(Object.hasOwn(proposals[1], "reasoningEffort"), false);
});

test("an unsupported explicit off pin retries without effort and never enables reasoning", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "off" }, { id: "low" }]), rejections: [unsupported()] });
	assert.equal(await summarizeWithModel(llm, { ...ROUTE, effort: "off" }, "material"), "Summary.");
	assert.equal(proposals[0].reasoningEffort, "off");
	assert.equal(Object.hasOwn(proposals[1], "reasoningEffort"), false);
});

test("a non-effort prepare failure is not retried and yields null", async () => {
	const { llm, proposals } = fakeLlm({ info: withEfforts([{ id: "low" }]), rejections: [new Error("provider down")] });
	assert.equal(await summarizeWithModel(llm, ROUTE, "material"), null);
	assert.equal(proposals.length, 1);
});
