/** Open skill registry + skill-load observability (refactor guide §5.2.1/§5.2.2,
 * P1 items 1-2). Covers:
 * - registry scanning: normal entries, fail-open on broken/duplicate entries,
 *   dot-entries and stray files skipped, missing directory silent;
 * - conflict resolution: bundled names win over locals (warned);
 * - catalog vs annotation split (§4.2): un-annotated local skills reach the
 *   provider catalog (they join the SAME ctx.skills provider, so the host's
 *   native available-skills metadata carries them) but never the
 *   [SWITCHMAN:SKILLS] table — only constraint-annotated entries add rows;
 * - optional frontmatter fields: constraints / pool_hint both optional,
 *   unknown pool hints drop, pool_hint alone never annotates;
 * - the → load marker: skill_match hit rows gain it, miss rows stay
 *   byte-identical to the pre-marker output;
 * - skill_loaded recording: gated by the master switch, provider-fact shape
 *   (name + bundled/local source), bounded at SKILL_LOAD_CAP, exported
 *   reader + reset;
 * - master-switch OFF short-circuit: no scan, bundled list untouched.
 *
 * Module-level tests per repo convention (no test mounts the full apply());
 * temp registry roots live under os.tmpdir() and are removed per test.
 * Zero new dependencies. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_REGISTRY_DIR,
	SKILL_LOAD_CAP,
	candidatesWithRegistry,
	getSkillLoadStats,
	mergeSkillCandidates,
	parseSkillFile,
	recordSkillLoad,
	resetSkillLoadStats,
	resolveRegistryRoot,
	scanRegistryCandidates,
} from "../../host/skill-registry.js";
import {
	annotateSkillCandidates,
	matchedSkillNames,
	parseSkillAnnotations,
	renderSkillsTable,
} from "../../host/constraints.js";

/** Minimal config stub: only what the registry/annotation layers read. */
const configWith = (enabled) => ({ constraintsEnabled: { get: () => enabled } });

/** One SKILL.md fixture (frontmatter + body). `extra` lands between the
 * required fields and the closing fence (pool_hint lines etc.). */
const skillMd = (name, description, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody.\n`;

/** Build a workspace with `.dsh-switchman/skills/<dir>/SKILL.md` entries and
 * return the WORKSPACE path (what candidatesWithRegistry receives as cwd —
 * resolveRegistryRoot joins DEFAULT_REGISTRY_DIR onto it). Entries whose
 * value is null become broken (SKILL.md holds junk / no frontmatter);
 * entries starting with "." are dot-dirs. */
function makeRegistry(entries) {
	const ws = mkdtempSync(join(tmpdir(), "switchman-ws-"));
	const root = join(ws, DEFAULT_REGISTRY_DIR);
	for (const [dir, content] of Object.entries(entries)) {
		const path = join(root, dir);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), content ?? "no frontmatter here\n");
	}
	return ws;
}

/** The registry root inside a workspace (for direct scan calls). */
const registryRootOf = (ws) => join(ws, DEFAULT_REGISTRY_DIR);

const bundledCandidate = (name) => ({
	name,
	description: `bundled ${name}`,
	invocation: { modelInvocable: true, userInvocable: true },
	provider: "dsh-switchman",
	source: "bundled",
	rank: 600,
	resourceBase: { kind: "directory", path: `/bundled/${name}/` },
	locator: `/bundled/${name}/SKILL.md`,
});

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

test("parseSkillFile: name/description required, body extracted", () => {
	const parsed = parseSkillFile(skillMd("my-skill", "Does one thing"), "SKILL.md");
	assert.equal(parsed.name, "my-skill");
	assert.equal(parsed.description, "Does one thing");
	assert.equal(parsed.content.includes("# my-skill"), true);
});

test("parseSkillFile: missing name or description throws (caller skips)", () => {
	assert.throws(() => parseSkillFile("---\ndescription: only desc\n---\nbody", "SKILL.md"), /name/);
	assert.throws(() => parseSkillFile("---\nname: only-name\n---\nbody", "SKILL.md"), /description/);
	assert.throws(() => parseSkillFile("no frontmatter", "SKILL.md"), /frontmatter/);
});

// ---------------------------------------------------------------------------
// resolveRegistryRoot
// ---------------------------------------------------------------------------

test("resolveRegistryRoot: default joins cwd, absolute setting wins, no cwd fails open", () => {
	assert.equal(resolveRegistryRoot("/ws", configWith(true)), join("/ws", DEFAULT_REGISTRY_DIR));
	assert.equal(resolveRegistryRoot("/ws", { ...configWith(true), skillRegistryDir: { get: () => "/abs/dir" } }), "/abs/dir");
	assert.equal(resolveRegistryRoot(undefined, configWith(true)), "");
});

// ---------------------------------------------------------------------------
// scanRegistryCandidates
// ---------------------------------------------------------------------------

test("scanRegistryCandidates: valid entries register as local candidates, broken ones warn and skip", () => {
	const warns = [];
	const root = makeRegistry({
		"alpha": skillMd("alpha-skill", "First"),
		"beta": skillMd("beta-skill", "Second", "pool_hint: main\n"),
		"broken": null,
		".hidden": skillMd("hidden-skill", "Dot dir"),
	});
	try {
		const candidates = scanRegistryCandidates(registryRootOf(root), (m) => warns.push(m));
		assert.deepEqual(candidates.map((c) => c.name).sort(), ["alpha-skill", "beta-skill"]);
		assert.ok(candidates.every((c) => c.source === "local"));
		assert.equal(candidates.find((c) => c.name === "beta-skill").description, "Second");
		assert.equal(warns.length, 1, "exactly the broken entry warns");
		assert.match(warns[0], /broken/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanRegistryCandidates: missing directory is silent (normal first-run state)", () => {
	const warns = [];
	assert.deepEqual(scanRegistryCandidates(join(tmpdir(), "switchman-nonexistent-xyz"), (m) => warns.push(m)), []);
	assert.equal(warns.length, 0);
});

// ---------------------------------------------------------------------------
// mergeSkillCandidates + candidatesWithRegistry
// ---------------------------------------------------------------------------

test("mergeSkillCandidates: bundled wins name conflicts with a warning", () => {
	const warns = [];
	const bundled = [bundledCandidate("db-query")];
	const local = [{ ...bundledCandidate("db-query"), source: "local", locator: "/x/SKILL.md" }];
	const merged = mergeSkillCandidates(bundled, [local[0], { ...bundledCandidate("local-only"), source: "local" }], (m) => warns.push(m));
	assert.deepEqual(merged.map((c) => c.name), ["db-query", "local-only"]);
	assert.equal(merged[0].source, "bundled", "conflicting name keeps the bundled entry");
	assert.equal(warns.length, 1);
	assert.match(warns[0], /db-query/);
});

test("candidatesWithRegistry: OFF returns the bundled list untouched (no scan)", () => {
	const warns = [];
	const bundled = [bundledCandidate("db-query")];
	const root = makeRegistry({ "extra": skillMd("extra-skill", "Local") });
	try {
		const off = candidatesWithRegistry(bundled, root, configWith(false), (m) => warns.push(m));
		assert.equal(off, bundled, "identity: no merge, no filesystem scan while OFF");
		assert.equal(warns.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidatesWithRegistry: ON merges the workspace registry under the bundled list", () => {
	const bundled = [bundledCandidate("db-query")];
	const root = makeRegistry({
		"extra": skillMd("extra-skill", "Local, un-annotated"),
		"shadow": skillMd("db-query", "Conflicting name"),
	});
	try {
		const merged = candidatesWithRegistry(bundled, root, configWith(true), () => {});
		assert.deepEqual(merged.map((c) => c.name), ["db-query", "extra-skill"]);
		assert.equal(merged.find((c) => c.name === "extra-skill").source, "local");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Catalog vs annotation split (§4.2)
// ---------------------------------------------------------------------------

test("un-annotated local skill: in the provider catalog, NOT in the annotation table", () => {
	const bundled = [bundledCandidate("db-query")];
	const root = makeRegistry({
		"annotated": skillMd("annotated-skill", "With tags", "constraints: verification_required\npool_hint: hard\n"),
		"plain": skillMd("plain-skill", "No frontmatter tags"),
	});
	try {
		const merged = candidatesWithRegistry(bundled, root, configWith(true), () => {});
		// Catalog: both locals are visible to the host's native disclosure.
		assert.deepEqual(merged.map((c) => c.name), ["db-query", "annotated-skill", "plain-skill"]);
		// Annotation table: only the constraint-annotated entry gains a row.
		const annotated = annotateSkillCandidates(merged);
		assert.deepEqual(annotated.map((s) => s.name), ["annotated-skill"]);
		assert.equal(renderSkillsTable(annotated).includes("plain-skill"), false);
		assert.equal(renderSkillsTable(annotated).includes("db-query"), false);
		assert.equal(renderSkillsTable(annotated).includes("annotated-skill"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("frontmatter optional fields: constraints absent → not annotated; pool_hint alone never annotates", () => {
	assert.equal(parseSkillAnnotations("---\nname: x\ndescription: y\n---\nbody"), null, "no constraints line → no annotation");
	assert.equal(parseSkillAnnotations("---\nname: x\ndescription: y\npool_hint: main\n---\nbody"), null, "pool_hint alone → no annotation");
	const withPool = parseSkillAnnotations("---\nname: x\ndescription: y\nconstraints: parallelizable\npool_hint: hard\n---\nbody");
	assert.deepEqual(withPool.tags, ["parallelizable"]);
	assert.equal(withPool.poolHint, "hard");
	assert.ok(Number.isInteger(withPool.estimatedTokens) && withPool.estimatedTokens > 0);
	const unknownPool = parseSkillAnnotations("---\nname: x\ndescription: y\nconstraints: parallelizable\npool_hint: turbo-lane\n---\nbody");
	assert.equal(unknownPool.poolHint, undefined, "unknown pool hint drops");
	const noPool = parseSkillAnnotations("---\nname: x\ndescription: y\nconstraints: parallelizable\n---\nbody");
	assert.equal(noPool.poolHint, undefined, "absent pool_hint stays absent");
});

test("pool_hint renders in the table only for annotated skills", () => {
	const table = renderSkillsTable([{ name: "a-skill", tags: ["parallelizable"], poolHint: "hard", estimatedTokens: 4000 }]);
	assert.equal(table.includes("[pool: hard]"), true);
	const plain = renderSkillsTable([{ name: "b-skill", tags: ["main"], estimatedTokens: 4000 }]);
	assert.equal(plain.includes("[pool:"), false);
});

// ---------------------------------------------------------------------------
// → load marker
// ---------------------------------------------------------------------------

test("→ load marker: hit rows gain it, miss rows stay byte-identical", () => {
	const annotated = [
		{ name: "db-query", tags: ["permission_boundary"], estimatedTokens: 4200 },
		{ name: "other-skill", tags: ["parallelizable"], estimatedTokens: 2000 },
	];
	const legacyRow = "- other-skill: parallelizable (~2k tok)";
	const withoutMarker = renderSkillsTable(annotated);
	assert.equal(withoutMarker.includes("→ load"), false, "no matched set → no marker (old callers byte-identical)");
	const matched = matchedSkillNames("please check db-query records", annotated);
	assert.deepEqual([...matched], ["db-query"]);
	const withMarker = renderSkillsTable(annotated, matched);
	assert.equal(withMarker.includes("- db-query: permission_boundary (~4.2k tok) → load"), true);
	assert.equal(withMarker.includes(legacyRow), true, "non-hit row byte-identical");
	// Same-name prefix must not match (word boundary).
	assert.equal(matchedSkillNames("the xdb-queryy tool", annotated).size, 0);
	// Marker never appears while the master switch gates the section OFF:
	// applyConstraints returns "" before rendering (covered in constraints.test.mjs).
});

// ---------------------------------------------------------------------------
// skill_loaded stats (P1 item 3 groundwork)
// ---------------------------------------------------------------------------

test("skill_loaded: gated recording, provider-fact shape, bounded cap, exported reader", () => {
	resetSkillLoadStats();
	// OFF: nothing recorded, nothing logged.
	const logs = [];
	recordSkillLoad({ name: "db-query", source: "bundled" }, false, (m) => logs.push(m));
	assert.deepEqual(getSkillLoadStats().entries, []);
	// ON: one event per get(), counts accumulate per skill, sources preserved.
	const bundled = { name: "db-query", source: "bundled" };
	const local = { name: "team-lint", source: "local" };
	recordSkillLoad(bundled, true, (m) => logs.push(m));
	recordSkillLoad(bundled, true, (m) => logs.push(m));
	recordSkillLoad(local, true, (m) => logs.push(m));
	const stats = getSkillLoadStats();
	assert.equal(stats.cap, SKILL_LOAD_CAP);
	assert.equal(stats.entries.length, 2);
	assert.deepEqual(stats.entries.map((e) => [e.name, e.source, e.count]), [
		["db-query", "bundled", 2],
		["team-lint", "local", 1],
	]);
	assert.ok(Number.isInteger(stats.entries[0].lastAt));
	assert.equal(logs.filter((m) => m.includes("skill_loaded")).length, 3);
	// Degenerate input never throws (fail-open).
	recordSkillLoad(null, true, null);
	recordSkillLoad(undefined, true, null);
	assert.equal(getSkillLoadStats().entries.length, 2);
	resetSkillLoadStats();
	assert.deepEqual(getSkillLoadStats(), { cap: SKILL_LOAD_CAP, entries: [] });
});

test("skill_loaded: bounded at SKILL_LOAD_CAP distinct names (insertion-order eviction)", () => {
	resetSkillLoadStats();
	const total = SKILL_LOAD_CAP + 20;
	for (let i = 0; i < total; i++) recordSkillLoad({ name: `skill-${String(i).padStart(4, "0")}`, source: "local" }, true, null);
	const stats = getSkillLoadStats();
	assert.equal(stats.entries.length, SKILL_LOAD_CAP, "cap holds");
	// Oldest (lowest-numbered) names evicted first; the newest survive.
	assert.equal(stats.entries.some((e) => e.name === `skill-${String(total - 1).padStart(4, "0")}`), true);
	assert.equal(stats.entries.some((e) => e.name === "skill-0000"), false);
	resetSkillLoadStats();
});
