// Constraint-recognition layer + skill annotation layer (refactor guide §4.1/
// §4.2, P0 items 1+2): function-level coverage — fake state objects only, no
// live sessions. The zero-diff contract is asserted at unit level: with
// `constraintsEnabled` off the injected section renders "" on every assembly
// and the classifier prompt is the exact pre-feature string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
	CONSTRAINT_VOCABULARY,
	MAX_SKILL_ROWS,
	annotateSkillCandidates,
	cleanClassifierConstraints,
	cleanConstraintTags,
	classifierConstraintsForTurn,
	deterministicPressureHits,
	mergeConstraints,
	parseSkillAnnotations,
	recordClassifierConstraints,
	renderConstraintsLine,
	renderSkillsTable,
	skillMatchHits,
	turnKeyFor,
	applyConstraints,
} from "../../host/constraints.js";
import { classifierSystemPrompt, parseClassifierVerdict } from "../../host/intent.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SKILLS_ROOT = join(ROOT, "skills");

// ---------------------------------------------------------------------------
// Vocabulary + cleaning
// ---------------------------------------------------------------------------

test("vocabulary is the closed six-tag set in canonical order", () => {
	assert.deepEqual(CONSTRAINT_VOCABULARY, [
		"context_pressure",
		"verification_required",
		"capability_gap",
		"parallelizable",
		"permission_boundary",
		"skill_match",
	]);
});

test("cleanConstraintTags filters to vocabulary, dedupes, canonicalizes order", () => {
	assert.deepEqual(cleanConstraintTags("skill_match, context_pressure"), ["context_pressure", "skill_match"]);
	assert.deepEqual(cleanConstraintTags(["junk", "skill_match", "skill_match"]), ["skill_match"]);
	assert.deepEqual(cleanConstraintTags(["permission_boundary", 42, null]), ["permission_boundary"]);
	assert.deepEqual(cleanConstraintTags(undefined), []);
	assert.deepEqual(cleanConstraintTags(42), []);
});

test("cleanClassifierConstraints: objects, strings, clamps, caps at 3; absent = null", () => {
	assert.deepEqual(cleanClassifierConstraints([{ tag: "skill_match", confidence: 1.7 }]), [
		{ tag: "skill_match", confidence: 1 },
	]);
	assert.deepEqual(cleanClassifierConstraints([{ tag: "capability_gap", confidence: -3 }]), [
		{ tag: "capability_gap", confidence: 0 },
	]);
	assert.deepEqual(cleanClassifierConstraints(["parallelizable", { tag: "skill_match", confidence: "0.9" }]), [
		{ tag: "parallelizable", confidence: 0.5 },
		{ tag: "skill_match", confidence: 0.9 },
	]);
	assert.equal(cleanClassifierConstraints([{ tag: "not-in-vocab" }]), null);
	assert.equal(cleanClassifierConstraints(undefined), null);
	assert.equal(cleanClassifierConstraints("junk"), null);
	assert.equal(cleanClassifierConstraints([]), null);
	const capped = cleanClassifierConstraints(
		CONSTRAINT_VOCABULARY.map((tag) => ({ tag, confidence: 0.5 })),
	);
	assert.equal(capped.length, 3);
});

test("mergeConstraints: strongest source wins per tag, vocabulary order kept", () => {
	assert.deepEqual(
		mergeConstraints(
			[{ tag: "skill_match", source: "classifier" }],
			[{ tag: "skill_match", source: "deterministic" }],
			[{ tag: "verification_required", source: "advisory" }],
		),
		[
			{ tag: "verification_required", source: "advisory" },
			{ tag: "skill_match", source: "deterministic" },
		],
	);
	// junk entries and unknown lists fail open
	assert.deepEqual(mergeConstraints(null, "junk", [{ tag: "nope", source: "deterministic" }]), []);
});

// ---------------------------------------------------------------------------
// Deterministic signals
// ---------------------------------------------------------------------------

function fakeCtx(totalTokens) {
	return { tokenMeter: { measure: () => ({ totalTokens }) } };
}
const fakeAgent = { session: { id: "s-det" } };
function fakeHostConfig(overrides = {}) {
	return {
		wmSoftTokens: { get: () => 80000 },
		wmHardTokens: { get: () => 100000 },
		wmForceTokens: { get: () => 200000 },
		...overrides,
	};
}

test("deterministicPressureHits: context_pressure exactly at/above soft, silent below", () => {
	const config = fakeHostConfig();
	assert.deepEqual(deterministicPressureHits(fakeCtx(79_999), fakeAgent, config), []);
	assert.deepEqual(deterministicPressureHits(fakeCtx(80_000), fakeAgent, config), [
		{ tag: "context_pressure", source: "deterministic" },
	]);
	assert.deepEqual(deterministicPressureHits(fakeCtx(200_000), fakeAgent, config), [
		{ tag: "context_pressure", source: "deterministic" },
	]);
	// meter missing/failing → no hit, never a throw
	assert.deepEqual(deterministicPressureHits(fakeCtx(null), fakeAgent, config), []);
	assert.deepEqual(deterministicPressureHits({}, fakeAgent, config), []);
	assert.deepEqual(deterministicPressureHits(fakeCtx(90_000), null, config), []);
});

test("skillMatchHits: word-boundary match on the newest human text only", () => {
	const skills = [{ name: "db-query", tags: ["permission_boundary"] }];
	assert.deepEqual(skillMatchHits("please run this SQL against db-query", skills), [
		{ tag: "skill_match", source: "deterministic" },
	]);
	assert.deepEqual(skillMatchHits("use DB-Query for the lookup", skills), [
		{ tag: "skill_match", source: "deterministic" },
	]);
	// substring without a boundary does not match
	assert.deepEqual(skillMatchHits("the xdb-queryy tool", skills), []);
	assert.deepEqual(skillMatchHits("", skills), []);
	assert.deepEqual(skillMatchHits(null, skills), []);
	assert.deepEqual(skillMatchHits("any text", []), []);
});

// ---------------------------------------------------------------------------
// Rendering (byte-stable lines; no numeric watermark values)
// ---------------------------------------------------------------------------

test("renderConstraintsLine: exact bytes; empty set renders zero bytes", () => {
	assert.equal(renderConstraintsLine([]), "");
	assert.equal(renderConstraintsLine(null), "");
	assert.equal(
		renderConstraintsLine([{ tag: "skill_match", source: "deterministic" }]),
		"[SWITCHMAN:CONSTRAINTS] hit: skill_match",
	);
	assert.equal(
		renderConstraintsLine([
			{ tag: "context_pressure", source: "deterministic" },
			{ tag: "verification_required", source: "advisory" },
			{ tag: "capability_gap", source: "classifier" },
		]),
		"[SWITCHMAN:CONSTRAINTS] hit: context_pressure, verification_required(advisory), capability_gap(classifier)",
	);
	// budget: any vocabulary-legal line stays under 60 tokens (~240 chars)
	const worst = renderConstraintsLine(CONSTRAINT_VOCABULARY.map((tag) => ({ tag, source: "classifier" })));
	assert.ok(worst.length < 240, `constraint line too long: ${worst.length} chars`);
});

test("renderSkillsTable: one row per annotated skill, row cap, zero bytes when empty", () => {
	assert.equal(renderSkillsTable([]), "");
	assert.equal(renderSkillsTable(null), "");
	assert.equal(
		renderSkillsTable([{ name: "db-query", tags: ["permission_boundary", "verification_required"], estimatedTokens: 4200 }]),
		"[SWITCHMAN:SKILLS] annotated skills (constraints tags; estimated size):\n- db-query: verification_required, permission_boundary (~4.2k tok)",
	);
	// invalid entries are skipped, valid ones after them still render
	assert.equal(
		renderSkillsTable([{ name: "", tags: [] }, { name: "ok", tags: ["parallelizable"], estimatedTokens: 100 }]),
		"[SWITCHMAN:SKILLS] annotated skills (constraints tags; estimated size):\n- ok: parallelizable (~0.1k tok)",
	);
	// row cap bounds the injected block
	const many = Array.from({ length: 50 }, (_, i) => ({ name: `skill-${i}`, tags: ["parallelizable"], estimatedTokens: 1000 }));
	assert.equal(renderSkillsTable(many).split("\n").length - 1, MAX_SKILL_ROWS);
});

// ---------------------------------------------------------------------------
// Skill annotation frontmatter + automatic token estimate
// ---------------------------------------------------------------------------

test("parseSkillAnnotations: frontmatter parsing + bytes/3.5 estimate; un-annotated = null", () => {
	const annotated = `---\nname: x\ndescription: d\nconstraints: skill_match, bogus_tag\n---\n\nbody`;
	const parsed = parseSkillAnnotations(annotated);
	assert.deepEqual(parsed.tags, ["skill_match"]);
	assert.equal(parsed.estimatedTokens, Math.round(Buffer.byteLength(annotated, "utf8") / 3.5));
	// no constraints line / no frontmatter / zero valid tags → not annotated
	assert.equal(parseSkillAnnotations("---\nname: x\ndescription: d\n---\nbody"), null);
	assert.equal(parseSkillAnnotations("no frontmatter"), null);
	assert.equal(parseSkillAnnotations("---\nname: x\nconstraints: bogus\n---\nbody"), null);
});

test("bundled skills carry the intended annotations and measured sizes", () => {
	const candidates = ["db-query", "git-commit-message", "requirement-docs"].map((name) => ({
		name,
		locator: join(SKILLS_ROOT, name, "SKILL.md"),
	}));
	const annotated = annotateSkillCandidates(candidates);
	assert.equal(annotated.length, 3);
	assert.deepEqual(byName("db-query").tags, ["verification_required", "permission_boundary"]);
	assert.deepEqual(byName("git-commit-message").tags, ["parallelizable"]);
	assert.deepEqual(byName("requirement-docs").tags, ["verification_required"]);
	function byName(name) {
		const entry = annotated.find((skill) => skill.name === name);
		assert.ok(entry !== undefined, `missing annotation for ${name}`);
		const bytes = readFileSync(join(SKILLS_ROOT, name, "SKILL.md")).length;
		assert.equal(entry.estimatedTokens, Math.round(bytes / 3.5));
		assert.ok(entry.estimatedTokens > 0);
		return entry;
	}
});

// ---------------------------------------------------------------------------
// Classifier extension: backward compatibility (old JSON without the field)
// ---------------------------------------------------------------------------

test("parseClassifierVerdict: legacy JSON without constraints parses unchanged", () => {
	const legacy = '{"best": 1, "confidence": 80}';
	assert.deepEqual(parseClassifierVerdict(legacy, 3), { best: 1, confidence: 80 });
	assert.deepEqual(parseClassifierVerdict("2", 3), { best: 2, confidence: 100 });
	// garbage constraints do not break an otherwise valid verdict
	assert.deepEqual(parseClassifierVerdict('{"best": 0, "confidence": 90, "constraints": "junk"}', 3), {
		best: 0,
		confidence: 90,
	});
	assert.deepEqual(parseClassifierVerdict('{"best": 0, "confidence": 90, "constraints": [{"tag": "nope", "confidence": 1}]}', 3), {
		best: 0,
		confidence: 90,
	});
});

test("parseClassifierVerdict: well-formed constraints ride along validated", () => {
	assert.deepEqual(parseClassifierVerdict('{"best": 0, "confidence": 90, "constraints": [{"tag": "capability_gap", "confidence": 0.7}, {"tag": "capability_gap", "confidence": 0.9}]}', 3), {
		best: 0,
		confidence: 90,
		constraints: [{ tag: "capability_gap", confidence: 0.7 }],
	});
});

test("classifierSystemPrompt: off = the exact pre-feature bytes; on = base + one clause", () => {
	const base = 'You route this conversation to one candidate model. Reply with STRICT JSON only: {"best": <candidate number>, "confidence": <0-100>}. No prose, no markdown fence.';
	assert.equal(classifierSystemPrompt(), base);
	assert.equal(classifierSystemPrompt(false), base);
	const on = classifierSystemPrompt(true);
	assert.ok(on.startsWith(base));
	assert.ok(on.length > base.length);
	assert.ok(on.includes("constraints"));
	// the base string is still verbatim in the host source (byte-compat anchor)
	assert.ok(readFileSync(join(ROOT, "host", "intent.js"), "utf8").includes(base));
});

// ---------------------------------------------------------------------------
// Injection snapshot: on vs off (zero-diff proof at the section level)
// ---------------------------------------------------------------------------

/** Fake host context: collects listeners + registered systemPrompt sections. */
/** Fake host context: collects listeners + registered systemPrompt sections;
 * `totalTokens` feeds the token meter (null = meter missing). */
function fakeHost(totalTokens = 50_000) {
	const log = [];
	const listeners = new Map();
	const sections = [];
	return {
		ctx: {
			on: (name, fn) => {
				if (!listeners.has(name)) listeners.set(name, []);
				listeners.get(name).push(fn);
			},
			systemPrompt: {
				section: (def) => sections.push(def),
			},
			logger: {
				warn: () => {},
				info: (message) => log.push(message),
			},
			...(totalTokens === null ? {} : { tokenMeter: { measure: () => ({ totalTokens }) } }),
		},
		listeners,
		sections,
		log,
	};
}
function emit(listeners, name, ...args) {
	for (const fn of listeners.get(name) ?? []) fn(...args);
}
const USER_EVENT = (id, text) => ({
	type: "user/message",
	data: { id, source: { kind: "user" }, content: [{ type: "text", text }] },
});
const AGENT = { session: { id: "s-inject" } };

function hostConfig(enabled) {
	return {
		constraintsEnabled: { get: () => enabled },
		wmSoftTokens: { get: () => 80000 },
		wmHardTokens: { get: () => 100000 },
		wmForceTokens: { get: () => 200000 },
	};
}

test("applyConstraints: switch OFF renders zero bytes on every assembly (zero-diff)", () => {
	const { ctx, sections, listeners } = fakeHost(90_000); // above soft → pressure
	const config = hostConfig(false);
	applyConstraints(ctx, config, [{ name: "db-query", tags: ["permission_boundary"], estimatedTokens: 4200 }]);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "switchman:constraints");
	// even WITH a fresh user message naming a skill, off renders ""
	emit(listeners, "session/event", AGENT, USER_EVENT("u1", "check db-query records please"));
	assert.equal(sections[0].text({ agent: AGENT }), "");
	assert.equal(sections[0].text({ agent: null }), "");
	assert.equal(sections[0].text({}), "");
});

test("applyConstraints: messages seen while OFF are not captured when switched ON", () => {
	let enabled = false;
	const config = { ...hostConfig(true), constraintsEnabled: { get: () => enabled } };
	const { ctx, sections, listeners } = fakeHost(90_000); // above soft → pressure
	applyConstraints(ctx, config, [{ name: "db-query", tags: ["permission_boundary"], estimatedTokens: 4200 }]);
	emit(listeners, "session/event", AGENT, USER_EVENT("u1", "check db-query records please"));
	// Nothing was captured while off: flipping on now renders the pressure
	// signal but no skill_match from the message that arrived while disabled.
	enabled = true;
	const text = sections[0].text({ agent: AGENT });
	assert.ok(text.includes("context_pressure"), "pressure signal still renders");
	assert.ok(!text.includes("skill_match"), "no stale capture from the off window");
});

test("applyConstraints: ON renders the exact expected line + table (snapshot)", () => {
	const { ctx, sections, listeners, log } = fakeHost(90_000); // above soft → context_pressure
	const annotated = [
		{ name: "db-query", tags: ["permission_boundary", "verification_required"], estimatedTokens: 4200 },
	];
	const config = hostConfig(true, 90_000); // above soft → context_pressure
	applyConstraints(ctx, config, annotated);
	emit(listeners, "session/event", AGENT, USER_EVENT("u1", "please check db-query records"));
	recordClassifierConstraints("s-inject", turnKeyFor("s-inject", { id: "u1" }), [
		{ tag: "verification_required", confidence: 0.8 },
	]);
	const rendered = sections[0].text({ agent: AGENT });
	assert.equal(
		rendered,
		"[SWITCHMAN:CONSTRAINTS] hit: context_pressure, verification_required(classifier), skill_match\n\n" +
			"[SWITCHMAN:SKILLS] annotated skills (constraints tags; estimated size):\n" +
			"- db-query: verification_required, permission_boundary (~4.2k tok)",
	);
	// host-side log carries the source labels once for this turn
	assert.equal(log.filter((line) => line.includes("constraints hit") && line.includes("deterministic")).length, 1);
	// re-render is byte-stable and does not double-log the same turn
	assert.equal(sections[0].text({ agent: AGENT }), rendered);
	assert.equal(log.filter((line) => line.includes("constraints hit")).length, 1);
});

test("applyConstraints: stale-turn classifier constraints are dropped", () => {
	const { ctx, sections, listeners } = fakeHost();
	const config = hostConfig(true, 50_000);
	applyConstraints(ctx, config, []);
	recordClassifierConstraints("s-stale", "s-stale:u-old", [{ tag: "capability_gap", confidence: 0.9 }]);
	// a newer human message moved the turn pin → the old payload is stale
	emit(listeners, "session/event", { session: { id: "s-stale" } }, USER_EVENT("u-new", "next question"));
	assert.deepEqual(classifierConstraintsForTurn("s-stale"), []);
	assert.equal(sections[0].text({ agent: { session: { id: "s-stale" } } }), "");
});

test("applyConstraints: no hits and no annotated skills renders zero bytes even when ON", () => {
	const { ctx, sections, listeners } = fakeHost(10_000); // below soft → ok
	applyConstraints(ctx, hostConfig(true), []);
	const agent = { session: { id: "s-clean" } };
	emit(listeners, "session/event", agent, USER_EVENT("u1", "hello world"));
	assert.equal(sections[0].text({ agent }), "");
	// disposal cleans every store; renders stay empty
	emit(listeners, "session/disposed", agent);
	assert.equal(sections[0].text({ agent }), "");
});

test("turnKeyFor mirrors the intent pin convention (id, seq fallback, no-user)", () => {
	assert.equal(turnKeyFor("s1", { id: "u9" }), "s1:u9");
	assert.equal(turnKeyFor("s1", null), "s1:no-user");
	assert.equal(turnKeyFor("s1", {}), "s1:no-user");
});
