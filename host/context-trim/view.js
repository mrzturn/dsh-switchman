/** dsh-switchman context-trim view builder (pure).
 *
 * The outbound-view half of the context-trim port (design:
 * .dsh-switchman/analysis/context-trim-port-design.md §4): folds stored in
 * a session ledger replace contiguous message ranges with ONE synthetic
 * user message each. Everything here is pure and deterministic — the same
 * (messages, ledger) pair must render a byte-identical view on every call
 * (the golden test pins this), because a stable serialized prefix between
 * folds is exactly what keeps provider prompt-cache hits alive.
 *
 * Message refs: messages at the llm/stream boundary are plain JSON-ish
 * objects ({id?, role, content blocks / text}). An explicit id is trusted
 * only when it looks addressable (short, no whitespace/control chars — the
 * same validation billion-context applies); otherwise the ref is derived as
 * a content hash of the canonicalized message (stable key order, volatile
 * fields dropped), which survives the full-history re-send the agent loop
 * performs every turn. Fold blocks anchor on refs, so a ledger keeps
 * applying across process restarts without a parallel session log.
 *
 * Fail-open: blocks whose refs cannot be located (history rewritten by a
 * racing compaction, content mutated) or that would reach into the
 * protected tail are skipped, never guessed at — a stale ledger can only
 * degrade to "no fold applied", never to lost messages.
 */

import { createHash } from "node:crypto";

/** Cheap char → token estimate (the brief's char/4 heuristic). */
export const TOKENS_PER_CHAR = 1 / 4;

/** Object keys dropped before hashing (volatility would churn refs). */
const VOLATILE_KEYS = new Set(["ts", "time", "timestamp", "createdAt", "updatedAt", "receivedAt", "sentAt"]);

/** Canonicalization depth cap (well beyond any real message nesting). */
const MAX_CANON_DEPTH = 8;

/** Canonical JSON of one value: object keys sorted, volatile keys dropped,
 * arrays kept in order. Used ONLY for ref hashing, never for output. */
function canonicalValue(value, depth) {
	if (value === null || typeof value !== "object") {
		if (typeof value === "bigint") return String(value);
		if (typeof value === "number" && !Number.isFinite(value)) return null;
		return value;
	}
	if (depth >= MAX_CANON_DEPTH) return "[depth]";
	if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1));
	const out = {};
	for (const key of Object.keys(value).sort()) {
		if (VOLATILE_KEYS.has(key)) continue;
		out[key] = canonicalValue(value[key], depth + 1);
	}
	return out;
}

/** Canonical JSON text of one message (ref-hash input). */
function canonicalizeMessage(message) {
	try {
		return JSON.stringify(canonicalValue(message ?? null, 0)) ?? "null";
	} catch {
		return String(message);
	}
}

/** True when an explicit message id is safe to address directly. */
function usableId(id) {
	if (typeof id !== "string" || id === "" || id.length > 512) return false;
	for (const char of id) {
		const code = char.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** Stable ref of one message: the explicit id when usable, else a short
 * content hash (prefixed "h" so the two families can be told apart in
 * logs). Index is unused for hashing — refs are position-independent on
 * purpose (the host may prepend/insert nothing, but ids may be absent). */
export function refOf(message, _index) {
	const id = message?.id;
	if (usableId(id)) return id;
	return `h${createHash("sha256").update(canonicalizeMessage(message)).digest("hex").slice(0, 12)}`;
}

/** ref -> ascending index list for one messages array. */
export function refPositions(messages) {
	const positions = new Map();
	messages.forEach((message, index) => {
		const ref = refOf(message, index);
		const list = positions.get(ref);
		if (list === undefined) positions.set(ref, [index]);
		else list.push(index);
	});
	return positions;
}

/** Estimated token count of one message (text content + tool-call payloads
 * + small per-message framing overhead). Never throws. */
export function messageTokens(message) {
	let chars = 8;
	const content = message?.content;
	try {
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (block !== null && typeof block === "object" && typeof block.text === "string") chars += block.text.length;
				else chars += JSON.stringify(block ?? null).length;
			}
		}
		if (Array.isArray(message?.tool_calls)) chars += JSON.stringify(message.tool_calls).length;
	} catch {
		/* unserializable block: keep the framing estimate */
	}
	return Math.max(1, Math.round(chars * TOKENS_PER_CHAR));
}

/** Estimated token count of a message range (inclusive indices). */
export function estimateTokensOf(messages, startIdx = 0, endIdx = messages.length - 1) {
	let total = 0;
	for (let i = Math.max(0, startIdx); i <= Math.min(messages.length - 1, endIdx); i++) total += messageTokens(messages[i]);
	return total;
}

// ---- tool-pair segmentation -------------------------------------------------

/** True when the message OPENS tool calls (either wire shape). */
function opensToolCalls(message) {
	if (message?.role !== "assistant") return false;
	if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
	if (Array.isArray(message.content)) return message.content.some((block) => block?.type === "tool_use");
	return false;
}

/** True when the message CARRIES tool results (either wire shape). */
function carriesToolResults(message) {
	if (message?.role === "tool") return true;
	if (Array.isArray(message.content)) return message.content.some((block) => block?.type === "tool_result");
	return false;
}

/** Atomic segments of a messages array: an assistant message that opens
 * tool calls plus every directly following tool-result message form ONE
 * segment (they must live or fold together — a split pair is rejected by
 * the upstream API, dsh-compaction/lib/index.js:557 validates the same
 * rule); every other message is its own segment. Returns [start, end]
 * index pairs covering the array in order. */
export function segmentBounds(messages) {
	const bounds = [];
	let i = 0;
	while (i < messages.length) {
		let end = i;
		if (opensToolCalls(messages[i])) {
			let j = i + 1;
			while (j < messages.length && carriesToolResults(messages[j])) j++;
			end = j - 1;
		}
		bounds.push([i, end]);
		i = end + 1;
	}
	return bounds;
}

/** True when [startIdx, endIdx] aligns with segment boundaries (a fold
 * range must never cut inside a tool pair). */
export function rangeIsSegmentAligned(messages, startIdx, endIdx) {
	if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || startIdx < 0 || endIdx < startIdx) return false;
	// The range must START at a segment start and END at a segment end (it may
	// span any number of whole segments — segments tile the array contiguously,
	// so aligned ends guarantee no tool pair is cut).
	let startHit = false;
	for (const [start, end] of segmentBounds(messages)) {
		if (start === startIdx) startHit = true;
		if (end === endIdx) return startHit && start <= endIdx;
		if (start > endIdx) break;
	}
	return false;
}

// ---- fold blocks ------------------------------------------------------------

/** Deterministic wire text of one fold block's synthetic message. */
export function renderSummaryText(block) {
	return `[SWITCHMAN:TRIM] ${block.summary}`;
}

/** The ONE synthetic message replacing a folded range (brief: synthetic
 * user message; id carries the acp_summary_ prefix downstream tooling
 * skips). Pure — same block, same bytes. */
export function summaryMessageOf(block) {
	return {
		id: `acp_summary_${block.id}`,
		role: "user",
		content: [{ type: "text", text: renderSummaryText(block) }],
	};
}

/** Locate a block's range in a positions map at/after afterIdx. Strict:
 * both endpoint refs must resolve and the located span must equal the
 * block's stored message count (guards against re-sent histories that no
 * longer match the folded range). Returns [firstIdx, lastIdx] or null. */
function locateBlock(positions, block, afterIdx) {
	const range = block?.refRange;
	if (range === null || typeof range !== "object") return null;
	const firstList = positions.get(range.firstId);
	const lastList = positions.get(range.lastId);
	if (firstList === undefined || lastList === undefined) return null;
	const anchored = Number.isInteger(block.count) && block.count > 0;
	let firstIdx = null;
	let lastIdx = null;
	for (const start of firstList) {
		if (start <= afterIdx) continue;
		if (anchored) {
			// Duplicate-content messages share one content-addressed ref, so
			// resolve the pair anchored on the stored count, not on extremes.
			const end = start + block.count - 1;
			if (!lastList.includes(end)) continue;
			firstIdx = start;
			lastIdx = end;
		} else {
			firstIdx = start;
		}
		break;
	}
	if (firstIdx === null) return null;
	if (lastIdx === null) {
		for (const index of lastList) {
			if (index >= firstIdx) {
				lastIdx = index;
				break;
			}
		}
		if (lastIdx === null) return null;
	}
	const span = lastIdx - firstIdx + 1;
	const expected = anchored ? block.count : span;
	return span === expected ? [firstIdx, lastIdx] : null;
}

/** Build the outbound view: apply every applicable fold block to a copy of
 * the messages array. Pure (never mutates the input; the assembly splices
 * the result into the live request array). Blocks apply in positional
 * order; a block that cannot be located, overlaps an already-applied one,
 * or reaches into the last protectedTail messages is skipped. Returns
 * { messages, applied, foldedMessages } (foldedMessages = live messages
 * the applied blocks replaced). */
export function buildView(messages, ledger, options = {}) {
	const protectedTail = Number.isInteger(options.protectedTail) && options.protectedTail > 0 ? options.protectedTail : 0;
	const blocks = Array.isArray(ledger?.blocks) ? ledger.blocks : [];
	const positions = refPositions(messages);
	const located = [];
	let unlocated = 0;
	for (const block of blocks) {
		const range = locateBlock(positions, block, -1);
		if (range !== null) located.push({ block, firstIdx: range[0], lastIdx: range[1] });
		else unlocated += 1;
	}
	located.sort((a, b) => a.firstIdx - b.firstIdx || b.lastIdx - a.lastIdx);
	const out = [];
	let at = 0;
	let applied = 0;
	let foldedMessages = 0;
	for (const entry of located) {
		if (entry.firstIdx < at) continue; // overlaps an applied block — skip
		if (protectedTail > 0 && entry.lastIdx >= messages.length - protectedTail) continue;
		if (!rangeIsSegmentAligned(messages, entry.firstIdx, entry.lastIdx)) continue; // never split a tool pair (design §4)
		for (let i = at; i < entry.firstIdx; i++) out.push(messages[i]);
		out.push(summaryMessageOf(entry.block));
		foldedMessages += entry.lastIdx - entry.firstIdx + 1;
		at = entry.lastIdx + 1;
		applied += 1;
	}
	for (let i = at; i < messages.length; i++) out.push(messages[i]);
	return { messages: out, applied, foldedMessages, unlocated };
}

/** Epoch-boundary detection: every block failed to LOCATE inside the current
 * re-send — the host replaced history (its own compaction) and the ledger
 * aged out as a whole. The fail-open skip stays correct, but a growth
 * baseline carried over from the previous epoch does not: the caller
 * re-anchors it exactly once per epoch. */
export function ledgerIsStale(view, ledger) {
	const blocksCount = Array.isArray(ledger?.blocks) ? ledger.blocks.length : 0;
	return blocksCount > 0 && view.applied === 0 && view.unlocated === blocksCount;
}

/** Install the built view for one dispatch. Host immutability varies: probe
 * and fresh re-sends hand out mutable arrays (splice in place — cheapest,
 * identity-preserving), resumed sessions re-send FROZEN host-assembled
 * history (splice throws on its internal index deletes), and some dispatch
 * options are frozen objects on top of that. Returns the strategy used so
 * the caller can log it: "in-place" | "swapped" | "none". */
export function injectView(options, messages, view) {
	if (view.applied > 0) {
		try {
			replaceInPlace(messages, view.messages);
			return "in-place";
		} catch {
			/* frozen array — fall through to the reference swap */
		}
		try {
			options.messages = view.messages;
			return "swapped";
		} catch {
			/* frozen options — this dispatch cannot carry the view; fail open */
		}
	}
	return "none";
}

/** Replace an array's CONTENT in place (identity preserved — the llm/stream
 * contract mutates the live request array). Chunked pushes keep huge
 * histories clear of the argument-count limit. */
export function replaceInPlace(target, source) {
	target.splice(0, target.length);
	for (let i = 0; i < source.length; i += 2048) target.push(...source.slice(i, i + 2048));
	return target;
}
