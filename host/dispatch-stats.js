// Dispatch-result observability keyed by pool×model×skill (refactor guide
// §4.5 pool statistics + §4.3 amortization/confidence inputs, P2 pack B0).
// Records per dispatch: outcome (success/failure), latency, and a rework
// signal. Read-only data layer: counters go to the host logger and the
// exported getters ONLY — never into any model-injection surface
// (MODEL-VISIBILITY). Pack B (differentiation) will consume the getters.
//
// Event surface (verified against DSH 0.2.2-rc.5 sources, the installed
// version):
// - Parent `session/event` `tool/call` with name "subagent"/"subagent_fork":
//   data.arguments (raw JSON string) carries the dispatch target `name`,
//   optional explicit `provider`/`model` route, and the parent `turn`.
// - Host lifecycle `subagent/start` (info = {runId, provider, parentSessionId,
//   id, local}) and `subagent/end` (adds stopReason
//   completed|aborted|error|max-tokens|refusal and optional
//   lastAssistantMessage). Plain plugin-level `ctx.on` receives them
//   (precedent: hooks-claude-code, sdk/server). Payloads carry NO timestamps,
//   so latency is the Date.now() delta between the two listener edges (wall
//   time of one residency epoch).
// - Child session `session/event` `request/header`:
//   data.header.config.{provider,model} is the ACTUAL resolved model route.
// - Child session `session/event` `tool/call` with name "skill":
//   data.arguments.name is a skill the child actually loaded.
//
// Dimension availability (honest accounting, nothing invented):
// - model: reliable — the child's request/header route; "unknown" if the run
//   ended before any request was logged.
// - pool: NOT directly observable (DSH has no lane concept; lanes are this
//   plugin's doctrine). Best-effort: match the dispatch's explicit route if
//   the arguments carried one, else the child's actual route, against the
//   configured lane pools (first matching lane in LANES order wins; a route
//   listed in several lanes is attributed to the first). No match →
//   "unattributed"; no route at all → "unknown".
// - skill: only what the child explicitly loaded via the skill tool. The
//   FIRST skill load in the run wins (multi-skill runs are not tracked
//   separately — documented simplification); zero loads → "none".
// - rework: same target name re-dispatched to the SAME pool within k parent
//   turns (k=5; when either turn number is missing, a 10-minute wall-clock
//   window is used instead). Counted on the REPEATED dispatch's record (the
//   share of a key's dispatches that were repeats). Runs without a linked
//   parent tool/call (e.g. non-tool spawns) carry no target and never enter
//   the rework window.
// - empty results: stopReason "completed" with no lastAssistantMessage is
//   counted in `emptyResults` but NOT in `failures`: continuable children
//   legitimately omit closing text after a final send_message, so folding it
//   into failures would mislabel healthy settlements. Pack B may weigh it.
// - workflow()-tool internal agents DO reach this seam: they go through
//   startActivation → the same subagent/start+end lifecycle pair, so they are
//   counted. Known limitation: when a parent session runs concurrent
//   dispatches, the per-parent FIFO can misattribute (a workflow run may
//   consume the slot of a real subagent dispatch), so target/rework
//   attribution stays best-effort.
// - prompts (free text — no reliable skill/target
//   extraction beyond the signals above).

import { sessionIdOf } from "./context-watch.js";

/** Distinct pool×model×skill records kept (insertion-order eviction, same
 *  discipline as SKILL_LOAD_CAP). */
export const DISPATCH_KEY_CAP = 256;
/** In-flight runs tracked between the start/end lifecycle edges. */
export const PENDING_RUNS_CAP = 256;
/** Unconsumed parent tool/call dispatches kept per parent session (FIFO). */
export const PARENT_PENDING_CAP = 16;
/** Parent sessions kept in the pending-dispatch / rework-window maps. */
export const PARENTS_CAP = 128;
/** Recent-target entries kept per parent for the rework window. */
export const RECENT_TARGETS_CAP = 32;
/** Per-session facts (model route / first skill load) kept across ALL
 *  sessions — child facts are only ever READ for tracked child ids, but the
 *  child's header may land before its start event, so capture is ungated.
 *  Capped and cleared on session disposal. */
export const SESSION_FACTS_CAP = 512;
/** Rework: repeats within this many parent turns of the same target+pool. */
export const REWORK_TURN_WINDOW = 5;
/** Rework fallback window when turn numbers are unavailable. */
export const REWORK_FALLBACK_MS = 10 * 60 * 1000;

/** Lane order and their config field names (mirrors host/config.js pools). */
const LANES = [
	["economy", "poolEconomy"],
	["mechanical", "poolMechanical"],
	["main", "poolMain"],
	["hard", "poolHard"],
	["vision", "poolVision"],
	["review", "poolReview"],
];

const statsByKey = new Map();
const pendingRunsByRunId = new Map();
const pendingDispatchesByParent = new Map();
const recentTargetsByParent = new Map();
const modelBySession = new Map();
const skillBySession = new Map();

/** Live-read the configured lane pools; tolerate plain arrays (tests) as
 *  well as volatile config refs. Returns [[laneName, routesArray], ...]. */
function lanePools(config) {
	const out = [];
	for (const [lane, field] of LANES) {
		const raw = config?.[field];
		const routes = typeof raw?.get === "function" ? raw.get() : raw;
		if (Array.isArray(routes)) out.push([lane, routes]);
	}
	return out;
}

/** First lane (LANES order) whose pool list contains this exact route, or
 *  null. Pure helper, exported for tests. */
export function laneOfRoute(route, config) {
	if (!route || typeof route.provider !== "string" || typeof route.model !== "string") return null;
	for (const [lane, routes] of lanePools(config)) {
		for (const entry of routes) {
			if (entry?.provider === route.provider && entry?.model === route.model) return lane;
		}
	}
	return null;
}

/** Parse a tool-call `arguments` JSON string defensively; returns {} on any
 *  failure or non-object payload (arrays included — arguments are objects).
 *  Pure helper, exported for tests. */
export function parseToolArguments(raw) {
	try {
		if (typeof raw !== "string" || raw === "" || raw.length > 65536) return {};
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Composite record key; "\0" separators never appear in ids/names. */
function keyOf(pool, model, skill) {
	return `${pool}\0${model}\0${skill}`;
}

/** Mutable record shape (JSON-clean). */
const emptyRecord = () => ({
	pool: "",
	model: "",
	skill: "",
	dispatches: 0,
	successes: 0,
	failures: 0,
	emptyResults: 0,
	rework: 0,
	latencySumMs: 0,
	latencyMaxMs: 0,
	lastAt: 0,
});

/** Fold one settled run into the stats map. Bounded writes, insertion-order
 *  eviction. Pure-ish core, exported for tests. */
export function recordSettledRun(map, obs) {
	const key = keyOf(obs.pool, obs.model, obs.skill);
	let record = map.get(key);
	if (record === undefined) {
		record = emptyRecord();
		record.pool = obs.pool;
		record.model = obs.model;
		record.skill = obs.skill;
		map.set(key, record);
	}
	record.dispatches += 1;
	if (obs.success === true) record.successes += 1;
	else if (obs.success === false) record.failures += 1;
	if (obs.empty === true) record.emptyResults += 1;
	if (obs.rework === true) record.rework += 1;
	const latency = Number(obs.latencyMs);
	if (Number.isFinite(latency) && latency >= 0) {
		record.latencySumMs += Math.round(latency);
		if (Math.round(latency) > record.latencyMaxMs) record.latencyMaxMs = Math.round(latency);
	}
	record.lastAt = Number.isFinite(obs.at) ? obs.at : Date.now();
	while (map.size > DISPATCH_KEY_CAP) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	return record;
}

/** Rework check + window update for one dispatched run: true when the same
 *  target was already dispatched to the same pool within the turn window
 *  (time-window fallback). Exported for tests. */
export function observeRework(windowMap, parentId, target, turn, pool, at) {
	if (typeof target !== "string" || target === "") return false;
	const now = Number.isFinite(at) ? at : Date.now();
	const window = windowMap.get(parentId);
	let rework = false;
	if (Array.isArray(window)) {
		for (let i = window.length - 1; i >= 0; i -= 1) {
			const entry = window[i];
			if (entry.target !== target || entry.pool !== pool) continue;
			const bothTurns = Number.isFinite(turn) && Number.isFinite(entry.turn);
			const within = bothTurns
				? turn - entry.turn <= REWORK_TURN_WINDOW
				: now - entry.at <= REWORK_FALLBACK_MS;
			if (within && (!bothTurns || turn >= entry.turn)) {
				rework = true;
				break;
			}
		}
	}
	const next = Array.isArray(window) ? window : [];
	next.push({ target, turn: Number.isFinite(turn) ? turn : null, pool, at: now });
	while (next.length > RECENT_TARGETS_CAP) next.shift();
	windowMap.set(parentId, next);
	while (windowMap.size > PARENTS_CAP) {
		const oldest = windowMap.keys().next().value;
		if (oldest === undefined) break;
		windowMap.delete(oldest);
	}
	return rework;
}

/** Bounded snapshot, busiest first (dispatches desc, then pool/model/skill
 *  asc for byte-stable output). Plain JSON for pack-B consumers — keep the
 *  shape stable. */
export function getDispatchStats() {
	try {
		const entries = [...statsByKey.entries()].map(([, record]) => ({ ...record }));
		entries.sort(
			(a, b) =>
				b.dispatches - a.dispatches ||
				(a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0) ||
				(a.model < b.model ? -1 : a.model > b.model ? 1 : 0) ||
				(a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0),
		);
		return { cap: DISPATCH_KEY_CAP, entries };
	} catch {
		return { cap: DISPATCH_KEY_CAP, entries: [] };
	}
}

/** Clear all captured state (tests and future admin surfaces). */
export function resetDispatchStats() {
	try {
		statsByKey.clear();
		pendingRunsByRunId.clear();
		pendingDispatchesByParent.clear();
		recentTargetsByParent.clear();
		modelBySession.clear();
		skillBySession.clear();
	} catch {
		/* fail open */
	}
}

/** Settle one start/end pair into a record. Internal; separated from the
 *  listener so the wiring stays thin. */
function settleRun(info, log) {
	const pending = pendingRunsByRunId.get(info.runId);
	if (pending === undefined) return; // end without a tracked start: skip
	pendingRunsByRunId.delete(info.runId);
	const startAt = pending.startAt;
	const latencyMs = Number.isFinite(startAt) ? Math.max(0, Date.now() - startAt) : NaN;
	const success = info.stopReason === "completed";
	const empty = success === true && !Array.isArray(info.lastAssistantMessage);
	// Model: the child's actual resolved route (request/header), else unknown.
	const route = modelBySession.get(pending.childId) ?? null;
	modelBySession.delete(pending.childId);
	const skill = skillBySession.get(pending.childId) ?? "none";
	skillBySession.delete(pending.childId);
	// Pool: explicit dispatch route wins, then the actual route; first
	// matching lane wins, misses bucket to "unattributed"/"unknown".
	const dispatch = pending.dispatch;
	const explicitRoute =
		typeof dispatch?.provider === "string" && dispatch.provider !== "" && typeof dispatch?.model === "string" && dispatch.model !== ""
			? { provider: dispatch.provider, model: dispatch.model }
			: null;
	const lane = laneOfRoute(explicitRoute ?? route, configRef) ?? (explicitRoute !== null || route !== null ? "unattributed" : "unknown");
	const rework = observeRework(
		recentTargetsByParent,
		pending.parentId,
		typeof dispatch?.target === "string" ? dispatch.target : "",
		Number.isFinite(dispatch?.turn) ? dispatch.turn : NaN,
		lane,
		Date.now(),
	);
	recordSettledRun(statsByKey, {
		pool: lane,
		model: route === null ? "unknown" : `${route.provider}/${route.model}`,
		skill,
		success,
		empty,
		rework,
		latencyMs,
		at: Date.now(),
	});
	log?.(
		`dispatch_stats: pool=${lane} model=${route === null ? "unknown" : `${route.provider}/${route.model}`} skill=${skill} ` +
			`stop=${info.stopReason ?? "unknown"} latencyMs=${Number.isFinite(latencyMs) ? Math.round(latencyMs) : "?"} rework=${rework ? 1 : 0}`,
	);
}

/** Module-level config reference captured at apply() so settleRun can read
 *  the live lane pools without threading it through every helper. */
let configRef = null;

/** Wire the dispatch observability listeners. Convention follows
 *  constraints.js: listeners registered once, master switch early-returns
 *  BEFORE any capture (OFF = zero reads, zero writes, zero pending state —
 *  review F1), every callback body inside fail-open try/catch. */
export function applyDispatchStats(ctx, config) {
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	configRef = config ?? null;
	try {
		ctx.on("session/event", (session, event) => {
			try {
				if (config?.dispatchStatsEnabled?.get() !== true) return;
				const key = sessionIdOf(session);
				if (key === null || event === null || typeof event !== "object") return;
				if (event.type === "request/header") {
					const header = event.data?.header?.config;
					if (typeof header?.provider === "string" && typeof header?.model === "string" && header.provider !== "" && header.model !== "") {
						modelBySession.set(key, { provider: header.provider, model: header.model });
						while (modelBySession.size > SESSION_FACTS_CAP) {
							const oldest = modelBySession.keys().next().value;
							if (oldest === undefined) break;
							modelBySession.delete(oldest);
						}
					}
					return;
				}
				if (event.type !== "tool/call") return;
				const name = event.data?.name;
				if (name === "skill") {
					const args = parseToolArguments(event.data?.arguments);
					const skill = typeof args.name === "string" && args.name !== "" ? args.name : null;
					// First load wins; later loads never overwrite.
					if (skill !== null && !skillBySession.has(key)) {
						skillBySession.set(key, skill);
						while (skillBySession.size > SESSION_FACTS_CAP) {
							const oldest = skillBySession.keys().next().value;
							if (oldest === undefined) break;
							skillBySession.delete(oldest);
						}
					}
					return;
				}
				if (name !== "subagent" && name !== "subagent_fork") return;
				const args = parseToolArguments(event.data?.arguments);
				const pending = pendingDispatchesByParent.get(key) ?? [];
				pending.push({
					target: typeof args.name === "string" && args.name !== "" ? args.name : typeof args.description === "string" && args.description !== "" ? args.description.slice(0, 120) : "",
					provider: typeof args.provider === "string" ? args.provider : null,
					model: typeof args.model === "string" ? args.model : null,
					turn: Number.isFinite(event.data?.turn) ? event.data.turn : null,
				});
				while (pending.length > PARENT_PENDING_CAP) pending.shift();
				pendingDispatchesByParent.set(key, pending);
				while (pendingDispatchesByParent.size > PARENTS_CAP) {
					const oldest = pendingDispatchesByParent.keys().next().value;
					if (oldest === undefined) break;
					pendingDispatchesByParent.delete(oldest);
				}
			} catch {
				/* fail open */
			}
		});
		ctx.on("session/disposed", (session) => {
			try {
				const key = sessionIdOf(session);
				if (key === null) return;
				modelBySession.delete(key);
				skillBySession.delete(key);
			} catch {
				/* fail open */
			}
		});
		// Lifecycle edges: single-argument callbacks (info object), per-listener
		// containment is provided by the emitter itself; we still guard.
		ctx.on("subagent/start", (info) => {
			try {
				if (config?.dispatchStatsEnabled?.get() !== true) return;
				if (info === null || typeof info !== "object" || typeof info.runId !== "string") return;
				// FIFO-link the parent's oldest unconsumed tool/call dispatch.
				const dispatchQueue = pendingDispatchesByParent.get(info.parentSessionId);
				const dispatch = Array.isArray(dispatchQueue) && dispatchQueue.length > 0 ? dispatchQueue.shift() : null;
				if (Array.isArray(dispatchQueue) && dispatchQueue.length === 0) pendingDispatchesByParent.delete(info.parentSessionId);
				pendingRunsByRunId.set(info.runId, {
					runId: info.runId,
					parentId: typeof info.parentSessionId === "string" ? info.parentSessionId : "",
					childId: typeof info.id === "string" ? info.id : "",
					dispatch,
					startAt: Date.now(),
				});
				while (pendingRunsByRunId.size > PENDING_RUNS_CAP) {
					const oldest = pendingRunsByRunId.keys().next().value;
					if (oldest === undefined) break;
					pendingRunsByRunId.delete(oldest);
				}
			} catch {
				/* fail open */
			}
		});
		ctx.on("subagent/end", (info) => {
			try {
				if (config?.dispatchStatsEnabled?.get() !== true) return;
				if (info === null || typeof info !== "object" || typeof info.runId !== "string") return;
				settleRun(info, ctx.logger?.info?.bind(ctx.logger));
			} catch {
				/* fail open */
			}
		});
	} catch (error) {
		warn(`dispatch stats event wiring failed: ${error?.message ?? error}`);
	}
}
