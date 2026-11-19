/** dsh-switchman open skill registry (refactor guide §5.2.2, P1 item 2)
 * + skill-load observability (§5.2.1, P1 item 1).
 *
 * Open registry: a workspace directory (default `<cwd>/.dsh-switchman/skills/`,
 * configurable via the volatile `skillRegistryDir` setting) where every
 * subdirectory containing a SKILL.md registers as a LOCAL skill on the same
 * `ctx.skills` provider as the bundled ones (§4.2 frontmatter contract:
 * name/description required, constraints/pool_hint optional — missing
 * optional fields simply mean "no annotation"). Everything here fails open:
 * a broken entry warns and is skipped, never failing the other skills, the
 * provider, or the session.
 *
 * Workspace resolution follows the host's own pattern: the skill tool calls
 * `ctx.skills.list({ cwd })` with the session's working directory, so the
 * scan root resolves per lookup (relative settings join the session cwd,
 * absolute settings are used verbatim). A missing directory is normal
 * (silent no-op); a present-but-unreadable one warns. Directory listings are
 * cached per resolved root keyed by the directory's mtime, so adding or
 * removing a skill directory is picked up without a plugin reload (content
 * EDITS inside a SKILL.md (including full file replacement — a new file
 * never bumps the parent directory's mtime) keep the stale copy until
 * reload — same freeze
 * semantics the apply-time bundled scan always had; the native filesystem
 * provider's watcher budget is deliberately not replicated).
 *
 * Name conflicts: bundled skills win, later locals lose to earlier locals;
 * every dropped duplicate warns. Names must match the host's skill-name
 * grammar (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) because the host REJECTS a
 * provider's whole contribution on one invalid candidate — validating here
 * keeps that failure mode impossible (fail-open at our boundary).
 *
 * skill_loaded observability (§5.2.1): every provider get() records one
 * bounded in-memory event (per-skill count, cap 256, plugin-global — the
 * P1 pool-feedback loop wants cross-session signal, sessions come and go).
 * The trigger (which turn/message caused the load) is not observable at the
 * provider layer, so the event records the provider-level fact only.
 * Exported readers feed P1 item 3.
 *
 * Zero new dependencies; ESM; same conventions as the other host/*.js layers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Cordis plugin name; also the provider id reported by every candidate. */
export const PROVIDER_NAME = "dsh-switchman";

/** Must equal `BUNDLED_SKILL_RANK` of @deepseek-ai/dsh-skill (packaged skill
 *  providers and local bundled roots). Not imported because that package is
 *  not a dependency of this bundle. */
export const BUNDLED_SKILL_RANK = 600;

/** The host's own skill-name grammar (packages/skill/skill/src/index.ts
 *  SKILL_NAME). Local candidates violating it are skipped with a warning —
 *  the host would otherwise reject this provider's whole contribution. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Default registry directory, relative to the session cwd. Deliberately NOT
 *  `<cwd>/.dsh/skills` or `<cwd>/.agents/skills`: those roots are ALREADY
 *  scanned by the host's native skill-filesystem provider, so skills placed
 *  there would register twice (once natively, once here). A switchman-owned
 *  dot-directory keeps the two catalogs disjoint and the annotation layer
 *  free of duplicate-metadata rows (guide §4.2). */
export const DEFAULT_REGISTRY_DIR = ".dsh-switchman/skills";

/** Root-scan cache cap: distinct resolved registry roots remembered at once
 *  (sessions rarely exceed a handful of workspaces). */
const SCAN_CACHE_CAP = 32;

/** skill_loaded stat cap: distinct skills tracked before the oldest entry is
 *  evicted (insertion-order bounded Map, same pattern as constraints.js). */
export const SKILL_LOAD_CAP = 256;

// ---------------------------------------------------------------------------
// Frontmatter parsing (moved verbatim from index.js so the registry scanner
// and the bundled loader share one parser)
// ---------------------------------------------------------------------------

/** Parse the `---` frontmatter subset used by SKILL.md files: single-line
 *  `key: value` scalars. Unknown keys are ignored, matching the shipped
 *  filesystem provider's tolerance. */
export function parseSkillFile(raw, path) {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	if (frontmatter?.[1] === undefined)
		throw new Error(`${path}: missing YAML frontmatter`);
	const fields = {};
	for (const line of frontmatter[1].split(/\r?\n/u)) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
		if (match === null) continue;
		let value = match[2].trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
			value = value.slice(1, -1);
		fields[match[1]] = value;
	}
	if (typeof fields.name !== "string" || fields.name.length === 0)
		throw new Error(`${path}: frontmatter requires name`);
	if (typeof fields.description !== "string" || fields.description.length === 0)
		throw new Error(`${path}: frontmatter requires description`);
	return { name: fields.name, description: fields.description, content: raw.slice(frontmatter[0].length).trim() };
}

// ---------------------------------------------------------------------------
// Registry directory resolution + scanning
// ---------------------------------------------------------------------------

/** Resolve the registry root for one session cwd. Empty result = "do not
 *  scan" (no usable cwd is a documented fail-open, not an error). The
 *  setting is read live (volatile) on every call. */
export function resolveRegistryRoot(cwd, config) {
	try {
		const setting = typeof config?.skillRegistryDir?.get === "function"
			? String(config.skillRegistryDir.get() ?? "").trim()
			: "";
		const base = setting !== "" ? setting : DEFAULT_REGISTRY_DIR;
		if (typeof cwd !== "string" || cwd === "") return "";
		return isAbsolute(base) ? base : join(cwd, base);
	} catch {
		return "";
	}
}

/** Build one local-skill candidate from a registry directory. Throws on any
 *  broken input — the caller warns and skips (fail-open per skill). */
function loadLocalCandidate(directory) {
	const path = join(directory, "SKILL.md");
	const parsed = parseSkillFile(readFileSync(path, "utf8"), path);
	if (!SKILL_NAME.test(parsed.name))
		throw new Error(`${path}: invalid skill name "${parsed.name}" (lowercase kebab-case required)`);
	return {
		name: parsed.name,
		description: parsed.description,
		invocation: { modelInvocable: true, userInvocable: true },
		provider: PROVIDER_NAME,
		source: "local",
		rank: BUNDLED_SKILL_RANK,
		resourceBase: { kind: "directory", path: `${directory}/` },
		locator: path,
	};
}

/** Scan the registry root once; cached per root by directory mtime. Returns
 *  [] for a missing root (normal — the user registered nothing here yet) and
 *  warns + skips broken entries individually. */
export function scanRegistryCandidates(root, warn) {
	if (typeof root !== "string" || root === "") return [];
	let stat;
	try {
		stat = statSync(root);
	} catch {
		return []; // missing registry directory: the normal no-op path
	}
	if (!stat.isDirectory()) return [];
	const cached = scanCache.get(root);
	if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.candidates;
	const candidates = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		warn?.(`skill registry ${root} unreadable, local skills skipped: ${error?.message ?? error}`);
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const directory = join(root, entry.name);
		try {
			candidates.push(loadLocalCandidate(directory));
		} catch (error) {
			warn?.(`skill registry entry ${directory} ignored: ${error?.message ?? error}`);
		}
	}
	if (scanCache.size >= SCAN_CACHE_CAP && !scanCache.has(root)) {
		const oldest = scanCache.keys().next().value;
		if (oldest !== undefined) scanCache.delete(oldest);
	}
	scanCache.set(root, { mtimeMs: stat.mtimeMs, candidates });
	return candidates;
}

/** The module-level root scan cache (see SCAN_CACHE_CAP). */
const scanCache = new Map();

/** Merge bundled and local candidates into one provider contribution:
 *  bundled names win, first registration wins among locals; every dropped
 *  duplicate warns. Order: bundled first, then locals in scan order. */
export function mergeSkillCandidates(bundled, local, warn) {
	const base = Array.isArray(bundled) ? bundled : [];
	const extra = Array.isArray(local) ? local : [];
	if (extra.length === 0) return base;
	const seen = new Set();
	const merged = [];
	for (const candidate of [...base, ...extra]) {
		const name = typeof candidate?.name === "string" ? candidate.name : "";
		if (name === "" || seen.has(name)) {
			if (name !== "") warn?.(`skill "${name}" ignored: name already registered (earlier entry wins)`);
			continue;
		}
		seen.add(name);
		merged.push(candidate);
	}
	return merged;
}

/** The single OFF gate for the registry: with `constraintsEnabled` false the
 *  bundled list is returned untouched and the filesystem is never touched
 *  (review F1 short-circuit standard). With it on, the registry scan joins
 *  the bundled candidates under the conflict rules above. */
export function candidatesWithRegistry(bundled, cwd, config, warn) {
	if (config?.constraintsEnabled?.get() !== true) return Array.isArray(bundled) ? bundled : [];
	return mergeSkillCandidates(bundled, scanRegistryCandidates(resolveRegistryRoot(cwd, config), warn), warn);
}

// ---------------------------------------------------------------------------
// skill_loaded observability (§5.2.1) — the P1 pool-feedback data source
// ---------------------------------------------------------------------------

/** skill name → { source, count, lastAt }, insertion-ordered, bounded. */
const skillLoadStats = new Map();

/** Record one provider-level skill load. `enabled` is the live master-switch
 *  read (OFF records nothing — the whole layer short-circuits); `info` is an
 *  optional host logger. Any throw is swallowed: observability must never
 *  break a skill load. */
export function recordSkillLoad(candidate, enabled, info) {
	try {
		if (enabled !== true) return;
		const name = typeof candidate?.name === "string" ? candidate.name : "";
		if (name === "" || !SKILL_NAME.test(name)) return;
		const source = candidate?.source === "local" ? "local" : "bundled";
		const previous = skillLoadStats.get(name);
		const record = { source, count: (previous?.count ?? 0) + 1, lastAt: Date.now() };
		if (previous !== undefined) skillLoadStats.delete(name);
		skillLoadStats.set(name, record);
		if (skillLoadStats.size > SKILL_LOAD_CAP) {
			const oldest = skillLoadStats.keys().next().value;
			if (oldest !== undefined) skillLoadStats.delete(oldest);
		}
		info?.(`skill_loaded (provider get): ${name} source=${source} count=${record.count}`);
	} catch {
		/* fail open */
	}
}

/** Bounded snapshot of the load statistics, busiest first (count desc, then
 *  name asc for byte-stable output). Plain JSON — the P1 pool-feedback loop
 *  consumes this shape; keep it stable. */
export function getSkillLoadStats() {
	try {
		const entries = [...skillLoadStats.entries()].map(([name, record]) => ({
			name,
			source: record.source,
			count: record.count,
			lastAt: record.lastAt,
		}));
		entries.sort((left, right) => (right.count - left.count) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		return { cap: SKILL_LOAD_CAP, entries };
	} catch {
		return { cap: SKILL_LOAD_CAP, entries: [] };
	}
}

/** Clear the load statistics (tests and future admin surfaces). */
export function resetSkillLoadStats() {
	try {
		skillLoadStats.clear();
	} catch {
		/* fail open */
	}
}
