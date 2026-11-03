/** dsh-switchman context-trim fold ledger store (host side).
 *
 * One ledger per session: the ordered list of fold blocks plus fold
 * metadata (last fold's view-token estimate for the growth gate, fold
 * timestamps for the hourly cadence cap). Ledgers persist as one JSON
 * file per session under <dshHome>/.dsh-switchman/state/trim/ (or an
 * explicit state dir) — atomic tmp+rename writes, corrupt files reset the
 * ledger (fail-open: trimming must never brick a session over its own
 * bookkeeping).
 *
 * commitFold validates a new block against the CURRENT messages snapshot
 * (the posMap: refs -> indices) before it enters the ledger — ref range
 * must be locatable, segment-aligned, disjoint from every existing block,
 * and strictly monotonic (behind or inside the existing frontier is
 * rejected). Without a posMap (ctx_trim_fold against a stale capture) only
 * structural checks and exact-duplicate guards apply.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHome } from "../lib/dsh-home.js";
import { estimateTokensOf, refPositions } from "./view.js";

/** Current ledger file format version. */
export const LEDGER_VERSION = 1;

/** Filenames are session-id-derived; keep them filesystem-safe. */
function sanitizeSessionId(sessionId) {
	const raw = typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";
	// Percent-encode % and path separators FIRST so the mapping is injective
	// ("a/b" and "a_b" must never share one ledger file).
	const safe = Array.from(raw, (ch) => (ch === "%" ? "%25" : ch === "/" ? "%2F" : ch === "\\" ? "%5C" : ch)).join("").slice(0, 128);
	return safe === "" ? "default" : safe;
}

/** Empty ledger for one session. frontier = ref of the newest folded
 * message (the fold boundary); it only ever advances (monotonic). */
export function emptyLedger(sessionId) {
	return {
		version: LEDGER_VERSION,
		sessionId,
		blocks: [],
		frontier: null,
		lastFoldViewTokens: 0,
		lastFoldLowTokens: 0,
		lastFoldAt: 0,
		foldsThisHour: [],
		// Fork-state inheritance marker (fork.js): set only when this ledger
		// was cloned from a parent session — one inheritance per child.
		inheritedFrom: null,
		inheritedAt: 0,
	};
}

/** Structural validation of a candidate block (refRange/count/summary).
 * Returns the normalized block or null. */
export function normalizeBlock(candidate, now) {
	if (candidate === null || typeof candidate !== "object") return null;
	const firstId = candidate.refRange?.firstId;
	const lastId = candidate.refRange?.lastId;
	if (typeof firstId !== "string" || firstId === "" || typeof lastId !== "string" || lastId === "") return null;
	const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
	if (summary === "") return null;
	const count = Number.isInteger(candidate.count) && candidate.count > 0 ? candidate.count : 0;
	if (count <= 0) return null;
	const approxTokens = Number.isFinite(candidate.approxTokens) && candidate.approxTokens > 0 ? Math.round(candidate.approxTokens) : count;
	const kind = candidate.kind === "mechanical" ? "mechanical" : "summary";
	const tier = candidate.tier === "emergency" || candidate.tier === "pressure" || candidate.tier === "growth" || candidate.tier === "model" ? candidate.tier : "model";
	return {
		id: typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : `b${now}`,
		kind,
		tier,
		refRange: { firstId, lastId },
		count,
		approxTokens,
		summary,
		createdAt: now,
	};
}

/** Create the ledger store. options: { stateDir?, warn? }. stateDir wins
 * over the dshHome default; warn receives soft failures. */
export function createStore(options = {}) {
	const warn = typeof options.warn === "function" ? options.warn : () => {};
	const stateDir = options.stateDir ?? join(dshHome(), ".dsh-switchman", "state", "trim");
	const ledgers = new Map(); // sessionId -> ledger (loaded lazily)

	function fileFor(sessionId) {
		return join(stateDir, `${sanitizeSessionId(sessionId)}.json`);
	}

	/** Load one ledger (cached). Corrupt or unreadable files reset the
	 * ledger and are moved aside (best effort) for forensics. */
	function ledgerOf(sessionId) {
		const cached = ledgers.get(sessionId);
		if (cached !== undefined) return cached;
		let ledger = emptyLedger(sessionId);
		const file = fileFor(sessionId);
		try {
			if (existsSync(file)) {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.blocks) && parsed.version === LEDGER_VERSION) {
					ledger = {
						version: LEDGER_VERSION,
						sessionId,
						blocks: parsed.blocks,
						frontier: typeof parsed.frontier === "string" ? parsed.frontier : null,
						lastFoldViewTokens: Number.isFinite(parsed.lastFoldViewTokens) ? parsed.lastFoldViewTokens : 0,
						lastFoldLowTokens: Number.isFinite(parsed.lastFoldLowTokens) ? parsed.lastFoldLowTokens : 0,
						lastFoldAt: Number.isFinite(parsed.lastFoldAt) ? parsed.lastFoldAt : 0,
						foldsThisHour: Array.isArray(parsed.foldsThisHour) ? parsed.foldsThisHour.filter((ts) => Number.isFinite(ts)) : [],
						inheritedFrom: typeof parsed.inheritedFrom === "string" ? parsed.inheritedFrom : null,
						inheritedAt: Number.isFinite(parsed.inheritedAt) ? parsed.inheritedAt : 0,
					};
				} else {
					warn(`[context-trim] ledger for ${sanitizeSessionId(sessionId)} has an unknown format — resetting`);
					try {
						renameSync(file, `${file}.corrupt`);
					} catch {
						/* best effort */
					}
				}
			}
		} catch (error) {
			warn(`[context-trim] ledger load failed (${error?.message ?? error}) — resetting`);
			ledger = emptyLedger(sessionId);
			try {
				renameSync(file, `${file}.corrupt`);
			} catch {
				/* best effort */
			}
		}
		ledgers.set(sessionId, ledger);
		return ledger;
	}

	/** Persist one ledger atomically (tmp + rename). */
	function persist(ledger) {
		try {
			mkdirSync(stateDir, { recursive: true });
			const file = fileFor(ledger.sessionId);
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, JSON.stringify(ledger));
			renameSync(tmp, file);
			return true;
		} catch (error) {
			warn(`[context-trim] ledger persist failed (${error?.message ?? error})`);
			return false;
		}
	}

	/** Commit a fold block. posMap (refs -> indices of the CURRENT capture)
	 * enables full validation; returns { ok, ledger, block } or
	 * { ok: false, reason }. Memory only — persist() separately. */
	function commitFold(sessionId, candidate, posMap = null, now = Date.now()) {
		const block = normalizeBlock(candidate, now);
		if (block === null) return { ok: false, reason: "invalid-block" };
		const ledger = ledgerOf(sessionId);
		// exact-duplicate guard (same range already folded)
		for (const existing of ledger.blocks) {
			if (existing.refRange.firstId === block.refRange.firstId && existing.refRange.lastId === block.refRange.lastId) {
				return { ok: false, reason: "duplicate-range" };
			}
		}
		if (posMap !== null) {
			const positions = posMap instanceof Map ? posMap : refPositions(posMap);
			const firstList = positions.get(block.refRange.firstId);
			const lastList = positions.get(block.refRange.lastId);
			if (firstList === undefined || lastList === undefined) return { ok: false, reason: "refs-not-found" };
			// Content-addressed refs collide for duplicate messages, so one ref
			// may map to many positions. Anchor the pair on block.count and
			// search occurrences instead of trusting list extremes.
			let firstIdx = -1;
			let lastIdx = -1;
			for (const start of firstList) {
				const end = start + block.count - 1;
				if (lastList.includes(end)) {
					firstIdx = start;
					lastIdx = end;
					break;
				}
			}
			if (firstIdx < 0) return { ok: false, reason: "count-mismatch" };
			// monotonicity: the new range must sit strictly behind the
			// frontier range and be disjoint from every existing block.
			for (const existing of ledger.blocks) {
				const eFirst = positions.get(existing.refRange.firstId);
				const eLast = positions.get(existing.refRange.lastId);
				if (eFirst === undefined || eLast === undefined) continue; // stale block outside this capture
				const eStart = eFirst[0];
				const eEnd = eLast[eLast.length - 1];
				if (firstIdx <= eEnd && eStart <= lastIdx) return { ok: false, reason: "overlaps-existing-fold" };
			}
		}
		ledger.blocks.push(block);
		ledger.frontier = block.refRange.lastId;
		ledger.lastFoldAt = now;
		ledger.foldsThisHour = ledger.foldsThisHour.filter((ts) => now - ts < 3_600_000);
		ledger.foldsThisHour.push(now);
		ledgers.set(sessionId, ledger);
		return { ok: true, ledger, block };
	}

	/** Adopt a fully-built ledger as one session's ledger (fork-state
	 * inheritance, fork.js resolveInheritance). One-shot: refused when the
	 * session already carries fold blocks or an inheritance marker — real
	 * state is never overwritten. Caches AND persists; returns true when
	 * adopted. */
	function adoptLedger(sessionId, ledger) {
		const current = ledgerOf(sessionId);
		if ((Array.isArray(current.blocks) && current.blocks.length > 0) || current.inheritedFrom !== null) return false;
		if (ledger === null || typeof ledger !== "object" || ledger.sessionId !== sessionId) return false;
		ledgers.set(sessionId, ledger);
		return persist(ledger);
	}

	/** Record the view-token estimate captured at the last fold (growth-gate
	 * baseline) and persist. */
	function recordFoldBaseline(sessionId, viewTokens, lowTokens) {
		const ledger = ledgerOf(sessionId);
		if (Number.isFinite(viewTokens) && viewTokens > 0) ledger.lastFoldViewTokens = Math.round(viewTokens);
		if (Number.isFinite(lowTokens) && lowTokens > 0) ledger.lastFoldLowTokens = Math.round(lowTokens);
		persist(ledger);
		return ledger;
	}

	return { ledgerOf, commitFold, recordFoldBaseline, adoptLedger, persist, stateDir };
}

/** Test/inspection helper: estimated tokens of a ledger's folds. */
export function ledgerFoldedTokens(messages, ledger) {
	const positions = refPositions(messages);
	let total = 0;
	for (const block of ledger?.blocks ?? []) {
		const firstList = positions.get(block.refRange?.firstId);
		const lastList = positions.get(block.refRange?.lastId);
		if (firstList === undefined || lastList === undefined) continue;
		total += estimateTokensOf(messages, firstList[0], lastList[lastList.length - 1]);
	}
	return total;
}
