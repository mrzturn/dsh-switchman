/** Preset intent categories for the "auto" pseudo-model's candidate list.
 *
 * A preset row ALWAYS exists in the merged candidate list: its note (the
 * text the classifier reads) is code-owned and immutable by mandate —
 * upgrades ship new wording without any settings migration — while the
 * route fields (provider/model/effort) and the enabled toggle stay
 * user-configured. Presets ship enabled with an empty model, so filling
 * the model is the single step that activates one.
 *
 * Descriptions are deliberately written FOR the classifier, not for
 * humans: each one states which user messages belong to the lane and
 * carries a contrastive anchor against its neighbours, because a small
 * local model needs explicit discrimination cues far more than prose
 * polish does. English by mandate. */

export const INTENT_PRESETS = [
	{
		id: "quick-chat",
		label: "Casual chat & quick Q&A",
		note: "Casual conversation, greetings, quick factual or meta questions about the session itself, and follow-up chatter. No code changes and no deep reasoning required; speed and cost matter most.",
	},
	{
		id: "mechanical-edit",
		label: "Mechanical edits & chores",
		note: "Small, fully specified changes: renames, typo and formatting fixes, config tweaks, license headers, running a known command, repetitive boilerplate edits. The plan is already given; execution is trivial.",
	},
	{
		id: "codebase-exploration",
		label: "Read-only codebase exploration",
		note: "Read-only investigation of the repository: locating code, tracing call paths, grepping symbols, summarizing how a subsystem works, or answering where/how something is implemented. Output is an explanation, not a diff.",
	},
	{
		id: "general-coding",
		label: "Everyday implementation",
		note: "Regular feature work and bug fixing: implementing a clear requirement across a few files, ordinary debugging, writing or updating tests and small scripts. The default lane for hands-on code changes.",
	},
	{
		id: "deep-reasoning",
		label: "Architecture & hard problems",
		note: "Decisions and problems that need careful, long thinking: architecture and design choices, multi-step orchestration, tricky cross-component bugs, algorithmic or concurrency issues, security-sensitive changes, anything with high rework cost if answered shallowly.",
	},
	{
		id: "code-review",
		label: "Review & verification",
		note: "Reading and judging existing changes or output: diff and PR review, adversarial verification of another agent's work, spotting regressions or spec violations, explaining whether and why a change is correct.",
	},
	{
		id: "docs-writing",
		label: "Docs, translation & wording",
		note: "Producing or polishing prose: documentation, READMEs, changelogs, commit messages, translation between languages, tone and clarity improvements. Language quality matters more than reasoning depth.",
	},
	{
		id: "vision-input",
		label: "Image understanding",
		note: "Turns whose input includes screenshots, photos, diagrams, charts, or UI mockups that must be visually interpreted to proceed.",
	},
];

const PRESET_BY_ID = new Map(INTENT_PRESETS.map((preset) => [preset.id, preset]));

function stringOf(value) {
	return typeof value === "string" ? value.trim() : "";
}

/** Deterministic id for a stored entry that predates ids (legacy rows keep
 * a stable identity across restarts even before the next settings save
 * persists one). Route-key based, with a numeric suffix on collisions. */
function derivedId(provider, model, used) {
	const base = `user:${provider}/${model}`;
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}#${n}`)) n += 1;
	return `${base}#${n}`;
}

/** Merge the stored candidate entries with the built-in presets into the
 * unified list the settings UI renders and the router filters.
 *
 * Rules:
 * - presets come first, in INTENT_PRESETS order, always all present;
 * - a stored entry whose id names a preset overrides that preset's
 *   route/effort/enabled, but its note is ALWAYS the code value;
 * - stored entries with unknown ids survive as user rows (graceful
 *   downgrade when a future preset id is removed again);
 * - legacy entries without ids get deterministic derived ids;
 * - fully-empty legacy junk (no id, no route, no note) is dropped, while
 *   any entry carrying an id survives as-is — a half-edited new row must
 *   not vanish from under the user between save and snapshot. */
export function mergeIntentCandidates(stored) {
	const list = Array.isArray(stored) ? stored : [];
	const presetOverrides = new Map();
	const userRows = [];
	// Pass 1 claims every explicit id BEFORE any derived id is minted, so a
	// later explicit row can never collide with an earlier legacy row's
	// derived `user:<provider>/<model>` name.
	const usedIds = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const id = stringOf(entry.id);
		if (id !== "") usedIds.add(id);
	}
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const id = stringOf(entry.id);
		const provider = stringOf(entry.provider);
		const model = stringOf(entry.model);
		const effort = stringOf(entry.effort);
		const note = stringOf(entry.note);
		const enabled = entry.enabled !== false;
		const preset = id === "" ? null : PRESET_BY_ID.get(id);
		if (preset !== null && preset !== undefined) {
			presetOverrides.set(preset.id, { provider, model, effort, enabled });
			usedIds.add(preset.id);
			continue;
		}
		if (id === "" && provider === "" && model === "" && note === "" && effort === "") continue;
		const row = {
			id: id !== "" ? id : derivedId(provider, model, usedIds),
			preset: false,
			enabled,
			provider,
			model,
		};
		if (effort !== "") row.effort = effort;
		if (note !== "") row.note = note;
		usedIds.add(row.id);
		userRows.push(row);
	}
	const rows = [];
	for (const preset of INTENT_PRESETS) {
		const override = presetOverrides.get(preset.id);
		const row = {
			id: preset.id,
			preset: true,
			enabled: override ? override.enabled : true,
			provider: override ? override.provider : "",
			model: override ? override.model : "",
			note: preset.note,
			label: preset.label,
		};
		if (override && override.effort !== "") row.effort = override.effort;
		rows.push(row);
	}
	for (const row of userRows) rows.push(row);
	return rows;
}

/** Only rows that actually participate in routing: enabled AND a complete
 * route. A preset still waiting for its model (or a freshly added custom
 * row) stays visible in the UI but outside the classifier's list. */
export function effectiveIntentCandidates(rows) {
	const list = Array.isArray(rows) ? rows : [];
	return list.filter(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			entry.enabled !== false &&
			typeof entry.provider === "string" &&
			entry.provider.trim() !== "" &&
			typeof entry.model === "string" &&
			entry.model.trim() !== "",
	);
}
