/** Enumeration of this session's still-running background subagents.
 *
 * Why this exists: a context handover (compaction) preserves dispatched
 * background subagents — they keep running. The parent's job registries
 * never list continuable children, and while the Agent-Teams bundle is
 * active send_message resolves teammate names only, so subagent-child
 * ids cannot be addressed mid-run (the global send_message({ agent_id })
 * could; the bundle replaces it). An agent that mistakes "not
 * addressable" for "dead" then double-dispatches. Recording the live
 * children — plus how to read their state — into the handover document
 * closes that gap.
 *
 * Disk format (verified against a packaged host's live records under
 * <DSH_HOME>/storages/session_projcache/sessions/):
 *
 * - Parent record `<sessionId>.json` (sessionId carries the `session-`
 *   prefix) -> { record: { rows: { subagentCatalog: { val: { head:
 *   { values: [{ childId, childCreatedAt, mode, label }, ...] } } } } } }
 *   — the append-only catalog of every subagent dispatched from the
 *   session (labels are the dispatch `description`).
 * - Child record `<childId>.json` (bare UUID) — running iff
 *   rows.sessionStats.val.openStep !== null; a settled child has
 *   openStep === null and rows.turnBoundary.val.lastStepBoundary
 *   === { kind: "end" } while a running one shows { kind: "start" }.
 *
 * Every failure mode is fail-open to [] — enumeration is advisory
 * context for the handover document, never a blocker. */
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

/** This session's still-running background subagents as
 * [{ id, label, mode }], empty when none are detected (or on any error).
 * Reads only; never throws. Disk fallback for enumerateRunningSubagents:
 * the projcache snapshot lags live state slightly (and a crashed child
 * can leave a stale open step), but it survives every service hiccup. */
export function runningSubagentsOf(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return [];
	const directory = sessionRecordsDir();
	const parentRows = recordPaths(directory, sessionId)
		.map((path) => readRows(path))
		.find((rows) => rows !== null);
	const catalog = parentRows?.subagentCatalog?.val;
	const entries = catalog?.head?.values;
	if (!Array.isArray(entries)) return [];
	const running = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const childId = entry.childId;
		if (typeof childId !== "string" || childId === "") continue;
		const childRows = recordPaths(directory, childId)
			.map((path) => readRows(path))
			.find((rows) => rows !== null);
		if (childRows === null) continue; // never created, or pruned: not live work
		if (childRows.sessionStats?.val?.openStep == null) continue; // settled
		running.push({
			id: childId,
			label: typeof entry.label === "string" ? entry.label : "",
			mode: typeof entry.mode === "string" ? entry.mode : "",
		});
	}
	return running;
}

/** Sanctioned enumeration (preferred over the disk scan): the live
 * subagent catalog service plus the in-memory agent registry — no flush
 * lag, no stale-after-crash heuristic. `listChildren` accepts the session
 * id; both id forms (with/without the `session-` prefix) are probed
 * because the wire form is not contractual. Falls back to the disk scan
 * whenever the services are absent, disagree with the shapes above, or
 * throw. Never throws. */
export async function enumerateRunningSubagents(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return [];
	try {
		const subagents = typeof ctx?.get === "function" ? ctx.get("subagents") : null;
		const agents = typeof ctx?.get === "function" ? ctx.get("agents") : null;
		if (
			subagents !== null &&
			typeof subagents.listChildren === "function" &&
			agents !== null &&
			typeof agents.get === "function"
		) {
			const candidates = new Set([sessionId]);
			const bare = sessionId.replace(/^session-/u, "");
			if (bare !== sessionId) candidates.add(bare);
			for (const id of candidates) {
				let children;
				try {
					children = await subagents.listChildren(id);
				} catch {
					continue; // this id form is unusable — probe the next one
				}
				if (!Array.isArray(children)) continue;
				const running = [];
				for (const child of children) {
					if (child === null || typeof child !== "object") continue;
					if (typeof child.id !== "string" || child.id === "") continue;
					if (agents.get(child.id)?.status !== "running") continue;
					running.push({
						id: child.id,
						label: typeof child.label === "string" ? child.label : "",
						mode: typeof child.mode === "string" ? child.mode : "",
					});
				}
				return running; // first id form that answers wins, even when empty
			}
		}
	} catch {
		/* fall through to the disk scan */
	}
	return runningSubagentsOf(sessionId);
}
