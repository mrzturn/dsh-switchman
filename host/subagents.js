/** Enumeration of this session's dispatched background subagents.
 *
 * Why this exists: a context handover (compaction) preserves dispatched
 * background subagents — they keep running. The parent's job registries
 * never list continuable children, and while the Agent-Teams bundle is
 * active send_message resolves teammate names only, so subagent-child
 * ids cannot be addressed mid-run. An agent that mistakes "not
 * addressable" for "dead" then double-dispatches. Recording the live
 * children — plus how to read their state — into the handover document
 * closes that gap.
 *
 * Redesign after the 2026-10-05 double-dispatch incident: dispatches
 * issued in the turn that triggered the handover MATERIALIZE only when
 * the session machinery resumes — the catalog entry and the child's
 * session record are stamped minutes after the dispatching tool call,
 * which was after the handover's own snapshot in the old flow. Neither
 * the sanctioned registry nor the disk catalog could have listed them
 * at snapshot time; the fix is timing (context-watch.js re-enumerates
 * after compaction settles, immediately before waking the session) plus
 * semantics: enumeration now answers "what dispatched work exists",
 * never filters on a single "running" flag. A dispatched child whose
 * record exists but has neither an open step nor a definite end
 * boundary is PENDING work (queued / provisioning / interrupted) —
 * exactly the state the incident's children were missed in.
 *
 * Disk format (verified against a packaged host's live records under
 * <DSH_HOME>/storages/session_projcache/sessions/):
 *
 * - Parent record `<sessionId>.json` (sessionId carries the `session-`
 *   prefix) -> { record: { rows: { subagentCatalog: { val: { head:
 *   { values: [{ childId, childCreatedAt, mode, label }, ...] } } } } } }
 *   — the append-only catalog of every subagent dispatched from the
 *   session (labels are the dispatch `description`); entries appear
 *   when the child MATERIALIZES, not when the tool call is made.
 * - Child record `<childId>.json` (bare UUID) — the same rows map:
 *   running iff record.rows.sessionStats.val.openStep is neither null
 *   nor missing;
 *   settled (delivered/aborted, nothing pending) iff
 *   record.rows.turnBoundary.val.lastStepBoundary.kind === "end";
 *   anything else with an existing record is pending.
 *
 * Every failure mode is fail-open to [] — enumeration is advisory
 * context for the handover document, never a blocker. */

/** Child states, in rough order of "how much work is outstanding".
 * - "running": an open step exists right now.
 * - "pending": dispatched (record exists) but no definite end — covers
 *   queued/provisioning children and ones interrupted mid-flight.
 * - "settled": last step boundary is a definite end; the child
 *   delivered (or aborted) and holds no pending work.
 * - "gone": no record — never materialized or pruned; not live work. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./lib/dsh-home.js";

/** Parse one session-projcache record into its rows map, or null on any
 * structural surprise (missing file, bad JSON, unexpected shape). */
function readRows(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const rows = parsed?.record?.rows;
		return rows !== null && typeof rows === "object" ? rows : null;
	} catch {
		return null;
	}
}

/** Directory holding the session-projcache records (advisory text). */
export function sessionRecordsDir() {
	return join(dshHome(), "storages", "session_projcache", "sessions");
}

/** Absolute path of one session's projcache record — advisory text for
 * handover documents, so recorded collection paths honor DSH_HOME the
 * same way the enumeration lookups do. */
export function sessionRecordPath(id) {
	return join(sessionRecordsDir(), `${id}.json`);
}

/** Candidate file names for a session record: the observed convention is
 * `session-<uuid>.json` for conversation sessions and `<uuid>.json` for
 * subagent children, but probing both keeps the lookup robust. */
function recordPaths(directory, id) {
	const names = new Set([`${id}.json`]);
	const bare = id.replace(/^session-/u, "");
	if (bare !== id) names.add(`${bare}.json`);
	else names.add(`session-${id}.json`);
	return [...names].map((name) => join(directory, name));
}

/** First parseable rows map for a session id, or null. */
function rowsOf(directory, id) {
	return recordPaths(directory, id).map((path) => readRows(path)).find((rows) => rows !== null) ?? null;
}

/** Disk state of one child from its rows map (see the state table in the
 * header). A null record means "gone". */
function childDiskState(childRows) {
	if (childRows === null) return "gone";
	if (childRows.sessionStats?.val?.openStep != null) return "running";
	if (childRows.turnBoundary?.val?.lastStepBoundary?.kind === "end") return "settled";
	return "pending";
}

/** Every cataloged child of a session with its disk state:
 * [{ id, label, mode, childCreatedAt, state }]. The catalog is the
 * authoritative "was ever dispatched" list; states come from each
 * child's own record. Empty on any error — never throws. */
export function catalogChildrenOf(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return [];
	const directory = sessionRecordsDir();
	const parentRows = rowsOf(directory, sessionId);
	const entries = parentRows?.subagentCatalog?.val?.head?.values;
	if (!Array.isArray(entries)) return [];
	const children = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const childId = entry.childId;
		if (typeof childId !== "string" || childId === "") continue;
		const state = childDiskState(rowsOf(directory, childId));
		children.push({
			id: childId,
			label: typeof entry.label === "string" ? entry.label : "",
			mode: typeof entry.mode === "string" ? entry.mode : "",
			childCreatedAt: typeof entry.childCreatedAt === "number" ? entry.childCreatedAt : null,
			state,
		});
	}
	return children;
}

/** Live (unresolved) dispatched children of a session as
 * [{ id, label, mode, childCreatedAt, state }|{…, state: "running"}] —
 * running OR pending, disk truth first. The sanctioned agents registry,
 * when reachable, only ever UPGRADES a pending child to "running" (its
 * live view has no flush lag); it can never demote disk truth, because
 * a status vocabulary mismatch is precisely what missed the incident's
 * queued children. Never throws. */
export async function enumerateLiveSubagents(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return [];
	let live;
	try {
		live = catalogChildrenOf(sessionId).filter((child) => child.state === "running" || child.state === "pending");
	} catch {
		return [];
	}
	if (live.length === 0) return [];
	try {
		const agents = typeof ctx?.get === "function" ? ctx.get("agents") : null;
		if (agents !== null && typeof agents.get === "function") {
			for (const child of live) {
				if (child.state !== "pending") continue;
				if (agents.get(child.id)?.status === "running") child.state = "running";
			}
		}
	} catch {
		/* registry overlay is best-effort */
	}
	return live;
}
