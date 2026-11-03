/** dsh-switchman context-trim fork-state inheritance.
 *
 * When a session is forked (subagent_fork tool, or the handover's backup
 * fork through the subagents service), the child conversation STARTS as a
 * content copy of the parent's history — including every range the parent
 * already folded. Without inheritance the child re-derives its ledger from
 * scratch and re-folds (or never folds) ranges the parent already settled,
 * and its first outbound view shows raw history.
 *
 * Copy-on-fork, in two halves:
 *
 * - Linkage (fork time): the parent→child edge is recorded the moment the
 *   fork is observed, into <stateDir>/fork-links.json (one bounded JSON
 *   map, atomic tmp+rename writes). Two call sites observe forks: the
 *   tools/post-execute listener on the subagent_fork tool (index.js) and
 *   the handover backup fork (context-watch.js forkBackup). Refs are
 *   CONTENT-anchored (view.js refOf), so a link only stores session ids.
 * - Inheritance (child first sight): when the child's history first flows
 *   through the llm/stream view builder, the parent ledger is cloned into
 *   the child's ledger — but ONLY when the parent ledger exists AND the
 *   child's history actually resolves the parent's frontier ref. A stale
 *   inherited frontier that resolves nothing is worse than no inheritance
 *   (the frontier anchors fold monotonicity), so a failed guard starts the
 *   child clean. One inheritance per child: the adopted ledger carries an
 *   inheritedFrom/inheritedAt marker and adoptLedger (state.js) refuses to
 *   overwrite a ledger that already has blocks or a marker — idempotent
 *   across restarts because the marker persists with the ledger.
 *
 * Fail-open everywhere: a lost link, an unreadable map, or a rejected
 * guard only downgrades to a clean start (or a later attempt inside the
 * bounded window) — never a broken session start.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "../lib/dsh-home.js";
import { LEDGER_VERSION } from "./state.js";
import { refPositions } from "./view.js";

/** Current fork-links file format version. */
export const FORK_LINKS_VERSION = 1;

/** The link map stays bounded: at most this many child entries. */
export const FORK_LINKS_MAX = 500;

/** Link entries older than this are pruned on write. */
export const FORK_LINKS_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** How long a child stays eligible for inheritance while no link (or no
 * parent folds) has appeared yet — covers the fork race where the child's
 * first model call beats the parent's post-execute bookkeeping or the
 * parent's first idle-boundary fold. */
export const INHERIT_WINDOW_MS = 60_000;

/** Default state dir (same resolution as createStore in state.js). */
function defaultStateDir() {
	return join(dshHome(), ".dsh-switchman", "state", "trim");
}

/** Config field reader for trimStateDir (plain string or {get()} accessor,
 * matching the volatile-settings pattern). Null when unset. */
export function trimStateDirOf(config) {
	try {
		const value = config?.trimStateDir;
		const got = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
		if (typeof got === "string" && got !== "") return got;
	} catch {
		/* fall through */
	}
	return null;
}

function linksFileOf(stateDir) {
	return join(stateDir ?? defaultStateDir(), "fork-links.json");
}

/** Load the fork-links map (tolerant: any structural surprise yields an
 * empty map — a lost link only downgrades to a clean start). */
export function loadForkLinks(stateDir, warn = () => {}) {
	const file = linksFileOf(stateDir);
	try {
		if (!existsSync(file)) return { version: FORK_LINKS_VERSION, links: {} };
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || parsed.version !== FORK_LINKS_VERSION || parsed.links === null || typeof parsed.links !== "object") {
			warn("[context-trim] fork-links map has an unknown format — ignoring");
			return { version: FORK_LINKS_VERSION, links: {} };
		}
		const links = {};
		for (const [childId, entry] of Object.entries(parsed.links)) {
			if (typeof childId !== "string" || childId === "") continue;
			if (entry === null || typeof entry !== "object" || typeof entry.parent !== "string" || entry.parent === "") continue;
			links[childId] = { parent: entry.parent, at: Number.isFinite(entry.at) ? entry.at : 0 };
		}
		return { version: FORK_LINKS_VERSION, links };
	} catch (error) {
		warn(`[context-trim] fork-links load failed (${error?.message ?? error}) — ignoring`);
		return { version: FORK_LINKS_VERSION, links: {} };
	}
}

/** Record one parent→child fork edge (merge + prune + cap + atomic write).
 * Returns true when the edge is durably recorded; false on any failure.
 * Never throws — the fork itself already succeeded and must not be
 * invalidated by bookkeeping. */
export function recordForkLink(parentId, childId, options = {}) {
	const warn = typeof options.warn === "function" ? options.warn : () => {};
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	if (typeof parentId !== "string" || parentId === "" || typeof childId !== "string" || childId === "" || parentId === childId) return false;
	try {
		const map = loadForkLinks(options.stateDir, warn);
		map.links[childId] = { parent: parentId, at: now };
		// Prune by age, then cap by count (oldest dropped first).
		const entries = Object.entries(map.links).filter(([, entry]) => now - entry.at < FORK_LINKS_MAX_AGE_MS);
		entries.sort((a, b) => a[1].at - b[1].at);
		while (entries.length > FORK_LINKS_MAX) entries.shift();
		const links = {};
		for (const [keptId, entry] of entries) links[keptId] = entry;
		const dir = options.stateDir ?? defaultStateDir();
		mkdirSync(dir, { recursive: true });
		const file = linksFileOf(dir);
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: FORK_LINKS_VERSION, links }));
		renameSync(tmp, file);
		return true;
	} catch (error) {
		warn(`[context-trim] fork-link recording failed (${error?.message ?? error})`);
		return false;
	}
}

/** The fork edge recorded for one child, or null. */
export function forkLinkOf(map, childId) {
	try {
		const entry = map?.links?.[childId];
		if (entry === null || typeof entry !== "object" || typeof entry.parent !== "string" || entry.parent === "") return null;
		return entry;
	} catch {
		return null;
	}
}

/** Validate + build the child ledger that inherits the parent's fold state.
 * Pure. The guard requires the child's history to resolve the parent's
 * FRONTIER ref (content-anchored): a frontier that resolves nothing would
 * silently pin every future fold decision to a wrong boundary, so a
 * mismatching child starts clean. Returns { ok: true, ledger } or
 * { ok: false, reason }. */
export function resolveInheritance(parentLedger, parentId, childId, childMessages, now = Date.now()) {
	const blocks = Array.isArray(parentLedger?.blocks) ? parentLedger.blocks : [];
	if (blocks.length === 0) return { ok: false, reason: "parent-ledger-empty" };
	if (!Array.isArray(childMessages) || childMessages.length === 0) return { ok: false, reason: "no-child-history" };
	const frontier = typeof parentLedger.frontier === "string" && parentLedger.frontier !== "" ? parentLedger.frontier : null;
	if (frontier === null || !refPositions(childMessages).has(frontier)) return { ok: false, reason: "frontier-not-found" };
	// Detached copy: blocks are shared CONTENT but the ledgers must never
	// alias each other (two levels deep covers block + refRange).
	const ledger = {
		version: LEDGER_VERSION,
		sessionId: childId,
		blocks: blocks.map((block) => ({ ...block, refRange: { ...block.refRange } })),
		frontier,
		lastFoldViewTokens: Number.isFinite(parentLedger.lastFoldViewTokens) && parentLedger.lastFoldViewTokens > 0 ? Math.round(parentLedger.lastFoldViewTokens) : 0,
		lastFoldAt: Number.isFinite(parentLedger.lastFoldAt) ? parentLedger.lastFoldAt : 0,
		foldsThisHour: Array.isArray(parentLedger.foldsThisHour) ? parentLedger.foldsThisHour.filter((ts) => Number.isFinite(ts)) : [],
		inheritedFrom: typeof parentId === "string" && parentId !== "" ? parentId : "unknown",
		inheritedAt: now,
	};
	return { ok: true, ledger };
}
