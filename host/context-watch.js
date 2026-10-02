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
 * - Handovers borrow the session's own per-agent /compact command handler
 *   via ctx.commands.find(agent, "compact"): the desktop profile mounts
 *   compaction only inside each preset's isolated per-agent group
 *   (isolate: { compaction: true }), so no root-level inject or lookup can
 *   reach it — the borrowed handler's closure carries the right composition.
 *   Auto handover is fire-and-forget with a session-level in-flight flag
 *   plus a 10-minute cooldown. Manual /ctx-handover is the full four-step
 *   flow: fork a dormant backup session (subagents' fork provider, economy
 *   pool model), write the handover document skeleton, compact, then wake
 *   this session (agent.followup + sessions.flush, the schedule service's
 *   delivery channel) to fill in the document and continue the unfinished
 *   task. /ctx-pause and /ctx-resume toggle process-lifetime pause
 *   state (a restart resumes enforcement — the safe side).
 *
 * All session state is in-process Maps; every path is fail-open (a failing
 * measurement or missing service degrades the banner to "" or the gate to
 * allow, never throws into the assembly chain or the tool pipeline).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Subagent-session banner: the same soft/hard/force absolute-token tiers
 *  as the root banner ("" while ok — token economy), with subagent-flavored
 *  advice and the HANDOFF block due at the force tier. Pausing never applies
 *  to subagents (oc index.ts:187-190). */
function renderSubBanner(used, th) {
	const level = levelOf(used, th);
	const head =
		`[SWITCHMAN:WATERMARK] subagent level=${level} used=${kilo(used)}` +
		` budget=${kilo(th.soft)}/${kilo(th.hard)}/${kilo(th.force)}`;
	if (level === "ok") return "";
	if (level === "soft")
		return `${head}\nsoft tier: keep reads narrow and drop bulky raw output.`;
	if (level === "hard")
		return `${head}\nhard tier: stop broad reading; start wrapping toward the final summary.`;
	return (
		`${head}\nforce tier: stop reading and return the final summary now.\n` +
		`End the FINAL message with a HANDOFF block: completed / key findings (file:line) / remaining / next steps.`
	);
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
			// Subagents share the root soft/hard thresholds; the optional
			// wmSubagentForceTokens override replaces only the force tier
			// (enabled by the wmSubagentCap toggle, 0/0 = follow the root set).
			const subForce = readBool(config.wmSubagentCap, true) ? readNumber(config.wmSubagentForceTokens, 0) : 0;
			const subTh = subForce > 0 ? { ...th, force: subForce } : th;
			return renderSubBanner(used, subTh);
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

	// --- C. handover execution: borrow the session's own /compact -----------
	// The desktop profile provides compaction ONLY inside each preset's
	// per-agent isolated group (isolate: { compaction: true }), where the
	// per-agent command-compact /compact command lives; a root plugin cannot
	// inject or resolve that service (inject would wait forever; property/get
	// access throws). The sanctioned bridge is the commands registry itself:
	// ctx.commands.find(agent, "compact") merges that agent's scoped layer and
	// returns the definition whose handler closure already carries the right
	// composition context with compaction injected.
	const sessionCompact = (agent, commandId, signal) => {
		let definition;
		try {
			definition = ctx.commands?.find?.(agent, "compact");
		} catch {
			definition = undefined;
		}
		if (definition === undefined || typeof definition.handler !== "function") return undefined;
		const invocation = Object.freeze({
			commandId,
			agent,
			rawInput: "",
			attachments: Object.freeze([]),
			signal,
		});
		return Promise.resolve(definition.handler(invocation));
	};

	const startHandover = (agent, sessionId) => {
		state.inflight.add(sessionId);
		let promise;
		try {
			promise = sessionCompact(agent, `switchman-auto-${sessionId}`, undefined);
			if (promise === undefined)
				warn(`auto handover found no per-agent /compact command for session ${sessionId} — nothing to do`);
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

	/** First {provider, model} route of a volatile pool field, or null. */
	const firstPoolRoute = (field) => {
		const raw = readValue(field);
		const first = Array.isArray(raw) ? raw[0] : undefined;
		if (first === null || typeof first !== "object") return null;
		return typeof first.provider === "string" && typeof first.model === "string" ? first : null;
	};

	/** Manual handover step 1 — fork a dormant backup child of this session
	 *  through the subagents service's fork provider (the child inherits the
	 *  completed turns, runs one tiny confirmation turn on the economy pool
	 *  model when configured, then stays idle as a browsable snapshot). The
	 *  spec MUST carry a signal: the manager calls spec.signal.throwIfAborted()
	 *  unconditionally, so a missing signal fails the whole fork with a
	 *  TypeError (the live failure observed on 2026-10-01). The append-only
	 *  session log always remains the full-fidelity backup, so a failed fork
	 *  only downgrades the UX, never the data. Returns {childId, reason}. */
	const forkBackup = async (agent, sessionId, signal) => {
		try {
			const economy = firstPoolRoute(config.poolEconomy);
			const started = await ctx.subagents?.startContinuable?.({
				provider: "fork",
				label: "dsh-switchman handover backup",
				signal: signal ?? new AbortController().signal,
				request: {
					parent: agent,
					prompt: [
						{
							type: "text",
							text: "[SWITCHMAN:HANDOVER-BACKUP] This session is a dormant fork snapshot taken immediately before a context handover in the parent session. Do not perform any work. Reply with exactly one line confirming you hold the complete pre-handover state, then stay idle.",
						},
					],
					...(economy === null ? {} : { agentOptions: { provider: economy.provider, model: economy.model } }),
				},
			});
			if (typeof started?.childId !== "string") {
				const reason = `startContinuable returned no child id (${JSON.stringify(started ?? null)})`;
				warn(
					`handover backup fork failed for session ${sessionId} (continuing; the append-only log remains the full backup): ${reason}`,
				);
				return { childId: null, reason };
			}
			return { childId: started.childId, reason: null };
		} catch (error) {
			const reason = error?.message ?? String(error);
			warn(
				`handover backup fork failed for session ${sessionId} (continuing; the append-only log remains the full backup): ${reason}`,
			);
			return { childId: null, reason };
		}
	};

	/** Manual handover step 2 — write the handover document skeleton into
	 *  the session's working directory. The mechanical facts land now (before
	 *  compaction); the agent's continuation turn fills in the task-state
	 *  summary using the compaction summary it can still see. Null when the
	 *  session exposes no usable cwd or the write fails. */
	const writeHandoverSkeleton = (agent, sessionId, backupId, used) => {
		const cwd = agent?.session?.header?.cwd;
		if (typeof cwd !== "string" || cwd === "") return null;
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		const directory = join(cwd, ".dsh-switchman", "handover");
		const short = sessionId.replace(/^session-/u, "").slice(0, 8) || sessionId;
		const path = join(directory, `${stamp}-${short}.md`);
		try {
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				path,
				[
					`# SWITCHMAN handover — ${sessionId}`,
					``,
					`- handed over at: ${new Date().toISOString()}`,
					`- context used before compaction: ~${used ?? "unknown"} tokens`,
					`- backup fork session: ${backupId ?? "(fork failed — the full history remains in this session's append-only log)"}`,
					``,
					`## Task state (filled in by the agent right after the handover)`,
					``,
					`- goal / objective in flight:`,
					`- completed so far:`,
					`- in progress:`,
					`- next steps:`,
					`- files touched / key references:`,
					``,
				].join("\n"),
				"utf8",
			);
			return path;
		} catch (error) {
			warn(`handover document write failed: ${error?.message ?? error}`);
			return null;
		}
	};

	/** Manual handover step 4 — wake the freshly compacted session: one
	 *  followup user message (the same delivery channel the schedule service
	 *  uses: agent.followup + sessions.flush) instructing the agent to fill
	 *  in the handover document from the compaction summary now in context
	 *  and continue the unfinished task. */
	const armContinuation = async (agent, backupId, docPath) => {
		if (typeof agent?.followup !== "function") {
			warn("handover continuation skipped: agent exposes no followup()");
			return;
		}
		const instruction = [
			"[SWITCHMAN:HANDOVER] A context handover just completed for this session.",
			backupId !== null
				? `A dormant fork backup holding the full pre-handover state is session ${backupId}.`
				: `No fork backup was created; the append-only session log still holds the full history.`,
			docPath !== null
				? `The handover document skeleton is at ${docPath}.`
				: `Create the handover document under .dsh-switchman/handover/ in the working directory.`,
			"Using the compaction summary now in your context, fill in the handover document (goal, completed, in progress, next steps, files), then continue the unfinished task — do not wait for further instructions.",
		].join(" ");
		try {
			agent.followup({
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text: instruction }],
				source: { kind: "user" },
			});
			await ctx.sessions?.flush?.(agent.session);
		} catch (error) {
			warn(`handover continuation failed: ${error?.message ?? error}`);
		}
	};

	/** Manual /ctx-handover — the full opencode-switchman handover flow on
	 *  DSH primitives: (1) fork a dormant backup session, (2) write the
	 *  handover document skeleton, (3) compact via the session's own
	 *  per-agent /compact handler (borrowed through ctx.commands.find; the
	 *  preset isolates compaction per agent, so no root-level access exists),
	 *  and (4) wake this session to fill in the document and continue the
	 *  unfinished task. Every step degrades independently; compaction is the
	 *  only mandatory one. */
	const manualHandover = async (agent, sessionId, commandId, signal) => {
		if (sessionId === null || agent?.session === undefined)
			return { kind: "error", text: "/ctx-handover: no active session" };
		if (state.inflight.has(sessionId))
			return { kind: "success", text: "[SWITCHMAN:WATERMARK] a handover is already in progress for this session." };
		const borrowed = sessionCompact(agent, commandId, signal);
		if (borrowed === undefined)
			return {
				kind: "error",
				text: "/ctx-handover: this session's preset exposes no /compact command, so no compaction backend is reachable.",
			};
		state.inflight.add(sessionId);
		try {
			const backup = await forkBackup(agent, sessionId, signal);
			const backupId = backup.childId;
			const docPath = writeHandoverSkeleton(agent, sessionId, backupId, measureNow(ctx, agent));
			const result = await borrowed;
			if (result?.kind === "error")
				return {
					kind: "error",
					text: `/ctx-handover: compaction failed after backup ${backupId ?? "n/a"} — ${result.text ?? "unknown error"}`,
				};
			await armContinuation(agent, backupId, docPath);
			const backupText =
				backupId ?? `n/a (${backup.reason ?? "log retains full history"})`;
			return {
				kind: "success",
				text: `[SWITCHMAN:WATERMARK] handover complete — backup ${backupText}, document ${docPath ?? "agent-created"}, compaction done, continuation armed.`,
			};
		} catch (error) {
			return { kind: "error", text: `/ctx-handover failed: ${error?.message ?? error}` };
		} finally {
			state.inflight.delete(sessionId);
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
		description: "Trigger a manual context handover (compaction) for this session now.",
		handler: (invocation) =>
			manualHandover(invocation?.agent, sessionIdOf(invocation?.agent), invocation?.commandId, invocation?.signal),
	});
}

export { applyContextWatch };
