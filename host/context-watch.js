/** dsh-switchman context-watermark layer (Phase 3).
 *
 * Ported from opencode-switchman's src/context-watch.ts (decision core),
 * src/index.ts:386-459 (banner rendering) and 2066-2110 (auto-handover with
 * its anti-deadlock lesson) onto DSH services:
 *
 * - One dynamic systemPrompt section 'switchman:watermark' (order 10500)
 *   renders the `[SWITCHMAN:WATERMARK]` banner from the live token meter
 *   (ctx.tokenMeter.measure(agent.session).totalTokens). Root sessions get
 *   the tiered banner (ok/soft/hard/force/paused); subagent sessions get a
 *   compact cap-aware banner. The text function is side-effect free.
 * - Read budget double gate: `tools/post-execute` accounts read/glob/grep/
 *   bash result text (~len/3.5 tokens) per session per turn; `tools/
 *   pre-execute` denies or caps read/glob/grep once the budget is exhausted
 *   at tier >= hard (wmDenyMode picks deny vs cap+warning-append).
 * - Force-tier auto handover: fire-and-forget `ctx.compaction.
 *   compactIfNeeded(agent, "pressure")` from the post-execute hook — never
 *   awaited (the oc self-deadlock lesson), session-level in-flight flag plus
 *   a 10-minute cooldown; compaction's own threshold gate keeps it idempotent.
 * - /ctx-pause, /ctx-resume, /ctx-handover commands (process-lifetime state;
 *   a restart resumes enforcement — the safe side).
 *
 * All session state is in-process Maps; every path is fail-open (a failing
 * measurement or missing service degrades the banner to "" or the gate to
 * allow, never throws into the assembly chain or the tool pipeline).
 */

/** Tools whose result text is accounted against the per-turn read budget. */
const ACCOUNT_TOOLS = new Set(["read", "glob", "grep", "bash"]);

/** Tools the pre-execute budget gate may deny or cap. */
const GATED_TOOLS = new Set(["read", "glob", "grep"]);

/** Result text length → estimated tokens. */
const TOKENS_PER_CHAR = 1 / 3.5;

/** Turn budget ceiling: 2×R* plus a 0.4×R* tolerance before denying. */
const CEILING_MULTIPLE = 2.4; // 2 + 0.4 — matches the spec (limit 2×R*, tolerance 0.4×R*)

/** Idle window after which a session's accounting resets itself. */
const IDLE_RESET_MS = 15 * 60 * 1000;

/** Cooldown between automatic force-tier handovers per session. */
const HANDOVER_COOLDOWN_MS = 10 * 60 * 1000;

// ---- shared volatile-read helpers (mirrors lang.js / dispatch.js) ----------

/** Read one volatile settings field's raw value (live `.get()` reference). */
function readValue(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get();
		} catch {
			return undefined;
		}
	}
	return field;
}

/** Field value as a string ("" when not a string). */
function readString(field) {
	const value = readValue(field);
	return typeof value === "string" ? value : "";
}

/** Field value as a finite positive number, else the fallback. */
function readNumber(field, fallback) {
	const value = readValue(field);
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Field value as a boolean, else the fallback. */
function readBool(field, fallback) {
	const value = readValue(field);
	return typeof value === "boolean" ? value : fallback;
}

// ---- pure helpers ----------------------------------------------------------

/** Tier for a used-token count against the thresholds. */
function levelOf(used, th) {
	if (used >= th.force) return "force";
	if (used >= th.hard) return "hard";
	if (used >= th.soft) return "soft";
	return "ok";
}

/** `42k`-style rounding for the anchor line. */
function kilo(tokens) {
	return `${Math.round(tokens / 1000)}k`;
}

/** Session id off an exec/invocation agent (shared agent/session id). */
function sessionIdOf(agent) {
	const id = agent?.session?.id ?? agent?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

/** Resolve the agent's own composition-scoped compaction service, if any.
 *  Presets mount compaction inside an isolated per-agent group, so the
 *  service is reachable from the agent's context, not from the root. */
function compactionOf(agent) {
	const agentCtx = agent?.ctx;
	if (agentCtx === null || typeof agentCtx !== "object") return undefined;
	try {
		const direct = agentCtx.compaction;
		if (direct !== undefined) return direct;
		if (typeof agentCtx.get === "function") return agentCtx.get("compaction");
	} catch {
		/* fall through */
	}
	return undefined;
}

/** True when the agent is a runtime root (owner-less); unknown registries
 *  count as root so the richer root banner wins the tie. */
function isRoot(ctx, agent) {
	try {
		const roots = ctx.agents?.roots?.();
		return !Array.isArray(roots) || roots.includes(agent);
	} catch {
		return true;
	}
}

/** Live threshold snapshot from the volatile settings. */
function readThresholds(config) {
	return {
		soft: readNumber(config.wmSoftTokens, 50000),
		hard: readNumber(config.wmHardTokens, 90000),
		force: readNumber(config.wmForceTokens, 130000),
	};
}

/** Measure one agent's session now; null when the meter is missing/failing. */
function measureNow(ctx, agent) {
	try {
		const measurement = agent?.session ? ctx.tokenMeter?.measure?.(agent.session) : undefined;
		const used = Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : null;
		return used === null ? null : used;
	} catch {
		return null;
	}
}

// ---- banner rendering (pure given state + measurement) ---------------------

/** Root-session banner: byte-stable anchor line + tier advice lines. */
function renderRootBanner(level, used, th, autoHandover) {
	const head =
		`[SWITCHMAN:WATERMARK] level=${level} used=${kilo(used)}` +
		` budget=${kilo(th.soft)}/${kilo(th.hard)}/${kilo(th.force)}`;
	if (level === "ok") return head;
	if (level === "paused")
		return `${head}\nPAUSED by /ctx-pause — measurement continues, but every watermark enforcement stays off until /ctx-resume.`;
	const lines = [head];
	if (level === "soft") lines.push(`soft tier: prefer delegating lightweight work (subagent/workflow) over reading more context yourself.`);
	if (level === "hard") lines.push(`hard tier: stop broad reading (read/glob/grep are budget-limited this turn) and start wrapping up.`);
	if (level === "force") {
		lines.push(`force tier: MANDATORY wrap-up now — produce the final answer from what you already hold.`);
		lines.push(
			autoHandover
				? `an automatic context handover (compaction) is armed and will fire at the next step boundary.`
				: `run /ctx-handover to trigger a manual context handover.`,
		);
	}
	return lines.join("\n");
}

/** Subagent-session banner: "" under 50% (token economy), one line to 80%,
 *  HANDOFF-block instructions to the cap, one-line ceiling notice at it.
 *  Pausing never applies to subagents (oc index.ts:187-190). */
function renderSubBanner(used, cap) {
	if (used < cap * 0.5) return "";
	if (used < cap * 0.8)
		return `[SWITCHMAN:WATERMARK] subagent context at ${kilo(used)}/${kilo(cap)} — keep reads narrow, drop bulky raw output.`;
	if (used < cap)
		return (
			`[SWITCHMAN:WATERMARK] subagent context at ${kilo(used)}/${kilo(cap)} — nearing the cap.\n` +
			`Your FINAL message must end with a HANDOFF block: completed / key findings (file:line) / remaining / next steps.`
		);
	return `[SWITCHMAN:WATERMARK] subagent context cap ${kilo(cap)} reached — stop reading and return the final summary now.`;
}

/** Whole banner for one assembly; "" whenever anything needed is missing. */
function renderBanner(ctx, config, state, agent) {
	try {
		const sessionId = sessionIdOf(agent);
		if (sessionId === null || agent.session === undefined) return "";
		const th = readThresholds(config);
		const used = measureNow(ctx, agent);
		if (used === null) return "";
		if (!isRoot(ctx, agent)) {
			const subForce = readNumber(config.wmSubagentForceTokens, 0);
			const cap = readBool(config.wmSubagentCap, true) && subForce > 0 ? subForce : th.force;
			return renderSubBanner(used, cap);
		}
		const level = state.paused.has(sessionId) ? "paused" : levelOf(used, th);
		return renderRootBanner(level, used, th, readBool(config.wmAutoHandover, true));
	} catch {
		return "";
	}
}

// ---- per-turn read accounting ----------------------------------------------

/** Estimated tokens in one tool result (content text blocks, else stringified value). */
function resultTokens(result) {
	try {
		let chars = 0;
		if (Array.isArray(result?.content)) {
			for (const block of result.content)
				if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		} else if (result?.value !== undefined && result.value !== null) {
			try {
				chars = JSON.stringify(result.value).length;
			} catch {
				chars = String(result.value).length;
			}
		}
		return Math.round(chars * TOKENS_PER_CHAR);
	} catch {
		return 0;
	}
}

/** Add tokens to a session's turn account (idle window resets it). */
function accountRead(state, sessionId, tokens, now = Date.now()) {
	const prior = state.readUsed.get(sessionId);
	if (prior !== undefined && now - prior.at > IDLE_RESET_MS) {
		state.readUsed.set(sessionId, { used: tokens, at: now });
		return state.readUsed.get(sessionId);
	}
	if (prior === undefined) {
		const entry = { used: tokens, at: now };
		state.readUsed.set(sessionId, entry);
		return entry;
	}
	prior.used += tokens;
	prior.at = now;
	return prior;
}

/** Current turn usage for a session (idle-expired accounts read as zero). */
function turnUsed(state, sessionId, now = Date.now()) {
	const entry = state.readUsed.get(sessionId);
	if (entry === undefined || now - entry.at > IDLE_RESET_MS) return 0;
	return entry.used;
}

// ---- layer -----------------------------------------------------------------

/** Mount the context-watermark layer: banner section, budget gates, auto
 *  handover, and the three /ctx-* commands. */
function applyContextWatch(ctx, config) {
	/** Process-lifetime session state (never persisted). */
	const state = {
		paused: new Set(),
		inflight: new Set(),
		lastHandover: new Map(),
		readUsed: new Map(),
	};
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);

	// --- A. watermark banner -------------------------------------------------
	ctx.systemPrompt.section({
		name: "switchman:watermark",
		order: 10500,
		interpolate: false,
		text: (context) => renderBanner(ctx, config, state, context?.agent),
	});

	// --- C. force-tier auto handover (fire-and-forget, never awaited) --------
	// The compaction service lives inside each preset's per-agent isolated
	// composition (isolate: { compaction: true }), never at the root where
	// this plugin row mounts — so resolve it through the triggering agent's
	// own context first, falling back to this plugin's ctx (tests, future
	// root-mounted compositions). Never inject-declare it: the root would
	// wait forever ("pending (waiting for service: compaction)").
	const startHandover = (agent, sessionId) => {
		state.inflight.add(sessionId);
		let promise;
		try {
			const compaction = compactionOf(agent) ?? ctx.compaction;
			promise = compaction?.compactIfNeeded?.(agent, "pressure", undefined);
		} catch (error) {
			warn(`handover failed to start: ${error?.message ?? error}`);
			promise = undefined;
		}
		const settle = () => state.inflight.delete(sessionId);
		if (promise !== undefined && typeof promise.then === "function") {
			promise.then(
				() => ctx.logger?.info?.(`dsh-switchman: context handover settled for session ${sessionId}`),
				(error) => warn(`context handover failed for session ${sessionId}: ${error?.message ?? error}`),
			).then(settle, settle);
		} else {
			settle();
		}
	};

	const maybeAutoHandover = (agent) => {
		try {
			const sessionId = sessionIdOf(agent);
			if (sessionId === null || agent.session === undefined) return;
			if (readBool(config.wmAutoHandover, true) !== true) return;
			if (state.paused.has(sessionId) || state.inflight.has(sessionId)) return;
			if (!isRoot(ctx, agent)) return;
			const now = Date.now();
			if (now - (state.lastHandover.get(sessionId) ?? 0) < HANDOVER_COOLDOWN_MS) return;
			const used = measureNow(ctx, agent);
			if (used === null || levelOf(used, readThresholds(config)) !== "force") return;
			state.lastHandover.set(sessionId, now);
			startHandover(agent, sessionId);
		} catch {
			/* fail-open: the banner still reports force */
		}
	};

	// --- B+C. post-execute: account reads, cap-warn, trigger handover --------
	ctx.on("tools/post-execute", (exec, result, next) => {
		try {
			maybeAutoHandover(exec?.agent);
			const sessionId = sessionIdOf(exec?.agent);
			if (sessionId !== null && ACCOUNT_TOOLS.has(exec?.name ?? "")) {
				const entry = accountRead(state, sessionId, resultTokens(result));
				if (GATED_TOOLS.has(exec.name) && !state.paused.has(sessionId)) {
					const budget = readNumber(config.wmReadBudgetTokens, 1500);
					const ceiling = budget * CEILING_MULTIPLE;
					const used = measureNow(ctx, exec.agent);
					const th = readThresholds(config);
					if (
						entry.used >= ceiling &&
						used !== null &&
						(levelOf(used, th) === "hard" || levelOf(used, th) === "force") &&
						readString(config.wmDenyMode) !== "deny" &&
						Array.isArray(result?.content)
					) {
						return {
							kind: "accept",
							content: [
								...result.content,
								{
									type: "text",
									text: `[SWITCHMAN:WATERMARK] read budget exceeded this turn (used ${Math.round(entry.used)}/${Math.round(ceiling)} tokens) — further reads may be denied; wrap up or delegate the remaining reading.`,
								},
							],
						};
					}
				}
			}
		} catch (error) {
			warn(`post-execute accounting failed: ${error?.message ?? error}`);
		}
		return next();
	});

	// --- B. pre-execute: deny over-budget reads at tier >= hard --------------
	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			if (!GATED_TOOLS.has(exec?.name ?? "")) return next();
			const sessionId = sessionIdOf(exec?.agent);
			if (sessionId === null || state.paused.has(sessionId)) return next();
			const budget = readNumber(config.wmReadBudgetTokens, 1500);
			if (turnUsed(state, sessionId) < budget * CEILING_MULTIPLE) return next();
			const used = measureNow(ctx, exec.agent);
			if (used === null) return next();
			const level = levelOf(used, readThresholds(config));
			if (level !== "hard" && level !== "force") return next();
			if (readString(config.wmDenyMode) !== "deny") return next();
			const ceiling = budget * CEILING_MULTIPLE;
			return {
				kind: "deny",
				reason:
					`[SWITCHMAN:WATERMARK] read budget exhausted this turn (used ${Math.round(turnUsed(state, sessionId))}/${Math.round(ceiling)}).` +
					` Wrap up, or delegate the remaining reading.`,
			};
		} catch (error) {
			warn(`read gate failed open: ${error?.message ?? error}`);
			return next();
		}
	});

	// --- turn reset: a claimed inbox batch starts a fresh accounting turn ----
	ctx.on("agent/inbox/claimed", (payload) => {
		const sessionId = sessionIdOf(payload?.agent);
		if (sessionId !== null) state.readUsed.delete(sessionId);
	});

	// --- D. /ctx-pause, /ctx-resume, /ctx-handover ----------------------------
	ctx.commands.register({
		name: "ctx-pause",
		description: "Pause dsh-switchman watermark enforcement for this session (measurement continues).",
		handler: (invocation) => {
			const sessionId = sessionIdOf(invocation?.agent);
			if (sessionId === null) return { kind: "error", text: "/ctx-pause: no active session" };
			state.paused.add(sessionId);
			return {
				kind: "success",
				text: "[SWITCHMAN:WATERMARK] paused for this session — measurement continues, enforcement off. /ctx-resume restores it.",
			};
		},
	});
	ctx.commands.register({
		name: "ctx-resume",
		description: "Resume dsh-switchman watermark enforcement for this session.",
		handler: (invocation) => {
			const sessionId = sessionIdOf(invocation?.agent);
			if (sessionId === null) return { kind: "error", text: "/ctx-resume: no active session" };
			const wasPaused = state.paused.delete(sessionId);
			return {
				kind: "success",
				text: wasPaused
					? "[SWITCHMAN:WATERMARK] resumed for this session — thresholds and the read budget apply again."
					: "[SWITCHMAN:WATERMARK] was not paused; enforcement continues.",
			};
		},
	});
	ctx.commands.register({
		name: "ctx-handover",
		description: "Trigger a manual context handover (background compaction) for this session now.",
		handler: (invocation) => {
			const agent = invocation?.agent;
			const sessionId = sessionIdOf(agent);
			if (sessionId === null || agent?.session === undefined)
				return { kind: "error", text: "/ctx-handover: no active session" };
			if (state.inflight.has(sessionId))
				return { kind: "success", text: "[SWITCHMAN:WATERMARK] a handover is already in progress for this session." };
			startHandover(agent, sessionId);
			return { kind: "success", text: "[SWITCHMAN:WATERMARK] manual handover started in the background (compaction)." };
		},
	});
}

export { applyContextWatch };
