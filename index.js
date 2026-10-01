/** Host half of the dsh-switchman bundle.
 *
 * Mounts the bundle's bundled skills: every `skills/<name>/SKILL.md` under
 * this package is registered on `ctx.skills` through one static provider,
 * following the shipped `@deepseek-ai/dsh-skill-badge` / `dsh-skill-office`
 * pattern (source "bundled", rank BUNDLED_SKILL_RANK, directory resource
 * base so the skill tool tells the Agent where `scripts/` and `references/`
 * live). The preset overrides live in cordis.patch.yml; the Client half in
 * client.js renders the "team autonomy" badge beside the preset chip.
 *
 * Phase 1 additionally mounts the language-preference layer (host/lang.js):
 * a dynamic systemPrompt section carrying the `[SWITCHMAN:LANG]` protocol
 * block plus a `tools/post-execute` listener that captures ask_user_question
 * answers and persists them into this plugin's settings namespace.
 *
 * Phase 2 mounts the dispatch-pool layer (host/dispatch.js + host/lib/rank.js):
 * a `[SWITCHMAN:POOLS]` recommendation section ordered by modelRank anchors
 * and the bundled capability snapshot, plus an optional (enforce mode only)
 * `tools/pre-execute` gate that denies subagent routes outside the pools.
 *
 * Phase 3 mounts the context-watermark layer (host/context-watch.js): the
 * `[SWITCHMAN:WATERMARK]` tiered banner from the live token meter, a per-turn
 * read budget with deny/cap gates, force-tier fire-and-forget handover into
 * compaction, and the /ctx-pause, /ctx-resume, /ctx-handover commands.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Plugin settings schema: flat `.volatile()` fields exposed as the
// "dsh-switchman" settings namespace (forms + profile-patch persistence).
export { Config, LANES, laneField } from "./host/config.js";

// Language-preference layer (dynamic prompt section + answer capture).
import { applyLanguage } from "./host/lang.js";

// Dispatch-pool layer (pools recommendation section + enforce gate).
import { applyDispatch } from "./host/dispatch.js";

// Context-watermark layer (banner + read budget + handover + /ctx-* commands).
import { applyContextWatch } from "./host/context-watch.js";

// Client-bridge routes (config snapshot/fenced write + model catalog for the
// restricted browser half, which has no configForms/remote services).
import { applyRoutes } from "./host/routes.js";

/** Cordis plugin name. */
const name = "dsh-switchman";

/** Services this plugin contributes to: the bundled-skill registry, the
 * system-prompt section registry, the settings store it writes back to, the
 * token meter and agent registry the watermark reads, the compaction service
 * the handover fires into, and the command registry for /ctx-*. */
// NOTE: "compaction" is deliberately NOT injected — presets mount it inside
// an isolated per-agent composition, so a root-level inject would wait
// forever; host/context-watch.js resolves it through the agent's own ctx.
const inject = ["skills", "systemPrompt", "settings", "tokenMeter", "commands", "agents", "webServer"];

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

/** Register the bundled dsh-switchman skill provider on `ctx.skills` and
 *  mount the language (lang), dispatch (dispatch), and watermark
 *  (context-watch) layers. */
function apply(ctx, config) {
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
	applyLanguage(ctx, config);
	applyDispatch(ctx, config);
	applyContextWatch(ctx, config);
	applyRoutes(ctx, config);
}

export { apply, inject, name };
