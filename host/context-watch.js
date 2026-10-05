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
 *   Every handover trigger — the force-tier automation (fire-and-forget,
 *   session-level in-flight flag plus a 10-minute cooldown) and manual
 *   /ctx-handover — shares one four-step flow: fork a dormant backup
 *   session (subagents' fork provider, economy pool model); then, on
 *   every compaction attempt, re-enumerate the live dispatched
 *   subagents and refresh the handover document as the very last
 *   action before compacting via the borrowed per-agent /compact
 *   (retried on a growing backoff until the agent goes idle, because
 *   the automation fires mid-turn); after compaction settles, diff the
 *   enumeration once more and append anything that materialized during
 *   the window; finally wake this session (agent.followup +
 *   sessions.flush, the schedule service's delivery channel) to fill in
 *   the document and continue the unfinished task, with two post-wake
 *   rechecks announcing late-materializing dispatches.
 *   The live handover phase feeds the force-tier banner so progress is
 *   visible instead of silent. /ctx-pause and /ctx-resume toggle
 *   process-lifetime pause state (a restart resumes enforcement — the
 *   safe side).
 *
 * All session state is in-process Maps; every path is fail-open (a failing
 * measurement or missing service degrades the banner to "" or the gate to
 * allow, never throws into the assembly chain or the tool pipeline).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearHandover, handoverOf, recordHandover } from "./handover-state.js";
import { enumerateLiveSubagents, sessionRecordPath, sessionRecordsDir } from "./subagents.js";

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

/** Root-session banner: byte-stable anchor line + tier advice lines plus
 * the live handover progress (phase/attempt) and auto-cooldown state. */
function renderRootBanner(level, used, th, status) {
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
		const phase = status?.phase;
		if (phase === "backup") {
			lines.push(`context handover running: forking the backup session and writing the handover document…`);
		} else if (phase === "compacting") {
			lines.push(`context handover running: compaction attempt ${status?.attempt ?? "?"} (retries while the turn is still running)…`);
		} else if (phase === "continuation") {
			lines.push(`context handover completing: waking this session to fill in the document and continue the task…`);
		} else if (status?.autoHandover) {
			lines.push(
				status?.cooldownMin > 0
					? `automatic handover cooldown: ${status.cooldownMin} min left; run /ctx-handover${status?.tool ? " or call the ctx_handover tool" : ""} to force one now.`
					: `an automatic context handover (backup + document + compaction + continuation) is armed and will fire at the next step boundary${status?.tool ? "; calling the ctx_handover tool triggers it immediately" : ""}.`,
			);
		} else {
			lines.push(`run /ctx-handover${status?.tool ? " or call the ctx_handover tool" : ""} to trigger a manual context handover.`);
		}
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
		const live = handoverOf(sessionId);
		const elapsed = Date.now() - (state.lastHandover.get(sessionId) ?? 0);
		return renderRootBanner(level, used, th, {
			autoHandover: readBool(config.wmAutoHandover, true),
			phase: live?.phase,
			attempt: live?.attempt,
			cooldownMin: Math.max(0, Math.ceil((HANDOVER_COOLDOWN_MS - elapsed) / 60_000)),
			tool: state.handoverTool ?? undefined,
		});
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
		handoverTool: null,
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
	/** Find the agent's scoped /compact definition without invoking it. */
	const compactDefinition = (agent) => {
		try {
			const definition = ctx.commands?.find?.(agent, "compact");
			return typeof definition?.handler === "function" ? definition : undefined;
		} catch {
			return undefined;
		}
	};

	const sessionCompact = (agent, commandId, signal) => {
		const definition = compactDefinition(agent);
		if (definition === undefined) return undefined;
		const invocation = Object.freeze({
			commandId,
			agent,
			rawInput: "",
			attachments: Object.freeze([]),
			// The borrowed /compact handler (and compactNow behind it) touches
			// signal.throwIfAborted()/aborted unconditionally; the auto path
			// has no real signal, so always carry a fresh un-aborted one.
			signal: signal ?? new AbortController().signal,
		});
		return Promise.resolve(definition.handler(invocation));
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

	/** One handover-document path per handover run (stamp frozen at run
	 *  start so refreshes overwrite the same file). Null when the session
	 *  exposes no usable cwd. */
	const handoverDocPath = (agent, sessionId) => {
		const cwd = agent?.session?.header?.cwd;
		if (typeof cwd !== "string" || cwd === "") return null;
		const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
		const short = sessionId.replace(/^session-/u, "").slice(0, 8) || sessionId;
		return join(cwd, ".dsh-switchman", "handover", `${stamp}-${short}.md`);
	};

	/** Write (or refresh) the handover document as the LAST action before
	 *  a compaction attempt — enumerate, write, compact, nothing mutating
	 *  in between. The old flow wrote the skeleton once, up front, and
	 *  then sat through the idle-retry loop while the triggering turn
	 *  kept executing: dispatches issued in that window MATERIALIZED into
	 *  the catalog only around the post-compaction resume, invisible to
	 *  both the old snapshot and the compacted agent, which then
	 *  re-dispatched live work (incident 2026-10-05). Refreshing on every
	 *  attempt keeps the document truthful at the moment compaction
	 *  actually lands while still capturing state strictly BEFORE
	 *  compaction destroys it. `live` entries are { id, label, mode,
	 *  state } from enumerateLiveSubagents. Returns the path on success,
	 *  null on failure (fail-open: never blocks compaction). */
	const writeHandoverDoc = (path, sessionId, backupId, used, live) => {
		if (path === null) return null;
		const liveSection =
			Array.isArray(live) && live.length > 0
				? [
						`## Live background subagents (captured immediately before the compaction attempt — still alive)`,
						``,
						...live.map(
							(child) =>
								`- \`${child.id}\`${child.label ? ` — ${child.label}` : ""}${child.mode ? ` (${child.mode})` : ""} — ${child.state === "running" ? "RUNNING" : "PENDING (dispatched, no open step yet)"}. Collect its report when it settles (in-session completion notice, or read its session record at ${sessionRecordPath(child.id)}) before re-dispatching anything similar — do not duplicate live work.`,
						),
						`How to address and re-check them:`,
						``,
						`- These are subagent children, not teammates. While the Agent-Teams bundle is active, send_message({ target }) resolves teammate names only — it will always answer "active teammate ... not found" for these ids. That error says nothing about the child's health: do not conclude it is dead, and do not re-dispatch while it is alive.`,
						`- Re-check liveness against the child's record JSON (exact paths — note the leading record.): running iff record.rows.sessionStats.val.openStep !== null; settled (nothing pending) iff record.rows.turnBoundary.val.lastStepBoundary.kind === "end"; anything else with an existing record is pending. One-liner: python3 -c 'import json;d=json.load(open("<DSH_HOME>/storages/session_projcache/sessions/<childId>.json"))["record"]["rows"];print("running" if (d.get("sessionStats") or {}).get("val",{}).get("openStep") else ("settled" if (((d.get("turnBoundary") or {}).get("val") or {}).get("lastStepBoundary") or {}).get("kind")=="end" else "pending"))'`,
						`- The catalog record.rows.subagentCatalog.val.head.values of THIS session lists every child ever dispatched from it (ids, labels, childCreatedAt timestamps). Entries younger than the handover time are dispatches the pre-compaction captures could not see — treat them as your own live work, never as candidates for re-dispatch.`,
						`- Report tail: <DSH_HOME>/sessions/<workspace-slug>/<childId>/session.v4.jsonl.zstd (zstd-compressed JSONL; the workspace slug is the dash-encoded session cwd). The last assistant/message records hold interim and final reports.`,
						``,
					]
				: [
						`## Live background subagents`,
						``,
						`- None live at the last capture. If the compaction summary mentions dispatched subagents anyway, they materialized after it: re-check the session catalog (record.rows.subagentCatalog) before re-dispatching anything.`,
						``,
					];
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				[
					`# SWITCHMAN handover — ${sessionId}`,
					``,
					`- handed over at: ${new Date().toISOString()} (document refreshed before every compaction attempt)`,
					`- context used before compaction: ~${used ?? "unknown"} tokens`,
					`- backup fork session: ${backupId ?? "(fork failed — the full history remains in this session's append-only log)"}`,
					``,
					...liveSection,
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

	/** One-shot delayed re-checks after the continuation is armed. A
	 *  dispatch from the pre-handover turn can materialize in the very
	 *  instants around the post-compaction resume — after the final
	 *  enumeration but before the woken agent looks. Two cheap probes
	 *  (20 s / 75 s) compare the catalog against everything already
	 *  announced; anything new is appended to the handover document AND
	 *  pushed to the session as a followup so the agent learns its
	 *  deferred dispatch exists before it can re-dispatch. Best-effort:
	 *  process-lifetime timers, fail-open, never throws. */
	const scheduleMaterializationRecheck = (agent, sessionId, backupId, docFile, known) => {
		const knownIds = new Set([backupId ?? "", ...(known ?? []).map((child) => child.id)]);
		const check = async (tag) => {
			try {
				const fresh = (await enumerateLiveSubagents(ctx, sessionId)).filter((child) => !knownIds.has(child.id));
				if (fresh.length === 0) return;
				for (const child of fresh) knownIds.add(child.id);
				const lines = fresh.map(
					(child) =>
						`${child.id}${child.label ? ` (${child.label})` : ""} [${child.state}] → record ${sessionRecordPath(child.id)}`,
				);
				if (docFile !== null) {
					try {
						appendFileSync(
							docFile,
							[
								``,
								`## Post-wake refresh (${new Date().toISOString()})`,
								``,
								`- ${fresh.length} dispatched subagent(s) materialized AFTER the wake-time enumeration:`,
								...lines.map((line) => `- ${line}`),
								`- These are pre-handover dispatches of this same session, now alive. Collect their results; do NOT re-dispatch.`,
								``,
							].join("\n"),
							"utf8",
						);
					} catch {
						/* document append is best-effort */
					}
				}
				agent.followup({
					id: randomUUID(),
					role: "user",
					content: [
						{
							type: "text",
							text: `[SWITCHMAN:HANDOVER-REFRESH] ${fresh.length} dispatched subagent(s) materialized after the handover snapshot — dispatched before the wake or by the just-woken agent itself — either way live work of this session the handover document could not have listed: ${lines.join("; ")}. They are ALIVE. Collect their results (each record path is listed; a "running" child will send a completion notice, a "pending" one has not started its first turn yet); do NOT re-dispatch this work.`,
						},
					],
					source: { kind: "user" },
				});
				await ctx.sessions?.flush?.(agent.session);
			} catch (error) {
				warn(`handover materialization recheck (${tag}) failed: ${error?.message ?? error}`);
			}
		};
		setTimeout(() => void check("20s"), 20_000);
		setTimeout(() => void check("75s"), 75_000);
	};

	/** Manual handover final step — wake the freshly compacted session: one
	 *  followup user message (the same delivery channel the schedule service
	 *  uses: agent.followup + sessions.flush) instructs the agent to fill
	 *  in the handover document from the compaction summary now in context
	 *  and continue the unfinished task. `live` is the post-compaction
	 *  enumeration; `appeared` are its members that were NOT in the last
	 *  pre-compaction capture — dispatches from the triggering turn that
	 *  only materialized during the compaction window, called out so the
	 *  agent can never mistake them for un-dispatched work. */
	const armContinuation = async (agent, backupId, docFile, live, appeared) => {
		if (typeof agent?.followup !== "function") {
			warn("handover continuation skipped: agent exposes no followup()");
			return;
		}
		const liveCount = Array.isArray(live) ? live.length : 0;
		const appearedCount = Array.isArray(appeared) ? appeared.length : 0;
		const liveSentence =
			liveCount === 0
				? `No dispatched background subagents were live when the compaction landed.`
				: docFile !== null
					? `${liveCount} dispatched background subagent(s) are LIVE and listed in the handover document — collect their results (in-session completion notices, or their session records) instead of re-dispatching duplicate work. The document explains the exact liveness re-check (record.rows paths plus a paste-ready one-liner) and each transcript tail; a send_message "active teammate not found" error is NOT evidence of death.`
					: `${liveCount} dispatched background subagent(s) are LIVE (the handover document could not be written; inline list): ${live
							.map(
								(child) =>
									`${child.id}${child.label ? ` (${child.label})` : ""} [${child.state}] → record ${sessionRecordPath(child.id)}`,
							)
							.join("; ")} — collect their results instead of re-dispatching duplicate work (records live under ${sessionRecordsDir()}/<childId>.json).`;
		const appearedSentence =
			appearedCount > 0
				? `${appearedCount} of them were dispatched before the handover but only MATERIALIZED during the compaction window (catalog entries stamped late) — they are this session's own deferred dispatches, alive; collect them, never re-dispatch their tasks.`
				: `If the compaction summary mentions dispatched subagents that are NOT listed above, they materialized after this enumeration — a post-wake recheck will announce them within seconds; do not re-dispatch anything before it fires.`;
		const instruction = [
			"[SWITCHMAN:HANDOVER] A context handover just completed for this session.",
			backupId !== null
				? `A dormant fork backup holding the full pre-handover state is session ${backupId}.`
				: `No fork backup was created; the append-only session log still holds the full history.`,
			docFile !== null
				? `The handover document is at ${docFile}.`
				: `Create the handover document under .dsh-switchman/handover/ in the working directory.`,
			liveSentence,
			appearedSentence,
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

	/** The shared four-step handover (see the header comment), used by
	 *  manual /ctx-handover and the force-tier automation alike. The
	 *  compaction step retries on a growing backoff: both triggers usually
	 *  fire mid-turn, the runMaintenance behind the borrowed /compact only
	 *  accepts an IDLE agent, and "busy" arrives as a RESOLVED
	 *  {kind:"error"} (not a rejection) — so both branches funnel into
	 *  retryOrFail. Once the agent goes idle the compact lands before the
	 *  next turn's driver (maintenance latches wake requests by design).
	 *  The per-session phase map feeds the force-tier banner so the wait is
	 *  visible instead of silent. */
	const runHandover = async (agent, sessionId, commandId, signal, source = "manual") => {
		if (sessionId === null || agent?.session === undefined)
			return { kind: "error", text: "/ctx-handover: no active session" };
		if (state.inflight.has(sessionId))
			return { kind: "success", text: "[SWITCHMAN:WATERMARK] a handover is already in progress for this session." };
		if (compactDefinition(agent) === undefined)
			return {
				kind: "error",
				text: "/ctx-handover: this session's preset exposes no /compact command, so no compaction backend is reachable.",
			};
		state.inflight.add(sessionId);
		try {
			recordHandover(sessionId, { phase: "backup", source, at: Date.now() });
			const backup = await forkBackup(agent, sessionId, signal);
			const backupId = backup.childId;
			// One document path per handover run (the stamp freezes here so
			// refreshes overwrite the same file). The document itself is
			// written as the LAST action before every compaction attempt —
			// see attempt() below. Writing it here and then sitting through
			// the idle-retry loop is exactly how the 2026-10-05 incident
			// lost deferred dispatches: the triggering turn kept executing
			// after the snapshot, and its subagent dispatches materialized
			// into the catalog only around the post-compaction resume.
			const docPath = handoverDocPath(agent, sessionId);
			let docFile = null; // last successful document write
			let lastLive = []; // last pre-compaction enumeration
			const delays = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
			const outcome = await new Promise((resolve) => {
				let attempts = 0;
				let attempting = false;
				let timer = null;
				let watchdog = null;
				let finished = false;
				let offStatus = null;
				const finish = (ok, reason) => {
					if (finished) return;
					finished = true;
					if (timer !== null) clearTimeout(timer);
					if (watchdog !== null) clearTimeout(watchdog);
					if (offStatus !== null) {
						try {
							offStatus();
						} catch {
							/* best-effort listener dispose */
						}
					}
					resolve({ ok, reason });
				};
				const attempt = async () => {
					if (finished || attempting) return;
					attempting = true;
					attempts += 1;
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
					recordHandover(sessionId, { phase: "compacting", source, attempt: attempts, at: Date.now() });
					// The LAST pre-compaction action: re-enumerate and (re)write
					// the handover document, then immediately compact — nothing
					// mutating in between. On retries this re-captures anything
					// the triggering turn did while the loop waited for the
					// agent to go idle; the document is therefore truthful at
					// the exact moment compaction lands, yet still strictly
					// pre-compaction state.
					try {
						lastLive = await enumerateLiveSubagents(ctx, sessionId);
						docFile = writeHandoverDoc(docPath, sessionId, backupId, measureNow(ctx, agent), lastLive) ?? docFile;
					} catch {
						/* enumeration and the document must never block compaction */
					}
					let promise;
					try {
						promise = sessionCompact(agent, commandId ?? `switchman-${source}-${sessionId}`, signal);
					} catch (error) {
						attempting = false;
						finish(false, `handover failed to start: ${error?.message ?? error}`);
						return;
					}
					if (promise === undefined) {
						attempting = false;
						finish(false, "the per-agent /compact command disappeared");
						return;
					}
					const settleAttempt = (ok, reason) => {
						attempting = false;
						if (ok) {
							finish(true);
							return;
						}
						if (attempts <= delays.length) timer = setTimeout(attempt, delays[attempts - 1]);
						else finish(false, String(reason));
					};
					promise.then(
						(value) => {
							if (value !== null && typeof value === "object" && value.kind === "error") {
								settleAttempt(false, value.text ?? "compact returned an error result");
								return;
							}
							settleAttempt(true);
						},
						(error) => settleAttempt(false, error?.message ?? String(error)),
					);
				};
				// Promptness: the agent/status idle transition (the same event
				// the official compaction layer uses for overflow-retry
				// cleanup) attempts the moment the turn really ends; the
				// timers above stay as the backstop for missed or filtered
				// events. Status reads "idle" externally while our own
				// maintenance runs, and the `attempting` latch collapses
				// those re-entrant events.
				try {
					offStatus = ctx.on("agent/status", (payload) => {
						if (payload?.agent === agent && payload?.status === "idle") attempt();
					});
				} catch {
					/* timer-only fallback */
				}
				// Watchdog: a borrowed /compact that never settles would hold
				// the in-flight latch (and this listener) forever; 20 min is
				// far beyond any real compaction (~2 min observed) yet finite.
				watchdog = setTimeout(
					() => finish(false, "handover watchdog timeout — the borrowed /compact never settled"),
					20 * 60_000,
				);
				attempt();
			});
			if (!outcome.ok)
				return {
					kind: "error",
					text: `/ctx-handover: compaction failed after backup ${backupId ?? "n/a"} — ${outcome.reason}`,
				};
			recordHandover(sessionId, { phase: "continuation", source, at: Date.now() });
			// Final enumeration right after compaction settled: anything that
			// materialized during the compaction window (the deferred-dispatch
			// race the document refresh cannot fully close) is announced in
			// the wake instruction and appended to the document.
			const live = await enumerateLiveSubagents(ctx, sessionId);
			const knownIds = new Set([...lastLive.map((child) => child.id), backupId ?? ""]);
			const appeared = live.filter((child) => !knownIds.has(child.id));
			if (docFile !== null && appeared.length > 0) {
				try {
					appendFileSync(
						docFile,
						[
							``,
							`## Materialized during the compaction window (${new Date().toISOString()})`,
							``,
							`- ${appeared.length} dispatched subagent(s) appeared after the last pre-compaction capture:`,
							...appeared.map(
								(child) =>
									`- \`${child.id}\`${child.label ? ` — ${child.label}` : ""} — ${child.state === "running" ? "RUNNING" : "PENDING"} → record ${sessionRecordPath(child.id)}`,
							),
							`- Dispatched before the handover, materialized late — this session's own work, alive. Collect their results; do NOT re-dispatch.`,
							``,
						].join("\n"),
						"utf8",
					);
				} catch {
					/* append is best-effort; the wake instruction lists them too */
				}
			}
			await armContinuation(agent, backupId, docFile, live, appeared);
			scheduleMaterializationRecheck(agent, sessionId, backupId, docFile, live);
			const backupText = backupId ?? `n/a (${backup.reason ?? "log retains full history"})`;
			return {
				kind: "success",
				text: `[SWITCHMAN:WATERMARK] handover complete — backup ${backupText}, document ${docFile ?? "agent-created"}, compaction done, continuation armed.`,
			};
		} catch (error) {
			return { kind: "error", text: `/ctx-handover failed: ${error?.message ?? error}` };
		} finally {
			clearHandover(sessionId);
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
			runHandover(agent, sessionId, `switchman-auto-${sessionId}`, undefined, "auto").then(
				(result) =>
					ctx.logger?.[result?.kind === "error" ? "warn" : "info"]?.(
						`dsh-switchman: ${result?.text ?? "handover ended"}`,
					),
				(error) => warn(`auto handover crashed: ${error?.message ?? error}`),
			);
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
		description: "Trigger a full context handover for this session now (backup fork + document + compaction + continuation).",
		handler: (invocation) =>
			runHandover(invocation?.agent, sessionIdOf(invocation?.agent), invocation?.commandId, invocation?.signal, "manual"),
	});

	// --- E. ctx_handover: the agent-callable front door to the same
	// four-step handover. The definition uses the register-level shape —
	// bare ctx.tools.register does not run defineTool's DSL compilation,
	// so parameters is a full object-root JSON Schema — and registers
	// best-effort: a validation rejection only skips the tool, never the
	// plugin. execute returns
	// fast on purpose — awaiting the compaction here would keep the agent
	// busy and starve the idle-only /compact — so the flow runs detached
	// and the result tells the model to end its turn immediately.
	try {
		ctx.tools?.register?.({
			name: "ctx_handover",
			description:
				"Trigger a full dsh-switchman context handover for this session NOW: fork a dormant backup session, write the handover document, compact this session at the idle boundary, then wake it to fill in the document and continue the task. Call it when the watermark banner reaches the force tier or the user asks for a handover, then END the turn immediately.",
			parameters: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						description: "Why the handover is triggered now (e.g. 'force tier watermark reached', 'user request'). Optional.",
					},
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute(_args, exec) {
				const agent = exec?.agent;
				const sessionId = sessionIdOf(agent);
				// No exec.signal here on purpose: the compact must outlive the
				// calling turn, and a turn-scoped AbortSignal could abort it.
				runHandover(agent, sessionId, `switchman-tool-${sessionId ?? "session"}`, undefined, "tool").then(
					(result) =>
						ctx.logger?.[result?.kind === "error" ? "warn" : "info"]?.(
							`dsh-switchman: ${result?.text ?? "handover ended"}`,
						),
					(error) => warn(`ctx_handover handover crashed: ${error?.message ?? error}`),
				);
				return "[SWITCHMAN:WATERMARK] ctx_handover scheduled: backup fork + handover document + compaction + continuation are running. END this turn now — reply briefly and call no more tools, so the compaction lands at the idle boundary. Your closing line must tell the user the handover is running in the background and will continue automatically (the session-header badge shows the live state) — otherwise the GUI looks idle during fork+compact.";
			},
			presentCall: (args) => ({
				card: "generic",
				title: "Switchman context handover",
				kind: "other",
				rawInput: args,
			}),
		});
		state.handoverTool = "ctx_handover";
	} catch (error) {
		warn(`ctx_handover tool registration failed: ${error?.message ?? error}`);
	}
}

export { applyContextWatch };
