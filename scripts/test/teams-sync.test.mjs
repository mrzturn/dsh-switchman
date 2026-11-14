/** Teams dispatch-model union + agent-team bundle state tests.
 *
 *  Guards two behaviors fixed together: (1) the whitelist replace-sync union
 *  must include modelRank — its head is the dispatch fallback route
 *  (dispatch.js orderedPool head / modelRank[0]) and enforce mode denies any
 *  route outside "pools or modelRank", so a rank-only head silently strands
 *  subagent dispatch when the whitelist strips it; (2) an agent-team bundle
 *  the DSH installation does not offer at all is a TERMINAL not-offered
 *  state — setBundleEnabled would resolve application:"failed" (not-bundle)
 *  on every attempt, so the orchestration must record the fact once and
 *  leave the retry pump untouched instead of retrying forever.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchModelUnion, ensureTeamsBundle, teamsBundleState } from "../../host/teams.js";

const CONFIG = {
	poolPlan: [{ provider: "github-copilot", model: "gpt-6-luna" }],
	poolReview: [
		{ provider: "github-copilot", model: "gpt-6-luna" },
		{ provider: "zai-coding-cn", model: "glm-5.3-flash" },
	],
	modelRank: [
		{ provider: "github-copilot", model: "claude-opus-5.5", tier: "S" },
		{ provider: "github-copilot", model: "gpt-6-luna" },
	],
};

test("union merges the six pools and modelRank with exact dedup", () => {
	assert.deepEqual(dispatchModelUnion(CONFIG), [
		{ provider: "github-copilot", model: "gpt-6-luna" },
		{ provider: "zai-coding-cn", model: "glm-5.3-flash" },
		{ provider: "github-copilot", model: "claude-opus-5.5" },
	]);
});

test("union includes a rank-only head that no pool names", () => {
	const u = dispatchModelUnion({ modelRank: [{ provider: "a", model: "b" }] });
	assert.deepEqual(u, [{ provider: "a", model: "b" }]);
});

test("union skips malformed rank entries", () => {
	const u = dispatchModelUnion({
		modelRank: [null, 3, { provider: "", model: "x" }, { provider: "a", model: "" }, { provider: "a", model: "b", tier: "C" }],
	});
	assert.deepEqual(u, [{ provider: "a", model: "b" }]);
});

test("union is empty when no pool and no rank is configured", () => {
	assert.deepEqual(dispatchModelUnion({}), []);
	assert.deepEqual(dispatchModelUnion({ modelRank: [] }), []);
});

// ---- ensureTeamsBundle state machine ---------------------------------------

function makeCtx(manager, log = []) {
	return {
		logger: {
			warn: (m) => log.push(["warn", m]),
			info: (m) => log.push(["info", m]),
		},
		get: (name) => (name === "pluginManager" ? manager : undefined),
	};
}

test("bundle absent from the inventory records terminal not-offered and never calls setBundleEnabled", async () => {
	const calls = [];
	const manager = {
		listBundles: async () => [{ name: "some-other-bundle", enabled: true }],
		setBundleEnabled: async (name) => {
			calls.push(name);
			return { application: "applied" };
		},
	};
	const log = [];
	await ensureTeamsBundle(makeCtx(manager, log));
	assert.equal(calls.length, 0);
	const st = teamsBundleState();
	assert.equal(st.ok, false);
	assert.equal(st.state, "not-offered");
	assert.match(st.error, /not offered/);
	assert.equal(log.filter(([lvl]) => lvl === "warn").length, 1);
});

test("bundle listed and enabled short-circuits to selected", async () => {
	const manager = {
		listBundles: async () => [{ name: "@deepseek-ai/dsh-experimental-agent-team-profile", enabled: true }],
		setBundleEnabled: async () => {
			throw new Error("must not be called");
		},
	};
	await ensureTeamsBundle(makeCtx(manager));
	const st = teamsBundleState();
	assert.equal(st.ok, true);
	assert.equal(st.state, "selected");
});

test("resolved failed outcome stays unlatched and warns", async () => {
	const manager = {
		listBundles: async () => [{ name: "@deepseek-ai/dsh-experimental-agent-team-profile", enabled: false }],
		setBundleEnabled: async () => ({ application: "failed", error: { message: "not-bundle: package is not resolvable" } }),
	};
	const log = [];
	await ensureTeamsBundle(makeCtx(manager, log));
	const st = teamsBundleState();
	assert.equal(st.ok, false);
	assert.equal(st.state, "failed");
	assert.match(st.error, /not-bundle/);
	assert.equal(log.filter(([lvl]) => lvl === "warn").length, 1);
});

test("missing pluginManager service records unavailable and warns", async () => {
	const log = [];
	await ensureTeamsBundle(makeCtx(undefined, log));
	const st = teamsBundleState();
	assert.equal(st.ok, false);
	assert.equal(st.state, "unavailable");
	assert.equal(log.filter(([lvl]) => lvl === "warn").length, 1);
});

test("listBundles throwing falls through to setBundleEnabled", async () => {
	const manager = {
		listBundles: async () => {
			throw new Error("profile read failed");
		},
		setBundleEnabled: async () => ({ application: "restart-required" }),
	};
	await ensureTeamsBundle(makeCtx(manager));
	const st = teamsBundleState();
	assert.equal(st.ok, true);
	assert.equal(st.state, "restart-required");
});
