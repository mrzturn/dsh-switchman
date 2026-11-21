/** Dispatch-pools rendering tests: the `[SWITCHMAN:POOLS]` block must carry
 *  the assembling session's own route (so an implicit dispatch can never be
 *  mistaken for a lane dispatch), and the implicit-fallback guidance must
 *  read as explicit-first with a declared downgrade. Guards the
 *  ffd9d6ac lesson: a model took "dispatch implicitly" as a coequal
 *  shortcut and every child silently inherited the session model instead
 *  of the configured lane routes.
 *
 *  Also locks the two sibling doctrine surfaces: the teams section must
 *  keep the child_message channel rule (subagent ids are not teammate
 *  ids), and the cordis.patch.yml persona suffix must keep the
 *  IMPLICIT-DOWNGRADED declaration requirement.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyDispatch } from "../../host/dispatch.js";
import { LANES, laneField } from "../../host/config.js";
import { TEAMS_SECTION_TEXT } from "../../host/teams.js";

const ROOT = join(import.meta.dirname, "..", "..");

function mountedSection() {
	const config = { dispatchEnforce: "advice", teamsMode: false, modelRank: [] };
	for (const lane of LANES) config[laneField(lane)] = lane === "economy" ? [{ provider: "zai-coding-cn", model: "glm-5.3-flash" }] : [];
	const sections = [];
	const contexts = [];
	const ctx = {
		systemPrompt: {
			section: (section) => sections.push(section),
			context: (entry) => contexts.push(entry),
		},
		on() {},
		get() { return undefined; },
		logger: { warn() {} },
	};
	applyDispatch(ctx, config);
	const section = sections.find((entry) => entry.name === "switchman:dispatch");
	assert.ok(section, "applyDispatch must register the switchman:dispatch section");
	const context = contexts.find((entry) => entry.name === "switchman:dispatch-route");
	assert.ok(context, "applyDispatch must register the switchman:dispatch-route tail entry");
	return { section, context };
}

test("session route renders from the assemble context in the tail payload", () => {
	const { section, context } = mountedSection();
	const assembleContext = {
		modelSelection: { provider: "zai-coding-cn", model: "glm-5.3-flashx", reasoningEffort: "high" },
	};
	// Head: the pools block WITHOUT the per-turn route line.
	const block = section.text(assembleContext);
	const lines = block.split("\n");
	assert.equal(lines[0], "[SWITCHMAN:POOLS] configured=1/6 enforce=advice");
	assert.ok(lines[1].startsWith("economy:"), `second head line is the lane row, got: ${lines[1]}`);
	assert.ok(!block.includes("session route:"), "head must not carry the route line anymore");
	// Tail: the route line, byte-identical to the pre-refactor placement.
	const routeLine = context.text(assembleContext);
	const routeLines = routeLine.split("\n");
	assert.ok(
		routeLines[0].startsWith("session route: zai-coding-cn/glm-5.3-flashx@high — implicit dispatch"),
		`payload must state the session route, got: ${routeLines[0]}`,
	);
	assert.ok(routeLine.endsWith("only an explicit dispatch lands a lane model."));
});

test("no or malformed modelSelection renders no session route line (fail-open)", () => {
	const { section, context } = mountedSection();
	for (const assembleContext of [undefined, {}, null, { modelSelection: null }, { modelSelection: {} }, { modelSelection: { provider: " ", model: "x" } }]) {
		const block = section.text(assembleContext);
		assert.ok(!block.includes("session route:"), `context ${JSON.stringify(assembleContext)} must not render the line`);
		assert.ok(block.startsWith("[SWITCHMAN:POOLS]"), "anchor line must survive");
		assert.equal(context.text(assembleContext), "", `payload must stay empty for ${JSON.stringify(assembleContext)}`);
	}
});

test("head block is byte-stable across changing session routes (cache stability)", () => {
	const { section } = mountedSection();
	const base = section.text({ modelSelection: { provider: "a", model: "m1" } });
	const again = section.text({ modelSelection: { provider: "b", model: "m2", reasoningEffort: "high" } });
	const none = section.text(undefined);
	assert.equal(base, again);
	assert.equal(base, none);
});

test("implicit fallback is explicit-first with a declared downgrade", () => {
	const block = mountedSection().section.text({});
	assert.ok(block.includes("Explicit lane dispatch is the DEFAULT for subagent/workflow"));
	assert.ok(block.includes("LAST-RESORT fallback, never a shortcut"));
	assert.ok(block.includes("declare IMPLICIT-DOWNGRADED in your report"));
	assert.ok(block.includes("list_subagent_models"));
	// The old coequal-reading wording must be gone for good.
	assert.ok(!block.includes("or dispatch implicitly by omitting all three fields"));
});

test("teams section keeps the child_message channel rule for subagent ids", () => {
	assert.match(TEAMS_SECTION_TEXT, /reachable only through the child_message bridge/);
	assert.match(TEAMS_SECTION_TEXT, /send_message resolves TEAMMATE NAMES only/);
	assert.match(TEAMS_SECTION_TEXT, /before re-dispatching or declaring death/);
});

test("teams section keeps the run_code parallel-isolation rule", () => {
	assert.match(TEAMS_SECTION_TEXT, /run_code parallel isolation/);
	assert.match(TEAMS_SECTION_TEXT, /must not run Promise\.all-parallel with file\/search tools inside one run_code program/);
	assert.match(TEAMS_SECTION_TEXT, /retry the same call verbatim/);
});

test("persona suffix in cordis.patch.yml keeps the implicit-downgrade doctrine", () => {
	const yml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(yml.includes("IMPLICIT-DOWNGRADED"), "suffix must require the declared downgrade");
	assert.ok(yml.includes("only after an explicit attempt was denied or list_subagent_models confirms no authorized route"));
});
