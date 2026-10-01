/** Host half of the dsh-switchman bundle.
 *
 * Mounts the bundle's bundled skills: every `skills/<name>/SKILL.md` under
 * this package is registered on `ctx.skills` through one static provider,
 * following the shipped `@deepseek-ai/dsh-skill-badge` / `dsh-skill-office`
 * pattern (source "bundled", rank BUNDLED_SKILL_RANK, directory resource
 * base so the skill tool tells the Agent where `scripts/` and `references/`
 * live). The preset overrides live in cordis.patch.yml; the Client half in
 * client.js renders the "team autonomy" badge beside the preset chip.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin name. */
const name = "dsh-switchman";

/** The bundled-skill registry service this plugin contributes to. */
const inject = ["skills"];

/** Must equal `BUNDLED_SKILL_RANK` of @deepseek-ai/dsh-skill (packaged skill
 *  providers and local bundled roots; below user entries, above none). Not
 *  imported because that package is not a dependency of this bundle. */
const BUNDLED_SKILL_RANK = 600;

/** Provider id reported by every candidate (must match `provider`). */
const PROVIDER_NAME = "dsh-switchman";

/** Parse the `---` frontmatter subset used by the bundled SKILL.md files:
 *  single-line `key: value` scalars. Unknown keys are ignored, matching the
 *  shipped filesystem provider's tolerance. */
function parseSkillFile(raw, path) {
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

/** Build one bundled-skill candidate from a skill directory. */
function loadSkillCandidate(directory) {
	const path = join(directory, "SKILL.md");
	const parsed = parseSkillFile(readFileSync(path, "utf8"), path);
	return {
		name: parsed.name,
		description: parsed.description,
		invocation: { modelInvocable: true, userInvocable: true },
		provider: PROVIDER_NAME,
		source: "bundled",
		rank: BUNDLED_SKILL_RANK,
		resourceBase: { kind: "directory", path: `${directory}/` },
		locator: path,
	};
}

/** Scan ./skills at apply time; broken entries warn and drop, never throw. */
function loadSkillCandidates(root, warn) {
	const candidates = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		warn(`skills directory missing or unreadable: ${root}`);
		return candidates;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const directory = join(root, entry.name);
		try {
			candidates.push(loadSkillCandidate(directory));
		} catch (error) {
			warn(`skill directory ${directory} ignored: ${error?.message ?? error}`);
		}
	}
	return candidates;
}

/** Register the bundled dsh-switchman skill provider on `ctx.skills`. */
function apply(ctx) {
	const root = fileURLToPath(new URL("./skills/", import.meta.url));
	const warn = (message) => ctx.logger.warn(`dsh-switchman: ${message}`);
	const candidates = loadSkillCandidates(root, warn);
	const provider = {
		name: PROVIDER_NAME,
		list: () => Promise.resolve(candidates),
		async get(candidate) {
			const { rank: _rank, locator, ...summary } = candidate;
			return { ...summary, content: parseSkillFile(readFileSync(locator, "utf8"), locator).content };
		},
	};
	ctx.skills.registerProvider(() => provider);
}

export { apply, inject, name };
