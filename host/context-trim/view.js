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
 * LADDER VIEW (docs/ladder-fold.md): the rebuild is a deterministic
 * three-pass overlay. Pass 1 locates every T1 block — active AND consumed —
 * on the raw messages (a consumed T1 summary is the ladder's raw material,
 * so it must render). Pass 2 replaces each active T2 block's consumed-run
 * summary messages with the T2 summary; pass 3 does the same for active T3
 * blocks over the T2 summaries. Fail-open: a ladder block whose consumed
 * run is missing, non-adjacent, or already covered is skipped for this
 * view, never guessed.
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

/** Ladder-block probe, inlined to keep the state.js ⇄ view.js import graph
 * acyclic (state.js imports this module's estimators). A ladder block is
 * an active distillation of other blocks: tier 2 or 3, no raw refRange. */
function isLadderBlock(block) {
	return block !== null && typeof block === "object" && (block.tier === 2 || block.tier === 3);
}

/** Cheap char → token estimate (the brief's char/4 heuristic). Applies to
 *  ASCII/latin text; CJK text tokenizes far denser (see below). */
export const TOKENS_PER_CHAR = 1 / 4;

/** CJK/fullwidth chars cost roughly ONE token each in the glm/deepseek BPE
 *  vocabularies (vs 0.25 for the char/4 ASCII heuristic). Pinned at 1.0:
 *  slightly high for common hanzi bigrams, which errs toward earlier folds
 *  (the safe direction). NOT the 2026-11-04 incident root cause (that session
 *  was only 4.8% CJK — the real bug was frozen-dispatch view injection); this
 *  is a general accuracy fix for CJK-heavy sessions. */
export const TOKENS_PER_CJK_CHAR = 1;

/** CJK-ish ranges: kana, Hangul jamo+syllables, CJK radicals/blocks and
 *  unified ideographs (incl. Ext-A), compat ideographs, vertical forms,
 *  fullwidth forms, and the supplementary-plane CJK extensions (Ext-B..F,
 *  /u flag — astral chars otherwise count as two ascii units). Halfwidth
 *  katakana (\uFF61-\uFF9F) rides in the fullwidth range at the CJK weight:
 *  slightly high, the safe direction for fold scheduling. */
const CJK_CHAR_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/gu;

/** Split one text into (asciiChars, cjkChars) in one pass over the string.
 *  The replace allocates a second string — same order of cost as the
 *  JSON.stringify this sits next to. */
function countChars(text) {
	let plain;
	try {
		plain = text.replace(CJK_CHAR_RE, "");
	} catch {
		return { ascii: text.length, cjk: 0 };
	}
	return { ascii: plain.length, cjk: text.length - plain.length };
}

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
 * + small per-message framing overhead). CJK-aware — see TOKENS_PER_CJK_CHAR.
 * Never throws. */
export function messageTokens(message) {
	let ascii = 8; // per-message framing overhead, counted in the ascii pool
	let cjk = 0;
	const content = message?.content;
	try {
		if (typeof content === "string") {
			const counted = countChars(content);
			ascii += counted.ascii;
			cjk += counted.cjk;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				const text = block !== null && typeof block === "object" && typeof block.text === "string" ? block.text : JSON.stringify(block ?? null);
				const counted = countChars(text);
				ascii += counted.ascii;
				cjk += counted.cjk;
			}
		}
		if (Array.isArray(message?.tool_calls)) {
			const counted = countChars(JSON.stringify(message.tool_calls));
			ascii += counted.ascii;
			cjk += counted.cjk;
		}
	} catch {
		/* unserializable block: keep the framing estimate */
	}
	return Math.max(1, Math.round(ascii * TOKENS_PER_CHAR + cjk * TOKENS_PER_CJK_CHAR));
}

/** Estimated token count of a message range (inclusive indices). */
export function estimateTokensOf(messages, startIdx = 0, endIdx = messages.length - 1) {
	let total = 0;
	for (let i = Math.max(0, startIdx); i <= Math.min(messages.length - 1, endIdx); i++) total += messageTokens(messages[i]);
	return total;
}

// ---- tool-pair segmentation -------------------------------------------------

/** True when the message OPENS tool calls. Covers the DSH-native shape
 *  (assistant content block {type:'tool-call', id} — packages/llm/llm/src/
 *  types.ts ToolCallBlock) plus the provider-shaped variants: the OpenAI
 *  message.tool_calls array and the Anthropic {type:'tool_use'} block. The
 *  DSH-native shape is what actually reaches this plugin's captures; missing
 *  it made every native assistant tool call look like a plain message, so
 *  segmentBounds below split the call from its results. */
function opensToolCalls(message) {
	if (message?.role !== "assistant") return false;
	if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
	if (Array.isArray(message.content)) return message.content.some((block) => block?.type === "tool_use" || block?.type === "tool-call");
	return false;
}

/** True when the message CARRIES tool results. DSH-native results are
 *  role:'tool' messages (with their call id on the message); provider-shaped
 *  variants keep a tool_result/tool-result content block. */
function carriesToolResults(message) {
	if (message?.role === "tool") return true;
	if (Array.isArray(message.content)) return message.content.some((block) => block?.type === "tool_result" || block?.type === "tool-result");
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

/** Deterministic wire text of one fold block's synthetic message. The
 * [SWITCHMAN:TRIM] content prefix is the downstream recognition anchor
 * (surface.js, session tooling) and stays IDENTICAL for every tier — the
 * ladder lives in the ledger, not in the wire text shape. */
export function renderSummaryText(block) {
	return `[SWITCHMAN:TRIM] ${block.summary}`;
}

/** Wire-id prefix of every fold-summary synthetic message. The single
 * definition: summaryMessageOf builds ids from it, isFoldSummaryMessage
 * recognizes them, and ladder relocation re-derives the same ids. */
export const FOLD_SUMMARY_ID_PREFIX = "acp_summary_";

/** The ONE synthetic message replacing a folded range (brief: synthetic
 * user message; id carries the acp_summary_ prefix downstream tooling
 * skips). Pure — same block, same bytes. The ladder replaces messages BY
 * this id (id-suffix = block id), which is why ids must stay stable. */
export function summaryMessageOf(block) {
	return {
		id: `${FOLD_SUMMARY_ID_PREFIX}${block.id}`,
		role: "user",
		content: [{ type: "text", text: renderSummaryText(block) }],
	};
}

/** True when one wire message is a prior fold's synthetic summary
 * (acp_summary_<blockId>). Recognition rides the id prefix only — never
 * the source kind (the v4 validator rejects compact-checkpoint sources
 * outside a compaction/start..end pair). Range selection and the advisory
 * fold tool use this to KEEP summaries out of new raw folds: summaries
 * stay live on the surface and consolidate only through ladder T2/T3. */
export function isFoldSummaryMessage(message) {
	return typeof message?.id === "string" && message.id.startsWith(FOLD_SUMMARY_ID_PREFIX);
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

// ---- ladder passes ------------------------------------------------------------

/** Summary-id positions of one intermediate view: id suffix (the block id)
 * -> index, for every synthetic message. One index per id (a block renders
 * at most once — single consumption). */
function summaryPositionsOf(messages) {
	const prefix = FOLD_SUMMARY_ID_PREFIX;
	const positions = new Map();
	messages.forEach((message, index) => {
		const id = message?.id;
		if (typeof id !== "string" || !id.startsWith(prefix)) return;
		positions.set(id.slice(prefix.length), index);
	});
	return positions;
}

/** Validate one ladder block's consumed run against a positions map: every
 * consumed id present, indices strictly consecutive ascending. Returns
 * [firstIdx, lastIdx] or null (fail-open skip). */
function locateLadderRun(positions, block) {
	const consumes = Array.isArray(block?.consumes) ? block.consumes : [];
	if (consumes.length === 0) return null;
	let prev = null;
	let firstIdx = -1;
	for (const id of consumes) {
		const at = positions.get(id);
		if (at === undefined) return null;
		if (prev !== null && at !== prev + 1) return null;
		prev = at;
		if (firstIdx < 0) firstIdx = at;
	}
	return [firstIdx, prev];
}

/** Apply one tier's ladder pass to the working view. Participation (docs/
 * ladder-fold.md): ACTIVE tier-`tier` blocks replace their consumed runs —
 * AND inactive tier-`tier` blocks consumed by an ACTIVE tier-`tier+1` block
 * render their summary as pure ANCHOR material (a T3's consumed T2 summary
 * must exist in the intermediate view or the T3 pass could never locate
 * its run). Anchors replaced by the next pass do not double-count
 * `applied`. Entries that fail their adjacency/completeness check are
 * skipped (never guessed); valid runs are disjoint by construction (single
 * consumption) and applied from the highest start index backward, so
 * earlier indices stay valid while splicing. Returns the new array. */
function applyLadderTier(messages, ladderBlocks, tier, state) {
	if (ladderBlocks.length === 0) return messages;
	const participants = [];
	for (const block of ladderBlocks) {
		if (block.tier !== tier) continue;
		if (block.active === true) {
			participants.push(block);
			continue;
		}
		// Inactive block: an anchor only when an ACTIVE next-tier block
		// directly consumed it.
		const consumedByActive = ladderBlocks.some((other) => other.active === true && other.tier === tier + 1 && Array.isArray(other.consumes) && other.consumes.includes(block.id));
		if (consumedByActive) participants.push(block);
	}
	if (participants.length === 0) return messages;
	const positions = summaryPositionsOf(messages);
	const runs = [];
	for (const block of participants) {
		const run = locateLadderRun(positions, block);
		if (run === null) continue;
		runs.push({ block, firstIdx: run[0], lastIdx: run[1] });
	}
	runs.sort((a, b) => b.firstIdx - a.firstIdx); // apply back-to-front
	const out = messages.slice();
	for (const run of runs) {
		if (run.lastIdx >= out.length) continue;
		// Splice the run out and drop the ladder summary in its place.
		out.splice(run.firstIdx, run.lastIdx - run.firstIdx + 1, summaryMessageOf(run.block));
		if (run.block.active === true) state.applied += 1;
	}
	return out;
}

/** Build the outbound view: apply every applicable fold block to a copy of
 * the messages array. Pure (never mutates the input; the assembly splices
 * the result into the live request array). The rebuild is deterministic
 * three-pass ladder overlay (docs/ladder-fold.md):
 * 1. every T1 block — active AND consumed — locates on raw messages and
 *    splices its summary (consumed T1 summaries are the ladder's material);
 * 2. active T2 blocks replace their consumed runs of T1 summaries;
 * 3. active T3 blocks replace their consumed runs of T2 summaries.
 * A block that cannot be located, overlaps an already-applied one, or
 * reaches into the last protectedTail messages is skipped. Returns
 * { messages, applied, foldedMessages, unlocated } (foldedMessages = live
 * raw messages the applied T1 blocks replaced). */
export function buildView(messages, ledger, options = {}) {
	const protectedTail = Number.isInteger(options.protectedTail) && options.protectedTail > 0 ? options.protectedTail : 0;
	const blocks = Array.isArray(ledger?.blocks) ? ledger.blocks : [];
	const t1Blocks = blocks.filter((block) => block !== null && typeof block === "object" && block.refRange !== null);
	// Ladder blocks participate regardless of active: ACTIVE ones replace
	// their consumed runs; INACTIVE ones may be pure anchors for the next
	// tier's pass (applyLadderTier decides per block).
	const ladderBlocks = blocks.filter((block) => block !== null && typeof block === "object" && isLadderBlock(block));
	const positions = refPositions(messages);
	const located = [];
	let unlocated = 0;
	for (const block of t1Blocks) {
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
		// The system prompt at index 0 is never foldable: splicing it off the
		// wire would drop the prompt itself. Plain skip (not unlocated) so
		// the ledgerIsStale epoch semantics stay untouched.
		if (entry.firstIdx === 0 && messages[0]?.role === "system") continue;
		if (!rangeIsSegmentAligned(messages, entry.firstIdx, entry.lastIdx)) continue; // never split a tool pair (design §4)
		for (let i = at; i < entry.firstIdx; i++) out.push(messages[i]);
		out.push(summaryMessageOf(entry.block));
		foldedMessages += entry.lastIdx - entry.firstIdx + 1;
		at = entry.lastIdx + 1;
		applied += 1;
	}
	for (let i = at; i < messages.length; i++) out.push(messages[i]);
	// Ladder passes, ascending tier (T3 anchors are T2 summaries that only
	// exist after the T2 pass ran).
	const ladderState = { applied };
	let ladderOut = applyLadderTier(out, ladderBlocks, 2, ladderState);
	ladderOut = applyLadderTier(ladderOut, ladderBlocks, 3, ladderState);
	applied = ladderState.applied;
	return { messages: ladderOut, applied, foldedMessages, unlocated };
}

/** Epoch-boundary detection: every T1 block failed to LOCATE inside the
 * current re-send — the host replaced history (its own compaction) and the
 * ledger aged out as a whole. Only raw-range blocks count (ladder blocks
 * locate through their consumed T1 summaries, which the T1 pass renders);
 * a ladder-only ledger can never read stale on its own. The fail-open skip
 * stays correct, but a growth baseline carried over from the previous epoch
 * does not: the caller re-anchors it exactly once per epoch. */
export function ledgerIsStale(view, ledger) {
	const blocks = Array.isArray(ledger?.blocks) ? ledger.blocks : [];
	const t1Count = blocks.filter((block) => block !== null && typeof block === "object" && block.refRange !== null).length;
	return t1Count > 0 && view.applied === 0 && view.unlocated === t1Count;
}

/** Install the built view for one dispatch. Host immutability varies: probe
 * and fresh re-sends hand out mutable arrays (splice in place — cheapest,
 * identity-preserving), resumed sessions re-send FROZEN host-assembled
 * history (splice throws on its internal index deletes), and some dispatch
 * options are frozen objects on top of that. Returns the strategy used so
 * the caller can log it: "in-place" | "swapped" | "none" (a fold existed but
 * the dispatch could not carry it — the wire ships raw history) |
 * "nothing-to-apply" (no located fold blocks; the raw history IS the view). */
export function injectView(options, messages, view) {
	if (view.applied <= 0) return "nothing-to-apply";
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
