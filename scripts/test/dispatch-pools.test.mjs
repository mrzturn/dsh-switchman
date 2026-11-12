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
	const ctx = {
		systemPrompt: { section: (section) => sections.push(section) },
		on() {},
		get() { return undefined; },
		logger: { warn() {} },
	};
	applyDispatch(ctx, config);
	const section = sections.find((entry) => entry.name === "switchman:dispatch");
	assert.ok(section, "applyDispatch must register the switchman:dispatch section");
	return section;
}

test("session route renders from the assemble context, right after the anchor", () => {
	const block = mountedSection().text({
		modelSelection: { provider: "zai-coding-cn", model: "glm-5.3-flashx", reasoningEffort: "high" },
	});
	const lines = block.split("\n");
	assert.equal(lines[0], "[SWITCHMAN:POOLS] configured=1/6 enforce=advice");
	assert.ok(
		lines[1].startsWith("session route: zai-coding-cn/glm-5.3-flashx@high — implicit dispatch"),
		`second line must state the session route, got: ${lines[1]}`,
	);
	assert.ok(lines[1].endsWith("only an explicit dispatch lands a lane model."));
});

test("no or malformed modelSelection renders no session route line (fail-open)", () => {
	const section = mountedSection();
	for (const context of [undefined, {}, null, { modelSelection: null }, { modelSelection: {} }, { modelSelection: { provider: " ", model: "x" } }]) {
		const block = section.text(context);
		assert.ok(!block.includes("session route:"), `context ${JSON.stringify(context)} must not render the line`);
		assert.ok(block.startsWith("[SWITCHMAN:POOLS]"), "anchor line must survive");
	}
});

test("implicit fallback is explicit-first with a declared downgrade", () => {
	const block = mountedSection().text({});
	assert.ok(block.includes("Explicit lane dispatch is the DEFAULT for subagent/workflow"));
	assert.ok(block.includes("LAST-RESORT fallback, never a shortcut"));
	assert.ok(block.includes("declare IMPLICIT-DOWNGRADED in your report"));
	assert.ok(block.includes("list_subagent_models"));
	// The old coequal-reading wording must be gone for good.
	assert.ok(!block.includes("or dispatch implicitly by omitting all three fields"));
});

test("teams section keeps the child_message channel rule for subagent ids", () => {
	assert.match(TEAMS_SECTION_TEXT, /子会话 id 只能经 child_message 桥接送达/);
	assert.match(TEAMS_SECTION_TEXT, /send_message 只解析 teammate 名字/);
	assert.match(TEAMS_SECTION_TEXT, /不要据此重派或判定死亡/);
});

test("teams section keeps the run_code parallel-isolation rule", () => {
	assert.match(TEAMS_SECTION_TEXT, /run_code 并行隔离/);
	assert.match(TEAMS_SECTION_TEXT, /不要与文件\/搜索工具放进同一 run_code 程序里 Promise\.all 并行/);
	assert.match(TEAMS_SECTION_TEXT, /下一步原样重试即可/);
});

test("persona suffix in cordis.patch.yml keeps the implicit-downgrade doctrine", () => {
	const yml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(yml.includes("IMPLICIT-DOWNGRADED"), "suffix must require the declared downgrade");
	assert.ok(yml.includes("仅当显式尝试被拒且 list_subagent_models 确认无可用路由后才可兜底"));
});
