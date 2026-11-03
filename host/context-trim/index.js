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
 *   session model may fold ranges itself and inspect trim state.
 * - systemPrompt head section (byte-stable protocol text) + live context
 *   line (bucketed view tokens / fold count / growth — byte-stable between
 *   5k-token steps so the serialized tail stops churning).
 *
 * Config fields (host/config.js, all volatile): trimEnabled, trimMode
 * ("off"|"advisory"|"auto"), trimGrowthTokens, trimIncrementTokens,
 * trimPressurePercent, trimEmergencyPercent, trimWindowTokens,
 * trimProtectedTail,
 * trimMaxFoldsPerHour, trimSideModel, trimStateDir.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildView, estimateTokensOf, injectView, ledgerIsStale, rangeIsSegmentAligned, refOf, refPositions } from "./view.js";
import { computeFoldableRange, evaluateTrigger, EMERGENCY_COOLDOWN_MS } from "./trigger.js";
import { mechanicalSummary, renderMaterial, summarizeWithModel } from "./summarizer.js";
import { createStore } from "./state.js";
import { createMetrics, extractUsage, wrapStreamForMetrics } from "./metrics.js";
import { forkLinkOf, loadForkLinks, recordForkLink, resolveInheritance, INHERIT_WINDOW_MS } from "./fork.js";
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
const trimViewBySession = new Map(); // sessionId -> { viewTokens, at }
const TRIM_VIEW_MAX_AGE_MS = 600_000; // 10 minutes

/** Most recent outbound-view token estimate for a session, or null when
 * missing, non-positive, or older than maxAgeMs. Read by the watermark
 * layer (meter duality); itself fail-open. */
export function recentTrimViewTokensOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		if (typeof sessionId !== "string" || sessionId === "") return null;
		const entry = trimViewBySession.get(sessionId);
		if (entry === undefined) return null;
		if (Date.now() - entry.at > maxAgeMs) return null;
		return Number.isFinite(entry.viewTokens) && entry.viewTokens > 0 ? entry.viewTokens : null;
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

/** Display label for the banner: object → name, string → itself, else the
 * session id (never prints [object Object]). */
export function agentLabelOf(agent) {
	if (typeof agent === "string") return agent;
	if (agent !== null && typeof agent === "object" && typeof agent.name === "string" && agent.name !== "") return agent.name;
	return agentSessionIdOf(agent);
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
 * watermark protocol, so it stays out of KV invariants' way). */
export const TRIM_PROTOCOL_TEXT = [
	"[SWITCHMAN:TRIM] This session has automatic context trimming.",
	"- Old message ranges may be replaced by ONE synthetic [SWITCHMAN:TRIM] summary message; treat those summaries as faithful compressions, and message refs inside them as historical anchors.",
	"- NEVER contradict or re-derive content a summary already settled; build on it.",
	"- When context grows large, you may fold a contiguous range yourself with the ctx_trim_fold tool (give firstId/lastId message refs and a summary following the compression rules); inspect state with ctx_trim_status.",
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

/** Live context line renderer (pure; exported for tests). Silent in "off"
 * mode and whenever nothing has been measured yet. */
export function renderTrimContextLine(agent, { enabled, mode, viewTokens, windowTokens, folds, growthTokens, lastModel }) {
	if (!enabled) return "";
	if (mode === "off") return "";
	if (agent === null || agent === undefined || agent === "") return "";
	const hasView = Number.isFinite(viewTokens) && viewTokens > 0;
	const hasFolds = Number.isFinite(folds) && folds > 0;
	if (!hasView && !hasFolds) return "";
	const kilo = (n) => `${Math.round(n / 1000)}k`;
	const parts = [];
	if (hasView) {
		let usage = "";
		if (Number.isFinite(windowTokens) && windowTokens > 0) usage = ` (${Math.round((viewTokens / windowTokens) * 100)}% of window ${kilo(windowTokens)})`;
		else usage = " (window unknown — pressure tiers off)";
		parts.push(`view ~${kilo(viewTokens)} tokens${usage}`);
	}
	if (hasFolds) {
		parts.push(`folds ${folds}`);
		if (Number.isFinite(growthTokens)) parts.push(`growth ~${kilo(growthTokens)} since last fold`);
	}
	if (lastModel !== null && typeof lastModel === "object" && typeof lastModel.model === "string" && lastModel.model !== "") parts.push(`model ${lastModel.model}`);
	if (parts.length === 0) return "";
	const modeNote = mode === "advisory" ? "advisory: fold via ctx_trim_fold when context feels heavy" : "auto folding active";
	return `[SWITCHMAN:TRIM] agent ${agent}: ${parts.join(", ")}; ${modeNote}.\n`;
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
	const metrics = createMetrics();
	const captures = new Map(); // sessionId -> { messages, refs, viewTokens, model, at }
	const inFlight = new Set(); // sessionIds with a fold running
	const windowCache = new Map(); // "provider/model" -> { windowTokens, at }
	const lastEmergencyAtBySession = new Map(); // sessionId -> epoch ms of last emergency fold (per-session cooldown)
	const lastStreamCheckAt = new Map(); // sessionId -> epoch ms of last stream-path fold check (throttle)
	const epochResetDoneBySession = new Map(); // sessionId -> ledger-stale baseline reset already done for this host epoch (cleared when a fold applies again)

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
		maxFoldsPerHour: readNumber(config, "trimMaxFoldsPerHour", 6),
	});
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
		const injected = injectView(options, messages, view);
		const viewTokens = estimateTokensOf(view.messages);
		const blocksCount = Array.isArray(ledger.blocks) ? ledger.blocks.length : 0;
		// Per-request application evidence: whether the ledger's blocks actually
		// locate inside THIS re-send (the host may compact/replace history, in
		// which case applied=0 explains a stuck-high view without any failure).
		decisionLog(`session=${sessionId} view-applied applied=${view.applied} foldedMsgs=${view.foldedMessages} view=${Math.round(viewTokens)} blocks=${blocksCount} injected=${injected}`);
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
		trimViewBySession.set(sessionId, { viewTokens, at: Date.now() });
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
		const { startIdx, endIdx } = decision;
		const slice = capture.messages.slice(startIdx, endIdx + 1);
		if (slice.length === 0) return "empty-slice";
		const refs = slice.map((message, i) => refOf(message, startIdx + i));
		const count = slice.length;
		const approxTokens = estimateTokensOf(slice);
		let summary = null;
		let kind = "summary";
		if (decision.action === "emergency") {
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
		// Growth-gate baseline pair: pre-fold view (banner display) plus the
		// post-fold low (tier-a anchor — keeps the gate armed after folds
		// that commit at high view points).
		const lowLedger = store.ledgerOf(sessionId);
		const lowView = estimateTokensOf(buildView(capture.messages, lowLedger, { protectedTail: thresholdsNow().protectedTail }).messages);
		store.recordFoldBaseline(sessionId, capture.viewTokens, lowView);
		if (decision.action === "emergency") lastEmergencyAtBySession.set(sessionId, Date.now());
		if (lastEmergencyAtBySession.size > 200) lastEmergencyAtBySession.delete(lastEmergencyAtBySession.keys().next().value);
		return `folded:${decision.tier}:${count} msgs (~${approxTokens} tokens)`;
	}

	/** Idle-boundary hook (also re-used by the stream-path fallback): decide
	 * and run the fold. All failures contained. */
	async function maybeFold(agent, via = "idle") {
		const sessionId = agent;
		if (sessionId === null || sessionId === undefined || sessionId === "") return;
		if (!enabledNow() || modeNow() !== "auto") return;
		if (inFlight.has(sessionId)) return;
		const capture = captures.get(sessionId);
		if (capture === undefined) return;
		inFlight.add(sessionId);
		try {
			const { protectedTail, ...thresholds } = thresholdsNow();
			const foldable = computeFoldableRange(capture.messages, store.ledgerOf(sessionId), protectedTail);
			const windowTokens = await windowTokensFor(capture.model);
			const ledger = store.ledgerOf(sessionId);
			const decision = evaluateTrigger({
				foldable,
				messages: capture.messages,
				viewTokens: capture.viewTokens,
				windowTokens,
				thresholds,
				now: Date.now(),
				lastFoldAt: ledger.lastFoldAt,
				foldsThisHour: ledger.foldsThisHour,
				lastEmergencyAt: lastEmergencyAtBySession.get(sessionId) ?? 0,
				ledger,
			});
			decisionLog(`session=${sessionId} via=${via} action=${decision.action} tier=${decision.tier ?? "-"} reason=${decision.reason || "-"} view=${Math.round(capture.viewTokens)} window=${windowTokens ?? "null"}`);
			if (decision.action === "none") return;
			const outcome = await runFoldCycle(sessionId, decision);
			// Outcome lands in the decision log too: warn() has no reachable
			// sink on some hosts, and the commit/fail boundary is exactly what
			// live diagnosis needs.
			decisionLog(`session=${sessionId} outcome=${outcome} tier=${decision.tier}`);
			warn(`[context-trim] ${sessionId}: ${outcome} (${decision.reason})`);
		} catch (error) {
			warn(`[context-trim] fold cycle failed: ${error?.message ?? error}`);
		} finally {
			inFlight.delete(sessionId);
		}
	}

	// ---- host registrations (each individually fail-open) --------------------

	try {
		ctx.systemPrompt?.section?.({ name: "switchman:trim", order: 10450, interpolate: false, text: () => TRIM_PROTOCOL_TEXT });
	} catch (error) {
		warn(`[context-trim] systemPrompt.section failed: ${error?.message ?? error}`);
	}
	try {
		ctx.systemPrompt?.context?.({
			name: "switchman:trim",
			order: 299,
			required: true,
			interpolate: false,
			text: (context) => {
				try {
					const agent = context?.agent ?? null;
					// context.agent is also the agent OBJECT — derive the id plus a
					// display label so the banner never prints [object Object].
					const sessionId = agentSessionIdOf(agent);
					const label = agentLabelOf(agent);
					const record = sessionId !== null ? metrics.of(sessionId) : null;
					const ledger = sessionId !== null ? store.ledgerOf(sessionId) : null;
					const model = captureModelOf(sessionId);
					const windowTokens = model === null ? null : cachedWindowOf(model);
					const growthBaseline = ledger !== null && Number.isFinite(ledger.lastFoldLowTokens) && ledger.lastFoldLowTokens > 0 ? ledger.lastFoldLowTokens : ledger !== null && Number.isFinite(ledger.lastFoldViewTokens) && ledger.lastFoldViewTokens > 0 ? ledger.lastFoldViewTokens : null;
return renderTrimContextLine(label, {
						enabled: enabledNow(),
						mode: modeNow(),
						viewTokens: record?.viewTokens ?? null,
						windowTokens,
						folds: Array.isArray(ledger?.blocks) ? ledger.blocks.length : 0,
						growthTokens: record?.viewTokens !== null && record !== undefined && growthBaseline !== null ? record.viewTokens - growthBaseline : null,
						lastModel: record?.lastModel ?? null,
					});
				} catch {
					return "";
				}
			},
		});
	} catch (error) {
		warn(`[context-trim] systemPrompt.context failed: ${error?.message ?? error}`);
	}

	/** Synchronous window lookup for the banner: raw cache composed with
	 *  the cap (async resolution happens in the idle path / stream path). */
	function captureModelOf(sessionId) {
		return captures.get(sessionId)?.model ?? null;
	}
	function cachedWindowOf(model) {
		const resolved = model !== null && typeof model.provider === "string" && typeof model.model === "string" ? windowCache.get(`${model.provider}/${model.model}`)?.windowTokens ?? null : null;
		return effectiveWindowTokens(resolved, windowCapNow());
	}

	try {
		ctx.on("agent/status", (payload) => {
			try {
				if (payload?.status !== "idle") return;
				// payload.agent is the agent OBJECT (dsh-agent fuses { ...payload,
				// agent }) — derive the session id per host/context-watch.js:122.
				const sessionId = agentSessionIdOf(payload?.agent);
				if (sessionId === null) return;
				void maybeFold(sessionId);
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

	try {
		ctx.tools?.register?.({
			name: "ctx_trim_status",
			description: "Inspect the context-trim state of the current session: mode, thresholds, view token estimate, fold ledger, per-message refs of the captured history. Read-only.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			required: [],
			async execute() {
				const sessionId = sessionIdOf({});
				if (sessionId === null) return "No session context available.";
				const ledger = store.ledgerOf(sessionId);
				const record = metrics.of(sessionId);
				const capture = captures.get(sessionId);
				const { protectedTail, ...thresholds } = thresholdsNow();
				const lines = [
					"ctx_trim_status",
					`mode: ${modeNow()} (enabled: ${enabledNow()})`,
					`view tokens (estimate): ${record?.viewTokens ?? "n/a"}`,
					`window tokens: ${cachedWindowOf(capture?.model ?? null) ?? "unknown"}`,
					`folds: ${Array.isArray(ledger.blocks) ? ledger.blocks.length : 0}, frontier: ${ledger.frontier ?? "none"}, last fold view tokens: ${ledger.lastFoldViewTokens || "n/a"}`,
					`thresholds: growth>${thresholds.growthTokens} increment>=${thresholds.incrementTokens} pressure=${thresholds.pressurePercent}% emergency=${thresholds.emergencyPercent}% maxPerHour=${thresholds.maxFoldsPerHour} protectedTail=${protectedTail}`,
				];
				if (capture !== undefined) {
					lines.push("", `captured history (${capture.messages.length} messages; refs [m...] are fold anchors):`);
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
						tier: "model",
					},
					positions,
				);
				if (!result.ok) return `Fold rejected: ${result.reason}.`;
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

	return { store, metrics, captures, inFlight, maybeFold, maybeInherit, applyViewToOptions, renderTrimContextLine: (agent) => renderTrimContextLine(agent, { enabled: enabledNow(), mode: modeNow(), viewTokens: null, windowTokens: null, folds: 0, growthTokens: null, lastModel: null }) };
}
