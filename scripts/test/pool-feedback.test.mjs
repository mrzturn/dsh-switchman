// Pool-feedback layer (refactor guide §4.5, P1 item 3): function-level
// coverage — fake host sections, no live sessions. Pins the zero-diff
// contract (switch off = "" on every assembly), the load-tier mapping
// (MODEL-VISIBILITY policy: tier labels only, never counts), the
// fail-open paths, the per-assembly closure resolution (review F6
// pin), and the §5 P1 acceptance signal for the loop: a recorded
// skill_loaded observation changes the injected recommendation bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPoolFeedback, renderPoolFeedbackBlock, POOL_FEEDBACK_ORDER } from "../../host/pool-feedback.js";
import { recordSkillLoad, resetSkillLoadStats } from "../../host/skill-registry.js";

// The bundled skills' lane hints (frontmatter pool_hint) — the loop's
// real out-of-the-box data path.
const HINTED = [
	{ name: "db-query", tags: ["verification_required"], poolHint: "mechanical", estimatedTokens: 4200 },
	{ name: "git-commit-message", tags: ["parallelizable"], poolHint: "mechanical", estimatedTokens: 1800 },
	{ name: "requirement-docs", tags: ["verification_required"], poolHint: "main", estimatedTokens: 3000 },
];

test("renderPoolFeedbackBlock: tier buckets, lane grouping, byte-exact block", () => {
	const block = renderPoolFeedbackBlock(HINTED, [
		{ name: "db-query", count: 7 },
		{ name: "git-commit-message", count: 3 },
		// requirement-docs: absent from stats → never (long-term zero load)
	]);
	assert.equal(
		block,
		"[SWITCHMAN:POOLS-FEEDBACK] skill loads since enable, by pool_hint lane (tier labels only; few = 1-5 loads, often = 6+):\n" +
			"- mechanical: db-query often, git-commit-message few\n" +
			"- main: requirement-docs never",
	);
});

test("renderPoolFeedbackBlock: bucket boundaries 0/1/5/6 + missing name", () => {
	const one = (count) => renderPoolFeedbackBlock([{ name: "x", poolHint: "economy" }], count === undefined ? [] : [{ name: "x", count }]);
	assert.match(one(undefined), /x never/);
	assert.match(one(0), /x never/);
	assert.match(one(1), /x few/);
	assert.match(one(5), /x few/);
	assert.match(one(6), /x often/);
});

test("renderPoolFeedbackBlock: MODEL-VISIBILITY — no digits outside the header legend", () => {
	const block = renderPoolFeedbackBlock(
		[{ name: "a-skill", poolHint: "hard" }, { name: "b-skill", poolHint: "review" }],
		[{ name: "a-skill", count: 9999 }, { name: "b-skill", count: 42 }],
	);
	const rows = block.split("\n").slice(1).join("\n");
	assert.doesNotMatch(rows, /[0-9]/u, `feedback rows must carry tier labels only, got: ${rows}`);
	const rowGrammar =
		/^- (economy|mechanical|main|hard|vision|review): [a-z0-9-]+ (never|few|often)(, [a-z0-9-]+ (never|few|often))*$/u;
	for (const row of block.split("\n").slice(1)) {
		assert.match(row, rowGrammar, `row violates the tier-label grammar: ${row}`);
	}
});

test("renderPoolFeedbackBlock: lane order follows LANES, items tier-then-name, unhinted excluded", () => {
	const skills = [
		{ name: "zeta", poolHint: "review" },
		{ name: "alpha", poolHint: "review" },
		{ name: "beta", poolHint: "vision" },
		{ name: "no-lane", tags: ["parallelizable"] },
		{ name: "bad-lane", poolHint: "not-a-lane" },
	];
	const block = renderPoolFeedbackBlock(skills, [
		{ name: "alpha", count: 2 },
		{ name: "beta", count: 10 },
		{ name: "no-lane", count: 99 },
		{ name: "bad-lane", count: 99 },
	]);
	assert.deepEqual(
		block.split("\n").slice(1),
		["- vision: beta often", "- review: alpha few, zeta never"],
	);
});

test("renderPoolFeedbackBlock: item cap bounds the block", () => {
	const skills = Array.from({ length: 30 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, poolHint: "economy" }));
	const lines = renderPoolFeedbackBlock(skills, []).split("\n");
	assert.equal(lines.length, 1 + 1); // header + one economy row
	assert.equal(lines[1].split(", ").length, 16);
});

test("renderPoolFeedbackBlock: junk shapes render zero bytes", () => {
	assert.equal(renderPoolFeedbackBlock(null, null), "");
	assert.equal(renderPoolFeedbackBlock(undefined, [{ name: "x", count: 1 }]), "");
	assert.equal(renderPoolFeedbackBlock([], [{ name: "x", count: 1 }]), "");
	assert.equal(
		renderPoolFeedbackBlock([{ name: "x", poolHint: "main" }], null),
		"[SWITCHMAN:POOLS-FEEDBACK] skill loads since enable, by pool_hint lane (tier labels only; few = 1-5 loads, often = 6+):\n- main: x never",
	);
	assert.equal(renderPoolFeedbackBlock("not-an-array", []), "");
	assert.equal(renderPoolFeedbackBlock([{ name: 42, poolHint: "main" }], []), "");
});

// ---------------------------------------------------------------------------
// Section wiring: fake host, off-by-default, fail-open, closure path
// ---------------------------------------------------------------------------

function fakeHost() {
	const sections = [];
	const infos = [];
	const warnings = [];
	const ctx = {
		logger: {
			info: (message) => infos.push(message),
			warn: (message) => warnings.push(message),
		},
		systemPrompt: {
			section: (spec) => sections.push(spec),
		},
	};
	return { ctx, sections, infos, warnings };
}

const configWith = (poolFeedbackEnabled, constraintsEnabled = true) => ({
	poolFeedbackEnabled: { get: () => poolFeedbackEnabled },
	constraintsEnabled: { get: () => constraintsEnabled },
});

test("applyPoolFeedback: registers one section at order 10406", () => {
	const { ctx, sections } = fakeHost();
	applyPoolFeedback(ctx, configWith(false), []);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "switchman:pool-feedback");
	assert.equal(sections[0].order, POOL_FEEDBACK_ORDER);
	assert.equal(POOL_FEEDBACK_ORDER, 10406);
	assert.equal(sections[0].interpolate, false);
});

test("applyPoolFeedback: switch OFF (default) renders zero bytes on every assembly", () => {
	resetSkillLoadStats();
	recordSkillLoad({ name: "db-query", source: "bundled" }, true, null);
	const { ctx, sections } = fakeHost();
	applyPoolFeedback(ctx, configWith(false), HINTED);
	const spec = sections[0];
	// Both agent shapes render "" — the section exists but contributes nothing.
	assert.equal(spec.text({ agent: { session: { header: { cwd: "/tmp/w" } } } }), "");
	assert.equal(spec.text({}), "");
	assert.equal(spec.text(undefined), "");
});

test("applyPoolFeedback: config without the field renders zero bytes (no throw)", () => {
	const { ctx, sections } = fakeHost();
	applyPoolFeedback(ctx, {}, HINTED);
	assert.equal(sections[0].text({}), "");
});

test("applyPoolFeedback: ON renders the loop — array and per-assembly closure agree (review F6 pin)", () => {
	resetSkillLoadStats();
	for (let i = 0; i < 7; i += 1) recordSkillLoad({ name: "db-query", source: "bundled" }, true, null);
	for (let i = 0; i < 3; i += 1) recordSkillLoad({ name: "git-commit-message", source: "bundled" }, true, null);
	const { ctx, sections, infos } = fakeHost();
	const config = configWith(true);
	applyPoolFeedback(ctx, config, HINTED);
	const fromArray = sections[0].text({});
	// Same data through a closure — the closure resolves INSIDE text().
	applyPoolFeedback(ctx, config, () => HINTED);
	const fromClosure = sections[1].text({ agent: { session: { header: { cwd: "/tmp/w" } } } });
	assert.equal(fromClosure, fromArray);
	const expected =
		"[SWITCHMAN:POOLS-FEEDBACK] skill loads since enable, by pool_hint lane (tier labels only; few = 1-5 loads, often = 6+):\n" +
		"- mechanical: db-query often, git-commit-message few\n" +
		"- main: requirement-docs never";
	assert.equal(fromArray, expected);
	// Audit log fires once for the first render, then stays silent for the
	// same signature; host-side only, so counts are allowed there.
	assert.equal(sections[1].text({}), fromArray);
	assert.equal(sections[1].text({}), fromArray);
	assert.equal(infos.length, 1);
	assert.match(infos[0], /pool feedback updated: mechanical: db-query often\(7\), git-commit-message few\(3\); main: requirement-docs never\(0\)/u);
	resetSkillLoadStats();
});

test("applyPoolFeedback: loop closes — a reset observation drops every tier (§5 acceptance signal)", () => {
	// The acceptance version of §4.5's "loop effective" criterion: the
	// injected recommendation context must be a FUNCTION of the recorded
	// skill_loaded observations, so removing observations removes the
	// signal instead of freezing a stale tier.
	resetSkillLoadStats();
	recordSkillLoad({ name: "db-query", source: "bundled" }, true, null);
	const { ctx, sections } = fakeHost();
	applyPoolFeedback(ctx, configWith(true), HINTED);
	const withLoad = sections[0].text({});
	assert.match(withLoad, /db-query few/u);
	resetSkillLoadStats();
	const afterReset = sections[0].text({});
	assert.match(afterReset, /db-query never/u);
	assert.notEqual(withLoad, afterReset);
});

test("applyPoolFeedback: fail-open — throwing closure, junk closure, missing stats", () => {
	const { ctx, sections } = fakeHost();
	const config = configWith(true);
	applyPoolFeedback(ctx, config, () => {
		throw new Error("registry exploded");
	});
	assert.equal(sections[0].text({}), "");
	applyPoolFeedback(ctx, config, () => null);
	assert.equal(sections[0].text({}), "");
	applyPoolFeedback(ctx, config, () => "junk");
	assert.equal(sections[0].text({}), "");
	applyPoolFeedback(ctx, config, () => undefined);
	assert.equal(sections[0].text({}), "");
});

test("applyPoolFeedback: ON but nothing hinted (or constraints off) renders zero bytes", () => {
	resetSkillLoadStats();
	recordSkillLoad({ name: "solo-skill", source: "local" }, true, null);
	const { ctx, sections } = fakeHost();
	applyPoolFeedback(ctx, configWith(true), [{ name: "solo-skill", tags: ["parallelizable"] }]);
	assert.equal(sections[0].text({}), "");
	// constraintsEnabled off → closure returns [] → "" even with hints configured.
	applyPoolFeedback(ctx, configWith(true, false), () => []);
	assert.equal(sections[1].text({}), "");
});

test("applyPoolFeedback: registration failure warns and disables the layer, never throws", () => {
	const { ctx, warnings } = fakeHost();
	ctx.systemPrompt.section = () => {
		throw new Error("section registry unavailable");
	};
	assert.doesNotThrow(() => applyPoolFeedback(ctx, configWith(true), HINTED));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /pool-feedback lines disabled/u);
});
