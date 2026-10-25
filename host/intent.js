/** dsh-switchman intent-routing layer: the "auto" pseudo-model.
 *
 * Adds a `dsh-switchman-auto/auto` entry to the native model catalog (via
 * `ctx.llm.registerAdapter`) so the composer dropdown offers an "Auto" route,
 * and routes that pseudo route onto a real model per request: the adapter's
 * own stream is THE routing point — it classifies the recent conversation
 * against the configured candidate list with a small classifier model,
 * advances the per-session state machine, and forwards to the decided route.
 * (The host's agent/request waterfall cannot do this: it throws when a
 * listener proposes provider/model different from the selection fixed at
 * step preparation, and its result is structuredClone'd — spreading this
 * plugin's volatile config into the return value crashed requests with
 * "() => current could not be cloned".) The switch is silent (no
 * `[model changed]` notice, no cache-breaking session mutation); retries
 * re-dispatching the same options object pin to the decided route via a
 * WeakMap; a provider prompt-cache window keeps the current model while the
 * classifier's confidence stays below the switch threshold (design:
 * .dsh-switchman/plans/intent-routing.md — field names/protocol/state machine
 * are frozen there).
 *
 * Fail-open everywhere: a missing service, an unconfigured classifier, a
 * timeout/abort, or an unparseable verdict degrades to the fallback chain
 * (pinned → previous routed route → intentFallbackRoute → first candidate);
 * with nothing configured the pseudo model passes through and the adapter's
 * last-resort stream explains what to configure. All services are reached
 * through defensive `ctx.get` reads — a deployment without the `llm` service
 * leaves the layer a warn-once no-op (documented runtime precondition, same
 * as index.js's inject note for sessionQuery/pluginManager). The classifier's
 * own call is a session-title-llm-style auxiliary request (real provider ≠
 * AUTO_PROVIDER → cannot re-enter this adapter), with
 * a local AbortController+setTimeout deadline instead of the
 * @deepseek-ai/dsh-timeout dependency (this bundle adds no dependencies).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { effectiveIntentCandidates, mergeIntentCandidates } from "./intent-presets.js";
import { sessionModelSelectionOf } from "./subagent-model.js";

/** Pseudo provider id (must match client.js and the design contract). */
export const AUTO_PROVIDER = "dsh-switchman-auto";

/** Pseudo model id under AUTO_PROVIDER. */
export const AUTO_MODEL = "auto";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Volatile settings readers (mirror host/dispatch.js's guards — these files
// stay independently mountable).
// ---------------------------------------------------------------------------

/** Read one volatile settings field as a plain string. */
function readField(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = field.get();
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}
	return typeof field === "string" ? field : "";
}

/** Boolean volatile-field read (false on any malformed value). */
function readBool(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get() === true;
		} catch {
			return false;
		}
	}
	return field === true;
}

/** Numeric volatile-field read (fallback on any malformed value). */
function readNumber(field, fallback) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = Number(field.get());
			return Number.isFinite(value) ? value : fallback;
		} catch {
			return fallback;
		}
	}
	const value = Number(field);
	return Number.isFinite(value) ? value : fallback;
}

/** Array volatile-field read (non-arrays degrade to []). */
function readList(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = field.get();
			return Array.isArray(value) ? value : [];
		} catch {
			return [];
		}
	}
	return Array.isArray(field) ? field : [];
}

/** One validated intent route reference ({provider, model} both non-empty
 *  after trim, plus optional non-empty effort), or null when unset. */
function readRoute(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return routeOf(field.get());
		} catch {
			return null;
		}
	}
	return routeOf(field);
}

/** Validate one raw route-like value; null unless provider+model are
 *  non-empty strings. A non-empty effort rides along as a pin. */
function routeOf(value) {
	if (value === null || typeof value !== "object") return null;
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	const model = typeof value.model === "string" ? value.model.trim() : "";
	if (provider === "" || model === "") return null;
	// Never route TO the pseudo provider itself: the rewrite would hand the
	// pseudo model back to the loop and the adapter fallback would re-enter
	// itself forever (review finding, 2026-10-24).
	if (provider === AUTO_PROVIDER) return null;
	const route = { provider, model };
	if (typeof value.effort === "string" && value.effort.trim() !== "") route.effort = value.effort.trim();
	return route;
}

/** Validated intent-candidate list: routes plus their optional effort/note. */
export function readCandidates(field) {
	// Unified list = stored rows merged with the built-in presets; only
	// enabled rows with a complete route reach the classifier, so a preset
	// still waiting for its model (or a freshly added custom row) never
	// dilutes the prompt.
	const candidates = [];
	const seenRoutes = new Set();
	for (const entry of effectiveIntentCandidates(mergeIntentCandidates(readList(field)))) {
		if (entry.provider === AUTO_PROVIDER) continue; // self-reference guard, mirrors routeOf
		// Same provider/model twice (a configured preset next to a legacy
		// row with that route) would list one route twice with different
		// notes; presets sort first, so the preset's note wins.
		const routeKey = `${entry.provider}/${entry.model}`;
		if (seenRoutes.has(routeKey)) continue;
		seenRoutes.add(routeKey);
		const candidate = { provider: entry.provider, model: entry.model };
		if (typeof entry.effort === "string" && entry.effort.trim() !== "") candidate.effort = entry.effort.trim();
		if (typeof entry.note === "string" && entry.note.trim() !== "") candidate.note = entry.note.trim();
		candidates.push(candidate);
	}
	return candidates;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/** Stable identity of one provider/model route (effort is a pin, not part
 *  of the model identity). */
function routeKeyOf(route) {
	return `${route?.provider ?? ""}\u0000${route?.model ?? ""}`;
}

/** Copy one route with its effort pin kept only when a non-empty string. */
function withEffort(route) {
	if (route === null || typeof route !== "object") return null;
	const copy = { provider: route.provider, model: route.model };
	if (typeof route.effort === "string" && route.effort !== "") copy.effort = route.effort;
	return copy;
}

/** First JSON number found in a number-or-numeric-string value. */
function numberOr(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return Number(value.trim());
	return null;
}

/** Validate one parsed verdict object against the candidate count: an
 *  in-range integer `best` (0-based) with a clamped 0-100 confidence
 *  (missing confidence = decisive pick, 100); null otherwise. */
function verdictFromValue(value, candidateCount) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const best = numberOr(value.best);
	if (best === null || !Number.isInteger(best) || best < 0 || best >= candidateCount) return null;
	const confidence = numberOr(value.confidence);
	return {
		best,
		confidence: confidence === null ? 100 : Math.min(100, Math.max(0, Math.round(confidence))),
	};
}

/** First balanced `{...}` segment of a text (string/escape aware), or null. */
function firstBalancedObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Tolerant classifier-verdict parser (design §3 chain, exported for tests):
 * ① direct JSON.parse → ② first balanced {...} segment → ③ JSON inside a
 * markdown code fence → ④ first bare-integer line (confidence = 100).
 * @param {string} text - raw classifier output.
 * @param {number} candidateCount - number of candidates (best is 0-based).
 * @returns {{best: number, confidence: number} | null} null when nothing
 *          parseable yields an in-range best (callers fail open).
 */
export function parseClassifierVerdict(text, candidateCount) {
	if (typeof text !== "string" || !Number.isInteger(candidateCount) || candidateCount < 1) return null;
	try {
		const direct = verdictFromValue(JSON.parse(text), candidateCount);
		if (direct !== null) return direct;
	} catch {
		/* not bare JSON — keep the chain */
	}
	const segment = firstBalancedObject(text);
	if (segment !== null) {
		try {
			const inner = verdictFromValue(JSON.parse(segment), candidateCount);
			if (inner !== null) return inner;
		} catch {
			/* malformed segment — keep the chain */
		}
	}
	const fence = /```[a-zA-Z]*\r?\n?([\s\S]*?)```/.exec(text);
	if (fence !== null) {
		const body = fence[1].trim();
		try {
			const fenced = verdictFromValue(JSON.parse(body), candidateCount);
			if (fenced !== null) return fenced;
		} catch {
			/* fence without bare JSON — try a balanced segment inside it */
		}
		const innerSegment = firstBalancedObject(body);
		if (innerSegment !== null) {
			try {
				const inner = verdictFromValue(JSON.parse(innerSegment), candidateCount);
				if (inner !== null) return inner;
			} catch {
				/* keep the chain */
			}
		}
	}
	const line = /^[ \t]*(\d+)[ \t]*$/m.exec(text);
	if (line !== null) {
		const best = Number(line[1]);
		if (Number.isInteger(best) && best >= 0 && best < candidateCount) return { best, confidence: 100 };
	}
	return null;
}

/**
 * The routing decision state machine (design §4, exported for tests). Pure:
 * no clocks, no settings reads, no mutation.
 * @param {object} args
 * @param {Array<{provider: string, model: string, effort?: string}>} args.candidates
 * @param {{provider: string, model: string, effort?: string} | null} args.current
 *     previously routed route (cache-reuse anchor).
 * @param {{best: number, confidence: number} | null} args.parsed
 *     classifier verdict, or null (parse failure/timeout/disabled → chain).
 * @param {number} args.now - decision timestamp (ms).
 * @param {number} args.routedAt - when `current` was last applied (ms), or
 *     null when unknown (the task brief's signature omits it; §4's cache rule
 *     needs the previous-route timestamp, so it rides along here).
 * @param {number} args.cacheTtlSeconds - provider prompt-cache window.
 * @param {number} args.switchConfidence - threshold to leave the current model.
 * @param {{provider: string, model: string, effort?: string} | null} args.fallback
 * @returns {{route: {provider: string, model: string, effort?: string} | null,
 *     switched: boolean, reason: string}} route null = nothing routable (the
 *     pseudo model passes through; the adapter explains how to configure).
 */
export function decideRoute({ candidates, current, parsed, now, routedAt, cacheTtlSeconds, switchConfidence, fallback }) {
	const list = Array.isArray(candidates) ? candidates.filter((entry) => routeOf(entry) !== null) : [];
	const ttlMs = Math.max(0, Number(cacheTtlSeconds) || 0) * 1000;
	const threshold = Number.isFinite(Number(switchConfidence)) ? Number(switchConfidence) : 80;
	const chain = () => {
		if (routeOf(current) !== null) return { route: withEffort(current), switched: false, reason: "fallback-keep-current" };
		if (routeOf(fallback) !== null) return { route: withEffort(fallback), switched: false, reason: "fallback-configured" };
		if (list.length > 0) return { route: withEffort(list[0]), switched: true, reason: "fallback-first-candidate" };
		return { route: null, switched: false, reason: "unavailable" };
	};
	if (parsed === null || typeof parsed !== "object") return chain();
	const bestRoute = routeOf(list[parsed.best]) === null ? null : withEffort(list[parsed.best]);
	if (bestRoute === null) return chain(); // defensive: verdict outlived its candidate list
	const currentRoute = routeOf(current) === null ? null : withEffort(current);
	if (currentRoute !== null) {
		if (routeKeyOf(currentRoute) === routeKeyOf(bestRoute)) {
			return { route: currentRoute, switched: false, reason: "keep-best-is-current" };
		}
		const currentListed = list.some((entry) => routeKeyOf(entry) === routeKeyOf(currentRoute));
		if (!currentListed) return { route: bestRoute, switched: true, reason: "switch-current-not-candidate" };
		if (parsed.confidence >= threshold) return { route: bestRoute, switched: true, reason: "switch-confidence" };
		const withinWindow = Number.isFinite(Number(routedAt)) && Number(now) - Number(routedAt) < ttlMs;
		if (withinWindow) return { route: currentRoute, switched: false, reason: "keep-cache-window" };
		return { route: bestRoute, switched: true, reason: "switch-cache-expired" };
	}
	// No previously routed model (first decision): the best pick applies.
	return { route: bestRoute, switched: true, reason: "switch-first-decision" };
}

// ---------------------------------------------------------------------------
// Per-session decision state (host/handover-state.js pattern: module-level,
// process-lifetime, never persisted; cleaned on session/disposed).
// ---------------------------------------------------------------------------

/** sessionId -> { pinnedTurnKey, decision, routedCurrent, routedAt,
 *  lastDecision } (design §4). */
const sessionState = new Map();

function stateOf(sessionId) {
	let state = sessionState.get(sessionId);
	if (state === undefined) {
		state = { pinnedTurnKey: null, decision: null, routedCurrent: null, routedAt: null, lastDecision: null };
		sessionState.set(sessionId, state);
	}
	return state;
}

/** Drop one session's decision state (session/disposed + intent-reset route). */
export function clearSessionState(sessionId) {
	if (typeof sessionId === "string" && sessionId !== "") sessionState.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Classifier prompt + conversation excerpt.
// ---------------------------------------------------------------------------

/** System prompt for the chat-channel classifier (design §3: strict JSON;
 *  tolerant parsing still accepts legacy bare-integer replies). */
function classifierSystemPrompt() {
	return 'You route this conversation to one candidate model. Reply with STRICT JSON only: {"best": <candidate number>, "confidence": <0-100>}. No prose, no markdown fence.';
}

/** Candidate list lines: `#N provider/model — note`, the currently routed
 *  model annotated. */
function candidateLines(candidates, currentKey) {
	return candidates.map((candidate, index) => {
		const current = routeKeyOf(candidate) === currentKey ? " (current)" : "";
		const note = typeof candidate.note === "string" && candidate.note !== "" ? ` — ${candidate.note}` : "";
		return `#${index} ${candidate.provider}/${candidate.model}${current}${note}`;
	});
}

/** The user-turn text: candidates, the neutral tie-break hint, the recent
 *  conversation excerpt, and the strict-JSON question. */
function classifierInput(config, candidates, current, excerpt) {
	const currentKey = current === null ? "\u0000-none" : routeKeyOf(current);
	const question =
		'Which candidate number is best for the next reply? Reply with strict JSON {"best": <number>, "confidence": <0-100>}.';
	return [
		"Candidates:",
		...candidateLines(candidates, currentKey),
		"When no candidate has a clear advantage, prefer the current model.",
		"",
		"Recent conversation:",
		excerpt === "" ? "(no messages yet)" : excerpt,
		"",
		question,
	].join("\n");
}

/** Plain-text blocks of one message content array, joined by newlines. */
function textBlocksOf(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block !== null && typeof block === "object" && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

/**
 * Recent user/assistant conversation excerpt for the classifier (design §3;
 * extraction mirrors session-title's user/message eligibility: text blocks
 * joined with "\n"), newest-first with a total character budget.
 */
function sessionHistoryOf(ctx, sessionId, config) {
	if (sessionId === null) return "";
	const maxMessages = Math.max(1, Math.round(readNumber(config.intentHistoryMessages, 6)));
	const maxChars = Math.max(0, Math.round(readNumber(config.intentHistoryMaxChars, 2400)));
	try {
		const session = ctx.sessions?.get?.(sessionId);
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		if (!Array.isArray(events)) return "";
		const picked = [];
		let budget = maxChars;
		for (let i = events.length - 1; i >= 0 && picked.length < maxMessages && budget > 0; i--) {
			const event = events[i];
			const data = event?.data ?? null;
			const isUser = event?.type === "user/message" && data?.source?.kind === "user";
			const isAssistant = event?.type === "assistant/message";
			if (!isUser && !isAssistant) continue;
			const message = isUser ? data : data?.message;
			const text = textBlocksOf(message?.content).trim();
			if (text === "") continue;
			const prefix = isUser ? "User" : "Assistant";
			const room = budget - prefix.length - 2;
			if (room <= 0) break;
			const body = text.length > room ? `${text.slice(0, room)}…` : text;
			picked.unshift(`${prefix}: ${body}`);
			budget -= prefix.length + 2 + body.length;
		}
		return picked.join("\n");
	} catch {
		return ""; // unreadable history degrades to an empty excerpt, never throws
	}
}

// ---------------------------------------------------------------------------
// Classifier call (session-title-llm pattern; local deadline, no new deps).
// ---------------------------------------------------------------------------

/** One user message literal (createUserMessage shape: role/content/source/id). */
function userMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "dsh-switchman-intent" },
	};
}

/**
 * Run one classification request and return the raw output text. Throws on
 * timeout, abort, operational finish (error/aborted), or a missing llm
 * service — callers fail open. The classifier route is a real provider, so
 * the call cannot re-enter this adapter (real provider ≠ AUTO_PROVIDER).
 */
async function classifyOnce(ctx, config, route, system, input, turnSignal) {
	const llm = typeof ctx.get === "function" ? ctx.get("llm", false) : undefined;
	if (llm === undefined || llm === null || typeof llm.prepareCall !== "function" || typeof llm.stream !== "function") {
		throw new Error("llm service unavailable");
	}
	const deadlineMs = Math.max(200, Math.round(readNumber(config.intentTimeoutMs, 3000)));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deadlineMs);
	const signal = turnSignal instanceof AbortSignal ? AbortSignal.any([controller.signal, turnSignal]) : controller.signal;
	try {
		const effort = readField(config.intentClassifierEffort).trim();
		const call = await llm.prepareCall(
			{ provider: route.provider, model: route.model, maxTokens: 4096 },
			signal,
			(controls) => (effort === "" ? controls : { ...controls, reasoningEffort: effort }),
		);
		const options = {
			...call.config,
			messages: [userMessage(input)],
			system,
			signal,
		};
		let text = "";
		let finish = null;
		for await (const chunk of call.stream(options)) {
			signal.throwIfAborted();
			if (chunk === null || typeof chunk !== "object") continue;
			if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
			else if (chunk.type === "finish") finish = chunk.reason ?? null;
		}
		signal.throwIfAborted();
		if (finish !== null && typeof finish === "object" && (finish.kind === "error" || finish.kind === "aborted")) {
			throw new Error(finish.failure?.message ?? "classifier stream failed");
		}
		return text;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Classify via an ollama /v1/systemone decision endpoint (direct HTTP —
 * no llm-service provider registration needed; the model name comes from
 * intentClassifierSystemoneModel, the URL from intentClassifierEndpoint).
 * Contract: POST {model, state, questions:{best:{type:"choice",
 * instructions, criteria:{key: description}}}} → answers.best.{choice,
 * probabilities, confidence}. Returns a verdict {best, confidence} with
 * confidence scaled to 0-100 (top probability preferred over the model's
 * calibrated `confidence`). Throws on unset config, timeout/abort/HTTP/
 * parse errors — callers fail open. Exported for tests.
 */
export async function classifySystemone(ctx, config, candidates, current, excerpt, turnSignal) {
	const endpoint = readField(config.intentClassifierEndpoint).trim();
	if (endpoint === "") throw new Error("systemone endpoint unset (intentClassifierEndpoint)");
	const model = readField(config.intentClassifierSystemoneModel).trim();
	if (model === "") throw new Error("systemone model unset (intentClassifierSystemoneModel)");
	if (candidates.length === 0) throw new Error("no candidates");
	const currentKey = current === null ? "\u0000-none" : routeKeyOf(current);
	const keys = [];
	const criteria = {};
	for (const [index, candidate] of candidates.entries()) {
		const key = `#${index} ${candidate.provider}/${candidate.model}${routeKeyOf(candidate) === currentKey ? " (current)" : ""}`;
		keys.push(key);
		criteria[key] = typeof candidate.note === "string" && candidate.note !== "" ? candidate.note : "no specific note";
	}
	const state = [
		"Candidates:",
		...candidateLines(candidates, currentKey),
		"When no candidate has a clear advantage, prefer the current model.",
		"",
		"Recent conversation:",
		excerpt === "" ? "(no messages yet)" : excerpt,
	].join("\n");
	const payload = {
		model,
		state,
		questions: {
			best: {
				type: "choice",
				instructions: "Which candidate model should answer the next turn? When no candidate has a clear advantage, prefer the current model.",
				criteria,
			},
		},
	};
	const deadlineMs = Math.max(200, Math.round(readNumber(config.intentTimeoutMs, 3000)));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deadlineMs);
	const signal = turnSignal instanceof AbortSignal ? AbortSignal.any([controller.signal, turnSignal]) : controller.signal;
	try {
		signal.throwIfAborted();
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal,
		});
		if (!response.ok) throw new Error(`systemone HTTP ${response.status}`);
		const body = await response.json();
		const answer = body?.answers?.best;
		const choice = typeof answer?.choice === "string" ? answer.choice : null;
		const best = choice === null ? -1 : keys.indexOf(choice);
		if (best < 0) throw new Error(`systemone choice unknown: ${JSON.stringify(choice)}`);
		const probabilities = answer?.probabilities !== null && typeof answer?.probabilities === "object" ? answer.probabilities : null;
		const top = probabilities !== null ? numberOr(probabilities[choice]) : null;
		const calibrated = numberOr(answer?.confidence);
		const score = top !== null && top >= 0 && top <= 1 ? top : calibrated !== null && calibrated >= 0 && calibrated <= 1 ? calibrated : null;
		// No usable confidence means the verdict carries zero evidence; treat it as a
		// classification failure so the shared catch fails open (fallback chain keeps
		// the current model) instead of committing a confidence-0 switch.
		if (score === null) throw new Error("systemone answer carried no usable confidence");
		return { best, confidence: Math.round(score * 1000) / 10 };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Rewrite + routing entry point.
// ---------------------------------------------------------------------------

/** Decide and apply one auto request (design §4 steps 2-4). Returns the
 *  decided route ({provider, model, effort?}) — reasoningEffort only when
 *  the route pins one (any effort the user picked on the pseudo model is
 *  dropped: the pseudo resolveModel declares no reasoning metadata, so a
 *  leaked effort would hard-fail prepareCall with
 *  UNSUPPORTED_REASONING_EFFORT) — or null when nothing is configured. */
async function routeAutoRequest(ctx, config, payload, warn) {
	const enabled = readBool(config.intentEnabled);
	const candidates = readCandidates(config.intentCandidates);
	const fallback = readRoute(config.intentFallbackRoute);
	const rawSessionId = payload?.agent?.session?.id;
	const sessionId = typeof rawSessionId === "string" && rawSessionId !== "" ? rawSessionId : null;
	const turn = typeof payload?.turn === "number" && Number.isInteger(payload.turn) && payload.turn > 0 ? payload.turn : 0;
	const state = sessionId === null ? null : stateOf(sessionId);
	const turnKey = sessionId !== null && turn > 0 ? `${sessionId}:${turn}` : null;

	// Turn pin: retries and later steps of the same turn reuse the decision.
	if (state !== null && turnKey !== null && state.pinnedTurnKey === turnKey && routeOf(state.decision) !== null) {
		return state.decision;
	}

	const classifier = readRoute(config.intentClassifierRoute);
	const kind = readField(config.intentClassifierKind);
	const now = Date.now();
	let parsed = null;
	// systemone needs no classifier route at all (endpoint + model are
	// hand-configured); the chat kind requires one. Either way a missing
	// prerequisite only skips classification — the fallback chain decides.
	if (enabled && candidates.length > 0 && (kind === "systemone" || classifier !== null)) {
		try {
			const excerpt = sessionHistoryOf(ctx, sessionId, config);
			const current = routeOf(state?.routedCurrent) === null ? null : state.routedCurrent;
			if (kind === "systemone") {
				// Direct decision endpoint — skips the llm service entirely;
				// model and URL are hand-configured, no provider involved.
				parsed = await classifySystemone(ctx, config, candidates, current, excerpt, payload?.signal);
			} else {
				const system = classifierSystemPrompt();
				const input = classifierInput(config, candidates, current, excerpt);
				const text = await classifyOnce(ctx, config, classifier, system, input, payload?.signal);
				parsed = parseClassifierVerdict(text, candidates.length);
				if (parsed === null) warn("intent: classifier output unparseable; using the fallback chain");
			}
		} catch (error) {
			warn(`intent: classification failed (${error?.message ?? error}); using the fallback chain`);
			parsed = null;
		}
	}
	const verdict = decideRoute({
		candidates,
		current: state === null ? null : state.routedCurrent,
		parsed,
		now,
		routedAt: state === null ? null : state.routedAt,
		cacheTtlSeconds: readNumber(config.intentCacheTtlSeconds, 300),
		switchConfidence: readNumber(config.intentSwitchConfidence, 80),
		fallback,
	});
	if (verdict.route === null) return null; // nothing configured — caller degrades
	if (state !== null) {
		state.pinnedTurnKey = turnKey;
		state.decision = verdict.route;
		state.routedCurrent = verdict.route;
		state.routedAt = now; // provider prompt caches refresh on hit — the window restarts
		state.lastDecision = {
			best: `${verdict.route.provider}/${verdict.route.model}`,
			confidence: parsed === null ? 0 : parsed.confidence,
			at: now,
			switched: verdict.switched === true,
		};
	}
	return verdict.route;
}

/**
 * Live intent-routing state for the client route (design §5 shape).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 * @param {string | null} [sessionId] - session to report (null = root-only
 *     fields; autoSelected needs a session).
 */
export async function intentStateOf(ctx, config, sessionId = null) {
	const enabled = readBool(config.intentEnabled);
	const kind = readField(config.intentClassifierKind);
	const candidates = readCandidates(config.intentCandidates);
	const classifier = readRoute(config.intentClassifierRoute);
	const state = typeof sessionId === "string" && sessionId !== "" ? sessionState.get(sessionId) : undefined;
	const selection = typeof sessionId === "string" && sessionId !== "" ? await sessionModelSelectionOf(ctx, sessionId) : null;
	const now = Date.now();
	const ttlMs = Math.max(0, readNumber(config.intentCacheTtlSeconds, 300)) * 1000;
	return {
		enabled,
		autoSelected: selection?.provider === AUTO_PROVIDER,
		// systemone runs on the hand-configured endpoint + model, so a blank
		// catalog route must not mark the feature unconfigured.
		configured:
			(kind === "systemone"
				? readField(config.intentClassifierEndpoint).trim() !== "" &&
					readField(config.intentClassifierSystemoneModel).trim() !== ""
				: classifier !== null) &&
			candidates.length > 0,
		current: routeOf(state?.routedCurrent) === null ? null : { provider: state.routedCurrent.provider, model: state.routedCurrent.model },
		lastDecision: state?.lastDecision ?? null,
		cacheWindowRemainingMs:
			typeof state?.routedAt === "number" ? Math.max(0, Math.round(state.routedAt + ttlMs - now)) : 0,
		candidates: candidates.map((candidate) => ({
			provider: candidate.provider,
			model: candidate.model,
			...(typeof candidate.note === "string" && candidate.note !== "" ? { note: candidate.note } : {}),
		})),
	};
}

// ---------------------------------------------------------------------------
// The pseudo adapter (catalog entry + the routing stream).
// ---------------------------------------------------------------------------

/** Options object → decided route. Llm-layer retries re-dispatch the SAME
 *  options object; the pin makes them reuse the decision instead of
 *  re-classifying (and possibly flip-flopping mid-retry). */
const requestPin = new WeakMap();

/** Build the dsh-switchman-auto adapter object (LlmAdapter protocol). We ship
 *  a plain object, which inherits NOTHING from the harness base class — every
 *  member the registry or the stream path touches must be present here. */
function createAutoAdapter(ctx, config, warn) {
	return {
		providerInfo: (provider) => ({ id: provider, name: "Auto · Switchman" }),
		/** Required by the registry's prepareRoutes (called unconditionally);
		 *  returning undefined lets the registry apply its default retry policy. */
		providerRetryPolicy: () => undefined,
		/** Base-class default: declare no provider-owned image pricing so the
		 *  token meter falls back to its neutral estimate. The registry reads
		 *  this for registered routes when pricing durable history. */
		imageRequestPricing: () => undefined,
		/** Base-class default: preserve normalized images untouched. */
		imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
		listModels: async (provider) => [
			{ provider, id: AUTO_MODEL, name: "Auto", description: "Intent-based model routing by switchman" },
		],
		resolveModel: async (provider, model) => ({
			provider,
			id: model,
			name: "Auto",
			context: { contextWindow: Math.round(readNumber(config.intentContextWindow, 200000)) },
		}),
		/** Base-class default (replicated): the registry's stream path calls
		 *  prepareCall and dispatches through the returned stream — it never
		 *  calls adapter.stream directly. */
		async prepareCall(provider, model, signal) {
			return {
				model: await this.resolveModel(provider, model, signal),
				stream: (options) => this.stream(options),
			};
		},
		/** THE routing point (see the file header): classify, advance the
		 *  state machine, forward to the decided route on a NEW options
		 *  object — a real provider cannot re-enter this adapter. */
		async *stream(options) {
			const sessionId = typeof options?.sessionId === "string" ? options.sessionId : null;
			let route = requestPin.get(options);
			if (route === undefined) {
				route = await routeAutoRequest(ctx, config, { agent: { session: { id: sessionId } }, signal: options?.signal }, warn);
				if (route !== null) requestPin.set(options, route);
			}
			const { reasoningEffort: _droppedPseudoEffort, ...rest } = options ?? {};
			const forwarded = {
				...rest,
				provider: route.provider,
				model: route.model,
				...(typeof route.effort === "string" && route.effort !== "" ? { reasoningEffort: route.effort } : {}),
			};
			yield* ctx.get("llm", false).stream(forwarded);
		},
	};
}

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------

/** Warn-once latch for the missing-llm-service degrade. */
let warnedUnavailable = false;

/**
 * Mount the intent-routing layer: the pseudo adapter and the session/disposed
 * cleanup. (Routing itself lives in the adapter's stream — see the header.)
 *
 * The llm service is deliberately NOT in the plugin's `inject` list (see
 * index.js): a deployment without it must still mount the rest of the plugin.
 * `ctx.inject(["llm"])` defers this feature's mount until the service is
 * stored (immediately when it already is) and re-runs it cleanly if the
 * service is ever replaced. Two timing traps this closes:
 * 1. A one-shot `ctx.get("llm", false)` at apply time loses the race against
 *    the llm fiber at boot — the layer silently no-ops forever (observed in
 *    the field as the composer picker missing the Auto group).
 * 2. `registerAdapter`'s backing effect lives on the LLM fiber, not ours, so
 *    without an explicit release any plugin reload (any settings change)
 *    re-registers onto a still-owned provider and dies on DUPLICATE_ADAPTER.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 */
export function applyIntent(ctx, config) {
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	ctx.inject(["llm"], (llmCtx) => {
		if (!readBool(config.intentEnabled)) {
			return; // feature off: no pseudo provider in the catalog
		}
		try {
			const llm = llmCtx.llm;
			if (llm === undefined || llm === null || typeof llm.registerAdapter !== "function" || typeof llm.prepareCall !== "function" || typeof llm.stream !== "function") {
				if (!warnedUnavailable) {
					warnedUnavailable = true;
					warn("intent routing unavailable: llm service malformed (documented runtime precondition); layer stays a no-op");
				}
				return;
			}
			const handle = llm.registerAdapter([AUTO_PROVIDER], createAutoAdapter(llmCtx, config, warn));
			// Release on OUR fiber: the disposal runs synchronously inside the
			// sub-fiber's unload, which cordis fully drains before any re-apply,
			// so reloads can never race into DUPLICATE_ADAPTER.
			llmCtx.effect(function* () {
				yield () => {
					try {
						handle();
					} catch {
						/* release is best-effort */
					}
				};
			}, "dsh-switchman:intent-auto-adapter-release");
			llmCtx.on("session/disposed", (session) => {
				try {
					if (session !== null && typeof session === "object" && typeof session.id === "string") clearSessionState(session.id);
				} catch {
					/* cleanup is best-effort */
				}
			});
		} catch (error) {
			warn(`intent routing layer failed to mount: ${error?.message ?? error}`);
		}
	});
}
