/** dsh-switchman context-trim assembly.
 *
 * applyContextTrim(ctx, config) wires the trimming pipeline:
 *
 * - llm/stream listener (mounted via ctx.inject(["llm"], ...) so it
 *   attaches only once the llm fiber exists; released via llmCtx.effect
 *   for reload safety): builds the deterministic outbound view from the
 *   session ledger, splices it into options.messages IN PLACE before
 *   calling next(), then wraps the returned stream to sample usage. The
 *   listener ALWAYS calls next() — any internal failure degrades to a
 *   no-op pass-through (fail-open). No fold decisions happen here.
 * - agent/status idle hook: the only place fold decisions run (design §4:
 *   fold at the idle boundary, never mid-stream).
 * - ctx_trim_fold / ctx_trim_status tools: the L1 advisory surface — the
 *   session model may fold ranges itself and inspect compressible ranges
 *   (true sizes only — NEVER a fill percentage or water level; bili lesson
 *   #2, docs/ladder-fold.md).
 *
 * MODEL-VISIBILITY INVARIANT: the trim layer registers NO systemPrompt
 * context line. Water levels, view-token estimates, growth numbers, and
 * fold counts are engine internals; the model sees only the byte-stable
 * protocol head and (on demand) the true-size recommendation list. Human
 * diagnostics live in decisions.log.
 *
 * Config fields (host/config.js, all volatile): trimEnabled, trimMode
 * ("off"|"advisory"|"auto"), trimGrowthTokens, trimIncrementTokens,
 * trimPressurePercent, trimEmergencyPercent, trimWindowTokens,
 * trimProtectedTail, trimMaxFoldsPerHour, trimSideModel, trimStateDir,
 * trimLadderEnabled, trimLadderT2Tokens, trimLadderT2MinBlocks,
 * trimLadderT3Tokens, trimLadderT3MinBlocks.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildView, estimateTokensOf, injectView, ledgerIsStale, messageTokens, rangeIsSegmentAligned, refOf, refPositions } from "./view.js";
import { computeFoldableRange, evaluateTrigger, EMERGENCY_COOLDOWN_MS } from "./trigger.js";
import { LADDER_SYSTEM_PROMPT, mechanicalSummary, renderLadderMaterial, renderMaterial, summarizeWithModel } from "./summarizer.js";
import { createStore } from "./state.js";
import { createMetrics, extractUsage, promptTokensOf, wrapStreamForMetrics } from "./metrics.js";
import { forkLinkOf, loadForkLinks, recordForkLink, resolveInheritance, INHERIT_WINDOW_MS } from "./fork.js";
import { createSurfaceFoldPass } from "./surface.js";
import { childSessionIdOf } from "../subagent-model.js";

// ---- agent reference helpers --------------------------------------------------

/** Derive a session id from an agent reference: either a plain string id or
 * the agent OBJECT (dsh-agent fuses { ...payload, agent } — payload.agent on
 * agent/status and assembleContextFor's context.agent are both the object
 * form). Mirrors the host/context-watch.js:122 precedent. Returns null when
 * nothing usable is present. */
// ---- cross-layer view registry (meter duality, design §8) ------------------
// Latest outbound-view token estimate per session, refreshed on EVERY
// llm/stream call. host/context-watch.js prefers this over the token meter's
// stored tally while it is fresh, so the watermark tracks what the model
// actually sees after billion-context folding instead of over-triggering
// handovers off a stale stored measure.
const trimViewBySession = new Map(); // sessionId -> { viewTokens, at, inject, lastNoneAt }
/** Freshness TTL for the in-memory view/injection registry (watermark and
 *  banner display only). NEVER a fold gate: gating folds on "did the surface
 *  channel ship recently" deadlocks resumed sessions (2026-11-05). The fold
 *  gate asks surfacePass.supported() — a durable capability question. */
const TRIM_VIEW_MAX_AGE_MS = 600_000; // 10 minutes

/** Dispatches below this message count are never treated as the session's
 *  main history (the side-dispatch guard in applyViewToOptions): auxiliary
 *  llm calls (web-search summaries, title generation) inherit the session id
 *  with 1-6 message arrays and would clobber every per-session meter. */
const SIDE_DISPATCH_MIN_MESSAGES = 12;

/** Consecutive side-dispatch skips tolerated before one is accepted as the
 *  main history anyway — the release valve for a genuine host-compaction
 *  epoch that shrank the history below SIDE_DISPATCH_MIN_MESSAGES (without
 *  it the guard would stick: no capture refresh, no epoch reset, folds run
 *  against a stale capture forever). */
const SIDE_DISPATCH_SKIP_BUDGET = 2;

/** Consecutive side-dispatch skips per session (bounded; reset on every
 *  accepted main dispatch). */
const sideDispatchSkipsBySession = new Map();

/** Most recent outbound-view token estimate for a session, or null when
 * missing, non-positive, older than maxAgeMs — or when the recent dispatch
 * stream could not carry the view (injected "none": frozen options AND
 * messages, so the model still receives the raw history and the provider
 * tally is the only truthful meter). The gate is deliberately sticky: a
 * single mutable dispatch right after frozen ones re-arms maybeFold, but
 * the WATERMARK keeps falling back to the tally until no "none" occurred
 * within the TTL window (mixed sessions exist — one real session logged 46
 * none + 14 swapped). Read by the watermark layer (meter duality); itself
 * fail-open. */
export function recentTrimViewTokensOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		if (typeof sessionId !== "string" || sessionId === "") return null;
		const entry = trimViewBySession.get(sessionId);
		if (entry === undefined) return null;
		if (Date.now() - entry.at > maxAgeMs) return null;
		// Wire-truth gate: a view that never reaches the wire must not drive
		// the watermark (observed 2026-11-04: view ~80k vs a 176k wire while
		// the force tier stayed silent and the auto-handover never fired).
		if (entry.inject === "none") return null;
		if (Number.isFinite(entry.lastNoneAt) && entry.lastNoneAt > 0 && Date.now() - entry.lastNoneAt < maxAgeMs) return null;
		return Number.isFinite(entry.viewTokens) && entry.viewTokens > 0 ? entry.viewTokens : null;
	} catch {
		return null;
	}
}

/** Injection outcome of the last dispatch for one session ("in-place" |
 * "swapped" | "none"), or null when unknown or stale. Read by maybeFold:
 * when the wire cannot carry the view, folding cannot relieve anything and
 * only burns a summarizer call — the watermark's tally-driven auto-handover
 * is the correct relief path instead. */
export function recentTrimInjectOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		if (typeof sessionId !== "string" || sessionId === "") return null;
		const entry = trimViewBySession.get(sessionId);
		if (entry === undefined || Date.now() - entry.at > maxAgeMs) return null;
		return typeof entry.inject === "string" ? entry.inject : null;
	} catch {
		return null;
	}
}

export function agentSessionIdOf(agent) {
	if (typeof agent === "string") return agent !== "" ? agent : null;
	if (agent !== null && typeof agent === "object") {
		const id = agent.session?.id ?? agent.id;
		return typeof id === "string" && id !== "" ? id : null;
	}
	return null;
}

// ---- config field readers (fail-open defaults) -------------------------------

function readBool(config, key, fallback) {
	try {
		const value = config?.[key];
		if (typeof value === "boolean") return value;
		if (value !== null && typeof value === "object" && typeof value.get === "function") {
			const got = value.get();
			if (typeof got === "boolean") return got;
		}
	} catch {
		/* fall through */
	}
	return fallback;
}

function readNumber(config, key, fallback) {
	try {
		const value = config?.[key];
		let got = value;
		if (value !== null && typeof value === "object" && typeof value.get === "function") got = value.get();
		if (Number.isFinite(got)) return got;
	} catch {
		/* fall through */
	}
	return fallback;
}

function readString(config, key, fallback) {
	try {
		const value = config?.[key];
		let got = value;
		if (value !== null && typeof value === "object" && typeof value.get === "function") got = value.get();
		if (typeof got === "string" && got !== "") return got;
	} catch {
		/* fall through */
	}
	return fallback;
}

function readRoute(config, key) {
	try {
		const value = config?.[key];
		let got = value;
		if (value !== null && typeof value === "object" && typeof value.get === "function") got = value.get();
		if (got !== null && typeof got === "object" && typeof got.provider === "string" && got.provider !== "" && typeof got.model === "string" && got.model !== "") {
			return { provider: got.provider, model: got.model };
		}
	} catch {
		/* fall through */
	}
	return null;
}

// ---- prompt texts -------------------------------------------------------------

/** Byte-stable head section: the trim protocol (digit-free, like the
 * watermark protocol, so it stays out of KV invariants' way). States the
 * number-free disclosure policy explicitly — the model never receives
 * water levels or progress numbers from this engine. */
export const TRIM_PROTOCOL_TEXT = [
	"[SWITCHMAN:TRIM] This session has automatic context trimming. The engine folds consumed ranges itself and never reports sizes, percentages, or progress to you — no action or pacing is expected of you on that front.",
	"- Old message ranges may be replaced by ONE synthetic [SWITCHMAN:TRIM] summary message; treat those summaries as faithful compressions, and message refs inside them as historical anchors.",
	"- NEVER contradict or re-derive content a summary already settled; build on it.",
	"- You may fold a contiguous range yourself with the ctx_trim_fold tool (give firstId/lastId message refs and a summary following the compression rules); ctx_trim_status lists the compressible ranges with their true sizes.",
	"- Tool-call pairs (an assistant tool call and its results) must always be folded together or not at all.",
].join("\n");

/** Effective window for the pressure/emergency tier math:
 * min(model-resolved window, configured cap). Null only when BOTH inputs
 * are unusable — the trigger then skips those tiers (fail-open). */
export function effectiveWindowTokens(resolved, cap) {
	const a = Number.isFinite(resolved) && resolved > 0 ? resolved : null;
	const b = Number.isFinite(cap) && cap > 0 ? cap : null;
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

// ---- layer ---------------------------------------------------------------------

/** Register the context-trim layer. Wired from the plugin root after
 * applyContextWatch. Every host touch is fail-open: registration failures
 * warn and the layer degrades to whatever part succeeded. */
export function applyContextTrim(ctx, config) {
	const warn = (message) => {
		try {
			ctx.log?.warn?.(message);
		} catch {
			/* logging must never throw */
		}
	};

	// Per-process pipeline state (process-wide by design: ledgers persist on
	// disk per session, metrics/captures live per session in memory).
	const store = createStore({ stateDir: readString(config, "trimStateDir", null) ?? undefined, warn });

	// Surface-replace pass (docs/surface-fold.md): ships committed fold blocks
	// onto the session surface so folds reach the wire even for frozen
	// dispatches. Registers its own agent/turn-stopping trigger; the idle
	// sweep below runs after each fold cycle.
	const surfacePass = createSurfaceFoldPass({ ctx, config, store, decisionLog, warn });

	// Durable capability probe (surface.js supported): the fold gate asks THIS,
	// never a recency window. An in-memory "did we ship in the last 10 minutes"
	// test deadlocked resumed sessions: dispatches report injected=none, so
	// after the window expired no fold ran, no fold meant no new ship, and the
	// gate stayed shut forever while the provider prompt grew to 135k.
	const surfaceChannelCapable = (sessionId) => {
		try {
			return surfacePass.supported(sessionId);
		} catch {
			return false;
		}
	};
	const metrics = createMetrics();

	/** Most recent provider prompt size for one session, or null when unknown.
	 * The tally is the FULL prompt: the host reports TokenUsage as
	 * { inputTokens (uncached), cacheReadTokens, cacheWriteTokens }, so a
	 * heavily cached session (~130k of 136k cached) would otherwise read as
	 * the uncached delta and keep max(view, wire) silent. The view estimate
	 * only counts the messages array, so it under-reports by the system and
	 * context sections; pressure tiers must not run blind on it. */
	const wireTokensOf = (sessionId) => {
		try {
			return promptTokensOf(metrics.of(sessionId));
		} catch {
			return null;
		}
	};
	const captures = new Map(); // sessionId -> { messages, refs, viewTokens, model, at }
	const inFlight = new Set(); // sessionIds with a fold running
	const windowCache = new Map(); // "provider/model" -> { windowTokens, at }
	const lastEmergencyAtBySession = new Map(); // sessionId -> epoch ms of last emergency fold (per-session cooldown)
	const lastStreamCheckAt = new Map(); // sessionId -> epoch ms of last stream-path fold check (throttle)
	const epochResetDoneBySession = new Map(); // sessionId -> ledger-stale baseline reset already done for this host epoch (cleared when a fold applies again)

	// Per-session fold-failure cooldown: a failing summarize/commit cycle
	// advances NONE of the cadence gates (lastFoldAt / foldsThisHour only
	// move on a successful commitFold), so without this the same failure
	// re-fires at every idle boundary plus every >=60s stream check forever.
	// In-memory only by design — a process restart re-arms the cycle open.
	const foldFailureBySession = new Map(); // sessionId -> { count, lastAt }
	const FOLD_FAILURE_BASE_MS = 60_000; // backoff ladder start (2^(n-1) growth)
	const FOLD_FAILURE_MAX_MS = 900_000; // 15 min ceiling

	/** Record one failed fold cycle (summary unavailable / commit rejected /
	 * thrown): consecutive-attempt count + timestamp drive the backoff. */
	function recordFoldFailure(sessionId) {
		const prior = foldFailureBySession.get(sessionId);
		foldFailureBySession.set(sessionId, { count: Math.min((prior?.count ?? 0) + 1, 16), lastAt: Date.now() });
		if (foldFailureBySession.size > 200) foldFailureBySession.delete(foldFailureBySession.keys().next().value);
	}

	/** Remaining cooldown ms for one session (0 when not cooling): the delay
	 * doubles per consecutive failure from 60s, capped at 15 min. */
	function foldFailureCooldownOf(sessionId, now = Date.now()) {
		const entry = foldFailureBySession.get(sessionId);
		if (entry === undefined || entry.count <= 0) return 0;
		const backoff = Math.min(FOLD_FAILURE_BASE_MS * 2 ** (entry.count - 1), FOLD_FAILURE_MAX_MS);
		return Math.max(0, entry.lastAt + backoff - now);
	}

	/** A committed fold resets the failure ladder. */
	function clearFoldFailure(sessionId) {
		foldFailureBySession.delete(sessionId);
	}

	/** Append one fold-decision line to <stateDir>/decisions.log (fail-open,
	 * best-effort observability — console warn stays reserved for outcomes). */
	function decisionLog(entry) {
		try {
			const dir = store.stateDir;
			if (typeof dir !== "string" || dir === "") return;
			mkdirSync(dir, { recursive: true });
						const logPath = join(dir, "decisions.log");
			if ((statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > 2_000_000) renameSync(logPath, `${logPath}.1`); // bound the log, keep one previous generation
			appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`);
		} catch {
			/* observability must never throw */
		}
	}

	// ---- fork-state inheritance (copy-on-fork; design in fork.js header) ------
	const linksCache = { mtime: -1, map: null }; // mtime-gated fork-links map
	const inheritFirstSeen = new Map(); // sessionId -> epoch ms of first eligibility check
	const inheritDecided = new Set(); // sessions whose inheritance attempt settled (this process)
	const inheritWarned = new Set(); // warn-once per session

	/** Fresh fork-links map, reloaded when the file changed on disk (the
	 * handover fork writes it from a different call site/process). Fail-open:
	 * a stat failure keeps the cached map. */
	function freshLinks() {
		try {
			const mtime = statSync(join(store.stateDir, "fork-links.json"), { throwIfNoEntry: false })?.mtimeMs ?? -1;
			if (linksCache.map === null || mtime !== linksCache.mtime) {
				linksCache.map = loadForkLinks(store.stateDir, warn);
				linksCache.mtime = mtime;
			}
		} catch {
			/* stat is best-effort; keep the cached map */
		}
		return linksCache.map;
	}

	/** Copy-on-fork: clone the parent fold ledger into this session at its
	 * first model call (called from the stream view path ONLY — the guard
	 * needs the child history). Guarded, one-shot per session, fail-open:
	 * any failure degrades to a clean start with one warning. */
	function maybeInherit(sessionId, messages) {
		if (inheritDecided.has(sessionId)) return;
		const finish = () => {
			inheritDecided.add(sessionId);
			// keep the decided set bounded (2000 sessions)
			if (inheritDecided.size > 2000) {
				const oldest = inheritDecided.keys().next().value;
				if (oldest !== undefined) inheritDecided.delete(oldest);
			}
		};
		try {
			const now = Date.now();
			const firstSeen = inheritFirstSeen.get(sessionId) ?? now;
			inheritFirstSeen.set(sessionId, firstSeen);
			if (inheritFirstSeen.size > 2000) inheritFirstSeen.delete(inheritFirstSeen.keys().next().value);
			if (inheritWarned.size > 2000) inheritWarned.delete(inheritWarned.values().next().value); // same bound family as inheritDecided
			const ledger = store.ledgerOf(sessionId);
			if ((Array.isArray(ledger.blocks) && ledger.blocks.length > 0) || ledger.inheritedFrom !== null) return finish(); // already folded / already inherited
			const link = forkLinkOf(freshLinks(), sessionId);
			const parentLedger = link !== null ? store.ledgerOf(link.parent) : null;
			const parentHasBlocks = parentLedger !== null && Array.isArray(parentLedger.blocks) && parentLedger.blocks.length > 0;
			if (link === null || !parentHasBlocks) {
				// Nothing (yet) to inherit: stay pending inside the bounded window
				// to cover the fork race (child's first call may beat the parent's
				// post-execute bookkeeping or first idle-boundary fold), then stop
				// checking — a plain session never inherits, and a fold-less parent
				// has nothing to give.
				if (now - firstSeen > INHERIT_WINDOW_MS) finish();
				return;
			}
			const outcome = resolveInheritance(parentLedger, link.parent, sessionId, messages, now);
			if (!outcome.ok) {
				if (!inheritWarned.has(sessionId)) {
					inheritWarned.add(sessionId);
					warn(`[context-trim] ${sessionId}: fork inheritance rejected (${outcome.reason}) — starting clean`);
				}
				return finish();
			}
			if (!store.adoptLedger(sessionId, outcome.ledger)) return finish();
			inheritWarned.add(sessionId); // any later rejection for this child stays quiet
			warn(`[context-trim] ${sessionId}: inherited fold state from ${link.parent} (${outcome.ledger.blocks.length} blocks, frontier preserved)`);
			finish();
		} catch (error) {
			finish();
			if (!inheritWarned.has(sessionId)) {
				inheritWarned.add(sessionId);
				warn(`[context-trim] fork inheritance failed for ${sessionId} (${error?.message ?? error}) — starting clean`);
			}
		}
	}

	const enabledNow = () => readBool(config, "trimEnabled", true);
	const modeNow = () => {
		const mode = readString(config, "trimMode", "auto");
		return mode === "off" || mode === "advisory" || mode === "auto" ? mode : "auto";
	};
	const thresholdsNow = () => ({
		growthTokens: readNumber(config, "trimGrowthTokens", 22_500),
		incrementTokens: readNumber(config, "trimIncrementTokens", 50_000),
		pressurePercent: readNumber(config, "trimPressurePercent", 60),
		emergencyPercent: readNumber(config, "trimEmergencyPercent", 95),
		protectedTail: Math.max(0, Math.round(readNumber(config, "trimProtectedTail", 6))),
		maxFoldsPerHour: readNumber(config, "trimMaxFoldsPerHour", 16),
		ladderT2Tokens: readNumber(config, "trimLadderT2Tokens", 8_000),
		ladderT2MinBlocks: readNumber(config, "trimLadderT2MinBlocks", 3),
		ladderT3Tokens: readNumber(config, "trimLadderT3Tokens", 6_000),
		ladderT3MinBlocks: readNumber(config, "trimLadderT3MinBlocks", 2),
	});
	const ladderEnabledNow = () => readBool(config, "trimLadderEnabled", true);
	/** CJK-aware summary-mass estimator for the ladder census (same units
	 * the view estimate speaks, applied to summary text). */
	const summaryTokensOf = (text) => messageTokens({ role: "user", content: [{ type: "text", text: typeof text === "string" ? text : "" }] });
	/** Maximal runs of consecutive ACTIVE tier-1 / tier-2 blocks in ledger
	 * order — the ladder's candidate consumes sets (docs/ladder-fold.md).
	 * A run breaks on an inactive member, a tier change, or a tier-3 block
	 * interleaving. Runs carry { consumes, mass, count }; mass is the
	 * CJK-aware summary-mass estimate. Pure over the ledger. */
	function ladderRunsOf(ledger) {
		const runs = { t2: [], t3: [] };
		if (ledger === null || !Array.isArray(ledger.blocks)) return runs;
		let cur = null;
		const flush = () => {
			if (cur !== null && cur.ids.length > 0) {
				const run = { consumes: cur.ids, mass: cur.mass, count: cur.ids.length };
				if (cur.tier === 1) runs.t2.push(run);
				else if (cur.tier === 2) runs.t3.push(run);
			}
			cur = null;
		};
		for (const block of ledger.blocks) {
			const tier = block?.active === true && (block.tier === 1 || block.tier === 2) ? block.tier : null;
			if (tier === null || (cur !== null && cur.tier !== tier)) {
				flush();
			}
			if (tier !== null && cur === null) cur = { tier, ids: [], mass: 0 };
			if (cur !== null) {
				cur.ids.push(block.id);
				cur.mass += summaryTokensOf(block.summary);
			}
		}
		flush();
		return runs;
	}
	/** Effective-window cap: explicit trimWindowTokens, else auto-follow
	 * wmForceTokens (keeps fold tiers ahead of the handover tier). */
	const windowCapNow = () => {
		const explicit = readNumber(config, "trimWindowTokens", 0);
		if (explicit > 0) return explicit;
		const force = readNumber(config, "wmForceTokens", 150_000);
		return force > 0 ? force : null;
	};

	/** Session id for a stream call: options.sessionId, else the current
	 * initiator's session (try/catch — host internals shift). */
	function sessionIdOf(options) {
		if (typeof options?.sessionId === "string" && options.sessionId !== "") return options.sessionId;
		try {
			return ctx.agents?.currentInitiator?.()?.session?.id ?? null;
		} catch {
			return null;
		}
	}

	/** Effective window for the tier math: min(model-resolved window, cap).
	 * The cache stores the RAW resolved value so runtime cap changes apply
	 * immediately without re-resolution. */
	async function windowTokensFor(model) {
		if (model === null || typeof model.provider !== "string" || typeof model.model !== "string") return windowCapNow();
		const key = `${model.provider}/${model.model}`;
		const cached = windowCache.get(key);
		const now = Date.now();
		const resolved = cached !== undefined && now - cached.at < 600_000 ? cached.windowTokens : await resolveRawWindow(model, key, now);
		return effectiveWindowTokens(resolved, windowCapNow());
	}

	/** Async raw-window resolution (fills the cache; null when unknown). */
	async function resolveRawWindow(model, key, now) {
		try {
			const llm = ctx.get("llm", false);
			const info = await llm?.resolveModelInfo?.(model);
			const windowTokens = info?.context?.contextWindow;
			const value = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null;
			windowCache.set(key, { windowTokens: value, at: now });
			if (windowCache.size > 200) windowCache.delete(windowCache.keys().next().value);
			return value;
		} catch {
			windowCache.set(key, { windowTokens: null, at: now });
			if (windowCache.size > 200) windowCache.delete(windowCache.keys().next().value);
			return null;
		}
	}

	/** Capture the pre-mutation messages of one stream call (shallow array
	 * copy — message objects are treated as immutable records). */
	function captureOf(sessionId, messages, model, viewTokens) {
		captures.set(sessionId, { messages: messages.slice(), model, viewTokens, at: Date.now() });
		// keep the capture map bounded (200 sessions)
		if (captures.size > 200) {
			const oldest = captures.keys().next().value;
			if (oldest !== undefined) captures.delete(oldest);
		}
	}

	/** The outbound view for one request: fold blocks spliced in place. */
	function applyViewToOptions(options) {
		const messages = options?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return null;
		const sessionId = sessionIdOf(options);
		if (sessionId === null) return null;
		maybeInherit(sessionId, messages); // copy-on-fork: inherit BEFORE the first view build
		const { protectedTail } = thresholdsNow();
		const ledger = store.ledgerOf(sessionId);
		const view = buildView(messages, ledger, { protectedTail });
		// Capture the RAW history BEFORE splicing the view in: the host rebuilds
		// a fresh RAW array per llm/stream call, so refs/frontier must always be
		// resolved against raw history (with a folded capture, fold #2+ refs
		// would never resolve and the frontier would silently reset).
		const rawSnapshot = messages.slice();
		// Dispatch immutability varies: probe/fresh re-sends hand out mutable
		// arrays, resumed sessions re-send frozen host-assembled history, and
		// some dispatch options are frozen on top of that. injectView picks the
		// best strategy per dispatch and fails open; the view-applied line
		// records which strategy was used.
		// [2026-11-07]-[trimMode "off" means measure only]-[the view build runs
		// for the meter, but the fold must not reach the wire — inspection
		// report P0-2: off previously still spliced the folded view into the
		// dispatch.]
		const injected = modeNow() !== "off" ? injectView(options, messages, view) : "nothing-to-apply";
		const viewTokens = estimateTokensOf(view.messages);
		const blocksCount = Array.isArray(ledger.blocks) ? ledger.blocks.length : 0;
		// Wire truth in the row: the most recent provider prompt size (from the
		// previous response's usage) makes the view-vs-wire divergence visible
		// instead of leaving the view estimate as the only lullaby in the log.
		const wireTokens = wireTokensOf(sessionId);
		// Per-request application evidence: whether the ledger's blocks actually
		// locate inside THIS re-send (the host may compact/replace history, in
		// which case applied=0 explains a stuck-high view without any failure).
		decisionLog(`session=${sessionId} view-applied applied=${view.applied} foldedMsgs=${view.foldedMessages} view=${Math.round(viewTokens)} blocks=${blocksCount} injected=${injected}${wireTokens === null ? "" : ` wire=${wireTokens}`}`);
		// Side-dispatch guard: auxiliary llm calls that inherit the session id
		// (web-search summaries, title generation, fold-span material) present
		// tiny arrays in which the ledger cannot locate. Accepting them as the
		// session view clobbers the capture, the cross-layer registry that
		// measureNow reads, and the growth baseline (observed 2026-11-04: a
		// baseline reset to ~150 tokens mid-session). Fold-span dispatches are
		// already covered by inFlight. A tiny dispatch is a side candidate
		// whenever the session ALREADY carries trim state — fold blocks, a
		// capture, or a view registry entry — regardless of blocksCount,
		// which is exactly 0 in the young zero-fold sessions an auxiliary
		// dispatch most often hits. A session's very FIRST dispatch is
		// indistinguishable from a real one and stays accepted: it cannot
		// clobber state that does not exist yet, and the next real dispatch
		// overwrites the capture. A genuine host-compaction epoch ALSO shrinks
		// history below the floor, so the guard must not stick: after
		// SIDE_DISPATCH_SKIP_BUDGET consecutive skips the dispatch is accepted
		// as main, which re-arms capture/baseline on the compacted history.
		// [2026-11-07]-[fold-span dispatches are self-noise, not side
		// candidates]-[an in-flight fold cycle's own summarizer re-sends used
		// to consume the side-dispatch skip budget: three consecutive span
		// dispatches got "budget exhausted — accepting as main" and polluted
		// the capture/baseline (the 2026-11-04 regression path). They now
		// bypass unconditionally — never counted, never main.]
		if (inFlight.has(sessionId)) {
			decisionLog(`session=${sessionId} fold-span dispatch skipped view=${Math.round(viewTokens)} msgs=${messages.length}`);
			return { sessionId, viewTokens, sideDispatch: true };
		}
		const sideCandidate = view.applied === 0 && messages.length < SIDE_DISPATCH_MIN_MESSAGES && (blocksCount > 0 || captures.has(sessionId) || trimViewBySession.has(sessionId));
		const skipCount = sideDispatchSkipsBySession.get(sessionId) ?? 0;
		if (sideCandidate && skipCount < SIDE_DISPATCH_SKIP_BUDGET) {
			sideDispatchSkipsBySession.set(sessionId, skipCount + 1);
			if (sideDispatchSkipsBySession.size > 200) sideDispatchSkipsBySession.delete(sideDispatchSkipsBySession.keys().next().value);
			decisionLog(`session=${sessionId} side-dispatch skipped n=${skipCount + 1} msgs=${messages.length} view=${Math.round(viewTokens)} blocks=${blocksCount}`);
			return { sessionId, viewTokens, sideDispatch: true };
		}
		if (sideCandidate) decisionLog(`session=${sessionId} side-dispatch budget exhausted — accepting as main msgs=${messages.length}`);
		sideDispatchSkipsBySession.delete(sessionId);
		// Host-compaction epoch boundary: every block failed to LOCATE inside
		// this re-send, so the ledger aged out as a whole. Re-anchor the growth
		// baseline at the true post-epoch view once per epoch — carrying the
		// pre-epoch baseline across the boundary produced misleading negative
		// growth and a growth gate armed against vanished messages. The flag
		// clears when a fold applies again (fresh epoch folds locate).
		// Skipped while a fold cycle is in flight: the cycle's own span dispatch presents a
		// subset array where refs cannot locate — not epoch evidence, just self-noise.
		if (!inFlight.has(sessionId) && ledgerIsStale(view, ledger)) {
			if (!epochResetDoneBySession.has(sessionId)) {
				epochResetDoneBySession.set(sessionId, true);
				if (epochResetDoneBySession.size > 200) epochResetDoneBySession.delete(epochResetDoneBySession.keys().next().value); // bounded like captures/trimViewBySession
				store.recordFoldBaseline(sessionId, viewTokens, viewTokens);
				decisionLog(`session=${sessionId} ledger-stale blocks=${blocksCount} view=${Math.round(viewTokens)} growth-baseline-reset`);
			}
		} else if (view.applied > 0) {
			epochResetDoneBySession.delete(sessionId);
		}
		const model = { provider: options.provider ?? null, model: options.model ?? null };
		captureOf(sessionId, rawSnapshot, model, viewTokens);
		metrics.noteView(sessionId, viewTokens, model);
		const priorEntry = trimViewBySession.get(sessionId);
		const lastNoneAt = injected === "none" ? Date.now() : Number.isFinite(priorEntry?.lastNoneAt) ? priorEntry.lastNoneAt : 0;
		trimViewBySession.set(sessionId, { viewTokens, at: Date.now(), inject: injected, lastNoneAt });
		// keep the view registry bounded (200 sessions, same as captures)
		if (trimViewBySession.size > 200) {
			const oldest = trimViewBySession.keys().next().value;
			if (oldest !== undefined) trimViewBySession.delete(oldest);
		}
		return { sessionId, viewTokens };
	}

	/** Resolve the side-model route: explicit trimSideModel route, else the
	 * session's own model (inherit — design §5). */
	function sideRouteFor(sessionId) {
		const explicit = readRoute(config, "trimSideModel");
		if (explicit !== null) return explicit;
		const model = metrics.of(sessionId)?.lastModel ?? null;
		if (model !== null && typeof model.provider === "string" && model.provider !== "" && typeof model.model === "string" && model.model !== "") {
			return { provider: model.provider, model: model.model };
		}
		return null;
	}

	/** Run one fold cycle for a session (called at the idle boundary ONLY).
	 * Returns a short outcome string for logging. */
	async function runFoldCycle(sessionId, decision) {
		const capture = captures.get(sessionId);
		if (capture === undefined) return "no-capture";
		const { protectedTail } = thresholdsNow();
		// Ladder cycle (docs/ladder-fold.md): distill the decision's consumed
		// run of block summaries into ONE replacement. Never mechanical — a
		// failed distillation skips the cycle (fail-open + failure ladder).
		if (decision.kind === "ladder") {
			const ledgerBefore = store.ledgerOf(sessionId);
			const byId = new Map(Array.isArray(ledgerBefore.blocks) ? ledgerBefore.blocks.map((block) => [block.id, block]) : []);
			const consumed = decision.consumes.map((id) => byId.get(id)).filter((block) => block !== undefined);
			if (consumed.length !== decision.consumes.length) return "ladder-consumed-missing";
			const llm = ctx.get("llm", false);
			const route = sideRouteFor(sessionId);
			const approxTokens = consumed.reduce((sum, block) => sum + (Number.isFinite(block.approxTokens) && block.approxTokens > 0 ? block.approxTokens : 0), 0);
			const summary = await summarizeWithModel(llm, route, renderLadderMaterial(consumed), {
				systemPrompt: LADDER_SYSTEM_PROMPT,
				onFail: (why) => decisionLog(`session=${sessionId} summary-fail why=${why} ladder=${decision.tier}`),
			});
			if (summary === null) return "summary-unavailable"; // skip cycle, fail-open
			const result = store.commitFold(
				sessionId,
				{ consumes: decision.consumes.slice(), summary, kind: "summary", tier: decision.tier === "ladder-3" ? 3 : 2, approxTokens },
				null, // ladder commits validate against the ledger, never the capture
			);
			if (!result.ok) return `commit-rejected:${result.reason}`;
			// Post-fold low baseline: the ladder shrinks the view; re-anchor
			// the growth gate at the new low so it does not re-fire on stale
			// anchor math (same pair semantics as raw folds).
			const lowLedger = store.ledgerOf(sessionId);
			const lowView = estimateTokensOf(buildView(capture.messages, lowLedger, { protectedTail }).messages);
			store.recordFoldBaseline(sessionId, capture.viewTokens, lowView);
			return `folded:${decision.tier}:${decision.consumes.length} blocks (~${approxTokens} tokens)`;
		}
		const { startIdx, endIdx } = decision;
		const slice = capture.messages.slice(startIdx, endIdx + 1);
		if (slice.length === 0) return "empty-slice";
		const refs = slice.map((message, i) => refOf(message, startIdx + i));
		const count = slice.length;
		const approxTokens = estimateTokensOf(slice);
		let summary = null;
		let kind = "summary";
		if (decision.action === "emergency") {
			// Emergency cooldown timestamp set BEFORE the cycle: a commitFold
			// rejection (e.g. duplicate-range) must cool the emergency tier
			// down like a success, or a rejected emergency fold retries at
			// every idle boundary forever. The 90s trigger gate semantics
			// (EMERGENCY_COOLDOWN_MS) stay untouched.
			lastEmergencyAtBySession.set(sessionId, Date.now());
			if (lastEmergencyAtBySession.size > 200) lastEmergencyAtBySession.delete(lastEmergencyAtBySession.keys().next().value);
			summary = mechanicalSummary(capture.messages, startIdx, endIdx, refOf);
			kind = "mechanical";
		} else {
			const llm = ctx.get("llm", false);
			const route = sideRouteFor(sessionId);
			summary = await summarizeWithModel(llm, route, renderMaterial(capture.messages, startIdx, endIdx, refOf), {
				onFail: (why) => decisionLog(`session=${sessionId} summary-fail why=${why}`),
			});
			if (summary === null) return "summary-unavailable"; // skip cycle, fail-open
		}
		const positions = refPositions(capture.messages);
		const result = store.commitFold(
			sessionId,
			{ refRange: { firstId: refs[0], lastId: refs[refs.length - 1] }, count, approxTokens, summary, kind, tier: decision.tier },
			positions,
		);
		if (!result.ok) return `commit-rejected:${result.reason}`;
		// Commit-time surface capture (primary range-mapping strategy, see
		// surface.js header): store the covered event seqs while the live
		// surface still resolves the folded range.
		surfacePass.captureFoldSeqs(sessionId, result.block);
		// Growth-gate baseline pair: pre-fold view (banner display) plus the
		// post-fold low (tier-a anchor — keeps the gate armed after folds
		// that commit at high view points).
		const lowLedger = store.ledgerOf(sessionId);
		const lowView = estimateTokensOf(buildView(capture.messages, lowLedger, { protectedTail }).messages);
		store.recordFoldBaseline(sessionId, capture.viewTokens, lowView);
		return `folded:${decision.tier}:${count} msgs (~${approxTokens} tokens)`;
	}

	/** Idle-boundary hook (also re-used by the stream-path fallback): decide
	 * and run the fold. All failures contained. */
	async function maybeFold(agent, via = "idle") {
		const sessionId = agent;
		if (sessionId === null || sessionId === undefined || sessionId === "") return;
		if (!enabledNow() || modeNow() !== "auto") return;
		if (inFlight.has(sessionId)) return;
		// Failure backoff: a session whose recent cycles failed stays quiet
		// for 60s*2^(n-1) (cap 15 min) instead of re-firing at every idle
		// boundary and stream check. Silent gate — the outcome row that armed
		// the cooldown is already in decisions.log.
		if (foldFailureCooldownOf(sessionId) > 0) return;
		const capture = captures.get(sessionId);
		if (capture === undefined) return;
		// Injection-unavailable: the last dispatch could not carry the view
		// (frozen options AND messages — the wire always ships raw history).
		// Folding is pointless ONLY when NEITHER channel can reach the wire:
		// the spliced view (inject !== "none") OR the surface-replace pass
		// (durable capability probe, not a recency window — a proven channel
		// that last shipped before the process restarted is still capable and
		// the next fold ships a fresh surface event). When neither can, the
		// watermark's tally-driven force tier + auto-handover is the relief
		// path.
		if (recentTrimInjectOf(sessionId) === "none" && !surfaceChannelCapable(sessionId)) {
			decisionLog(`session=${sessionId} via=${via} action=none reason=injection-unavailable view=${Math.round(capture.viewTokens)}`);
			return;
		}
		inFlight.add(sessionId);
		try {
			const { protectedTail, ...thresholds } = thresholdsNow();
			const ledger = store.ledgerOf(sessionId);
			const foldable = computeFoldableRange(capture.messages, ledger, protectedTail);
			const windowTokens = await windowTokensFor(capture.model);
			// Pressure tiers run on the REAL prompt size when the tally is known:
			// max(view, wire). The view estimate misses the system/context
			// sections, so a 136k wire once read as a 50k view and the tiers
			// stayed silent. Unknown tally → exactly today's behavior.
			const wireTokens = wireTokensOf(sessionId);
			const pressureTokens = wireTokens !== null ? Math.max(capture.viewTokens, wireTokens) : capture.viewTokens;
			const decision = evaluateTrigger({
				foldable,
				messages: capture.messages,
				viewTokens: pressureTokens,
				windowTokens,
				thresholds,
				now: Date.now(),
				lastFoldAt: ledger.lastFoldAt,
				foldsThisHour: ledger.foldsThisHour,
				lastEmergencyAt: lastEmergencyAtBySession.get(sessionId) ?? 0,
				ledger,
				ladderRuns: ladderEnabledNow() ? ladderRunsOf(ledger) : { t2: [], t3: [] },
			});
			decisionLog(`session=${sessionId} via=${via} action=${decision.action} tier=${decision.tier ?? "-"} reason=${decision.reason || "-"} view=${Math.round(capture.viewTokens)}${wireTokens === null ? "" : ` wire=${wireTokens}`} window=${windowTokens ?? "null"}`);
			if (decision.action === "none") return;
			const outcome = await runFoldCycle(sessionId, decision);
			// Failure ladder: commit resets it; a summarize/commit failure
			// climbs it (the no-backoff loop this closes — those outcomes
			// advance no cadence gate on their own). A ladder run whose
			// consumed blocks vanished between trigger and commit is the same
			// family: without backoff it would re-fire at every boundary.
			if (outcome.startsWith("folded:")) clearFoldFailure(sessionId);
			else if (outcome === "summary-unavailable" || outcome.startsWith("commit-rejected:") || outcome === "ladder-consumed-missing") recordFoldFailure(sessionId);
			// Outcome lands in the decision log too: warn() has no reachable
			// sink on some hosts, and the commit/fail boundary is exactly what
			// live diagnosis needs.
			decisionLog(`session=${sessionId} outcome=${outcome} tier=${decision.tier}`);
			warn(`[context-trim] ${sessionId}: ${outcome} (${decision.reason})`);
		} catch (error) {
			recordFoldFailure(sessionId); // a thrown cycle counts as failed too
			warn(`[context-trim] fold cycle failed: ${error?.message ?? error}`);
		} finally {
			inFlight.delete(sessionId);
		}
	}

	// ---- host registrations (each individually fail-open) --------------------

	// MODEL-VISIBILITY INVARIANT: only the byte-stable protocol head is
	// registered. The previous live context line (view tokens, % of window,
	// folds, growth) is gone by design — water levels and progress numbers
	// steer model judgment (bili lesson #2, docs/ladder-fold.md). Human
	// diagnostics live in decisions.log (view-applied / decision / outcome
	// rows) and the client badge.
	try {
		ctx.systemPrompt?.section?.({ name: "switchman:trim", order: 10450, interpolate: false, text: () => (enabledNow() && modeNow() !== "off" ? TRIM_PROTOCOL_TEXT : "") });
	} catch (error) {
		warn(`[context-trim] systemPrompt.section failed: ${error?.message ?? error}`);
	}

	try {
		ctx.on("agent/status", (payload) => {
			try {
				if (payload?.status !== "idle") return;
				// payload.agent is the agent OBJECT (dsh-agent fuses { ...payload,
				// agent }) — derive the session id per host/context-watch.js:122.
				const sessionId = agentSessionIdOf(payload?.agent);
				if (sessionId === null) return;
				// Fold first, then the surface-replace idle sweep (design
				// docs/surface-fold.md): a block committed by this idle pass
				// ships on the same boundary.
				void maybeFold(sessionId).finally(() => {
					try {
						void surfacePass.sweep(sessionId, "idle");
					} catch {
						/* sweep must never break the idle hook */
					}
				});
			} catch {
				/* idle hook must never throw */
			}
		});
	} catch (error) {
		warn(`[context-trim] agent/status hook failed: ${error?.message ?? error}`);
	}

	// ---- fork linkage, channel A: the subagent_fork tool -----------------------
	// The child id is read from the tool result (subagent-model.js
	// childSessionIdOf: kind activation/continuable -> subagentId, kind
	// foreground -> runId); the parent id is THIS session (currentInitiator).
	// Recording is bookkeeping on an already-successful fork: best-effort,
	// and the downstream decision is always returned untouched.
	try {
		ctx.on("tools/post-execute", (exec, result, next) => {
			// Fast path: only successful subagent_fork calls fork a conversation
			// (a plain subagent child starts with fresh history — nothing to
			// inherit). Everything else stays exactly on the pipeline.
			if (exec?.name !== "subagent_fork" || result?.isError === true) return next();
			return (async () => {
				const downstream = await next();
				try {
					if (downstream === null || typeof downstream !== "object" || downstream.kind !== "accept") return downstream;
					const childId = childSessionIdOf(result?.value);
					if (childId === null) return downstream;
					const parentId = sessionIdOf({});
					if (parentId === null || parentId === childId) return downstream;
					if (recordForkLink(parentId, childId, { stateDir: store.stateDir, warn })) {
						// The child's eligibility window re-opens: its first model
						// call may already have raced past the fork bookkeeping.
						inheritDecided.delete(childId);
						inheritFirstSeen.delete(childId);
					}
				} catch (error) {
					warn(`[context-trim] fork-link recording failed: ${error?.message ?? error}`);
				}
				return downstream;
			})();
		});
	} catch (error) {
		warn(`[context-trim] tools/post-execute hook failed: ${error?.message ?? error}`);
	}

	// ---- tools (L1 advisory surface) ------------------------------------------

	/** Render the fold ledger for the status tool: ACTIVE blocks with true
	 * sizes, absorbed history as one line. NO water level, NO fill
	 * percentage, NO window math, NO threshold percentages — sizes of
	 * concrete ranges are the model-facing interface (bili mechanism #5);
	 * global progress numbers are not (lesson #2). */
	function renderStatusLedger(ledger) {
		const blocks = Array.isArray(ledger?.blocks) ? ledger.blocks : [];
		const active = blocks.filter((block) => block?.active === true);
		const absorbed = blocks.length - active.length;
		const lines = [];
		if (blocks.length === 0) {
			lines.push("fold ledger: empty (nothing folded yet)");
			return lines;
		}
		lines.push(`fold ledger: ${active.length} active block(s)${absorbed > 0 ? `, ${absorbed} absorbed by higher tiers` : ""} (oldest first)`);
		for (const block of active) {
			const tier = block.tier === 3 ? "T3" : block.tier === 2 ? "T2" : "T1";
			const range = block.refRange !== null && block.refRange !== undefined ? ` refs [m${block.refRange.firstId}]..[m${block.refRange.lastId}]` : ` distills ${block.count} lower-tier block(s)`;
			lines.push(`- ${block.id} ${tier}: ~${Math.round(Number.isFinite(block.approxTokens) ? block.approxTokens : 0)} tokens of material${range}${block.tier >= 2 ? ` — foldable into a higher tier together with its sibling blocks` : ""}`);
		}
		return lines;
	}

	try {
		ctx.tools?.register?.({
			name: "ctx_trim_status",
			description: "List this session's compressible context ranges with their true sizes: the fold ledger, the raw range a fold would cover, and distillation targets. Read-only. Contains sizes only — never progress percentages.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			required: [],
			async execute() {
				const sessionId = sessionIdOf({});
				if (sessionId === null) return "No session context available.";
				if (!enabledNow()) return "Context trimming is disabled for this deployment.";
				const ledger = store.ledgerOf(sessionId);
				const capture = captures.get(sessionId);
				const { protectedTail } = thresholdsNow();
				const lines = [`ctx_trim_status — mode: ${modeNow()} (enabled: ${enabledNow()})`];
				lines.push(...renderStatusLedger(ledger));
				// The raw range a fold would cover next, with its true size.
				if (capture !== undefined) {
					const foldable = computeFoldableRange(capture.messages, ledger, protectedTail);
					if (foldable !== null) {
						const firstRef = refOf(capture.messages[foldable.startIdx], foldable.startIdx);
						const lastRef = refOf(capture.messages[foldable.endIdx], foldable.endIdx);
						lines.push("", `compressible raw range: [m${firstRef}]..[m${lastRef}] (${foldable.endIdx - foldable.startIdx + 1} messages, ~${estimateTokensOf(capture.messages, foldable.startIdx, foldable.endIdx)} tokens) — a ctx_trim_fold over this range replaces it with your summary.`);
					} else {
						lines.push("", "compressible raw range: none right now (everything settled is already folded).");
					}
					// Message refs stay available for fold targeting (sizes only).
					lines.push("", `captured history (${capture.messages.length} messages; refs [m...] are fold anchors, per-message sizes are estimates):`);
					capture.messages.forEach((message, i) => {
						lines.push(`- [m${refOf(message, i)}] (${message?.role ?? "?"}) ~${estimateTokensOf(capture.messages, i, i)} tokens`);
					});
				} else {
					lines.push("", "captured history: none yet (appears after the next model call)");
				}
				return lines.join("\n");
			},
		});
	} catch (error) {
		warn(`[context-trim] ctx_trim_status tool failed: ${error?.message ?? error}`);
	}

	try {
		ctx.tools?.register?.({
			name: "ctx_trim_fold",
			description: "Fold a contiguous range of this session's history into one summary message (model-driven advisory fold). Provide firstId/lastId message refs (from ctx_trim_status), a summary text (compression rules: keep paths/signatures/errors verbatim, decisions with rationale, open objectives), and the message count in the range. Tool-call pairs must be folded whole.",
			parameters: {
				type: "object",
				properties: {
					firstId: { type: "string", description: "Ref of the first message to fold ([m...] form from ctx_trim_status, without the brackets)." },
					lastId: { type: "string", description: "Ref of the last message to fold." },
					count: { type: "number", description: "Number of messages in the inclusive range." },
					summary: { type: "string", description: "Self-contained summary text replacing the range." },
				},
				required: ["firstId", "lastId", "count", "summary"],
				additionalProperties: false,
			},
			async execute(args) {
				const sessionId = sessionIdOf({});
				if (sessionId === null) return "No session context available.";
				if (!enabledNow() || modeNow() === "off") return "Context trimming is disabled for this deployment.";
				const capture = captures.get(sessionId);
				if (capture === undefined) return "No captured history yet — fold is unavailable until the next model call.";
				const positions = refPositions(capture.messages);
				const firstList = positions.get(String(args?.firstId ?? ""));
				const lastList = positions.get(String(args?.lastId ?? ""));
				if (firstList === undefined || lastList === undefined) return "Refs not found in the current history — re-check with ctx_trim_status.";
				// Count-anchored resolution: duplicate refs (identical content)
				// make the first/last occurrence lists ambiguous — anchor on the
				// stated count and take the first consistent pair (commitFold does
					// the same).
				const wanted = Number.isInteger(args?.count) && args.count > 0 ? args.count : null;
				let firstIdx = -1;
				let lastIdx = -1;
				for (const start of firstList) {
					const end = wanted !== null ? start + wanted - 1 : lastList[lastList.length - 1];
					if (end >= start && lastList.includes(end)) { firstIdx = start; lastIdx = end; break; }
				}
				if (firstIdx < 0) { firstIdx = firstList[0]; lastIdx = lastList[lastList.length - 1]; }
				if (lastIdx < firstIdx) return "lastId sorts before firstId in the current history.";
				const { protectedTail } = thresholdsNow();
				if (lastIdx >= capture.messages.length - Math.max(0, protectedTail)) return `Range reaches into the protected tail (last ${protectedTail} messages are never folded).`;
				if (!rangeIsSegmentAligned(capture.messages, firstIdx, lastIdx)) return "Range splits a tool-call pair — fold whole assistant/tool segments (extend firstId/lastId to the segment boundaries).";
				const count = wanted !== null ? wanted : lastIdx - firstIdx + 1;
				const result = store.commitFold(
					sessionId,
					{
						refRange: { firstId: String(args.firstId), lastId: String(args.lastId) },
						count,
						approxTokens: estimateTokensOf(capture.messages, firstIdx, lastIdx),
						summary: String(args.summary ?? ""),
						kind: "summary",
						tier: 1,
					},
					positions,
				);
				if (!result.ok) return `Fold rejected: ${result.reason}.`;
				surfacePass.captureFoldSeqs(sessionId, result.block);
				// Growth-gate baseline pair: pre-fold view (banner display) plus the
				// post-fold low (tier-a anchor — keeps the gate armed after folds
				// that commit at high view points).
				const lowLedger = store.ledgerOf(sessionId);
				const lowView = estimateTokensOf(buildView(capture.messages, lowLedger, { protectedTail: thresholdsNow().protectedTail }).messages);
				store.recordFoldBaseline(sessionId, capture.viewTokens, lowView);
				return `Folded ${count} messages into block ${result.block.id}. The view applies on the next model call.`;
			},
		});
	} catch (error) {
		warn(`[context-trim] ctx_trim_fold tool failed: ${error?.message ?? error}`);
	}

	// ---- llm/stream listener (mounted when the llm fiber exists) ---------------

	function streamListener(options, next) {
		let viewTokens = null;
		try {
			if (enabledNow()) {
				const applied = applyViewToOptions(options);
				if (applied !== null) viewTokens = applied.viewTokens;
			}
		} catch (error) {
			decisionLog(`view-build-failed why=${error?.message ?? error}`);
			warn(`[context-trim] view build failed: ${error?.message ?? error}`);
		}
		const result = next();
		let wrappedSession = null;
		try {
			if (!enabledNow()) return result;
			wrappedSession = sessionIdOf(options);
			if (wrappedSession === null) return result;
			return wrapStreamForMetrics(result, (chunk) => {
				const usage = extractUsage(chunk);
				if (usage !== null) metrics.recordUsage(wrappedSession, usage);
			});
		} catch (error) {
			warn(`[context-trim] stream wrap failed: ${error?.message ?? error}`);
			return result;
		} finally {
			// Fallback fold check on the stream path: the agent/status idle event
			// may not reach a globally-registered listener on every host topology,
			// so each stream end also runs a throttled (60 s/session) check. The
			// trigger's own cadence gates still guard over-folding.
			try {
				if (enabledNow() && modeNow() === "auto" && wrappedSession !== null) {
					const nowMs = Date.now();
					if (nowMs - (lastStreamCheckAt.get(wrappedSession) ?? 0) >= 60_000) {
						lastStreamCheckAt.set(wrappedSession, nowMs);
						if (lastStreamCheckAt.size > 200) lastStreamCheckAt.delete(lastStreamCheckAt.keys().next().value);
						void maybeFold(wrappedSession, "stream");
					}
				}
			} catch {
				/* fallback must never break the stream */
			}
		}
	}

	try {
		ctx.inject(["llm"], (llmCtx) => {
			const attach = () => {
				try {
					// Global + prepend: the cordis dispatch filter silently drops NON-global
					// llm/stream listeners when the dispatching llm runtime lives outside
					// this fiber's isolate (resumed sessions dispatch through their own
					// subtree) — that silenced the whole stream path for a resumed session
					// while fresh sessions kept logging. Stock consumers (dsh-session-title)
					// register exactly this way.
					llmCtx.on?.("llm/stream", streamListener, { global: true, prepend: true });
					decisionLog(`llm-attached hasOn=${typeof llmCtx.on} hasOff=${typeof llmCtx.off} hasEffect=${typeof llmCtx.effect} pid=${process.pid}`);
				} catch (error) {
					warn(`[context-trim] llm/stream attach failed: ${error?.message ?? error}`);
				}
			};
			// Reload-safe release (applyIntent precedent): undo the listener
			// registration when the llm fiber disposes (plugin reload).
			try {
				const effect = llmCtx.effect;
				if (typeof effect === "function") {
					effect(function* () {
						yield () => {
							try {
								llmCtx.off?.("llm/stream", streamListener);
							} catch {
								/* best effort */
							}
						};
					}, "context-trim-stream-listener");
				}
			} catch {
				/* effect registration is best-effort */
			}
			attach();
		});
	} catch (error) {
		warn(`[context-trim] ctx.inject(llm) failed: ${error?.message ?? error}`);
	}

	return { store, metrics, captures, inFlight, maybeFold, maybeInherit, applyViewToOptions, surfacePass };
}
