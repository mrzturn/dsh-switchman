/** dsh-switchman pool-feedback layer (refactor guide §4.5, P1 item 3).
 *
 * Closes the pool-recommendation loop with the only dispatch-relevant
 * signal observable at this layer so far: WHICH annotated skills are
 * actually being loaded (the skill_loaded stats recorded by
 * host/skill-registry.js, guide §5.2.1). A skill annotated with a
 * `pool_hint` frontmatter tag maps 1:1 onto a dispatch lane, so its
 * load tier becomes a per-lane contrast signal rendered beside the
 * pools table:
 *
 *   [SWITCHMAN:POOLS-FEEDBACK] skill loads since enable, by pool_hint lane (tier labels only; few = 1-5 loads, often = 6+):
 *   - mechanical: db-query often, git-commit-message few
 *   - main: requirement-docs never
 *
 * `never` rows are the guide's long-term-zero-load signal: a lane whose
 * annotated skills have not been pulled once since the layer started
 * recording. The guide's full pool × model × skill success/latency/
 * rework telemetry (§4.5) needs dispatch-result observability that does
 * not exist yet — those rows are later increments; this section never
 * touches or blocks the main `[SWITCHMAN:POOLS]` table.
 *
 * MODEL-VISIBILITY (same policy as constraints.js / context-watch.js):
 * the injected block carries NO absolute counts, NO timestamps, and NO
 * numeric watermark values — only tier labels (`never` / `few` /
 * `often`). The header's `1-5` / `6+` are the generic bucket
 * definitions, not observations. The host-side log line carries the
 * exact counts instead (logs never reach the model).
 *
 * OFF by default (`poolFeedbackEnabled`, an independent switch): the
 * section renders "" on every assembly = zero prompt diff. The DATA
 * depends on constraintsEnabled (load recording and pool-hint
 * annotations are gated behind it), so an on/off mismatch simply
 * renders "" — no error, no partial block.
 *
 * Fail-open everywhere: missing stats, missing hints, junk shapes, or
 * any throw inside the section render "" — the session keeps its prompt
 * and only loses the feedback lines.
 *
 * Zero new dependencies; ESM; same conventions as the other host/*.js layers.
 */

import { LANES } from "./config.js";
import { getSkillLoadStats } from "./skill-registry.js";

/** Final position of the pool-feedback section: right after the
 * constraints/skills section (10405) — the feedback rows qualify the
 * `[pool: x]` hints that section prints, and both read as footnotes of
 * the pools table (10400). Free slot: 10200 (lang head), 10250 (teams),
 * 10300 (lang), 10400 (dispatch), 10405 (constraints), 10450
 * (context-trim), 10510 (ptc-guard) are taken; a LATER order also keeps
 * every existing section the "last word" on its own topic. */
export const POOL_FEEDBACK_ORDER = 10406;

/** Load tiers, strongest first: the FIRST bucket whose minimum the load
 * count meets wins. Labels only — the counts themselves never leave the
 * host (MODEL-VISIBILITY policy, see file header). */
const LOAD_TIERS = Object.freeze([
	{ min: 6, label: "often" },
	{ min: 1, label: "few" },
	{ min: 0, label: "never" },
]);

/** Tier label of one raw load count (missing/NaN counts as 0 = never). */
function tierLabelOf(count) {
	const n = Number.isFinite(count) ? count : 0;
	for (const tier of LOAD_TIERS) {
		if (n >= tier.min) return tier.label;
	}
	return LOAD_TIERS[LOAD_TIERS.length - 1].label;
}

/** Render rank of a tier label (often sorts before few before never
 * inside a lane so the busiest signal leads the row). */
function tierRank(label) {
	return LOAD_TIERS.findIndex((tier) => tier.label === label);
}

/** Total skill-item cap across all lanes: bounds the injected block for
 * pathological annotated sets (mirrors constraints.js MAX_SKILL_ROWS). */
const MAX_FEEDBACK_ITEMS = 16;

/** The header line: one legend stating the tier semantics (the only
 * digits in the whole block, and they are bucket definitions, not
 * observations). */
const FEEDBACK_HEADER =
	"[SWITCHMAN:POOLS-FEEDBACK] skill loads since enable, by pool_hint lane (tier labels only; few = 1-5 loads, often = 6+):";

/** The `[SWITCHMAN:POOLS-FEEDBACK]` block, or "" when there is nothing
 * to report. `annotatedSkills` is a plain array ({ name, poolHint }
 * entries); `loadEntries` mirrors getSkillLoadStats().entries
 * ({ name, count }). One row per lane that owns at least one hinted
 * skill, lanes in LANES (pools-table) order, items tier-then-name
 * ordered — byte-stable for a given observation state. Skills without
 * a valid pool hint carry no lane signal and stay out entirely (the
 * loop annotates POOLS, not the raw catalog). */
export function renderPoolFeedbackBlock(annotatedSkills, loadEntries) {
	if (!Array.isArray(annotatedSkills) || annotatedSkills.length === 0) return "";
	const counts = new Map();
	for (const entry of Array.isArray(loadEntries) ? loadEntries : []) {
		if (typeof entry?.name === "string" && entry.name !== "") counts.set(entry.name, Number(entry.count));
	}
	const perLane = new Map();
	let total = 0;
	for (const lane of LANES) {
		const items = [];
		for (const skill of annotatedSkills) {
			if (total >= MAX_FEEDBACK_ITEMS) break;
			const name = typeof skill?.name === "string" ? skill.name : "";
			if (name === "" || skill?.poolHint !== lane) continue;
			const label = tierLabelOf(counts.get(name));
			items.push({ name, label, rank: tierRank(label) });
			total += 1;
		}
		if (items.length > 0) perLane.set(lane, items);
	}
	const rows = [];
	for (const lane of LANES) {
		const items = perLane.get(lane);
		if (items === undefined) continue;
		items.sort((left, right) => (left.rank - right.rank) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		rows.push(`- ${lane}: ${items.map((item) => `${item.name} ${item.label}`).join(", ")}`);
	}
	if (rows.length === 0) return "";
	return [FEEDBACK_HEADER, ...rows].join("\n");
}

/** Host-side audit log: one line whenever the rendered feedback signature
 * changes (counts allowed — logs never reach the model). Module-level
 * single string: the stats are plugin-global, so one last-signature slot
 * is enough and stays bounded. */
let lastFeedbackSignature = "";
function logFeedbackChange(ctx, block, loadEntries) {
	try {
		const counts = new Map((Array.isArray(loadEntries) ? loadEntries : []).map((entry) => [entry?.name, entry?.count]));
		const rows = block.split("\n").slice(1);
		const signature = rows.join("|");
		if (signature === lastFeedbackSignature) return;
		lastFeedbackSignature = signature;
		// Item shape is `name tier` (skill names are kebab-case, no spaces),
		// so a flat pattern enriches each tier label with its exact count.
		const detail = rows
			.map((row) =>
				row
					.replace(/^-\s*/, "")
					.replace(/(\S+) (never|few|often)/g, (match, name, tier) => `${name} ${tier}(${counts.get(name) ?? 0})`),
			)
			.join("; ");
		ctx.logger?.info?.(`dsh-switchman: pool feedback updated: ${detail}`);
	} catch {
		/* fail open */
	}
}

/** Mount the pool-feedback layer: one systemPrompt section. Records no
 * state of its own (the stats live in skill-registry.js). Registration
 * is defensive like every other layer; a failure warns and disables the
 * layer, never throws. `annotatedSkills` may be an array or a
 * per-assembly closure — resolved ONCE here, before any helper sees it,
 * so a raw closure never reaches the for..of helpers (review F6's
 * lesson from constraints.js). */
export function applyPoolFeedback(ctx, config, annotatedSkills) {
	const warn = (message) => ctx?.logger?.warn?.(`dsh-switchman: ${message}`);
	try {
		ctx.systemPrompt.section({
			name: "switchman:pool-feedback",
			order: POOL_FEEDBACK_ORDER,
			interpolate: false,
			text: (context) => {
				try {
					// Master switch: off renders "" on every assembly — the
					// section exists but contributes zero bytes (zero diff).
					if (config?.poolFeedbackEnabled?.get() !== true) return "";
					// Per-assembly closure (index.js) or plain array (tests):
					// resolve first so downstream helpers always see an array.
					const skills = typeof annotatedSkills === "function" ? annotatedSkills(context?.agent) : annotatedSkills;
					const stats = getSkillLoadStats();
					const block = renderPoolFeedbackBlock(skills, stats?.entries);
					if (block !== "") logFeedbackChange(ctx, block, stats?.entries);
					return block;
				} catch {
					return "";
				}
			},
		});
	} catch (error) {
		warn(`systemPrompt.section registration failed — pool-feedback lines disabled: ${error?.message ?? error}`);
	}
}
