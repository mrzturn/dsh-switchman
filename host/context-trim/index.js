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
 * trimPressurePercent, trimEmergencyPercent, trimAdvisoryPercent,
 * trimAdvisoryCriticalPercent, trimWindowTokens,
 * trimProtectedTail, trimMaxFoldsPerHour, trimSideModel, trimFoldFallbackModel, trimStateDir,
 * trimLadderEnabled, trimLadderT2Tokens, trimLadderT2MinBlocks,
 * trimLadderT3Tokens, trimLadderT3MinBlocks.
 */

import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildView, estimateTokensOf, injectView, isFoldSummaryMessage, ledgerIsStale, messageTokens, rangeIsSegmentAligned, refOf, refPositions } from "./view.js";
import { computeFoldableRange, evaluateTrigger, EMERGENCY_COOLDOWN_MS } from "./trigger.js";
import { LADDER_SYSTEM_PROMPT, mechanicalSummary, renderLadderMaterial, renderMaterial, summarizeWithModel } from "./summarizer.js";
import { createStore } from "./state.js";
import { createMetrics, extractUsage, promptTokensOf, wrapStreamForMetrics } from "./metrics.js";
import { forkLinkOf, loadForkLinks, recordForkLink, resolveInheritance, INHERIT_WINDOW_MS } from "./fork.js";
import { createSurfaceFoldPass } from "./surface.js";
import { childSessionIdOf } from "../subagent-model.js";
import { tmpdir } from "node:os";
import { dshHome } from "../lib/dsh-home.js";
import { fileURLToPath } from "node:url";

// Module build stamp ([2026-11-15]-[stale-module observability]): the
// per-dispatch view-applied row carries it, so a host process still
// running a pre-reload copy of this engine is identifiable in
// decisions.log without after-the-fact reconciliation. Fail-open: 0
// omits the field (2026-11-15 incident: a stale module nudged at
// 81-125% for two hours while the relief code sat uninstalled on disk —
// nothing in the log distinguished the running copy from the repo one).
const MODULE_BUILD_STAMP = (() => {
	try {
		return Math.round(statSync(fileURLToPath(import.meta.url)).mtimeMs);
	} catch {
		return 0;
	}
})();
/** Resolve the configured ledger state dir to an absolute path that
 *  stays inside the plugin's own state root (<dshHome>/.dsh-switchman/
 *  state/trim/) or the OS temp root (os.tmpdir(), for throwaway test
 *  state). The dir is settings-writable, and the ledger writer mkdirSyncs
 *  and writes JSON there — an arbitrary out-of-root value would aim that
 *  writer at any directory. Empty/unset keeps the store default; a
 *  relative value resolves inside the root; anything else is refused
 *  with a warn and the default root is used. Exported for tests. */
export function resolveStateDir(raw, warn = () => {}) {
	const root = resolve(dshHome(), ".dsh-switchman", "state", "trim");
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const candidate = resolve(root, raw);
	if (candidate === root || candidate.startsWith(root + "/")) return candidate;
	// The OS temp root hosts throwaway state (tests mkdtemp under it); it is
	// per-user and 0700 on macOS/Linux, so it stays inside the threat model.
	const tmpRoots = [resolve(tmpdir())];
	try { tmpRoots.push(realpathSync(tmpRoots[0])); } catch { /* first is enough */ }
	if (tmpRoots.some((t) => candidate === t || candidate.startsWith(t + "/"))) return candidate;
	warn(`dsh-switchman: trimStateDir refused (must stay under ${root} or the OS temp root): ${raw}`);
	return undefined;
}


// ---- agent reference helpers --------------------------------------------------

/** Derive a session id from an agent reference: either a plain string id or
 * the agent OBJECT (dsh-agent fuses { ...payload, agent } — payload.agent on
 * agent/status and assembleContextFor's context.agent are both the object
 * form). Mirrors the host/context-watch.js:122 precedent. Returns null when
 * nothing usable is present. */
// ---- cross-layer meter registries (meter duality, design §8) ---------------
// Per session: the latest outbound-view token estimate plus the last sampled
// provider prompt, refreshed on every ACCEPTED main llm/stream call (the
// side-dispatch guard keeps auxiliary calls out of both). host/context-watch.js
// reads the wire-domain bridge over these (recentTrimPromptTokensOf:
// max(view, wire)) so the watermark meters on the same boundary as the trim
// pressure tiers; the wire-truth gate decides when neither registry may drive
// it and the stored tally takes over.
const trimViewBySession = new Map(); // sessionId -> { viewTokens, at, inject, lastNoneAt }
const trimWireBySession = new Map(); // sessionId -> { promptTokens, at } — last sampled provider prompt of an accepted MAIN dispatch (side calls never write; a tiny inherited-id usage sample must not lower the watermark's wire floor)
const trimProjectedBySession = new Map(); // sessionId -> { totalTokens, at } — last host-meter reading (tokenMeter.measure().totalTokens: provider-anchored projection of the NEXT prompt, the figure the DSH context panel displays). Observability only — recorded at the idle boundary where the agent object is reachable; the trim tiers never read it.
const capturedModelBySession = new Map(); // sessionId -> { provider, model, at } — last stream-captured model route, read by the watermark layer to scale subagent tiers to the session's own model window
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

/** Shared wire-truth gate (docs/context-trim.md): the view-registry entry for
 * one session when the recent dispatch stream provably carried the view —
 * null when missing, stale, injected "none", or inside the sticky lastNoneAt
 * window (mixed sessions exist — one real session logged 46 none + 14
 * swapped). Observed 2026-11-04: a view that never reaches the wire must not
 * drive the watermark (view ~80k vs a 176k wire while the force tier stayed
 * silent and the auto-handover never fired). Both watermark accessors read
 * through this gate; itself fail-open. */
function gatedViewEntry(sessionId, maxAgeMs) {
	if (typeof sessionId !== "string" || sessionId === "") return null;
	const entry = trimViewBySession.get(sessionId);
	if (entry === undefined) return null;
	if (Date.now() - entry.at > maxAgeMs) return null;
	if (entry.inject === "none") return null;
	if (Number.isFinite(entry.lastNoneAt) && entry.lastNoneAt > 0 && Date.now() - entry.lastNoneAt < maxAgeMs) return null;
	return entry;
}

/** Most recent outbound-view token estimate for a session, or null when
 * missing, non-positive, or gate-rejected. The bare-view half of the meter
 * duality bridge — kept for diagnostics and as the gate primitive; the
 * watermark layer reads the wire-domain accessor below. */
export function recentTrimViewTokensOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		const entry = gatedViewEntry(sessionId, maxAgeMs);
		return entry !== null && Number.isFinite(entry.viewTokens) && entry.viewTokens > 0 ? entry.viewTokens : null;
	} catch {
		return null;
	}
}

/** Most recent captured model route ({provider, model}) for a session, or
 * null when missing, stale, or malformed. The watermark layer reads this to
 * look up the session's own model window (subagent tier scaling). */
export function recentTrimModelOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		const entry = capturedModelBySession.get(sessionId);
		if (entry === undefined || Date.now() - entry.at > maxAgeMs) return null;
		return typeof entry.provider === "string" && typeof entry.model === "string" ? { provider: entry.provider, model: entry.model } : null;
	} catch {
		return null;
	}
}

/** Meter-duality bridge, wire domain (design §8): the same number the trim
 * pressure tiers evaluate in maybeFold — Math.max(outbound view estimate,
 * the last sampled provider prompt) — or null when the gate rejects or
 * neither component is fresh. The watermark layer reads THIS (not the bare
 * view) so its soft/hard/force tiers and the read budget sit on the same
 * boundary as the fold engine: the view estimate never counts the
 * system/tool sections (a session-shape-dependent mass — live decision-log
 * pairs drift −5k…+6k between view and wire in steady state), so a
 * view-only watermark tightens every protective tier late by exactly that
 * mass, and the wmHardTokens-95k ≈ trim-pressure-97.5k adjacency (65%
 * of the 150k window) is silently defeated. The wire half comes from
 * accepted MAIN dispatches only (noteTrimWireTokens below). Same sticky
 * gate as the view bridge;
 * fail-open — null means the caller falls back to the stored tally. */
export function recentTrimPromptTokensOf(sessionId, maxAgeMs = TRIM_VIEW_MAX_AGE_MS) {
	try {
		const entry = gatedViewEntry(sessionId, maxAgeMs);
		if (entry === null) return null;
		let best = 0;
		if (Number.isFinite(entry.viewTokens) && entry.viewTokens > 0) best = entry.viewTokens;
		const wire = trimWireBySession.get(sessionId);
		if (wire !== undefined && Date.now() - wire.at <= maxAgeMs && Number.isFinite(wire.promptTokens) && wire.promptTokens > best) best = wire.promptTokens;
		return best > 0 ? best : null;
	} catch {
		return null;
	}
}

/** Record the provider prompt size (uncached + cacheRead + cacheWrite) of one
 * usage sample from an ACCEPTED main dispatch. Side dispatches (fold-span
 * re-sends, title generation, web-search summaries) sample usage on the same
 * session id but must never reach this registry: their tiny prompts would
 * LOWER the watermark's wire floor below the main history's real prompt —
 * exactly the pollution the side-dispatch guard keeps out of the view
 * registry. Fail-open, bounded like the view registry. */
function noteTrimWireTokens(sessionId, usage) {
	try {
		if (typeof sessionId !== "string" || sessionId === "") return;
		const promptTokens = promptTokensOf({
			lastInputTokens: usage.inputTokens,
			cachedTokens: usage.cachedTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
		});
		if (promptTokens === null) return;
		trimWireBySession.set(sessionId, { promptTokens, at: Date.now() });
		if (trimWireBySession.size > 200) trimWireBySession.delete(trimWireBySession.keys().next().value);
	} catch {
		/* observability must never throw */
	}
}

/** Record the host meter's projected prompt size for one session. Read from
 * the agent/status idle boundary (the only place the agent object — and thus
 * agent.session for tokenMeter.measure — is reachable in this layer). The
 * figure is the DSH context panel's number (projectedTokens domain):
 * provider-anchored plus heuristic surface deltas, i.e. what the NEXT prompt
 * would cost — ahead of the wire, which only updates when the next response
 * reports usage. Observability only: it lands in the view-applied row as
 * proj=<n> so view/wire/proj divergence (estimator vs provider vs
 * projection-domain) is one grep away. Fail-open, bounded (200 sessions). */
function noteTrimProjectedTokens(sessionId, agent, ctx) {
	try {
		if (typeof sessionId !== "string" || sessionId === "") return;
		const measurement = agent?.session ? ctx?.tokenMeter?.measure?.(agent.session) : undefined;
		const total = Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : null;
		if (total === null) return;
		trimProjectedBySession.set(sessionId, { totalTokens: total, at: Date.now() });
		if (trimProjectedBySession.size > 200) trimProjectedBySession.delete(trimProjectedBySession.keys().next().value);
	} catch {
		/* observability must never throw */
	}
}

// ---- pressure-snapshot bridge (client badge) -------------------------------
// The routes layer (host/routes.js) serves GET /trim-pressure for the client
// dock chip; the live window/pressure math lives in THIS closure. A module
// bridge mirrors the recentTrim*Of pattern: applyContextTrim publishes a
// snapshot function once at mount; the route reads it per request. Null
// publisher (module unloaded) or null window (nothing to measure against)
// degrades to { available: false } — the chip renders nothing.
let trimPressureSnapshotFn = null;
export function trimPressureSnapshotOf(sessionId) {
	try {
		if (typeof trimPressureSnapshotFn !== "function") return { available: false };
		return trimPressureSnapshotFn(sessionId) ?? { available: false };
	} catch {
		return { available: false };
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
			// Pass the configured effort through verbatim (IntentRouteSchema
			// already carries the optional field); absent/empty just omits it.
			return typeof got.effort === "string" && got.effort !== ""
				? { provider: got.provider, model: got.model, effort: got.effort }
				: { provider: got.provider, model: got.model };
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
	"- When run_code is your only directly callable tool (program-transport mode), invoke these from inside a run_code program: await tools.ctx_trim_status({}) to list ranges, await tools.ctx_trim_fold({ firstId, lastId, count, summary }) to fold.",
	"- Tool-call pairs (an assistant tool call and its results) must always be folded together or not at all.",
].join("\n");

// Advisory nudge thresholds: the default speak line (50%) deliberately sits
// well below the protocol's own 80% fold line so the model is nudged while
// it still has comfortable headroom; critical wording escalates at 80%.
// [2026-11-15]-[advisory lines recalibrated 65/95 → 50/80]-[the 2026-11-14
// turn-25 incident (nudges ignored, 74%→99% in 28 minutes) showed a speak
// line at 65% arrives too late to matter]. At most one nudge per session
// per 10 minutes (an instant re-nudge when the level band changes). Both
// lines are config-tunable via trimAdvisoryPercent / trimAdvisoryCriticalPercent.
export const ADVISORY_NUDGE_PERCENT = 50;
export const ADVISORY_NUDGE_CRITICAL_PERCENT = 80;
export const ADVISORY_NUDGE_REPEAT_MS = 600_000;

/** Effective advisory lines for one dispatch: config-tunable, falling back to
 * the configured defaults (50/80) when absent, inverted, or out of range —
 * a broken pair never silences the nudge. */
function advisoryNudgeLines(config) {
	const line = readNumber(config, "trimAdvisoryPercent", ADVISORY_NUDGE_PERCENT);
	const critical = readNumber(config, "trimAdvisoryCriticalPercent", ADVISORY_NUDGE_CRITICAL_PERCENT);
	const sane = (v) => Number.isFinite(v) && v > 0 && v <= 100;
	if (!sane(line) || !sane(critical) || line >= critical) return { line: ADVISORY_NUDGE_PERCENT, critical: ADVISORY_NUDGE_CRITICAL_PERCENT };
	return { line, critical };
}

/** Advisory-mode nudge text. Deliberate, bounded exception to the
 * digit-free disclosure policy of TRIM_PROTOCOL_TEXT above: advisory mode
 * never folds on a schedule (the modeNow gate); besides the model's own
 * fold, the only engine-initiated relief is the one-shot critical relief
 * fold (trimCriticalRelief, cooldown-gated). At threshold, the live-number
 * instruction is appended to the session surface tail, not injected into
 * the registered system section. */
export function advisoryNudgeText(pressurePercent, critical, foldLine = ADVISORY_NUDGE_PERCENT, criticalLine = ADVISORY_NUDGE_CRITICAL_PERCENT) {
	const action = critical
		? `Pressure is CRITICAL (${pressurePercent}% ≥ ${criticalLine}%): fold down to under ~50% of the context IN THIS TURN.`
		: `At ${pressurePercent}% (fold line ${foldLine}%): ${foldLine}–${foldLine + 9}% → fold roughly half of the older history now; ≥${foldLine + 10}% → fold down to under ~50%.`;
	return [
		'[SWITCHMAN:TRIM] Advisory nudge — pinned to the session tail until pressure falls below the fold line.',
		`Live context pressure on this session has reached the fold line. ${action}`,
		"FOLD FIRST: treat this nudge as a preemption, not background advice. Finish the current tool call if (and only if) aborting it mid-flight would leave broken state; otherwise interrupt the task queue and fold before continuing. Every queued step, plan item and pending subtask waits until pressure is back under the fold line. The only valid excuse to defer is a task that genuinely cannot be resumed after an interruption — and even then, fold at the first safe pause rather than at task end.",
		"Act now: call ctx_trim_status to list compressible ranges, pick one contiguous range, and fold it with ctx_trim_fold (tool-call pairs fold together or not at all; existing summaries stay). If run_code is your only directly callable tool, run both inside a program: await tools.ctx_trim_status({}) then await tools.ctx_trim_fold({ firstId, lastId, count, summary }). Do not wait for a routine moment.",
	].join("\n");
}

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

	// Reload/teardown marker: HMR disposes and remounts this section on every
	// plugin edit (the profile's node_modules entry is a dev symlink into this
	// checkout). An in-flight fold whose llm stream is cut by the dispose ends
	// as a clean zero-chunk stream — inside the summarizer that is
	// indistinguishable from a genuine empty model reply. Cycles record their
	// start time; a dispose at/after that time reclassifies the outcome as
	// reload-aborted so it neither climbs the failure ladder nor reads as a
	// model failure in decisions.log.
	let disposedAt = 0;
	try {
		// cordis emits no "dispose" event: self-teardown arrives as
		// "internal/plugin" carrying OUR fiber with its uid CLEARED — uid is a
		// positive counter at construction (vendor/cordis fiber.ts:239) and is
		// set to null right before the disposal emit (:274-275; the DISPOSED
		// state is defined as uid === null at :581). Same guard DSH ships in
		// mcp-manager:249 and client-ui-cot-translation mount.ts:123.
		ctx.on("internal/plugin", (fiber) => { if (fiber === ctx.fiber && fiber.uid === null) disposedAt = Date.now(); });
	} catch {
		/* lifecycle events unavailable on this ctx — flag stays 0, behavior unchanged */
	}
	const disposedSince = (since) => disposedAt !== 0 && disposedAt >= since;

	// Per-process pipeline state (process-wide by design: ledgers persist on
	// disk per session, metrics/captures live per session in memory).
	const store = createStore({ stateDir: resolveStateDir(readString(config, "trimStateDir", null), warn) ?? undefined, warn });

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

	// Advisory nudge state: sessionId -> { at, critical, seq }. Bounded like the
	// other per-session registries (200 entries).
	const advisoryNudgeBySession = new Map();

	// Single-flight for nudge warm-ups: during resolveRawWindow's <=10s window
	// every main dispatch would otherwise re-fire the same resolve. Entries
	// self-delete on settle; the expiry is only a belt-and-suspenders bound.
	const windowWarmupInFlight = new Map(); // "provider/model" -> expiresAt
	function warmWindowOnce(model, now) {
		const key = `${model.provider}/${model.model}`;
		const until = windowWarmupInFlight.get(key);
		if (until !== undefined && now < until) return;
		windowWarmupInFlight.set(key, now + 15_000); // > resolveRawWindow's 10s ceiling
		void windowTokensFor(model).catch(() => {}).finally(() => {
			if (windowWarmupInFlight.get(key) === until) windowWarmupInFlight.delete(key);
		});
	}

	/** Advisory-mode pressure nudge (text: advisoryNudgeText). Appends the live
	 * instruction to the session surface tail once pressure crosses the fold
	 * line. Pressure reuses the meter-duality bridge (wire preferred, view
	 * estimate as floor) against the session model's window read from the SYNC
	 * cache — a cache miss fires an async warm-up (windowTokensFor) and defers
	 * the nudge to a later dispatch instead of blocking this one — and it only
	 * reaches the wire on the NEXT dispatch (the current request is already
	 * assembled). The speak is a pure suffix, so the prompt prefix stays
	 * untouched; a later clear or upgrade prunes only the nudge nodes, so
	 * cache reuse survives up to the nudge instead of invalidating the whole
	 * prefix as the old system-head splice did. */
	function deliverAdvisoryNudge(sessionId, viewTokens) {
		if (modeNow() !== "advisory") {
			debug(`nudge skip mode=${modeNow()} session=${sessionId}`);
			return;
		}
		const model = capturedModelBySession.get(sessionId) ?? null;
		if (model === null) {
			decisionLog("advisory-nudge skip why=no-captured-model");
			return;
		}
		if (typeof model.provider !== "string" || typeof model.model !== "string") {
			decisionLog("advisory-nudge skip why=bad-model-shape");
			return;
		}
		const cached = windowCache.get(model.provider + "/" + model.model);
		let resolvedWindow; // model-resolved window, or the configured cap when unknown
		if (cached === undefined) {
			// Unknown: warm up single-flight but stay AUDIBLE — fall back to the
			// configured cap (the same denominator the emergency tier uses), so a
			// model whose metadata never resolves still gets nudged at the fold
			// line instead of burning to force unseen (2026-11-14: window-unknown
			// swallowed every nudge at 89% pressure).
			warmWindowOnce(model, Date.now());
			resolvedWindow = windowCapNow();
		} else {
			// Stale-but-known still gates correctly: effectiveWindowTokens binds to the
			// configured cap for every model larger than it, so the pressure math is
			// unchanged. Re-warm in the background instead of burning this boundary.
			if (Date.now() - cached.at >= 600_000) warmWindowOnce(model, Date.now());
			// Resolution failed inside the TTL: same cap fallback instead of going
			// quiet (no retry hammering — the warm-up stays single-flight).
			resolvedWindow = cached.windowTokens ?? windowCapNow();
		}
		// Bind the resolved window to the configured cap before computing pressure.
		const windowTokens = effectiveWindowTokens(resolvedWindow, windowCapNow());
		if (windowTokens === null) {
			// Cap unavailable too (wmForceTokens=0 and no explicit cap): nothing to
			// measure against — the one remaining legitimate silence.
			decisionLog("advisory-nudge skip why=window-unknown");
			return;
		}
		const wire = wireTokensOf(sessionId);
		const mass = Math.max(Number.isFinite(wire) ? wire : 0, Number.isFinite(viewTokens) ? viewTokens : 0);
		if (mass <= 0) {
			debug(`nudge skip empty-mass session=${sessionId}`);
			return;
		}
		const pressurePercent = (mass / windowTokens) * 100;
		const nudgeLines = advisoryNudgeLines(config);
		const prior = advisoryNudgeBySession.get(sessionId);
		if (pressurePercent < nudgeLines.line) {
			// Below the line every live nudge must go. The sweep is NOT gated
			// on `prior`: restarts and registry evictions lose the episode while
			// the node stays visible. The recorded seq joins the union even when
			// it fell out of the 50-node scan window; nudgePrune skips seqs a
			// fold already consumed, so a vanished prior.seq cannot wedge this.
			const seqs = new Set(surfacePass.nudgeScan(sessionId));
			if (Number.isFinite(prior?.seq)) seqs.add(prior.seq);
			if (seqs.size > 0) {
				if (!surfacePass.nudgePrune(sessionId, [...seqs])) {
					decisionLog("advisory-nudge skip why=prune-failed pressure=" + Math.round(pressurePercent) + "%");
					return;
				}
				advisoryNudgeBySession.delete(sessionId);
				// Log the resolved denominator (cap fallback included), not
				// cached.windowTokens — on a cache miss `cached` is undefined
				// here and this row threw after a successful prune
				// (2026-11-15T02:28:12Z advisory-nudge-failed).
				decisionLog("advisory-nudge below-line pressure=" + Math.round(pressurePercent) + "% mass=" + Math.round(mass) + " resolved=" + resolvedWindow + " cap=" + windowCapNow() + " pruned=" + seqs.size);
			} else if (prior !== undefined) {
				advisoryNudgeBySession.delete(sessionId); // nothing visible left; close the episode quietly
			}
			return; // fresh episode on the next crossing
		}
		const critical = pressurePercent >= nudgeLines.critical;
		const now = Date.now();
		// Critical relief ([2026-11-15]-[advisory critical relief fold]-[nudges
		// alone let a session burn from the speak line to host compaction —
		// turn-25: nudges ignored, 74%→99% in 28 minutes]). At the critical line
		// the engine performs ONE mechanical (emergency-style) fold itself,
		// cooldown-gated like the emergency tier, instead of only nudging.
		// Runs ahead of the same-band nudge throttle: the relief cadence is owned
		// by reliefBySession + inFlight alone. `trimCriticalRelief: false`
		// restores nudge-only advisory mode.
		if (critical && reliefEnabledNow() && !inFlight.has(sessionId) && captures.has(sessionId)
			&& now - (reliefBySession.get(sessionId) ?? 0) >= EMERGENCY_COOLDOWN_MS) {
			// Cooldown armed BEFORE the cycle (same pre-set semantics as the
			// emergency tier): every attempt, folded or rejected, cools down.
			reliefBySession.set(sessionId, now);
			if (reliefBySession.size > 200) reliefBySession.delete(reliefBySession.keys().next().value);
			const reliefCapture = captures.get(sessionId);
			const cycleToken = {};
			inFlight.set(sessionId, cycleToken);
			void (async () => {
				try {
					if (disposedSince(now)) {
						decisionLog(`session=${sessionId} advisory-relief outcome=reload-aborted tier=emergency pressure=${Math.round(pressurePercent)}%`);
						return;
					}
					const { protectedTail, protectTaskIntent, ...reliefThresholds } = thresholdsNow();
					const ledger = store.ledgerOf(sessionId);
					const foldable = computeFoldableRange(reliefCapture.messages, ledger, protectedTail, { protectTaskIntent });
					const decision = evaluateTrigger({
						foldable,
						messages: reliefCapture.messages,
						viewTokens: mass, // same basis as the nudge line: max(view, wire)
						windowTokens,
						thresholds: { ...reliefThresholds, emergencyPercent: 1 }, // force the mechanical tier through
						now,
						lastFoldAt: ledger.lastFoldAt,
						foldsThisHour: ledger.foldsThisHour,
						lastEmergencyAt: 0, // reliefBySession owns the relief cadence
						ledger,
						ladderRuns: { t2: [], t3: [] }, // relief is mechanical-only; no ladder cut-in
					});
					if (decision.action !== "emergency") {
						decisionLog(`session=${sessionId} advisory-relief outcome=none reason=${decision.reason || "-"} pressure=${Math.round(pressurePercent)}%`);
						return;
					}
					const outcome = await runFoldCycle(sessionId, decision, now, cycleToken);
					decisionLog(`session=${sessionId} advisory-relief outcome=${outcome} tier=emergency pressure=${Math.round(pressurePercent)}%`);
					if (outcome.startsWith("folded:") || outcome === "summary-unavailable" || outcome.startsWith("commit-rejected:")) {
						warn(`[context-trim] ${sessionId}: advisory relief ${outcome} at ${Math.round(pressurePercent)}%`);
					}
				} catch (error) {
					decisionLog(`session=${sessionId} advisory-relief outcome=error why=${error?.message ?? error}`);
					warn(`[context-trim] ${sessionId}: advisory relief failed: ${error?.message ?? error}`);
				} finally {
					// Only the cycle owning the CURRENT token may release the lock.
					if (inFlight.get(sessionId) === cycleToken) inFlight.delete(sessionId);
				}
			})();
		} else if (critical) {
			debug(`relief gate held pressure=${Math.round(pressurePercent)}% session=${sessionId}`);
			// Audible silence ([2026-11-15]-[relief skip diagnostics]): the turn-25
			// incident hid here — a session sat at 81-125% critical while the gate
			// held, and the only trace was a two-hour view-applied reconciliation.
			// One throttled row per minute names the exact gate that held the
			// relief back (cooldown / cycle in flight / no capture / disabled).
			if (now - (reliefSkipLogAt.get(sessionId) ?? 0) >= 60_000) {
				reliefSkipLogAt.set(sessionId, now);
				if (reliefSkipLogAt.size > 200) reliefSkipLogAt.delete(reliefSkipLogAt.keys().next().value);
				debug(`relief gate detail enabled=${reliefEnabledNow()} cycle=${inFlight.has(sessionId)} capture=${captures.has(sessionId)} sinceLast=${now - (reliefBySession.get(sessionId) ?? 0)}ms session=${sessionId}`);
			const why = !reliefEnabledNow() ? "relief-disabled"
					: inFlight.has(sessionId) ? "cycle-in-flight"
					: !captures.has(sessionId) ? "no-capture"
					: "cooldown";
				decisionLog(`session=${sessionId} advisory-relief skip why=${why} pressure=${Math.round(pressurePercent)}%`);
			}
		}
		// Any band CHANGE re-speaks immediately: escalation high->critical, and
		// intentionally also a downgrade back into high after a partial fold.
		if (prior !== undefined && prior.critical === critical && now - prior.at < ADVISORY_NUDGE_REPEAT_MS) {
			debug(`nudge throttle band=${critical ? "critical" : "high"} age=${now - prior.at}ms session=${sessionId}`);
			return;
		}
		if (!surfacePass.nudgeSupported(sessionId)) {
			decisionLog("advisory-nudge skip why=surface-unavailable pressure=" + Math.round(pressurePercent) + "%");
			return;
		}

		// Replace the recorded prior nudge, or clear orphans a restart left
		// behind, before speaking fresh. nudgePrune only touches seqs still
		// live on the surface, so a prior a fold already consumed is a no-op.
		const priorSeq = Number.isFinite(prior?.seq) ? prior.seq : null;
		if (priorSeq !== null) {
			if (!surfacePass.nudgePrune(sessionId, [priorSeq])) {
				decisionLog("advisory-nudge skip why=prune-failed pressure=" + Math.round(pressurePercent) + "%");
				return;
			}
		} else {
			const orphans = surfacePass.nudgeScan(sessionId);
			if (orphans.length > 0) {
				if (!surfacePass.nudgePrune(sessionId, orphans)) {
					decisionLog("advisory-nudge skip why=prune-failed pressure=" + Math.round(pressurePercent) + "%");
					return;
				}
				decisionLog("advisory-nudge orphan-pruned seqs=" + orphans.length + " pressure=" + Math.round(pressurePercent) + "%");
			}
		}
		const nudge = advisoryNudgeText(Math.round(pressurePercent), critical, nudgeLines.line, nudgeLines.critical);
		const appended = surfacePass.nudgeAppend(sessionId, nudge);
		if (appended.error !== null || !Number.isFinite(appended.seq)) {
			advisoryNudgeBySession.delete(sessionId); // a pruned prior must not throttle the retry
			decisionLog("advisory-nudge skip why=append-failed err=" + (appended.error ?? "unknown") + " pressure=" + Math.round(pressurePercent) + "%");
			return;
		}
		const seq = appended.seq;
		advisoryNudgeBySession.delete(sessionId); // re-insert: refresh recency so eviction drops the least recently nudged
		advisoryNudgeBySession.set(sessionId, { at: now, critical, seq });
		debug(`nudge prepared seq=${seq} level=${critical ? "critical" : "high"} pressure=${Math.round(pressurePercent)}% session=${sessionId}`);
		if (advisoryNudgeBySession.size > 200) advisoryNudgeBySession.delete(advisoryNudgeBySession.keys().next().value);
		decisionLog("session=" + sessionId + " advisory-nudge pressure=" + Math.round(pressurePercent) + "% mass=" + Math.round(mass) + " window=" + windowTokens + " level=" + (critical ? "critical" : "high") + " seq=" + seq);
	}

	const captures = new Map(); // sessionId -> { messages, refs, viewTokens, model, at }
	// sessionId -> generation token of the running fold cycle. A plain Set
	// pinned a session forever once a cycle's await never settled; the
	// maybeFold watchdog swaps the token so wedged cycles release the lock.
	const inFlight = new Map();
	// Fold-cycle watchdog: a cycle still "in flight" after this long logs a
	// cycle-stuck row, releases the lock, and lets the next trigger retry.
	// The ceiling must exceed the worst LEGITIMATE cycle — a raw fold can
	// summarize on side AND fallback routes (2 x SUMMARY_TIMEOUT_MS = 240s) —
	// so a healthy slow cycle is never preempted.
	const CYCLE_WATCHDOG_MS = 300_000;
	// Hard ceiling for one host model-info lookup: some llm builds never
	// settle resolveModelInfo for unresolvable routes, and that wedged
	// await used to pin the whole fold cycle until restart.
	const WINDOW_RESOLVE_TIMEOUT_MS = 10_000;
	const windowCache = new Map(); // "provider/model" -> { windowTokens, at }
	const lastEmergencyAtBySession = new Map(); // sessionId -> epoch ms of last emergency fold (per-session cooldown)
	// Advisory critical relief cooldown: sessionId -> epoch ms of the last
	// relief fold. Set BEFORE the cycle (emergency semantics: a rejected
	// commit cools the relief like a success, or a failing range retries at
	// every dispatch forever). Bounded 200 like the sibling registries.
	const reliefBySession = new Map();
	const reliefSkipLogAt = new Map(); // sessionId -> epoch ms of the last relief-skip diagnostic row (60 s throttle, bounded 200)
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

	/** Debug-trace verbosity gate ([2026-11-15]-[verbose debug log]): the
	 *  turn-25 and window-unknown incidents both hid inside gates that
	 *  outcomes-only logging never names. With trimVerboseLog on, every
	 *  step/gate/decision path writes a debug row; off keeps key rows only. */
	function verboseNow() {
		try {
			return readBool(config, "trimVerboseLog", false) === true;
		} catch {
			return false;
		}
	}
	/** Verbose-only row: one line naming a step/gate/decision path. */
	function debug(entry) {
		if (!verboseNow()) return;
		decisionLog("debug " + entry);
	}
	/** ALWAYS-ON exception detail ([2026-11-15]-[verbose debug log]):
	 *  independent of trimVerboseLog — message + top stack frames, so a
	 *  swallowed catch is reconstructable without reproducing it. */
	function errorLog(where, error) {
		try {
			const stack = typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 5).join(" | ") : "no-stack";
			decisionLog(`error where=${where} msg=${error?.message ?? error} stack=${stack}`);
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
	const reliefEnabledNow = () => readBool(config, "trimCriticalRelief", true);
	const thresholdsNow = () => ({
		growthTokens: readNumber(config, "trimGrowthTokens", 22_500),
		incrementTokens: readNumber(config, "trimIncrementTokens", 45_000),
		// Count-typed fields integerize here (Math.round): the schema allows
		// decimals (z.number()), but trigger.js gates them with Number.isInteger
		// — a non-integer config value would otherwise fall back to the
		// hard-coded default silently (convention mismatch, F6).
		pressurePercent: readNumber(config, "trimPressurePercent", 45),
		emergencyPercent: readNumber(config, "trimEmergencyPercent", 90),
		protectedTail: Math.max(0, Math.round(readNumber(config, "trimProtectedTail", 6))),
		maxFoldsPerHour: Math.max(1, Math.round(readNumber(config, "trimMaxFoldsPerHour", 30))),
		ladderT2Tokens: readNumber(config, "trimLadderT2Tokens", 8_000),
		ladderT2MinBlocks: Math.max(2, Math.round(readNumber(config, "trimLadderT2MinBlocks", 3))),
		ladderT3Tokens: readNumber(config, "trimLadderT3Tokens", 6_000),
		ladderT3MinBlocks: Math.max(2, Math.round(readNumber(config, "trimLadderT3MinBlocks", 2))),
		protectTaskIntent: readBool(config, "trimProtectTaskIntent", true),
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
		const force = readNumber(config, "wmForceTokens", 200_000);
		return force > 0 ? force : null;
	};

	// Publish the client-badge snapshot bridge (module-level trimPressureSnapshotOf
	// reads this). Every field is recomputed per request from live config + the
	// session's captured model/window/wire — same math as the nudge line, no new
	// state. viewTokens arrives from the recent-view bridge (10-min TTL); proj
	// from the meter-projection registry. Failure of any component degrades that
	// field to null; the chip hides on available=false or window=null.
	trimPressureSnapshotFn = (sessionId) => {
		try {
			if (!enabledNow() || typeof sessionId !== "string" || sessionId === "") return { available: false };
			const model = recentTrimModelOf(sessionId, TRIM_VIEW_MAX_AGE_MS);
			let resolvedWindow = null;
			if (model !== null) {
				const cached = windowCache.get(model.provider + "/" + model.model);
				if (cached !== undefined) resolvedWindow = cached.windowTokens ?? null;
			}
			const cap = windowCapNow();
			const windowTokens = resolvedWindow !== null ? effectiveWindowTokens(resolvedWindow, cap) : cap;
			if (windowTokens === null || windowTokens <= 0) return { available: false };
			const viewTokens = recentTrimViewTokensOf(sessionId, TRIM_VIEW_MAX_AGE_MS);
			const wire = wireTokensOf(sessionId);
			const mass = Math.max(Number.isFinite(wire) ? wire : 0, Number.isFinite(viewTokens) ? viewTokens : 0);
			const projectedEntry = trimProjectedBySession.get(sessionId);
			const proj = projectedEntry !== undefined && Date.now() - projectedEntry.at <= TRIM_VIEW_MAX_AGE_MS ? Math.round(projectedEntry.totalTokens) : null;
			const lines = advisoryNudgeLines(config);
			const pressure = mass > 0 ? (mass / windowTokens) * 100 : 0;
			// Cooldown story must match the GATE, not just the timestamp
			// ([2026-11-15]-[relief snapshot coherence]): the gate is
			// enabled + advisory + no cycle in flight + cooldown elapsed;
			// reporting only the arithmetic let the chip claim "ready"
			// while the engine would still skip (cycle in flight).
			const reliefAt = reliefBySession.get(sessionId) ?? 0;
			const reliefCooldownRemaining = reliefEnabledNow() && modeNow() === "advisory"
				? Math.max(0, EMERGENCY_COOLDOWN_MS - (Date.now() - reliefAt))
				: null;
			const reliefReady = reliefCooldownRemaining !== null
				&& reliefCooldownRemaining === 0
				&& !inFlight.has(sessionId)
				&& captures.has(sessionId);

			return {
				available: true,
				mode: modeNow(),
				mass: Math.round(mass),
				window: windowTokens,
				pressure: Math.round(pressure),
				view: viewTokens !== null ? Math.round(viewTokens) : null,
				wire: Number.isFinite(wire) ? Math.round(wire) : null,
				proj,
				advisoryLine: lines.line,
				criticalLine: lines.critical,
				reliefEnabled: reliefEnabledNow(),
				reliefCooldownRemaining,
				reliefReady,
			};
		} catch {
			return { available: false };
		}
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

	/** Async raw-window resolution (fills the cache; null when unknown).
	 * Two fixes over the historical behavior: the host contract is
	 * resolveModelInfo(provider, model) — two strings; passing the model
	 * object threw NO_ADAPTER on every route, so every decision row ran on
	 * the cap fallback. And the lookup is raced against a hard timeout:
	 * a never-settling promise must not pin the fold cycle. */
	async function resolveRawWindow(model, key, now) {
		let timer = null;
		try {
			const llm = ctx.get("llm", false);
			const lookup = Promise.resolve(llm?.resolveModelInfo?.(model.provider, model.model));
			const info = await Promise.race([
				lookup,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`no settle within ${WINDOW_RESOLVE_TIMEOUT_MS}ms`)), WINDOW_RESOLVE_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
			const windowTokens = info?.context?.contextWindow;
			const value = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null;
			if (value === null) decisionLog(`window-resolve-failed key=${key} why=no context metadata`);
			windowCache.set(key, { windowTokens: value, at: now });
			if (windowCache.size > 200) windowCache.delete(windowCache.keys().next().value);
			if (value !== null) decisionLog(`window-resolved key=${key} window=${value}`);
			return value;
		} catch (error) {
			windowCache.set(key, { windowTokens: null, at: now });
			if (windowCache.size > 200) windowCache.delete(windowCache.keys().next().value);
			// One row per model per 10-min cache window (plus rare concurrent
			// misses inside the 10s race window): a silently failing resolution
			// is what hid the wrong-arity call for months.
			decisionLog(`window-resolve-failed key=${key} why=${error?.message ?? error}`);
			return null;
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/** Capture the pre-mutation messages of one stream call (shallow array
	 * copy — message objects are treated as immutable records). */
	function captureOf(sessionId, messages, model, viewTokens) {
		captures.set(sessionId, { messages: messages.slice(), model, viewTokens, at: Date.now() });
		if (model !== null && typeof model === "object" && typeof model.provider === "string" && typeof model.model === "string") {
		capturedModelBySession.set(sessionId, { provider: model.provider, model: model.model, at: Date.now() });
		if (!windowCache.has(model.provider + "/" + model.model)) warmWindowOnce(model, Date.now());
			if (capturedModelBySession.size > 200) capturedModelBySession.delete(capturedModelBySession.keys().next().value);
		}
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
		// Projection truth in the row: the host meter's projected NEXT-prompt
		// size (context-panel domain) sampled at the last idle boundary. Diverges
		// from wire by design — wire is the last PAID prompt, proj estimates the
		// next one — so the two columns bracket the real pressure band.
		const projectedEntry = trimProjectedBySession.get(sessionId);
		const projectedTokens = projectedEntry !== undefined && Date.now() - projectedEntry.at <= TRIM_VIEW_MAX_AGE_MS ? Math.round(projectedEntry.totalTokens) : null;
		// Per-request application evidence: whether the ledger's blocks actually
		// locate inside THIS re-send (the host may compact/replace history, in
		// which case applied=0 explains a stuck-high view without any failure).
		decisionLog(`session=${sessionId} view-applied applied=${view.applied} foldedMsgs=${view.foldedMessages} view=${Math.round(viewTokens)} blocks=${blocksCount} injected=${injected}${wireTokens === null ? "" : ` wire=${wireTokens}`}${projectedTokens === null ? "" : ` proj=${projectedTokens}`}${MODULE_BUILD_STAMP > 0 ? ` b=${MODULE_BUILD_STAMP}` : ""}`);
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
		// Record the active request's route and resolved effort for diagnostics only.
		// The side summarizer follows provider/model only and resolves effort from its
		// model metadata rather than inheriting this dispatch's effort.
		const model = {
			provider: options.provider ?? null,
			model: options.model ?? null,
			effort: typeof options.reasoningEffort === "string" && options.reasoningEffort !== "" ? options.reasoningEffort : null,
		};
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
	 * session's own provider/model. Effort is resolved from that model's
	 * supported thinking metadata, not inherited from the active session call. */
	function sideRouteFor(sessionId) {
		const explicit = readRoute(config, "trimSideModel");
		if (explicit !== null) return explicit;
		const model = metrics.of(sessionId)?.lastModel ?? null;
		if (model !== null && typeof model.provider === "string" && model.provider !== "" && typeof model.model === "string" && model.model !== "") {
			return { provider: model.provider, model: model.model };
		}
		return null;
	}

	/** Resolve the fold-fallback route (trimFoldFallbackModel): the second
	 * chance when the side/session route fails, and the last model stop
	 * before a raw pressure fold degrades to mechanical. Null = no fallback. */
	function foldFallbackRouteFor() {
		return readRoute(config, "trimFoldFallbackModel");
	}

	/** True when two resolved routes name the same provider+model (a fallback
	 * identical to the primary route would only double the failure latency). */
	function sameRoute(a, b) {
		return a !== null && b !== null && a.provider === b.provider && a.model === b.model;
	}

	/** Run one fold cycle for a session (called at the idle boundary ONLY).
	 * Returns a short outcome string for logging. */
	async function runFoldCycle(sessionId, decision, cycleStartedAt, cycleToken) {
		const capture = captures.get(sessionId);
		if (capture === undefined) {
			debug(`cycle step no-capture session=${sessionId}`);
			return "no-capture";
		}
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
			const fallback = foldFallbackRouteFor();
			const approxTokens = consumed.reduce((sum, block) => sum + (Number.isFinite(block.approxTokens) && block.approxTokens > 0 ? block.approxTokens : 0), 0);
			const summarize = (r, tag) => summarizeWithModel(llm, r, renderLadderMaterial(consumed), {
				systemPrompt: LADDER_SYSTEM_PROMPT,
				onFail: (why) => decisionLog(`session=${sessionId} summary-fail route=${tag} why=${why} blocks=${consumed.length} ~${approxTokens}t ladder=${decision.tier}`),
				onNotice: (why) => decisionLog(`session=${sessionId} summary-retry route=${tag} why=${why} blocks=${consumed.length} ~${approxTokens}t ladder=${decision.tier}`),
			});
			let summary = route !== null ? await summarize(route, "side") : null;
			if (summary === null && fallback !== null && !sameRoute(fallback, route)) summary = await summarize(fallback, "fallback");
			// Ladder folds never degrade to mechanical (docs/ladder-fold.md):
			// after both routes fail the cycle stays fail-open with backoff.
			if (summary === null) return disposedSince(cycleStartedAt) ? "reload-aborted" : "summary-unavailable"; // skip cycle, fail-open; a dispose cut is not a model failure
			if (inFlight.get(sessionId) !== cycleToken) return "superseded"; // watchdog released us; a retry owns the session
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
		debug(`cycle step begin kind=${decision.kind} tier=${decision.tier ?? "-"} range=${startIdx}..${endIdx} session=${sessionId}`);
		let summary = null;
		let kind = "summary";
		let degraded = false; // set when a PRESSURE fold falls back to mechanical
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
			const fallback = foldFallbackRouteFor();
			const material = renderMaterial(capture.messages, startIdx, endIdx, refOf);
			const summarize = (r, tag) => summarizeWithModel(llm, r, material, {
				onFail: (why) => decisionLog(`session=${sessionId} summary-fail route=${tag} why=${why} msgs=${count} ~${approxTokens}t`),
				onNotice: (why) => decisionLog(`session=${sessionId} summary-retry route=${tag} why=${why} msgs=${count} ~${approxTokens}t`),
			});
			debug(`cycle step summarize route=${route ? `${route.provider}/${route.model}` : "none"} fallback=${fallback ? `${fallback.provider}/${fallback.model}` : "none"} msgs=${count} ~${approxTokens}t session=${sessionId}`);
			summary = route !== null ? await summarize(route, "side") : null;
			if (summary === null && fallback !== null && !sameRoute(fallback, route)) summary = await summarize(fallback, "fallback");
			// Last resort for PRESSURE folds only: relief beats fidelity when
			// the window is nearly gone; growth folds stay fail-open (a
			// mechanical growth fold would burn fold budget on junk). The
			// outcome row marks the degrade so the log shows why no model
			// summary landed.
			if (summary === null && decision.tier === "pressure") {
				if (disposedSince(cycleStartedAt)) return "reload-aborted";
				summary = mechanicalSummary(capture.messages, startIdx, endIdx, refOf);
				kind = "mechanical";
				degraded = true;
			}
			if (summary === null) return disposedSince(cycleStartedAt) ? "reload-aborted" : "summary-unavailable"; // skip cycle, fail-open; a dispose cut is not a model failure
		}
		const positions = refPositions(capture.messages);
		if (inFlight.get(sessionId) !== cycleToken) return "superseded"; // watchdog released us; a retry owns the session
		debug(`cycle step commit kind=${kind} tier=${decision.tier} msgs=${count} ~${approxTokens}t session=${sessionId}`);
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
		return `folded:${decision.tier}:${count} msgs (~${approxTokens} tokens)${degraded ? " fallback=mechanical" : ""}`;
	}

	/** Idle-boundary hook (also re-used by the stream-path fallback): decide
	 * and run the fold. All failures contained. */
	async function maybeFold(agent, via = "idle") {
		const sessionId = agent;
		if (sessionId === null || sessionId === undefined || sessionId === "") return;
		if (!enabledNow() || modeNow() !== "auto") {
			debug(`session=${sessionId} via=${via} skip enabled=${enabledNow()} mode=${modeNow()}`);
			return;
		}
		if (inFlight.has(sessionId)) {
			debug(`session=${sessionId} via=${via} skip cycle-in-flight`);
			return;
		}
		// Failure backoff: a session whose recent cycles failed stays quiet
		// for 60s*2^(n-1) (cap 15 min) instead of re-firing at every idle
		// boundary and stream check. Silent gate — the outcome row that armed
		// the cooldown is already in decisions.log.
		const failureCooldown = foldFailureCooldownOf(sessionId);
		if (failureCooldown > 0) {
			debug(`session=${sessionId} via=${via} skip failure-backoff remaining=${failureCooldown}ms`);
			return;
		}
		const capture = captures.get(sessionId);
		if (capture === undefined) {
			debug(`session=${sessionId} via=${via} skip no-capture`);
			return;
		}
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
		const cycleStartedAt = Date.now();
		// Generation token lock (was a plain Set): a cycle wedged on an await
		// that never settles used to pin this session's fold path until
		// restart. The watchdog logs the wedge and releases the lock; an
		// abandoned cycle returns "superseded" at its commit guard, and its
		// finally can no longer delete a retry's entry.
		const cycleToken = {};
		inFlight.set(sessionId, cycleToken);
		const cycleWatchdog = setTimeout(() => {
			if (inFlight.get(sessionId) !== cycleToken) return;
			inFlight.delete(sessionId);
			decisionLog(`session=${sessionId} via=${via} outcome=cycle-stuck elapsedMs=${Date.now() - cycleStartedAt}`);
			warn(`[context-trim] ${sessionId}: fold cycle stuck >${CYCLE_WATCHDOG_MS}ms — lock released for the next trigger`);
		}, CYCLE_WATCHDOG_MS);
		cycleWatchdog.unref?.();
		// Hoisted for the catch below: a dispose-cut throw may land before the
		// trigger ever ran, and the catch must not touch a dead binding.
		let decision = null;
		try {
			const { protectedTail, protectTaskIntent, ...thresholds } = thresholdsNow();
			const ledger = store.ledgerOf(sessionId);
			const foldable = computeFoldableRange(capture.messages, ledger, protectedTail, { protectTaskIntent });
			const windowTokens = await windowTokensFor(capture.model);
			// Pressure tiers run on the REAL prompt size when the tally is known:
			// max(view, wire). The view estimate misses the system/context
			// sections, so a 136k wire once read as a 50k view and the tiers
			// stayed silent. Unknown tally → exactly today's behavior.
			const wireTokens = wireTokensOf(sessionId);
			const pressureTokens = wireTokens !== null ? Math.max(capture.viewTokens, wireTokens) : capture.viewTokens;
			decision = evaluateTrigger({
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
			const outcome = await runFoldCycle(sessionId, decision, cycleStartedAt, cycleToken);
			// Failure ladder: commit resets it; a summarize/commit failure
			// climbs it (the no-backoff loop this closes — those outcomes
			// advance no cadence gate on their own). A ladder run whose
			// consumed blocks vanished between trigger and commit is the same
			// family: without backoff it would re-fire at every boundary.
			// "superseded" (watchdog released the lock mid-cycle) and neutral
			// skips advance no ladder either — the retry that owns the session
			// is judged alone.
			if (outcome.startsWith("folded:")) clearFoldFailure(sessionId);
			else if (outcome === "summary-unavailable" || outcome.startsWith("commit-rejected:") || outcome === "ladder-consumed-missing") recordFoldFailure(sessionId);
			// Outcome lands in the decision log too: warn() has no reachable
			// sink on some hosts, and the commit/fail boundary is exactly what
			// live diagnosis needs.
			decisionLog(`session=${sessionId} outcome=${outcome} tier=${decision.tier ?? "-"}`);
			warn(`[context-trim] ${sessionId}: ${outcome} (${decision.reason})`);
		} catch (error) {
			// A dispose mid-cycle throws through here too (ctx/service teardown) —
			// that is a reload cut, not a model failure: log it and skip the ladder.
			if (disposedSince(cycleStartedAt)) decisionLog(`session=${sessionId} outcome=reload-aborted tier=${decision?.tier ?? "-"}`);
			else {
				errorLog("fold-cycle", error);
				recordFoldFailure(sessionId); // a thrown cycle counts as failed too
				warn(`[context-trim] fold cycle failed: ${error?.message ?? error}`);
			}
		} finally {
			clearTimeout(cycleWatchdog);
			// Only the cycle owning the CURRENT token may release the lock —
			// a watchdog-superseded wedged cycle must not delete a retry's entry.
			if (inFlight.get(sessionId) === cycleToken) inFlight.delete(sessionId);
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
				// Meter projection sample: host meter's projected NEXT-prompt size
				// (the context panel's figure) for the view-applied proj=<n> column.
				noteTrimProjectedTokens(sessionId, payload?.agent, ctx);
				// Fold first, then the surface-replace idle sweep (design
				// docs/surface-fold.md): a block committed by this idle pass
				// ships on the same boundary.
				void maybeFold(sessionId).finally(() => {
					try {
						void surfacePass.sweep(sessionId, "idle");
					} catch {
						/* sweep must never break the idle hook */
					}
						}).catch((error) => {
							// Parity with the stream path: maybeFold is catch-total by design,
							// but a dispose-cut throw or a future regression must not become
							// an unhandled rejection on the void'd chain.
							errorLog("fold-idle", error);
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
			// Register-level shape: bare ctx.tools.register runs no defineTool DSL
			// compilation and REJECTS a definition without an output block — the
			// missing block silently killed both tools in every session (native
			// and PTC). The execute bodies return plain strings, rendered as one
			// text block.
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute() {
				const sessionId = sessionIdOf({});
				if (sessionId === null) return "No session context available.";
				if (!enabledNow()) return "Context trimming is disabled for this deployment.";
				const ledger = store.ledgerOf(sessionId);
				const capture = captures.get(sessionId);
				const { protectedTail, protectTaskIntent } = thresholdsNow();
				const lines = [`ctx_trim_status — mode: ${modeNow()} (enabled: ${enabledNow()})`];
				lines.push(...renderStatusLedger(ledger));
				// The raw range a fold would cover next, with its true size.
				if (capture !== undefined) {
					const foldable = computeFoldableRange(capture.messages, ledger, protectedTail, { protectTaskIntent });
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
			// Register-level output block — see ctx_trim_status above.
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute(args) {
				const sessionId = sessionIdOf({});
				if (sessionId === null) return "No session context available.";
				if (!enabledNow() || modeNow() === "off") return "Context trimming is disabled for this deployment.";
				const capture = captures.get(sessionId);
				if (capture === undefined) return "No captured history yet — fold is unavailable until the next model call.";
				const positions = refPositions(capture.messages);
				// Ref normalization ([2026-11-15]-[m-prefix fold refs]): ctx_trim_status
				// displays anchors in the protocol's [m...] form — "m" prepended to
				// refOf's raw id/hash — and its description tells the model to pass
				// exactly that form. The lookup map is keyed by the RAW ref, so an
				// m-prefixed argument (the only form the model can copy) never matched:
				// every model-driven fold failed with "Refs not found" (found live in
				// the PTC runtime — status listed a 234-message range and the fold
				// rejected it four times in a row). Resolve both forms: try the
				// argument as given, then with one leading "m" stripped.
				const resolveKey = (raw) => {
					const given = String(raw ?? "");
					if (positions.has(given)) return given;
					if (given.startsWith("m") && positions.has(given.slice(1))) return given.slice(1);
					return given;
				};
				const resolveRef = (raw) => positions.get(resolveKey(raw));

				const firstList = resolveRef(args?.firstId);
				const lastList = resolveRef(args?.lastId);

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
				// Prior fold summaries are never raw-fold material: a T1 fold
				// covering an acp_summary_* node would shadow the replacement
				// node and break the ladder's consumed-run bookkeeping.
				// Summaries consolidate only through ladder T2/T3 distillation.
				for (let i = firstIdx; i <= lastIdx; i++) {
					if (isFoldSummaryMessage(capture.messages[i])) {
						return "Range covers a previous fold's summary (acp_summary_*) — summaries are preserved and consolidate via T2/T3 ladder; pick a range that excludes them.";
					}
				}
				const { protectedTail } = thresholdsNow();
				if (lastIdx >= capture.messages.length - Math.max(0, protectedTail)) return `Range reaches into the protected tail (last ${protectedTail} messages are never folded).`;
				if (!rangeIsSegmentAligned(capture.messages, firstIdx, lastIdx)) return "Range splits a tool-call pair — fold whole assistant/tool segments (extend firstId/lastId to the segment boundaries).";
				const count = wanted !== null ? wanted : lastIdx - firstIdx + 1;
				const result = store.commitFold(
					sessionId,
					{
						// Resolved refs: strip the display "m" prefix so commitFold's raw-key
						// posMap lookup matches (same normalization as resolveRef above).
						refRange: {
							firstId: resolveKey(args.firstId),
							lastId: resolveKey(args.lastId),
						},
						count,
						approxTokens: estimateTokensOf(capture.messages, firstIdx, lastIdx),
						summary: String(args.summary ?? ""),
						kind: "summary",
						tier: 1,
					},
					positions,
				);
				if (!result.ok) return `Fold rejected: ${result.reason}.`;
				// Auditable commit ([2026-11-15]-[tool-fold observability]): the only
				// prior trace was the fold-commit SURFACE sweep; a sweep that failed
				// or stayed pending left the commit itself invisible in the log.
				decisionLog(`session=${sessionId} via=tool action=fold tier=advisory block=${result.block.id} msgs=${count} tokens=~${result.block.approxTokens}`);

				surfacePass.captureFoldSeqs(sessionId, result.block);
				// Growth-gate baseline pair: pre-fold view (banner display) plus the
				// post-fold low (tier-a anchor — keeps the gate armed after folds
				// that commit at high view points).
				const lowLedger = store.ledgerOf(sessionId);
				const lowView = estimateTokensOf(buildView(capture.messages, lowLedger, { protectedTail: thresholdsNow().protectedTail }).messages);
				store.recordFoldBaseline(sessionId, capture.viewTokens, lowView);
				// Ship the fresh block onto the session surface NOW instead of waiting for
				// the next idle/turn-stopping boundary: a fold committed mid-turn used to
				// stay meter-only for the rest of the turn (2026-11-14 live test: two
				// tool-path folds left the wire carrying raw history for ~11 min at 97%
				// pressure — injected=none on frozen dispatches, both blocks pending).
				// The sweep's own guards (enabled flag, capable session, compaction lock,
				// per-block validation) fail closed to pending; the boundary sweeps
				// remain the closure pass.
				void surfacePass.sweep(sessionId, "fold-commit").catch((error) => {
					decisionLog(`session=${sessionId} surface-replace failed via=fold-commit why=${error?.message ?? error}`);
				});
				return `Folded ${count} messages into block ${result.block.id}. An immediate surface ship was queued (via=fold-commit): when it lands, even frozen dispatches carry the reduced history; if the surface cannot accept it right now the block stays pending and the boundary sweeps retry.`;
			},
		});
	} catch (error) {
		warn(`[context-trim] ctx_trim_fold tool failed: ${error?.message ?? error}`);
	}

	// ---- llm/stream listener (mounted when the llm fiber exists) ---------------

	function streamListener(options, next) {
		let viewTokens = null;
		let mainDispatch = false;
		try {
			if (enabledNow()) {
				const applied = applyViewToOptions(options);
				if (applied !== null) {
					viewTokens = applied.viewTokens;
					mainDispatch = applied.sideDispatch !== true;
					if (mainDispatch) {
						// Advisory pressure nudge (modeNow gates inside): the model's
						// own fold is advisory mode's primary relief channel, plus the
						// cooldown-gated critical relief fold below — speak at the fold
						// line. Fail-open, never breaks the dispatch.
						try {
							deliverAdvisoryNudge(applied.sessionId, applied.viewTokens);
						} catch (error) {
							decisionLog(`advisory-nudge-failed why=${error?.message ?? error}`);
							errorLog("advisory-nudge", error);
						}
					}
				}
			}
		} catch (error) {
			decisionLog(`view-build-failed why=${error?.message ?? error}`);
			warn(`[context-trim] view build failed: ${error?.message ?? error}`);
			errorLog("view-build", error);
		}
		const result = next();
		let wrappedSession = null;
		try {
			if (!enabledNow()) return result;
			wrappedSession = sessionIdOf(options);
			if (wrappedSession === null) return result;
			return wrapStreamForMetrics(result, (chunk) => {
				const usage = extractUsage(chunk);
				if (usage !== null) {
					metrics.recordUsage(wrappedSession, usage);
					if (mainDispatch) noteTrimWireTokens(wrappedSession, usage);
					// Second proj sample point ([2026-11-15]-[proj sampling gaps]):
					// the agent/status idle boundary alone left proj=null on most rows —
					// long-running turns never go idle mid-flight, so the view-applied
					// column went dark exactly when the divergence data mattered. At
					// response end the agent handle is resolvable via
					// ctx.agents.get(sessionId) (the same service subagents.js reads);
					// unreachable => the sample silently skips, as designed.
					try {
						noteTrimProjectedTokens(wrappedSession, ctx.agents?.get?.(wrappedSession), ctx);
					} catch {
						/* observability must never break the stream */
					}
				}
			});
		} catch (error) {
			warn(`[context-trim] stream wrap failed: ${error?.message ?? error}`);
			decisionLog(`stream-wrap-failed why=${error?.message ?? error}`);
			errorLog("stream-wrap", error);
			return result;
		} finally {
			// Fallback fold check on the stream path: the agent/status idle event
			// may not reach a globally-registered listener on every host topology,
			// so each stream end also runs a throttled (60 s/session) check. The
			// trigger's own cadence gates still guard over-folding. After the fold
			// check, chain a surface sweep: fold blocks commit mid-run even for
			// sessions whose dispatches are host-frozen (subagent children see
			// exactly ONE idle — at task end — so without this their wire ships
			// raw history until they finish; the sweep is the only relief channel
			// that reaches frozen dispatches). Same 60 s cadence, fail-open.
			try {
				if (enabledNow() && modeNow() === "auto" && wrappedSession !== null) {
					const nowMs = Date.now();
					if (nowMs - (lastStreamCheckAt.get(wrappedSession) ?? 0) >= 60_000) {
						lastStreamCheckAt.set(wrappedSession, nowMs);
						if (lastStreamCheckAt.size > 200) lastStreamCheckAt.delete(lastStreamCheckAt.keys().next().value);
						void maybeFold(wrappedSession, "stream").finally(() => {
							try {
								void surfacePass.sweep(wrappedSession, "stream");
							} catch (error) {
								errorLog("surface-sweep-stream", error);
							}
						}).catch((error) => {
							// maybeFold never rejects by design (its own catch is total), but a
							// dispose-cut throw or a future regression must not become an
							// unhandled rejection: the .finally here chains the sweep, so the
							// void'd chain needs its own terminal handler (parity with the
							// fold-commit sweep's .catch below).
							errorLog("fold-stream", error);
						});
					}
				}
			} catch (error) {
				/* fallback must never break the stream */
				errorLog("stream-fallback", error);
			}
		}
	}

	try {
		ctx.inject(["llm"], (llmCtx) => {
			const disposeListenerOf = new Map(); // "llm/stream" -> the on() disposer of the current attach
			const attach = () => {
				try {
					// Global + prepend: the cordis dispatch filter silently drops NON-global
					// llm/stream listeners when the dispatching llm runtime lives outside
					// this fiber's isolate (resumed sessions dispatch through their own
					// subtree) — that silenced the whole stream path for a resumed session
					// while fresh sessions kept logging. Stock consumers (dsh-session-title)
					// register exactly this way.
					// [2026-11-15]-[llm-attach diagnostics proxy trap]: reading llmCtx.off
					// through the context proxy THROWS on the cordis build the harness
					// ships (the events mixin exposes on/once/emit/… but NOT off —
					// vendor/cordis/src/reflect.ts get-trap: `cannot get property "off"
					// without inject`). `?.` cannot defend against a throwing getter, so
					// the old SUCCESS row itself raised, landed as llm-attach-failed, and
					// the true success line vanished (2026-11-15 06:29Z). on()'s returned
					// disposer is the unsubscribe API; off never existed here.
					const disposeListener = llmCtx.on?.("llm/stream", streamListener, { global: true, prepend: true });
					disposeListenerOf.set("llm/stream", disposeListener);
					let hasOff = false;
					try { hasOff = typeof llmCtx.off === "function"; } catch { hasOff = false; }
					decisionLog(`llm-attached hasOn=${typeof llmCtx.on} hasOff=${hasOff} hasDisposer=${typeof disposeListener} hasEffect=${typeof llmCtx.effect} pid=${process.pid}`);
				} catch (error) {
					warn(`[context-trim] llm/stream attach failed: ${error?.message ?? error}`);
					decisionLog(`llm-attach-failed why=${error?.message ?? error}`);
					errorLog("llm-attach", error);
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
							// The on() disposer is the only real unsubscribe: ctx.off is not
							// exposed by this cordis build (see the attach comment above) — the
							// old llmCtx.off?.() call threw on EVERY reload teardown and the
							// cleanup silently never ran (fiber-unload auto-dispose was the
							// only thing that actually removed the listener).
							const dispose = disposeListenerOf.get("llm/stream");
							disposeListenerOf.delete("llm/stream");
							if (typeof dispose === "function") dispose();
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

	return { store, metrics, captures, inFlight, windowCache, advisoryNudgeBySession, maybeFold, maybeInherit, applyViewToOptions, surfacePass };
}
