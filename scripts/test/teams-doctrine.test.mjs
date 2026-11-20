/** Teams doctrine conditionalization tests (refactor guide §4.4, P0 item 4).
 *
 *  Three behaviors are pinned together: (1) `teamsMode` defaults to ON
 *  since 2026-11-20 (maintainer-proven desktop config; §4.4 P0 shipped OFF
 *  — teams were the constraint-triggered exception path), and the OFF
 *  path still renders ZERO bytes on every assembly and the DSH factory
 *  conservative team policy takes over; (2) the ON-mode doctrine is the
 *  `## 1` delegation block + the teams clauses, both extracted verbatim
 *  from the cordis.patch.yml persona-suffix anchor — the byte snapshots
 *  below copy the current English doctrine text so any accidental rewrite fails loudly;
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
// LEGACY_DELEGATION_LINES reproduce the "## 1" delegate-by-default block verbatim
// in the pre-§4.4 cordis.patch.yml suffix. LEGACY_TEAMS_LINES pin the
// legacy-mode output: the HEAD teams section plus the one appended
// §4.4.2 spawn-reason clause — not the raw pre-change yaml text.

const LEGACY_DELEGATION_LINES = [
	"## 1. Delegate by Default, Act Directly Only as the Exception",
	"- Delegation spends one fresh child context and returns one summary; reading and writing everything yourself bloats this session's context — costlier in the long run. Long or heavy context leans toward delegation; trivial items stay in hand.",
	"- Act directly only when ALL hold: cognitive load low or medium, total reading <200 lines, change <50 lines; tight iterate-and-probe loops (each step immediately consumes the previous result); finishing touches with expected payoff <3k tokens.",
	"- Searches with uncertain location, multi-file investigations, large refactors, independent research, or option comparisons: always delegate; recon goes to the economy lane first.",
	"- Judge once at task start; redo when scale or structure changes mid-task; conclusions need no user sign-off.",
];
const LEGACY_TEAMS_LINES = [
	"[SWITCHMAN:TEAMS] Agent Teams mode enabled. This section is the team branch dynamically injected from the persona-suffix doctrine (numbering continues from Section 4).",
	"",
	"The default team policy earlier in the system prompt says to create teammates only when the user explicitly asks. That default does not apply in the current profile: installing dsh-switchman pre-authorizes it — judge and trigger autonomously, without asking the user again.",
	"",
	"## 5. Team Trigger & Collaboration Discipline",
	"- Dispatch-channel priority (replacing the earlier default split of 'one-shot, no-shared-state single investigations go to subagent'): when this session's tool catalog has spawn_teammate/list_agents (Agent Teams enabled), ALL child delegation defaults to Agent Teams — spawn_teammate to assemble, team_task_* on the shared board, send_message/wait_agent to collaborate; stateless subagent/subagent_fork falls back to the backup channel, used only in the unavailable scenarios described in the next clause.",
	"- Teams unavailable → fall back immediately, never retry: without spawn_teammate/list_agents in the tool catalog (bundle inactive or unsupported in this session), or when spawn_teammate reports provisioning failed / creation failure, switch directly to subagent/subagent_fork dispatch and keep working; do not repeatedly retry the teams channel. As a teammate yourself (not Lead), keep the original rule: no spawn_teammate; use subagent when you need to delegate downward. workflow is only for explicitly requested workflows or scripted large-scale orchestration — never by default.",
	"- Write-domain isolation: declare non-overlapping write_scopes on shared tasks; keep the task board and dependency order via team_task_*; the Lead assembles the final diff, re-checks key changes, and runs tests; use wait_agent until required teammates finish — never conclude before results return.",
	"- Subagent message channel: child session ids returned by subagent/workflow are reachable only through the child_message bridge — send_message resolves TEAMMATE NAMES only and reports active teammate '…' not found for any child session id; that error does NOT mean the child died. Switch to child_message before re-dispatching or declaring death.",
	"- run_code parallel isolation: calls that mutate the team environment (member roster, tool table) — spawn_teammate / send_message — must not run Promise.all-parallel with file/search tools inside one run_code program; during the concurrency window other tool bindings may misreport unknown tool '…' (UNKNOWN_TOOL). Let such calls occupy their own step. When a previously working tool suddenly reports UNKNOWN_TOOL, retry the same call verbatim on the next step — do not switch tool names or abandon the task.",
	"- Resident members declare their constraint rationale first (advisory soft rule): before spawn_teammate, declare which constraint tag fired (e.g. 'hit parallelizable + permission_boundary'); when the constraint layer is off (no [SWITCHMAN:CONSTRAINTS] line), declare the irreplaceable structural reason instead (parallel independent subtasks / permission isolation / sustained collaboration). A missing declaration never blocks dispatch — this clause is a declaration requirement only; it does not change spawn-channel availability.",
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
	assert.ok(!yaml.includes("## 1. Delegate by Default"), "delegation heading extracted from the yaml");
	assert.ok(!yaml.includes("delegate by default"), "no delegation text left in the yaml");
	// The rest of the doctrine is untouched: the boundary rule survives verbatim
	// (the user override always wins — guide risk table, manual /team path).
	assert.ok(yaml.includes("that immediate request overrides this section"), "immediate-exit rule preserved");
	assert.ok(yaml.includes("## 2. Orchestration"), "following doctrine heading intact");
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
	assert.ok(text.includes("[SWITCHMAN:CONSTRAINTS] Team-constraint combination hit (parallelizable + permission_boundary)"));
	assert.ok(text.includes("child delegation defaults to Agent Teams"), "hit variant keeps the teams-first channel");
	// The delegation block and every fixed discipline clause survive verbatim.
	assert.ok(text.startsWith(DELEGATION_SECTION_TEXT + "\n\n"));
	for (const line of LEGACY_TEAMS_LINES.slice(7)) {
		assert.ok(text.includes(line), "discipline clause preserved verbatim");
	}
	assert.ok(text.includes("Resident members declare their constraint rationale"), "spawn-justification clause present");
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
	assert.ok(text.includes("(parallelizable + permission_boundary + capability_gap)"));
});

// ---- 6. miss: stateless subagents + on-demand skills stay the default path --------

test("no recorded tags renders the miss variant, never the unconditional trigger", () => {
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-miss-empty") });
	assert.ok(text.includes("No team-constraint combination hit"), "miss intro present");
	assert.ok(text.includes("stateless subagent / subagent_fork single dispatch plus on-demand skills is the default delegation path"), "default path restated");
	assert.ok(!text.includes("ALL child delegation defaults to Agent Teams"), "unconditional teams trigger is gone");
	assert.ok(text.includes("only when the user explicitly asks in conversation"), "manual override path preserved");
});
test("non-structural classifier hits (pressure only) still render the miss variant", () => {
	recordClassifierConstraints("s-miss2", "s-miss2:no-user", ["context_pressure", "skill_match"]);
	const { ctx } = fakeApplyHost();
	const section = mount(ctx, cfg(true, true));
	const text = section.text({ agent: AGENT("s-miss2") });
	assert.ok(text.includes("No team-constraint combination hit"));
	assert.ok(!text.includes("[SWITCHMAN:CONSTRAINTS] Team-constraint combination hit"), "no hit intro");
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
		assert.ok(text.includes("Resident members declare their constraint rationale first (advisory soft rule)"), "clause present");
		assert.ok(text.includes("never blocks dispatch"), "advisory, not a hard gate");
	}
});
