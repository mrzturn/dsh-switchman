/** dsh-switchman context-trim summarizer.
 *
 * Produces the summary text for one fold block, three ways:
 *
 * - summarizeWithModel — the L3 path (design §5): a side-model call via
 *   llm.prepareCall + call.stream (receiver-bound on the llm service, the
 *   same waterfall pattern intent classification uses). Guarded by a hard
 *   deadline (AbortController); ANY failure (timeout, error chunk, empty
 *   output) returns null and the caller skips the fold cycle — fail-open.
 *   A length-finished (output-limit) summary is NOT a failure: it returns
 *   the text prefixed with TRUNCATED_SUMMARY_MARK so the missing tail
 *   stays visible (inspection S2).
 *   Used by BOTH the raw T1 folds (renderMaterial) and the ladder T2/T3
 *   distillations (renderLadderMaterial, LADDER_SYSTEM_PROMPT).
 * - mechanicalSummary — the deterministic fallback used by the emergency
 *   tier: structural heads of each message, no model round trip. Never
 *   used for ladder folds (mechanical summary-of-summaries reclaims little
 *   and corrupts craft — docs/ladder-fold.md).
 *
 * The summary prompts carry the bili compression rules: message refs and
 * file paths verbatim, decisions WITH rationale, exact values, open
 * objectives carry forward, verbose logs drop.
 */

import { randomUUID } from "node:crypto";

/** Default side-model summary deadline. Large increments legitimately
 * take a while; the emergency tier does not wait on this path at all. */
export const SUMMARY_TIMEOUT_MS = 120_000;

/** Material cap: beyond this the render keeps head+tail and marks the cut
 * (a 1M-token material would burn the side-model call for no fidelity). */
export const MAX_MATERIAL_CHARS = 400_000;

/** Prefix for a summary whose side-model output ended early (finish=length):
 * the text otherwise reads as settled fact while its tail is missing — and
 * ladder T2/T3 distillation builds on summaries as established facts, so
 * the gap must stay visible on the wire. Prefixed, not rejected: the fold
 * still relieves pressure, and re-running at the same maxTokens would
 * truncate again. (inspection S2) */
export const TRUNCATED_SUMMARY_MARK = "[truncated summary: the summarizer's output hit its limit (finish=length) — content after the cut may be missing] ";

/** System prompt for the side-model summarizer. English per repo docs
 * style; the OUTPUT language follows the summarized material. */
export const SUMMARY_SYSTEM_PROMPT = [
	"You compress one contiguous range of a coding-agent conversation into ONE self-contained plain-text summary that will replace that range permanently.",
	"",
	"KEEP VERBATIM:",
	"- Full file paths with line numbers (lib/hooks.ts:347) — never bare filenames.",
	"- Function/class/type signatures and the critical code line that encodes a finding.",
	"- Error messages and stack-trace key lines (exact text).",
	"- Exact values: versions, config keys, thresholds, magic numbers.",
	"- Decisions WITH their rationale (the because is load-bearing).",
	"- Open objectives, unresolved TODOs, and open questions, each tagged with its message ref.",
	"",
	"DROP (keep one line of lesson for failures): verbose logs once the error line is captured, repeated file reads, dead-end exploration details, back-and-forth discussion once the outcome is recorded.",
	"",
	"FORMAT:",
	"- Dense bullets, short thematic headers; no narrative prose.",
	"- Reference messages as [m<ref>] using the refs in the material.",
	"- Write the summary in the same language as the material.",
	"- Output ONLY the summary text.",
].join("\n");

/** Flat text body of one message (content blocks joined, unserializable
 * values tolerated). Shared by renderMaterial and the zero-material
 * rescue path. */
function renderMessageBody(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const chunks = [];
		for (const block of content) {
			if (block !== null && typeof block === "object" && typeof block.text === "string") chunks.push(block.text);
			else {
				try {
					chunks.push(JSON.stringify(block ?? null));
				} catch {
					chunks.push("[unserializable]");
				}
			}
		}
		return chunks.join("\n");
	}
	try {
		return JSON.stringify(message ?? null);
	} catch {
		return "[unserializable]";
	}
}

/** Render the fold material for one message range: labeled, ref-stamped
 * blocks. Deterministic (same slice, same bytes) — refs come from refOf so
 * id-less messages stay stable across re-sends. */
export function renderMaterial(messages, startIdx, endIdx, refOf) {
	const parts = [];
	let chars = 0;
	let truncated = false;
	for (let i = startIdx; i <= endIdx; i++) {
		const message = messages[i];
		const ref = refOf(message, i);
		const role = typeof message?.role === "string" ? message.role : "unknown";
		let text = renderMessageBody(message);
		if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
			try {
				text += `\n[tool_calls] ${JSON.stringify(message.tool_calls)}`;
			} catch {
				/* keep the base text */
			}
		}
		const head = `--- [m${ref}] (${role}) ---\n`;
		const body = `${text}\n\n`;
		if (chars + head.length + body.length > MAX_MATERIAL_CHARS) {
			truncated = true;
			break;
		}
		parts.push(head + body);
		chars += head.length + body.length;
	}
	if (truncated) {
		// [2026-11-07]-[a single over-ceiling message used to render ZERO
		// material]-[parts stayed empty, the side model was asked to compress
		// nothing, and the giant message got permanently replaced by a
		// content-free summary. Keep the FIRST message's head plus a capped
		// prefix so the summary at least carries what the message is.]
		if (parts.length === 0 && startIdx <= endIdx) {
			const first = messages[startIdx];
			const firstRef = refOf(first, startIdx);
			const role = typeof first?.role === "string" ? first.role : "unknown";
			parts.push(`--- [m${firstRef}] (${role}) ---\n${renderMessageBody(first).slice(0, 2_000)}\n\n`);
		}
		parts.push(`--- [...material truncated after ${chars} chars; ${endIdx - startIdx + 1 - parts.length} messages dropped from this render...] ---\n`);
	}
	return parts.join("");
}

/** Distillation system prompt for the ladder tiers (T2 merges active T1
 * summaries; T3 merges active T2 summaries). The output replaces its
 * inputs PERMANENTLY — the craft rules are the same KEEP/DROP priorities,
 * applied one level up. */
export const LADDER_SYSTEM_PROMPT = [
	"You distill several context-fold summaries of one coding-agent session into ONE shorter self-contained plain-text summary that permanently replaces them.",
	"",
	"Treat the input summaries as facts already settled: never re-derive, never contradict, merge overlapping points.",
	"",
	"KEEP VERBATIM:",
	"- Full file paths with line numbers (lib/hooks.ts:347) — never bare filenames.",
	"- Function/class/type signatures and the critical code line that encodes a finding.",
	"- Error messages and stack-trace key lines (exact text).",
	"- Exact values: versions, config keys, thresholds, magic numbers.",
	"- Decisions WITH their rationale (the because is load-bearing).",
	"- Open objectives, unresolved TODOs, and open questions, each tagged with its original message refs.",
	"",
	"DROP (one line of lesson per failure stays): verbose detail once the exact value is captured, repetition between the summaries, settled exploration, process narration.",
	"",
	"FORMAT:",
	"- Dense bullets, short thematic headers; no narrative prose.",
	"- Keep the [m<ref>] anchors for anything a later step may need to unfold.",
	"- Write the summary in the same language as the input summaries.",
	"- Output ONLY the summary text.",
].join("\n");

/** Render the ladder distillation material for one run of consumed blocks:
 * labeled, block-stamped sections (deterministic — same blocks, same
 * bytes). Capped by the same material ceiling as renderMaterial. */
export function renderLadderMaterial(blocks) {
	const parts = [];
	let chars = 0;
	let truncated = false;
	for (const block of blocks) {
		const tier = block?.tier === 3 ? 3 : block?.tier === 2 ? 2 : 1;
		const tokens = Number.isFinite(block?.approxTokens) ? Math.round(block.approxTokens) : "?";
		const count = Number.isInteger(block?.count) && block.count > 0 ? block.count : "?";
		const summary = typeof block?.summary === "string" ? block.summary : "";
		const head = `--- [block ${block?.id ?? "?"}] (tier ${tier}, ~${tokens} tokens, ${count} msgs) ---\n`;
		const body = `${summary}\n\n`;
		if (chars + head.length + body.length > MAX_MATERIAL_CHARS) {
			truncated = true;
			break;
		}
		parts.push(head + body);
		chars += head.length + body.length;
	}
	if (truncated) parts.push(`--- [...material truncated after ${chars} chars; ${blocks.length - parts.length} blocks dropped from this render...] ---\n`);
	return parts.join("");
}

/** Emergency-tier mechanical summary: deterministic structural heads (no
 * model call). One line per message: ref, role, first line (capped). */
export function mechanicalSummary(messages, startIdx, endIdx, refOf) {
	const lines = [`Mechanical fold of ${endIdx - startIdx + 1} messages (emergency tier; no model summary available).`, ""];
	for (let i = startIdx; i <= endIdx; i++) {
		const message = messages[i];
		const ref = refOf(message, i);
		const role = typeof message?.role === "string" ? message.role : "unknown";
		const content = message?.content;
		let firstLine = "";
		if (typeof content === "string") firstLine = content;
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (block !== null && typeof block === "object" && typeof block.text === "string" && block.text.trim() !== "") {
					firstLine = block.text;
					break;
				}
			}
		}
		const line = firstLine.replace(/\s+/gu, " ").trim().slice(0, 160);
		lines.push(`- [m${ref}] (${role}) ${line === "" ? "(no text content)" : line}`);
	}
	lines.push("", "Open objectives and exact details are NOT preserved by this mechanical fold; the next model-driven fold will supersede it.");
	return lines.join("\n");
}

/** One-line suffix carrying the adapter's failure detail: DSH terminal
 * finishes ride { reason: { kind, failure: { message, code, status? } } } —
 * without this the decisions.log only ever sees finishKind, and upstream
 * rejections (quota/concurrency/risk) stay invisible. Single-lined, capped. */
function describeFailure(chunk) {
	const failure = chunk?.reason?.failure ?? chunk?.failure ?? null;
	const raw = typeof failure?.message === "string" && failure.message !== ""
		? failure.message
		: (typeof failure?.code === "string" && failure.code !== "" ? failure.code : "");
	if (raw === "") return "";
	return ` (${raw.replace(/\s+/gu, " ").trim().slice(0, 300)})`;
}

/** Side-model summary. llm: the dsh llm service (receiver-bound methods);
 * route: { provider, model } | null (null → caller skips); materialText:
 * renderMaterial output; options.systemPrompt overrides the default
 * compression prompt (the ladder distillation passes its own); deadlineMs:
 * hard budget. Returns the summary text, or null on ANY failure (caller
 * skips the fold cycle). */
export async function summarizeWithModel(llm, route, materialText, options = {}) {
	const fail = typeof options.onFail === "function" ? options.onFail : null;
	if (route === null || route === undefined) { fail?.("no-route"); return null; }
	if (typeof llm?.prepareCall !== "function") { fail?.("no-prepare-call"); return null; }
	const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : SUMMARY_TIMEOUT_MS;
	const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 8_192;
	const systemPrompt = typeof options.systemPrompt === "string" && options.systemPrompt !== "" ? options.systemPrompt : SUMMARY_SYSTEM_PROMPT;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("trim summary deadline")), deadlineMs);
	try {
		const call = await llm.prepareCall(
			{ provider: route.provider, model: route.model, maxTokens },
			controller.signal,
			(controls) => controls,
		);
		let text = "";
		let finishKind = null;
		// stream options MUST carry the prepared call config — the adapter
		// dispatch binds credentials/routing from it (same waterfall shape as
		// the intent classifier; dropping it fails prepare-time integrity).
		// system rides as a top-level option and the user message carries a
		// source tag, exactly like the intent classifier's proven shape.
		const streamOptions = {
			...call.config,
			system: systemPrompt,
			messages: [
				{ id: randomUUID(), role: "user", content: [{ type: "text", text: materialText }], source: { kind: "dsh-switchman-trim-summary" } },
			],
			signal: controller.signal,
		};
		for await (const chunk of call.stream(streamOptions)) {
			if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
			else if (chunk?.type === "finish") {
				// The translator's clean stop is { type:'finish', reason:{kind:'stop'} } —
				// no top-level kind. Read the nested reason first so clean EOFs log
				// finish=stop (not finish=none), and treat abort/error finishes as
				// explicit failures in either shape.
				const topKind = chunk.kind ?? null;
				finishKind = chunk.reason?.kind ?? topKind;
				if (topKind === "error" || topKind === "aborted" || finishKind === "error" || finishKind === "aborted") {
					fail?.(`stream-${finishKind}${describeFailure(chunk)}`);
					return null;
				}
			}
		}
		const summary = text.trim();
		if (summary === "") { fail?.(`empty-output finish=${finishKind ?? "none"}`); return null; }
		// A length/max-tokens finish means the tail of the material never got
		// summarized, yet the text that DID land reads as settled fact — mark it
		// so every later consumer (view rendering, ladder distillation) sees the
		// gap. DSH's FinishReasonMap has no "length" kind: adapters map
		// finish_reason=length to kind "max-tokens" (llm-deepseek translate).
		if (finishKind === "length" || finishKind === "max-tokens") return `${TRUNCATED_SUMMARY_MARK}${summary}`;
		return summary;
	} catch (error) {
		fail?.(`error: ${error?.message ?? error}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
