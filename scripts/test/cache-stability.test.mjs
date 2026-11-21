/** Cache-stability cross-module integration tests (T8 of the 2026-11-21
 * cache-safe injection design, docs/requirements-and-design/
 * 2026-11-21-cache-safe-injection-design.md).
 *
 * Mounts every migrated module on one fake host in the production mount
 * order (index.js apply sequence) and asserts the §4.1 invariant end to
 * end:
 *   (a) the runtime-context snapshot joins all eight entries, ordered
 *       300..370, every one required:true;
 *   (b) every HEAD doctrine closure is byte-stable across a scripted turn
 *       sequence (ledger growth, constraint-tag variation, skill-load
 *       growth, route change, ask-latch transition) and never embeds
 *       per-turn bytes;
 *   (c) tail payload closures reproduce the golden per-turn outputs;
 *   (d) on a legacy host without systemPrompt.context the section text
 *       equals head + blank line + payload (pre-refactor embedding).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyConstraints, recordClassifierConstraints } from "../../host/constraints.js";
import { applyLanguage } from "../../host/lang.js";
import { applyDispatch } from "../../host/dispatch.js";
import { applyTeams, teamsDoctrineText, renderTeamsHitsDelta } from "../../host/teams.js";
import { applyPtcGuard, renderPtcGuard } from "../../host/ptc-guard.js";
import { applyPtcBindings } from "../../host/ptc-bindings.js";
import { applyContextWatch } from "../../host/context-watch.js";
import { applyPoolFeedback, renderPoolFeedbackBlock } from "../../host/pool-feedback.js";
import { applyPoolDifferentiation, renderPoolDifferentiationBlock } from "../../host/pool-differentiation.js";
import { getSkillLoadStats, recordSkillLoad, resetSkillLoadStats } from "../../host/skill-registry.js";

// ---- pinned doctrine lines -------------------------------------------------

const CONSTRAINTS_ANCHOR =
	"Per-turn constraint hits and the matched-skills table are delivered in the Current runtime context snapshot at the tail of the conversation; treat them as binding for this turn.";

/** Tokens that must never appear in a head section: per-turn payload bytes
 *  (the teams hit variant, ledger declarations, the route line, verdict
 *  rows, the load marker). The §4.1 invariant in token form. Tag names
 *  themselves are structural — the teams head's NOT-hit trigger policy
 *  names them — so only payload-unique strings are forbidden. */
const HEAD_FORBIDDEN = ["combination hit (", "const ledg", "const legacyvar", "session route:", "effort raise", "→ load"];

// ---- fixtures --------------------------------------------------------------

const ROOT_AGENT = { id: "root", session: { id: "root" } };
const SUB_AGENT = { id: "sub", session: { id: "sub" } };
const SKILLS = [
	{ name: "db-query", poolHint: "hard", estimatedTokens: 1200, tags: ["verification_required"] },
	{ name: "code-review", poolHint: "review", estimatedTokens: 800, tags: ["skill_match"] },
];
const DIFF_ENTRIES = [{ pool: "hard", dispatches: 5, failures: 5, rework: 0, emptyResults: 0 }];

const EXPECTED_ENTRIES = [
	["switchman:watermark", 300],
	["switchman:ptc-ledger", 310],
	["switchman:constraints-live", 320],
	["switchman:pool-feedback-live", 330],
	["switchman:pool-differentiation-live", 340],
	["switchman:dispatch-route", 350],
	["switchman:teams-hits", 360],
	["switchman:lang-ask", 370],
];
const SECTION_NAMES = [
	"switchman:watermark",
	"switchman:lang",
	"switchman:dispatch",
	"switchman:teams",
	"switchman:ptc-guard",
	"switchman:constraints",
	"switchman:pool-feedback",
	"switchman:pool-differentiation",
];

const box = (initial) => {
	let value = initial;
	return { get: () => value, set: (next) => { value = next; } };
};

const makeConfig = () => ({
	constraintsEnabled: box(true),
	teamsMode: box(true),
	poolFeedbackEnabled: box(true),
	poolDifferentiationEnabled: box(true),
	langConversation: box(""),
	langComments: box(""),
	langDocs: box(""),
	langScope: box("global"),
});

function fakeHost({ legacy = false, config, diffEntries }) {
	const sections = [];
	const contexts = [];
	const listeners = new Map();
	const ctx = {
		logger: { warn: () => {}, info: () => {} },
		fiber: { uid: 8 },
		agents: { roots: () => [ROOT_AGENT], currentInitiator: () => ROOT_AGENT },
		systemPrompt: {
			section: (s) => sections.push(s),
			...(legacy ? {} : { context: (c) => contexts.push(c) }),
		},
		on: (event, fn) => {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
		},
		tools: {
			register: () => {},
			// PTC executor shape (mirrors ptc-guard.test.mjs): selectExecutor
			// resolves every scope to an executor whose describe() declares the
			// reserved run_code transport, so isPtcScope() is true everywhere.
			selectExecutor: () => ({ describe: () => ({ schemas: [], knownNames: ["run_code"] }) }),
		},
		commands: { register: () => {} },
		get: () => null,
		inject: () => {},
	};
	const emit = (event, ...args) => {
		for (const fn of listeners.get(event) ?? []) void fn(...args);
	};
	const mount = () => {
		applyLanguage(ctx, config);
		applyDispatch(ctx, config);
		applyTeams(ctx, config);
		applyPtcGuard(ctx);
		applyPtcBindings(ctx);
		applyContextWatch(ctx, config);
		applyConstraints(ctx, config, SKILLS);
		applyPoolFeedback(ctx, config, SKILLS);
		applyPoolDifferentiation(ctx, config, () => ({ entries: diffEntries }));
	};
	const section = (name) => sections.find((s) => s.name === name);
	const entry = (name) => contexts.find((c) => c.name === name);
	return { ctx, sections, contexts, emit, mount, section, entry };
}

/** Drive the PTC ledger exactly like scripts/test/ptc-bindings.test.mjs. */
function runCall(emit, agent, code) {
	const exec = { name: "run_code", arguments: { code, description: "d" }, agent };
	emit("tools/pre-execute", exec, () => "next");
	emit("tools/post-execute", exec, { value: { logs: [] } }, () => "next");
}

const assembly = (agent, model) => ({ agent, modelSelection: { provider: "prov", model } });

test("cache stability: snapshot ordering, head constancy, golden payloads", () => {
	resetSkillLoadStats();
	const config = makeConfig();
	const host = fakeHost({ config, diffEntries: DIFF_ENTRIES });
	host.mount();

	// (a) one snapshot joins all eight entries, ordered 300..370, required.
	assert.equal(host.contexts.length, EXPECTED_ENTRIES.length);
	assert.deepEqual(
		[...host.contexts].sort((a, b) => a.order - b.order).map((c) => [c.name, c.order]),
		EXPECTED_ENTRIES,
	);
	for (const entry of host.contexts) assert.equal(entry.required, true);
	assert.equal(host.sections.length, SECTION_NAMES.length);

	// Turn 1 snapshot: fresh ledger, ≥2 structural tags (teams conjunction
	// hit), empty stats, unlatched ask, route m1.
	recordClassifierConstraints("root", "root:no-user", ["parallelizable", "permission_boundary"]);
	const ctx1 = assembly(ROOT_AGENT, "m1");
	const ctxSub = assembly(SUB_AGENT, "m1");
	const heads1 = Object.fromEntries(host.sections.map((s) => [s.name, s.text(ctx1)]));
	const subs1 = Object.fromEntries(host.sections.map((s) => [s.name, s.text(ctxSub)]));
	const tails1 = Object.fromEntries(host.contexts.map((c) => [c.name, c.text(ctx1)]));

	// (b) head purity: no per-turn bytes in any head, for root or sub.
	for (const head of [...Object.values(heads1), ...Object.values(subs1)]) {
		for (const token of HEAD_FORBIDDEN) assert.ok(!head.includes(token), `head leaked payload token: ${token}`);
	}

	// (c) golden per-turn payloads on turn 1.
	assert.equal(tails1["switchman:ptc-ledger"], ""); // empty ledger → no clause
	assert.ok(tails1["switchman:constraints-live"].includes("parallelizable"));
	assert.ok(tails1["switchman:constraints-live"].includes("- db-query: "));
	assert.equal(tails1["switchman:teams-hits"], renderTeamsHitsDelta(["parallelizable", "permission_boundary"]));
	assert.ok(tails1["switchman:teams-hits"].startsWith("[SWITCHMAN:CONSTRAINTS] Team-constraint combination hit"));
	assert.equal(tails1["switchman:pool-feedback-live"], renderPoolFeedbackBlock(SKILLS, getSkillLoadStats().entries));
	assert.equal(tails1["switchman:pool-differentiation-live"], renderPoolDifferentiationBlock(DIFF_ENTRIES));
	assert.ok(tails1["switchman:pool-differentiation-live"].includes("effort raise (failure-heavy)"));
	assert.notEqual(tails1["switchman:lang-ask"], ""); // unlatched root → ask fires
	assert.equal(host.entry("switchman:lang-ask").text(ctxSub), ""); // subagents never ask (root-only guidance)
	assert.equal(tails1["switchman:dispatch-route"], ""); // no pools configured → no route bytes
	assert.equal(tails1["switchman:watermark"], ""); // zero usage → ok level

	// Latch the ask exactly the way the host does: a declined marked
	// ask_user_question still flips the once-flag on tools/post-execute
	// (rendering a payload has no side effects — the latch is event-driven).
	const askExec = {
		name: "ask_user_question",
		arguments: { questions: [{ id: "lang-conversation", question: "switchman-lang: which conversation language?" }] },
		agent: ROOT_AGENT,
	};
	host.emit("tools/post-execute", askExec, { isError: true }, () => "next");

	// Turn 2 mutations: ledger growth, stats growth, tag variation, route
	// change; the ask latch flipped above.
	runCall(host.emit, ROOT_AGENT, "const ledg = 1;");
	recordSkillLoad(SKILLS[0], true);
	recordSkillLoad(SKILLS[1], true);
	recordClassifierConstraints("root", "root:no-user", ["capability_gap", "permission_boundary"]);
	const ctx2 = assembly(ROOT_AGENT, "m2");
	const ctxSub2 = assembly(SUB_AGENT, "m2");
	const heads2 = Object.fromEntries(host.sections.map((s) => [s.name, s.text(ctx2)]));
	const subs2 = Object.fromEntries(host.sections.map((s) => [s.name, s.text(ctxSub2)]));
	const tails2 = Object.fromEntries(host.contexts.map((c) => [c.name, c.text(ctx2)]));

	// (b) THE invariant: every head byte-identical across the whole sequence.
	assert.deepEqual(heads2, heads1);
	assert.deepEqual(subs2, subs1);

	// (c) turn 2 payloads follow the per-turn state; heads did not.
	assert.ok(tails2["switchman:ptc-ledger"].includes("ledg"));
	assert.ok(tails2["switchman:constraints-live"].includes("capability_gap"));
	assert.ok(!tails2["switchman:constraints-live"].includes("parallelizable"));
	assert.equal(tails2["switchman:teams-hits"], renderTeamsHitsDelta(["capability_gap", "permission_boundary"]));
	assert.equal(tails2["switchman:pool-feedback-live"], renderPoolFeedbackBlock(SKILLS, getSkillLoadStats().entries));
	assert.equal(tails2["switchman:lang-ask"], ""); // one ask per process
	assert.equal(tails2["switchman:dispatch-route"], ""); // route change without pools → still no bytes
});

test("legacy fallback: head + blank line + payload reproduces the pre-refactor section", () => {
	const config = makeConfig();
	const host = fakeHost({ legacy: true, config, diffEntries: DIFF_ENTRIES });
	host.mount();

	// No context API → zero context entries; same section surface.
	assert.equal(host.contexts.length, 0);
	assert.deepEqual(
		host.sections.map((s) => s.name).sort(),
		[...SECTION_NAMES].sort(),
	);

	// Grow the shared module state (ledger is global across hosts), then
	// mount a dual-channel host over the same state for composition.
	runCall(host.emit, ROOT_AGENT, "const legacyvar = 1;");
	recordClassifierConstraints("root", "root:no-user", ["parallelizable", "permission_boundary"]);
	const dual = fakeHost({ config, diffEntries: DIFF_ENTRIES });
	dual.mount();

	const ctxNow = assembly(ROOT_AGENT, "m1");
	const legacyText = (name) => host.section(name).text(ctxNow);

	// (d) byte-exact legacy embedding for every migrated module (entry name
	// differs from section name — mirror the registration names).
	const ENTRY_OF = {
		"switchman:constraints": "switchman:constraints-live",
		"switchman:pool-feedback": "switchman:pool-feedback-live",
		"switchman:pool-differentiation": "switchman:pool-differentiation-live",
		"switchman:dispatch": "switchman:dispatch-route",
		"switchman:teams": "switchman:teams-hits",
		"switchman:ptc-guard": "switchman:ptc-ledger",
	};
	for (const [name, entryName] of Object.entries(ENTRY_OF)) {
		const head = dual.section(name).text(ctxNow);
		const tail = dual.entry(entryName).text(ctxNow);
		assert.equal(legacyText(name), tail === "" ? head : `${head}\n\n${tail}`, name);
	}

	// Spot-checks: doctrine head, embedded payload bytes.
	assert.ok(legacyText("switchman:constraints").startsWith(CONSTRAINTS_ANCHOR));
	assert.ok(legacyText("switchman:constraints").includes("parallelizable"));
	assert.equal(
		legacyText("switchman:teams"),
		`${teamsDoctrineText({ constraintsEnabled: true, hitTags: [] })}\n\n${renderTeamsHitsDelta(["parallelizable", "permission_boundary"])}`,
	);
	assert.ok(legacyText("switchman:ptc-guard").startsWith(renderPtcGuard()));
	assert.ok(legacyText("switchman:ptc-guard").includes("legacyvar"));

	// Watermark: no context API → static head protocol only, same bytes as
	// the dual-channel host's head.
	assert.equal(legacyText("switchman:watermark"), dual.section("switchman:watermark").text(ctxNow));

	// Lang ask: unlatched on the fresh legacy host → guidance embedded in
	// the (empty-doctrine) head section as head + blank line + payload; a
	// declined marked ask flips the latch, and the next read embeds nothing.
	const langFirst = legacyText("switchman:lang");
	assert.notEqual(langFirst.trim(), "");
	assert.ok(langFirst.includes("\n\n"));
	const askExec = {
		name: "ask_user_question",
		arguments: { questions: [{ id: "lang-conversation", question: "switchman-lang: which conversation language?" }] },
		agent: ROOT_AGENT,
	};
	host.emit("tools/post-execute", askExec, { isError: true }, () => "next");
	assert.equal(legacyText("switchman:lang"), "");
});
