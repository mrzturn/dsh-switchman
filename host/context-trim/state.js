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
 * LEDGER v2 — the T1/T2/T3 ladder (docs/ladder-fold.md):
 * - every block carries `tier` (1 = raw-range fold, 2 = distillation of
 *   active T1 blocks, 3 = distillation of active T2 blocks), `active`
 *   (false once consumed by a ladder block — blocks are NEVER deleted, so
 *   coverage stays expressible), and `consumes` (the ledger-consecutive run
 *   of blocks a ladder block absorbed; [] on T1).
 * - a ladder block has no refRange (null): its material is the consumed
 *   blocks' summaries, not raw messages. The raw fold frontier stays a
 *   T1-only concept — ladder commits never move it.
 * - v1 ledgers migrate on load (tier strings → 1, active: true,
 *   consumes: []) and re-persist as v2; unknown formats still reset.
 *
 * commitFold validates a new block before it enters the ledger. T1
 * candidates validate against the CURRENT messages snapshot (the posMap:
 * refs -> indices) — ref range must be locatable, segment-aligned, disjoint
 * from every existing block, and strictly monotonic (behind or inside the
 * existing frontier is rejected). Ladder candidates validate against the
 * LEDGER itself — consumed ids must exist, be active, match tier-1, and be
 * ledger-consecutive; view-adjacency is checked when a posMap is available.
 * Without a posMap (ctx_trim_fold against a stale capture) only structural
 * checks and exact-duplicate guards apply.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { dshHome } from "../lib/dsh-home.js";
import { estimateTokensOf, refPositions } from "./view.js";

/** Current ledger file format version (2 = the T1/T2/T3 ladder). */
export const LEDGER_VERSION = 2;

/** Legacy tier-string → numeric tier for v1 migration (and for callers
 * still passing the old strings). Numeric 1|2|3 passes through. */
export function tierOf(candidate) {
	if (candidate === 1 || candidate === 2 || candidate === 3) return candidate;
	if (candidate === "emergency" || candidate === "pressure" || candidate === "growth" || candidate === "model") return 1;
	return null;
}

/** True when a block is a ladder block (tier ≥ 2, distills other blocks). */
export function isLadderBlock(block) {
	return block !== null && typeof block === "object" && (block.tier === 2 || block.tier === 3);
}

/** Unique block id. `b<ms>` alone collides whenever two folds commit within
 * the same millisecond — and the ladder consumes blocks BY ID (the view
 * builder anchors synthetic-message replacement on the id), so uniqueness
 * is load-bearing: a colliding id would make one block absorb another's
 * coverage. Time prefix stays for chronology, a per-process sequence and a
 * random tail disambiguate. */
let blockIdSeq = 0;
function allocateBlockId(now) {
	blockIdSeq += 1;
	return `b${now}-${blockIdSeq.toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Filenames are session-id-derived; keep them filesystem-safe. */
function sanitizeSessionId(sessionId) {
	const raw = typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";
	// Percent-encode % and path separators FIRST so the mapping is injective
	// ("a/b" and "a_b" must never share one ledger file).
	const safe = Array.from(raw, (ch) => (ch === "%" ? "%25" : ch === "/" ? "%2F" : ch === "\\" ? "%5C" : ch)).join("").slice(0, 128);
	return safe === "" ? "default" : safe;
}

/** Empty ledger for one session. frontier = ref of the newest folded
 * message (the fold boundary); it only ever advances (monotonic) and is a
 * T1-only concept — ladder folds never move it. */
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

/** Normalize one persisted block record (load path AND migration). Returns
 * a v2-shaped block or null when the record is structurally unusable.
 * Tolerant by design: a ladder-shaped block that lost its consumed ids is
 * a plain invalid record (null), not a crash. */
function normalizeStoredBlock(record) {
	if (record === null || typeof record !== "object") return null;
	const id = typeof record.id === "string" && record.id !== "" ? record.id : null;
	if (id === null) return null;
	const summary = typeof record.summary === "string" && record.summary.trim() !== "" ? record.summary.trim() : null;
	if (summary === null) return null;
	const tier = tierOf(record.tier);
	if (tier === null) return null;
	const count = Number.isInteger(record.count) && record.count > 0 ? record.count : null;
	if (count === null) return null;
	const approxTokens = Number.isFinite(record.approxTokens) && record.approxTokens > 0 ? Math.round(record.approxTokens) : count;
	const createdAt = Number.isFinite(record.createdAt) && record.createdAt > 0 ? record.createdAt : 0;
	const kind = record.kind === "mechanical" ? "mechanical" : "summary";
	// consumes: a validated list of unique non-empty strings, or [] when
	// absent (v1 migration / T1). A ladder-shaped record (tier ≥ 2) without
	// a usable consumes list is invalid — its coverage is unknowable.
	let consumes = [];
	if (Array.isArray(record.consumes)) {
		consumes = record.consumes.filter((entry) => typeof entry === "string" && entry !== "");
		if (consumes.length !== record.consumes.length) return null;
		if (new Set(consumes).size !== consumes.length) return null;
	}
	if (tier >= 2 && consumes.length === 0) return null;
	// refRange: T1 blocks carry it; ladder blocks carry null (a v1-style
	// ladder-shaped record cannot exist, but a corrupt one must not slip a
	// phantom range through).
	let refRange = null;
	if (tier === 1) {
		const firstId = record.refRange?.firstId;
		const lastId = record.refRange?.lastId;
		if (typeof firstId !== "string" || firstId === "" || typeof lastId !== "string" || lastId === "") return null;
		refRange = { firstId, lastId };
	}
	const block = {
		id,
		kind,
		tier,
		refRange,
		count,
		approxTokens,
		summary,
		createdAt,
		active: record.active === false ? false : true,
		consumes,
	};
	// Surface bookkeeping (surface.js) rides along verbatim when present.
	if (record.surfaceSeqs !== undefined) block.surfaceSeqs = record.surfaceSeqs;
	if (record.surfaceReplaced !== undefined) block.surfaceReplaced = record.surfaceReplaced;
	if (record.surfaceSkip !== undefined) block.surfaceSkip = record.surfaceSkip;
	if (record.surfaceHeadClamped !== undefined) block.surfaceHeadClamped = record.surfaceHeadClamped;
	return block;
}

/** Upgrade a parsed v1 ledger file to the v2 shape: every block gains
 * numeric tier 1 (legacy tier strings map), active: true, consumes: [].
 * Returns { ledger, migrated } or null when the file is unusable. */
function upgradeLedgerFile(parsed, sessionId) {
	if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) return null;
	if (parsed.version === LEDGER_VERSION) {
		const blocks = parsed.blocks.map(normalizeStoredBlock);
		if (blocks.some((block) => block === null)) return null;
		return { ledger: hydrateLedger(sessionId, parsed, blocks), migrated: false };
	}
	if (parsed.version !== 1) return null;
	const blocks = parsed.blocks.map((record) => {
		// v1 blocks always fold raw ranges: rebuild them through the same
		// normalizer with the legacy tier strings it understands.
		return normalizeStoredBlock({ ...record, tier: tierOf(record.tier) ?? 1, active: true, consumes: [] });
	});
	if (blocks.some((block) => block === null)) return null;
	return { ledger: hydrateLedger(sessionId, parsed, blocks), migrated: true };
}

/** Assemble the in-memory ledger from parsed file fields + normalized
 * blocks (shared by the v1 upgrade and the v2 load path). */
function hydrateLedger(sessionId, parsed, blocks) {
	return {
		version: LEDGER_VERSION,
		sessionId,
		blocks,
		frontier: typeof parsed.frontier === "string" ? parsed.frontier : null,
		lastFoldViewTokens: Number.isFinite(parsed.lastFoldViewTokens) ? parsed.lastFoldViewTokens : 0,
		lastFoldLowTokens: Number.isFinite(parsed.lastFoldLowTokens) ? parsed.lastFoldLowTokens : 0,
		lastFoldAt: Number.isFinite(parsed.lastFoldAt) ? parsed.lastFoldAt : 0,
		foldsThisHour: Array.isArray(parsed.foldsThisHour) ? parsed.foldsThisHour.filter((ts) => Number.isFinite(ts)) : [],
		inheritedFrom: typeof parsed.inheritedFrom === "string" ? parsed.inheritedFrom : null,
		inheritedAt: Number.isFinite(parsed.inheritedAt) ? parsed.inheritedAt : 0,
	};
}

/** Validate + normalize a raw T1 fold candidate (public surface; the ladder
 * path validates inside commitFold against the live ledger). Returns the
 * normalized v2-shaped block or null. */
export function normalizeBlock(candidate, now) {
	if (candidate === null || typeof candidate !== "object") return null;
	if (Array.isArray(candidate.consumes) && candidate.consumes.length > 0) return null; // ladder candidates take the commit path
	const firstId = candidate.refRange?.firstId;
	const lastId = candidate.refRange?.lastId;
	if (typeof firstId !== "string" || firstId === "" || typeof lastId !== "string" || lastId === "") return null;
	const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
	if (summary === "") return null;
	const count = Number.isInteger(candidate.count) && candidate.count > 0 ? candidate.count : 0;
	if (count <= 0) return null;
	const approxTokens = Number.isFinite(candidate.approxTokens) && candidate.approxTokens > 0 ? Math.round(candidate.approxTokens) : count;
	const kind = candidate.kind === "mechanical" ? "mechanical" : "summary";
	const tier = tierOf(candidate.tier) ?? 1;
	return {
		id: typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : allocateBlockId(now),
		kind,
		tier,
		refRange: { firstId, lastId },
		count,
		approxTokens,
		summary,
		createdAt: now,
		active: true,
		consumes: [],
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
	 * ledger and are moved aside (best effort) for forensics. v1 files
	 * migrate to v2 in memory and persist lazily on the next write (an
	 * immediate write here would cost one disk write per session load). */
	function ledgerOf(sessionId) {
		const cached = ledgers.get(sessionId);
		if (cached !== undefined) return cached;
		let ledger = emptyLedger(sessionId);
		const file = fileFor(sessionId);
		try {
			if (existsSync(file)) {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				const upgraded = upgradeLedgerFile(parsed, sessionId);
				if (upgraded !== null) {
					ledger = upgraded.ledger;
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

	/** Locate a T1 candidate range in the posMap, count-anchored (shared by
	 * the T1 commit path). Returns [firstIdx, lastIdx] or null. */
	function locateT1Range(positions, refRange, count) {
		const firstList = positions.get(refRange.firstId);
		const lastList = positions.get(refRange.lastId);
		if (firstList === undefined || lastList === undefined) return { reason: "refs-not-found" };
		let firstIdx = -1;
		let lastIdx = -1;
		for (const start of firstList) {
			const end = start + count - 1;
			if (lastList.includes(end)) {
				firstIdx = start;
				lastIdx = end;
				break;
			}
		}
		if (firstIdx < 0) return { reason: "count-mismatch" };
		return { firstIdx, lastIdx };
	}

	/** Commit a LADDER fold block (tier 2/3): distill a contiguous run of
	 * active tier-(n-1) blocks into one summary. Validated against the
	 * ledger itself (never the capture). Returns { ok, ledger, block } or
	 * { ok: false, reason }. Memory only — persist() separately. */
	function commitLadderFold(sessionId, candidate, posMap, now) {
		const tier = tierOf(candidate.tier);
		if (tier !== 2 && tier !== 3) return { ok: false, reason: "invalid-ladder-tier" };
		const consumes = Array.isArray(candidate.consumes) ? candidate.consumes.filter((entry) => typeof entry === "string" && entry !== "") : [];
		if (consumes.length === 0) return { ok: false, reason: "ladder-empty-consumes" };
		const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
		if (summary === "") return { ok: false, reason: "invalid-block" };
		const ledger = ledgerOf(sessionId);
		const byId = new Map(ledger.blocks.map((block) => [block.id, block]));
		// Crash-retry idempotency: an exact replay of an already-committed
		// ladder block (same id + tier + consumes) returns the committed
		// block as success instead of rejecting — the commit already
		// happened, so a retry must be a no-op, never a second append.
		const candidateId = typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : null;
		if (candidateId !== null) {
			const existing = byId.get(candidateId);
			if (existing !== undefined && existing.kind === "summary" && existing.tier === tier
				&& Array.isArray(existing.consumes) && existing.consumes.length === consumes.length
				&& existing.consumes.every((id, i) => id === consumes[i])) {
				return { ok: true, ledger, block: existing, duplicate: true };
			}
		}
		// Every consumed id must exist, be active, and sit one tier below.
		let approxTokens = 0;
		const indexes = [];
		for (const id of consumes) {
			const block = byId.get(id);
			if (block === undefined) return { ok: false, reason: "ladder-consumed-missing" };
			if (block.active !== true) return { ok: false, reason: "ladder-consumed-inactive" };
			if (block.tier !== tier - 1) return { ok: false, reason: "ladder-tier-mismatch" };
			approxTokens += Number.isFinite(block.approxTokens) && block.approxTokens > 0 ? block.approxTokens : 0;
			indexes.push(ledger.blocks.indexOf(block));
		}
		// The consumed run must be consecutive in the ledger's block list
		// (creation order). Duplicates were rejected implicitly: two equal
		// ids map to one block index and a duplicated id breaks consecutiveness.
		for (let i = 1; i < indexes.length; i++) {
			if (indexes[i] !== indexes[i - 1] + 1) return { ok: false, reason: "ladder-not-contiguous" };
		}
		// View adjacency (strong check, only with a capture posMap): the run's
		// raw spans must tile — each block starts exactly after the previous
		// one ends. Engine-paced folds always tile; advisory middle-range
		// folds do not, and distilling them would fold un-covered raw
		// messages into the replacement. Without a posMap the structural
		// checks above stand alone (fail-open).
		if (posMap !== null && posMap !== undefined) {
			const positions = posMap instanceof Map ? posMap : refPositions(posMap);
			let prevEnd = null;
			for (const id of consumes) {
				const block = byId.get(id);
				// Ladder blocks carry no raw span (refRange null) — their
				// adjacency is already guaranteed by ledger consecutiveness,
				// so a tier-3 run of T2 blocks skips the view check entirely
				// instead of crashing on a missing span.
				if (block.refRange === null || block.refRange === undefined) continue;
				const located = locateT1Range(positions, block.refRange, block.count);
				if (located.reason !== undefined) break; // stale capture: skip the check, structural holds
				if (prevEnd !== null && located.firstIdx !== prevEnd + 1) return { ok: false, reason: "ladder-not-adjacent" };
				prevEnd = located.lastIdx;
			}
		}
		const block = {
			id: typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : allocateBlockId(now),
			kind: "summary",
			tier,
			refRange: null,
			count: consumes.length,
			approxTokens: Number.isFinite(candidate.approxTokens) && candidate.approxTokens > 0 ? Math.round(candidate.approxTokens) : approxTokens,
			summary,
			createdAt: now,
			active: true,
			consumes: consumes.slice(),
		};
		// Single consumption: deactivate every consumed block, then append.
		for (const id of consumes) {
			const consumed = byId.get(id);
			consumed.active = false;
		}
		ledger.blocks.push(block);
		ledger.lastFoldAt = now;
		ledger.foldsThisHour = ledger.foldsThisHour.filter((ts) => now - ts < 3_600_000);
		ledger.foldsThisHour.push(now);
		ledgers.set(sessionId, ledger);
		return { ok: true, ledger, block };
	}

	/** Commit a fold block. posMap (refs -> indices of the CURRENT capture)
	 * enables full validation; returns { ok, ledger, block } or
	 * { ok: false, reason }. Memory only — persist() separately.
	 * Dispatches on candidate.consumes: non-empty → the ladder path. */
	function commitFold(sessionId, candidate, posMap = null, now = Date.now()) {
		if (candidate === null || typeof candidate !== "object") return { ok: false, reason: "invalid-block" };
		if (Array.isArray(candidate.consumes) && candidate.consumes.length > 0) return commitLadderFold(sessionId, candidate, posMap, now);
		const firstId = candidate.refRange?.firstId;
		const lastId = candidate.refRange?.lastId;
		if (typeof firstId !== "string" || firstId === "" || typeof lastId !== "string" || lastId === "") return { ok: false, reason: "invalid-block" };
		const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
		if (summary === "") return { ok: false, reason: "invalid-block" };
		const count = Number.isInteger(candidate.count) && candidate.count > 0 ? candidate.count : 0;
		if (count <= 0) return { ok: false, reason: "invalid-block" };
		const approxTokens = Number.isFinite(candidate.approxTokens) && candidate.approxTokens > 0 ? Math.round(candidate.approxTokens) : count;
		const kind = candidate.kind === "mechanical" ? "mechanical" : "summary";
		const tier = tierOf(candidate.tier) ?? 1;
		const block = {
			id: typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : allocateBlockId(now),
			kind,
			tier,
			refRange: { firstId, lastId },
			count,
			approxTokens,
			summary,
			createdAt: now,
			active: true,
			consumes: [],
		};
		const ledger = ledgerOf(sessionId);
		// exact-duplicate guard (same range already folded)
		for (const existing of ledger.blocks) {
			if (existing.refRange !== null && existing.refRange.firstId === block.refRange.firstId && existing.refRange.lastId === block.refRange.lastId) {
				return { ok: false, reason: "duplicate-range" };
			}
		}
		if (posMap !== null) {
			const positions = posMap instanceof Map ? posMap : refPositions(posMap);
			const located = locateT1Range(positions, block.refRange, block.count);
			if (located.reason !== undefined) return { ok: false, reason: located.reason };
			const { firstIdx, lastIdx } = located;
			// monotonicity: the new range must sit strictly behind the
			// frontier range and be disjoint from every existing block.
			for (const existing of ledger.blocks) {
				if (existing.refRange === null) continue; // ladder block: coverage rides its consumed T1s
				const eFirst = positions.get(existing.refRange.firstId);
				const eLast = positions.get(existing.refRange.lastId);
				if (eFirst === undefined || eLast === undefined) continue; // stale block outside this capture
				const eStart = eFirst[0];
				const eEnd = eLast[eLast.length - 1];
				if (firstIdx <= eEnd && eStart <= lastIdx) return { ok: false, reason: "overlaps-existing-fold" };
			}
		}
		ledger.blocks.push(block);
		// [2026-11-07]-[frontier only ever advances]-[an advisory fold of a
		// MIDDLE range must not drag the boundary backward: computeFoldableRange
		// would re-propose already-folded spans and every raw fold would stall
		// on overlaps-existing-fold until an epoch reset (inspection report
		// P0-1). Position comparison when a posMap is available; without one
		// the historical unconditional assignment stands — engine folds always
		// pass a posMap.]
		let advanceFrontier = true;
		if (posMap !== null) {
			const positions = posMap instanceof Map ? posMap : refPositions(posMap);
			const lastList = positions.get(block.refRange.lastId);
			const frontierList = typeof ledger.frontier === "string" ? positions.get(ledger.frontier) : undefined;
			if (lastList !== undefined && frontierList !== undefined && frontierList.length > 0) {
				advanceFrontier = lastList[lastList.length - 1] > frontierList[frontierList.length - 1];
			}
		}
		if (advanceFrontier) ledger.frontier = block.refRange.lastId;
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

/** Test/inspection helper: estimated tokens of a ledger's raw-range folds
 * (T1 blocks only; ladder blocks have no raw range of their own). */
export function ledgerFoldedTokens(messages, ledger) {
	const positions = refPositions(messages);
	let total = 0;
	for (const block of ledger?.blocks ?? []) {
		if (block.refRange === null) continue;
		const firstList = positions.get(block.refRange?.firstId);
		const lastList = positions.get(block.refRange?.lastId);
		if (firstList === undefined || lastList === undefined) continue;
		total += estimateTokensOf(messages, firstList[0], lastList[lastList.length - 1]);
	}
	return total;
}

/** Ladder census of one ledger: the ACTIVE tier-1 and tier-2 populations
 * (id + summary mass estimate + approxTokens) the trigger and the ladder
 * ship pass read. Pure; never throws. */
export function ladderCensusOf(ledger, countTokens = null) {
	const estimate = typeof countTokens === "function"
		? countTokens
		: (text) => Math.max(1, Math.round((typeof text === "string" ? text.length : 0) / 4));
	const t1 = [];
	const t2 = [];
	for (const block of ledger?.blocks ?? []) {
		if (block.active !== true) continue;
		const summaryTokens = estimate(block.summary);
		const entry = { id: block.id, tier: block.tier, summaryTokens, approxTokens: Number.isFinite(block.approxTokens) ? block.approxTokens : 0, count: block.count };
		if (block.tier === 1) t1.push(entry);
		else if (block.tier === 2) t2.push(entry);
	}
	return { t1, t2 };
}
