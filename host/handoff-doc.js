/** dsh-switchman handoff document content spec (guide §4.6 — handoff_min /
 *  handoff_full split).
 *
 * The plugin-controllable surface of a DSH context handover is the
 * instruction text: the handover document template (written by the agent's
 * own fill-in step right after compaction) and the continuation prompt
 * (armed after the wake). §4.6 splits the document's content spec into two
 * levels:
 *
 * - handoff_min (REQUIRED, sync): task goal, current status, next steps,
 *   key files & commands, background subagent ids + report paths. These are
 *   the minimum a woken session needs to resume without re-dispatching or
 *   re-deriving live work.
 * - handoff_full (OPTIONAL, append-only): cost profile, decision history,
 *   open questions. Writing none of them never blocks the handover; they
 *   are excluded from every synchronous path (fail-open by construction —
 *   see guide §6 risk table).
 *
 * Pure text builders: no fs, no clock, no host access — snapshot-testable.
 * With `split` off, every builder returns byte-identical legacy text (the
 * pre-split template verbatim), so the default-off switch carries zero
 * behavior change. With `split` on and an empty profileLines array, the
 * split template is likewise byte-identical — only the P2 ① cost-attribution
 * block (host/cost-profile.js, gated by its own config switch) adds bytes,
 * spliced under the cost-profile bullet.
 */

/** Legacy (pre-split) "Task state" section, verbatim. */
const LEGACY_TASK_STATE_LINES = [
	`## Task state (filled in by the agent right after the handover)`,
	``,
	`- goal / objective in flight:`,
	`- completed so far:`,
	`- in progress:`,
	`- next steps:`,
	`- files touched / key references:`,
	``,
];

/** Split-mode sections: handoff_min (required, sync) then handoff_full
 *  (optional, skip-without-blocking). The live-subagent section above the
 *  template already carries ids + report paths; handoff_min references it
 *  instead of duplicating it. */
const SPLIT_TASK_LINES = [
	`## Task state — handoff_min (REQUIRED: fill in right after the handover, before continuing)`,
	``,
	`- goal / objective in flight:`,
	`- current status (completed / in progress):`,
	`- next steps (ordered, immediate):`,
	`- key files & commands (exact paths, commands, names):`,
	`- background subagents: ids + report paths — use the "Live background subagents" section above; collect their results, never re-dispatch`,
	``,
	`## Task context — handoff_full (OPTIONAL: append below only what is readily available; skipping any or all of it never blocks the handover)`,
	``,
	`- cost profile (tokens / calls spent so far, if cheaply known):`,
	`- decision history (the why behind key choices):`,
	`- open questions / unresolved risks:`,
	``,
];

/** Task-state section lines for one handover document.
 *  split=false → legacy bytes verbatim (zero diff). profileLines (optional,
 *  guide §5 P2 ① measured cost-attribution block from host/cost-profile.js)
 *  is spliced under the handoff_full cost-profile bullet; empty/absent →
 *  byte-identical to the pre-P2 split template. */
export function taskStateLines(split, profileLines = []) {
	const lines = (split ? SPLIT_TASK_LINES : LEGACY_TASK_STATE_LINES).slice();
	if (!split || !Array.isArray(profileLines) || profileLines.length === 0) return lines;
	const anchor = lines.findIndex((line) => line.startsWith("- cost profile"));
	if (anchor < 0) return lines; // template drift → fail open, never restructure
	lines.splice(anchor + 1, 0, ...profileLines);
	return lines;
}

/** Final fill-in sentence of the continuation prompt.
 *  split=false → legacy sentence verbatim (zero diff). The ON branch adds the
 *  guide §5 P2 ① resume-first-turn hint only when the measured cost profile
 *  is actually enabled (costProfileOn) — without it the sentence stays
 *  pre-P2 verbatim, never instructing about a block that will not exist. */
export function handoverFillInstruction(split, costProfileOn = false) {
	if (!split) {
		return `Using the compaction summary now in your context, fill in the handover document (goal, completed, in progress, next steps, files), then continue the unfinished task — do not wait for further instructions.`;
	}
	const measured = costProfileOn
		? ` The cost profile line may already carry dsh-switchman's measured session totals — treat them as given, do not re-derive them.`
		: ``;
	return `Using the compaction summary now in your context, fill in the handover document's handoff_min sections (goal, current status, next steps, key files & commands, background subagent ids + report paths) before continuing; its handoff_full sections (cost profile, decision history, open questions) are optional — append them only if readily available, skipping never blocks.${measured} Then continue the unfinished task — do not wait for further instructions.`;
}
