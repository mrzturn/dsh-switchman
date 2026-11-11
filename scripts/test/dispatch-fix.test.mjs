/** Dispatch field-shape sanitation + teams-first doctrine tests.
 *
 *  Regression guard for the 2026-11-11 incident: pool-table routes render
 *  as one display string `provider/model(TIER)@effort`, but the subagent
 *  tool schema takes SEPARATE provider/model fields. Production session
 *  logs show models repeating four doomed shapes (2-4 blind retries each):
 *  a merged "provider/model" string with provider omitted, a bare model
 *  with provider omitted, a model still carrying its "provider/" prefix,
 *  and a provider-less list_subagent_models call. The pre-execute
 *  sanitation must deny each with the exact corrected fields; well-formed
 *  and unknown-id calls must still pass through untouched, and the
 *  annotated-copy fix keeps priority over the shape fix.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDispatch } from "../../host/dispatch.js";
import { TEAMS_SECTION_TEXT } from "../../host/teams.js";

/** Mount applyDispatch on a recording ctx and return the captured
 *  pre-execute handler plus the pools-section renderer. */
function mount(config) {
	const listeners = new Map();
	let sectionText = null;
	const warns = [];
	const ctx = {
		on: (name, handler) => listeners.set(name, handler),
		get: () => undefined,
		logger: { warn: (msg) => warns.push(String(msg)) },
		systemPrompt: {
			section: (spec) => {
				if (spec.name === "switchman:dispatch") sectionText = spec.text;
			},
		},
	};
	applyDispatch(ctx, config);
	return {
		preExecute: listeners.get("tools/pre-execute"),
		poolsText: (context = null) => sectionText(context),
		warns,
	};
}

/** One dispatch-pool config: two zai routes in economy (one shared model
 *  name with github-copilot for the multi-provider case), distinct routes
 *  elsewhere. */
function baseConfig(overrides = {}) {
	return {
		poolEconomy: [
			{ provider: "zai-coding-cn", model: "glm-5.3-flash" },
			{ provider: "zai-coding-cn", model: "glm-5.3-flashx" },
		],
		poolMechanical: [{ provider: "github-copilot", model: "claude-haiku-5.5" }],
		poolMain: [{ provider: "github-copilot", model: "glm-5.3-flash" }],
		poolHard: [], poolVision: [], poolReview: [],
		poolEconomyManual: false, poolMechanicalManual: false, poolMainManual: false,
		poolHardManual: false, poolVisionManual: false, poolReviewManual: false,
		poolEconomyEfforts: [], poolMechanicalEfforts: [], poolMainEfforts: [],
		poolHardEfforts: [], poolVisionEfforts: [], poolReviewEfforts: [],
		modelRank: [],
		dispatchEnforce: "off",
		teamsMode: false,
		...overrides,
	};
}

const NEXT = Symbol("next");
const next = () => NEXT;
const call = (handler, name, args) => handler({ name, arguments: args }, next);

test("merged provider/model string with provider omitted is denied with the split fields", () => {
	const { preExecute } = mount(baseConfig());
	// Exact 22:18:06 production failure.
	const result = call(preExecute, "subagent", { model: "zai-coding-cn/glm-5.3-flash", reasoning_effort: "high" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /merges provider and model into one string/);
	assert.match(result.reason, /provider "zai-coding-cn", model "glm-5\.3-flash"/);
	assert.match(result.reason, /configured pool route zai-coding-cn\/glm-5\.3-flash/);
});

test("merged string whose split matches no pool still denies (DSH rejects it regardless)", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "subagent_fork", { model: "unknown-prov/some-model" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /provider "unknown-prov", model "some-model"/);
	assert.match(result.reason, /not authorized for this session, the re-dispatch error will say so/);
});

test("model still carrying its provider prefix is denied with the prefix stripped", () => {
	const { preExecute } = mount(baseConfig());
	// Exact 23:45:50 production failure (double prefix).
	const result = call(preExecute, "subagent", {
		provider: "zai-coding-cn",
		model: "zai-coding-cn/glm-5.3-flash",
		reasoning_effort: "high",
	});
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /already carries the provider prefix/);
	assert.match(result.reason, /resolves to the route "zai-coding-cn\/zai-coding-cn\/glm-5\.3-flash"/);
	assert.match(result.reason, /provider "zai-coding-cn", model "glm-5\.3-flash"/);
});

test("bare model with provider omitted resolves a unique configured provider", () => {
	const { preExecute } = mount(baseConfig());
	// Exact 21:23:56 production failure.
	const result = call(preExecute, "subagent", { model: "claude-haiku-5.5", reasoning_effort: "xhigh" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /provider field is missing/);
	assert.match(result.reason, /provider "github-copilot", model "claude-haiku-5\.5"/);
});

test("bare model configured under several providers lists the candidates", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "subagent", { model: "glm-5.3-flash" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /configured under several providers \(zai-coding-cn, github-copilot\)/);
});

test("bare model unknown to every pool passes through for DSH's own error", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "subagent", { model: "totally-unknown-model" });
	assert.equal(result, NEXT);
});

test("well-formed calls pass untouched (subagent and subagent_fork)", () => {
	const { preExecute } = mount(baseConfig());
	assert.equal(call(preExecute, "subagent", { provider: "zai-coding-cn", model: "glm-5.3-flash" }), NEXT);
	assert.equal(call(preExecute, "subagent", { provider: "github-copilot", model: "gpt-9-imaginary" }), NEXT);
	assert.equal(call(preExecute, "subagent_fork", { provider: "github-copilot", model: "claude-haiku-5.5" }), NEXT);
	assert.equal(call(preExecute, "subagent", {}), NEXT);
	assert.equal(call(preExecute, "subagent", { provider: "p", model: "p/exotic/kept" }), NEXT);
});

test("annotated whole-cell copy still takes the annotation fix, not the shape fix", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "subagent", { model: "glm-5.3-flash(A)@high" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /embeds pool-table display annotations/);
	// Prefixed AND annotated copy is also the annotation fix.
	const prefixed = call(preExecute, "subagent", { model: "zai-coding-cn/glm-5.3-flash(A)@high" });
	assert.equal(prefixed.kind, "deny");
	assert.match(prefixed.reason, /embeds pool-table display annotations/);
});

test("provider-given model naming another provider's configured route is denied with that pair", () => {
	const { preExecute, warns } = mount(baseConfig());
	const result = call(preExecute, "subagent", { provider: "zai-coding-cn", model: "github-copilot/gpt-6-luna" });
	// Explicit pass-through, not the fail-open catch: the warn list must stay empty.
	assert.equal(result, NEXT);
	assert.deepEqual(warns, []);
	const known = call(preExecute, "subagent", { provider: "zai-coding-cn", model: "github-copilot/claude-haiku-5.5" });
	assert.equal(known.kind, "deny");
	assert.match(known.reason, /embeds another provider's route/);
	assert.match(known.reason, /provider "github-copilot", model "claude-haiku-5\.5"/);
});

test("list_subagent_models without provider is denied with the provider list", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "list_subagent_models", {});
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /list_subagent_models requires a non-empty provider/);
	assert.match(result.reason, /Providers configured on this session's pools: zai-coding-cn, github-copilot/);

	const byModel = call(preExecute, "list_subagent_models", { model: "glm-5.3-flash" });
	assert.equal(byModel.kind, "deny");
	assert.match(byModel.reason, /configured under several providers/);

	assert.equal(call(preExecute, "list_subagent_models", { provider: "zai-coding-cn" }), NEXT);
	assert.equal(call(preExecute, "list_subagent_models", { provider: "zai-coding-cn", model: "glm-5.3-flash" }), NEXT);
});

test("enforce gate still denies out-of-pool routes after the sanitation changes", () => {
	const { preExecute } = mount(baseConfig({ dispatchEnforce: "enforce" }));
	const result = call(preExecute, "subagent", { provider: "unknown-prov", model: "some-model" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /outside every configured pool and modelRank/);
});

test("pools guidance renders the separate-fields example and the restored lines", () => {
	const { poolsText } = mount(baseConfig());
	const text = poolsText();
	assert.match(text, /Decompose into SEPARATE tool fields: provider\/model\(TIER\)@effort → \{"provider":"<provider>","model":"<model>","reasoning_effort":"<effort>"\}/);
	assert.match(text, /The table cell is ONE display string, never a field value/);
	assert.match(text, /list_subagent_models verifies authorized routes before dispatching/);
	// Lines that must survive the text reshuffle.
	assert.match(text, /When delegating via subagent\/workflow, pick a model from the lane/);
	assert.match(text, /Lanes marked \* are in manual order/);
	assert.match(text, /effort: economy=medium mechanical=medium main=medium/);
});

test("teams doctrine makes Agent Teams the default channel with an explicit fallback", () => {
	assert.ok(TEAMS_SECTION_TEXT.includes("派发通道优先级"), "doctrine states the teams-first priority");
	assert.ok(TEAMS_SECTION_TEXT.includes("一切子任务委派默认走 Agent Teams"), "default channel is Agent Teams");
	assert.ok(TEAMS_SECTION_TEXT.includes("teams 不可用即降级，不重试"), "fallback rule present");
	assert.ok(TEAMS_SECTION_TEXT.includes("直接改用 subagent/subagent_fork 派发并继续工作"), "fallback names the subagent channel");
	// The superseded default split must be gone from the trigger bullet.
	assert.ok(!TEAMS_SECTION_TEXT.includes("一次性、无需共享状态的单点调查用 subagent。\","), "old subagent-default bullet removed");
});

test("leading-slash model passes through instead of recommending the malformed id back", () => {
	const { preExecute, warns } = mount(baseConfig());
	// Folding would silently strip the slash and match the pool; the old
	// code then denied with the malformed id, which DSH would reject again.
	const result = call(preExecute, "subagent", { model: "/glm-5.3-flash" });
	assert.equal(result, NEXT);
	assert.deepEqual(warns, []);
});

test("double-slash merged string passes through instead of a trailing-slash provider fix", () => {
	const { preExecute, warns } = mount(baseConfig());
	const result = call(preExecute, "subagent", { model: "zai-coding-cn//glm-5.3-flash" });
	assert.equal(result, NEXT);
	assert.deepEqual(warns, []);
});

test("out-of-pool annotated merged copy recommends the stripped model", () => {
	const { preExecute } = mount(baseConfig());
	const result = call(preExecute, "subagent", { model: "unknown-prov/some-model(A)@high" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /provider "unknown-prov", model "some-model"/);
	assert.ok(!result.reason.includes("(A)@high"), "annotation tail stripped from the recommendation");
});

test("case-variant merged and bare copies recommend the canonical pool spelling", () => {
	const { preExecute } = mount(baseConfig());
	const merged = call(preExecute, "subagent", { model: "ZAI-CODING-CN/GLM-5.3-FLASH" });
	assert.equal(merged.kind, "deny");
	assert.match(merged.reason, /provider "zai-coding-cn", model "glm-5\.3-flash"/);
	const bare = call(preExecute, "subagent", { model: "CLAUDE-HAIKU-5.5" });
	assert.equal(bare.kind, "deny");
	assert.match(bare.reason, /provider "github-copilot", model "claude-haiku-5\.5"/);
});

test("double-prefixed merged string is denied with the inner pair", () => {
	const { preExecute, warns } = mount(baseConfig());
	// Merged variant of the 23:45:50 double-prefix failure.
	const result = call(preExecute, "subagent", { model: "zai-coding-cn/zai-coding-cn/glm-5.3-flash" });
	assert.equal(result.kind, "deny");
	assert.match(result.reason, /provider "zai-coding-cn", model "glm-5\.3-flash"/);
	// A non-repeated three-segment id has no correctable reading — pass through.
	const foreign = call(preExecute, "subagent", { model: "a/b/c" });
	assert.equal(foreign, NEXT);
	assert.deepEqual(warns, []);
});
