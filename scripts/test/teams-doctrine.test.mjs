/** Teams doctrine conditionalization tests (refactor guide §4.4, P0 item 4).
 *
 *  Three behaviors are pinned together: (1) `teamsMode` defaults to ON
 *  since 2026-11-20 (maintainer-proven desktop config; §4.4 P0 shipped OFF
 *  — teams were the constraint-triggered exception path), and the OFF
 *  path still renders ZERO bytes on every assembly and the DSH factory
 *  conservative team policy takes over; (2) the ON-mode doctrine is the
 *  `## 一` delegation block + the teams clauses, both extracted verbatim
 *  from the cordis.patch.yml persona-suffix anchor — the byte snapshots
 *  below copy the pre-change text so any accidental rewrite fails loudly;
 *  (3) with the constraint layer ON, only a §4.4.1 structural-tag
 *  conjunction (≥2 of parallelizable / permission_boundary / capability_gap)
 *  suggests a resident team — a miss keeps stateless subagents + on-demand
 *  skills as the default path, and the layer being OFF falls back to the
 *  original unconditional text (guide §6: prefer loose over missing a real
 *  teams case). The §4.4.2 spawn-justification requirement is advisory in
 *  every variant; the fixed discipline clauses are never rewritten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Config } from "../../host/config.js";
import {
	applyTeams,
	DELEGATION_SECTION_TEXT,
	TEAMS_SECTION_TEXT,
	TEAMS_STRUCTURAL_TAGS,
	structuralTeamHits,
	teamsDoctrineText,
} from "../../host/teams.js";
import { recordClassifierConstraints } from "../../host/constraints.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---- pinned doctrine lines -------------------------------------------------
// LEGACY_DELEGATION_LINES reproduce the "## 一" block verbatim as it stood
// in the pre-§4.4 cordis.patch.yml suffix. LEGACY_TEAMS_LINES pin the
// legacy-mode output: the HEAD teams section plus the one appended
// §4.4.2 spawn-reason clause — not the raw pre-change yaml text.

const LEGACY_DELEGATION_LINES = [
	"## 一、默认委派，例外亲做（delegate by default）",
	"- 委派只消耗一个全新子上下文、只收回一份摘要；亲自读写每一份都会膨胀本会话上下文，长期更贵。长或重的上下文偏向委派，琐碎小事留在手里。",
	"- 仅当满足全部条件才亲自做：认知负载低或中、读取合计 <200 行、改动 <50 行；强迭代小步试错（每步都要立刻用上一步结果）；期望收益 <3k token 的收尾。",
	"- 位置不确定的检索、跨多文件调查、大范围重构、独立研究或方案对比：一律委派，侦察优先派 economy 泳道。",
	"- 任务开始时判断一次，中途规模或结构变化时重做；结论不必请示用户。",
];
const LEGACY_TEAMS_LINES = [
	"[SWITCHMAN:TEAMS] Agent Teams 模式已启用。本段是 persona suffix 调度规程动态注入的团队分支（编号续接其「四、边界」）。",
	"",
	"系统提示词前文的默认团队策略写的是「仅当用户明确要求时才创建 teammate」。该默认策略在当前 profile 下不适用：用户安装 dsh-switchman 即预先授权，你应当自主判断、自主触发，无需再询问用户。",
	"",
	"## 五、团队触发与协作纪律",
	"- 派发通道优先级（取代前文「一次性、无需共享状态的单点调查用 subagent」的默认分工）：本会话工具目录里有 spawn_teammate/list_agents（Agent Teams 已启用）时，一切子任务委派默认走 Agent Teams——spawn_teammate 组队、team_task_* 落共享任务板、send_message/wait_agent 协作；subagent/subagent_fork 单智能体派发退为后备通道，仅在本条下一条所述的不可用场景使用。",
	"- teams 不可用即降级，不重试：工具目录没有 spawn_teammate/list_agents（bundle 未生效或本会话不支持），或 spawn_teammate 报 provisioning failed / 创建失败时，直接改用 subagent/subagent_fork 派发并继续工作，不要反复重试 teams 通道。你自身是 teammate（非 Lead）时维持原规则：不 spawn_teammate，需要子委派时用 subagent。workflow 仅在用户明确要求工作流或脚本化大规模编排时使用，默认不主动使用。",
	"- 写作域隔离：共享任务上写明互不重叠的 write_scopes；用 team_task_* 维护任务板与依赖顺序；Lead 汇总最终 diff、复核关键改动并运行测试；用 wait_agent 等到必需的 teammate 完成，绝不在结果未回前下最终结论。",
	"- 子智能体消息通道：subagent/workflow 返回的子会话 id 只能经 child_message 桥接送达——send_message 只解析 teammate 名字，对子会话 id 必报 active teammate「…」not found；该报错不代表子会话死亡，先改用 child_message，不要据此重派或判定死亡。",
	"- run_code 并行隔离：spawn_teammate / send_message 这类会改变团队环境（成员目录、工具表）的调用不要与文件/搜索工具放进同一 run_code 程序里 Promise.all 并行——并发窗口内其它工具绑定可能误报 unknown tool「…」（UNKNOWN_TOOL）；让这类调用单独占一步执行。某工具此前可用却突然报 UNKNOWN_TOOL 时，下一步原样重试即可，不要换工具名或放弃任务。",
	"- 常驻成员先声明约束理由（advisory 软约束）：spawn_teammate 前声明触发了哪条约束标签（如「命中 parallelizable + permission_boundary」）；约束层未启用（无 [SWITCHMAN:CONSTRAINTS] 行）时改为声明不可替代的结构性理由（并行独立子任务 / 权限隔离 / 持续协作）。缺失声明不拦截派发——本条只是声明要求，不改变 spawn 通道可用性。",
];
/** Byte snapshot of the whole legacy ON-mode doctrine body. */
const LEGACY_DOCTRINE = [...LEGACY_DELEGATION_LINES, "", ...LEGACY_TEAMS_LINES].join("\n");

// ---- fake host plumbing -----------------------------------------------------

/** Minimal host ctx for applyTeams: collects sections + listeners; the
 *  missing pluginManager makes the deferred orchestration land in its
 *  "unavailable" warn branch (same as teams-sync.test.mjs). */
function fakeApplyHost() {
	const sections = [];
	const listeners = new Map();
	const log = [];
	return {
		ctx: {
			sections,
			systemPrompt: { section: (def) => sections.push(def) },
			on: (name, fn) => {
				if (!listeners.has(name)) listeners.set(name, []);
				listeners.get(name).push(fn);
			},
			logger: {
				warn: (m) => log.push(["warn", m]),
				info: (m) => log.push(["info", m]),
			},
			get: () => undefined,
		},
		sections,
		listeners,
		log,
	};
}
const cfg = (teamsMode, constraintsEnabled = false) => ({
	teamsMode: { get: () => teamsMode },
	constraintsEnabled: { get: () => constraintsEnabled },
});
const AGENT = (id) => ({ session: { id } });

function mount(ctx, config) {
	applyTeams(ctx, config);
	assert.equal(ctx.sections.length, 1);
	assert.equal(ctx.sections[0].name, "switchman:teams");
	assert.equal(ctx.sections[0].order, 10250);
	return ctx.sections[0];
}

// ---- 1. the default --------------------------------------------------------------

test("teamsMode defaults to ON (2026-11-20 promotion); constraints default ON", () => {
	const parsed = Config({});
	assert.equal(parsed.teamsMode.get(), true);
	assert.equal(parsed.constraintsEnabled.get(), true);
});

// ---- 2. OFF renders zero bytes (the old non-teams session shape) ------------------

test("teamsMode OFF renders zero bytes on every assembly (delegation gone too)", () => {
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(false));
	assert.equal(section.text({ agent: AGENT("s-off") }), "");
	assert.equal(section.text({ agent: null }), "");
	assert.equal(section.text({}), "");
	assert.equal(section.text(), "");
});

// ---- 3. the yaml no longer ships the delegation block -----------------------------

test("persona suffix no longer carries the delegate-by-default block", () => {
	const yaml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(!yaml.includes("## 一、默认委派"), "delegation heading extracted from the yaml");
	assert.ok(!yaml.includes("delegate by default"), "no delegation text left in the yaml");
	// The rest of the doctrine is untouched: the boundary rule survives verbatim
	// (the user override always wins — guide risk table, manual /team path).
	assert.ok(yaml.includes("该即时要求优先于本段"), "immediate-exit rule preserved");
	assert.ok(yaml.includes("## 二、编排与 token 纪律"), "following doctrine heading intact");
});

// ---- 4. legacy ON (constraint layer off): byte-identical fallback -----------------

test("teamsMode ON + constraints OFF reproduces the pre-change text byte-for-byte", () => {
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, false));
	const text = section.text({ agent: AGENT("s-legacy") });
	assert.equal(text, LEGACY_DOCTRINE);
	// The exported pieces compose to exactly that body too.
	assert.equal(DELEGATION_SECTION_TEXT, LEGACY_DELEGATION_LINES.join("\n"));
	assert.equal(TEAMS_SECTION_TEXT, LEGACY_TEAMS_LINES.join("\n"));
	assert.equal(teamsDoctrineText({ constraintsEnabled: false, hitTags: [] }), LEGACY_DOCTRINE);
});

// ---- 5. hit: the §4.4.1 conjunction suggests a resident team ----------------------

test("structural conjunction hit (≥2 tags) swaps the trigger lines to the teams suggestion", () => {
	recordClassifierConstraints("s-hit", "s-hit:no-user", ["parallelizable", "permission_boundary"]);
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-hit") });
	assert.ok(text.includes("[SWITCHMAN:CONSTRAINTS] 命中团队约束组合（parallelizable + permission_boundary）"));
	assert.ok(text.includes("默认走 Agent Teams"), "hit variant keeps the teams-first channel");
	// The delegation block and every fixed discipline clause survive verbatim.
	assert.ok(text.startsWith(DELEGATION_SECTION_TEXT + "\n\n"));
	for (const line of LEGACY_TEAMS_LINES.slice(7)) {
		assert.ok(text.includes(line), "discipline clause preserved verbatim");
	}
	assert.ok(text.includes("常驻成员先声明约束理由"), "spawn-justification clause present");
});

test("three-tag hit lists the whole conjunction in the trigger line", () => {
	recordClassifierConstraints("s-hit3", "s-hit3:no-user", [
		"parallelizable",
		"permission_boundary",
		"capability_gap",
		"context_pressure",
	]);
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-hit3") });
	assert.ok(text.includes("（parallelizable + permission_boundary + capability_gap）"));
});

// ---- 6. miss: stateless subagents + on-demand skills stay the default path --------

test("no recorded tags renders the miss variant, never the unconditional trigger", () => {
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-miss-empty") });
	assert.ok(text.includes("未命中团队约束组合"), "miss intro present");
	assert.ok(text.includes("无状态 subagent / subagent_fork 单次派发加按需 skill 是默认委派路径"), "default path restated");
	assert.ok(!text.includes("一切子任务委派默认走 Agent Teams"), "unconditional teams trigger is gone");
	assert.ok(text.includes("仅当用户在会话中明确要求时使用"), "manual override path preserved");
});

test("non-structural classifier hits (pressure only) still render the miss variant", () => {
	recordClassifierConstraints("s-miss2", "s-miss2:no-user", ["context_pressure", "skill_match"]);
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-miss2") });
	assert.ok(text.includes("未命中团队约束组合"));
	assert.ok(!text.includes("[SWITCHMAN:CONSTRAINTS] 命中团队约束组合"), "no hit intro");
});

// ---- 7. the pure hit predicate -----------------------------------------------------

test("structuralTeamHits: conjunction threshold, vocabulary order, junk tolerance", () => {
assert.deepEqual(structuralTeamHits(["parallelizable", "permission_boundary"]), ["parallelizable", "permission_boundary"]);
	assert.deepEqual(
		structuralTeamHits(["capability_gap", "context_pressure", "verification_required", "skill_match"]),
		[],
		"one structural tag is a miss — the conjunction needs ≥2",
	);
	assert.deepEqual(
		structuralTeamHits(["skill_match", "context_pressure", "verification_required"]),
		[],
		"deterministic-only signals never suggest a team",
	);
	assert.deepEqual(structuralTeamHits([]), []);
	assert.deepEqual(structuralTeamHits(undefined), []);
	assert.deepEqual(structuralTeamHits([null, 42, "parallelizable", {}]), [], "junk filtered before scoring");
	assert.deepEqual(TEAMS_STRUCTURAL_TAGS, ["parallelizable", "permission_boundary", "capability_gap"]);
});

// ---- 8. advisory spawn-justification clause in EVERY ON variant --------------------

test("spawn-justification clause is present and explicitly advisory in all three states", () => {
	const legacy = teamsDoctrineText({ constraintsEnabled: false, hitTags: [] });
	const hit = teamsDoctrineText({ constraintsEnabled: true, hitTags: ["parallelizable", "capability_gap"] });
	const miss = teamsDoctrineText({ constraintsEnabled: true, hitTags: [] });
	for (const text of [legacy, hit, miss]) {
		assert.ok(text.includes("常驻成员先声明约束理由（advisory 软约束）"), "clause present");
		assert.ok(text.includes("缺失声明不拦截派发"), "advisory, not a hard gate");
	}
});
