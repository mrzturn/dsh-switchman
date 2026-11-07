/** dsh-switchman context-trim surface-replace pass (design:
 *  docs/surface-fold.md, v1.10.0).
 *
 * The splice-level view (view.js injectView) cannot reach the wire while the
 * host deep-freezes assembled requests — those sessions log wire=raw and the
 * folds stay meter-only phantoms. The host's own compaction proves the escape
 * hatch: history is a DERIVED projection of the append-only event log, and
 * appending ONE event with surfaceOp {op:'replace', startSeq, endSeq} shadows
 * a range in that projection (Session.deriveMessages walks surface.nodes,
 * core/session/src/index.ts:999-1020). This pass clones that mechanism for
 * fold blocks: at a serial boundary it appends a shadow-price metering event
 * plus ONE replacement user/message whose body is the block's rendered text,
 * so the fold reaches the wire from the source level — frozen dispatches
 * included, because deriveMessages runs before every assembly.
 *
 * RANGE-MAPPING STRATEGY (design §2 / requirement 4): commit-time capture is
 * PRIMARY — the moment a fold commits, captureFoldSeqs resolves the block's
 * ref range against the LIVE session surface and stores the covered event
 * seqs on the ledger block (block.surfaceSeqs). Event seqs are immutable log
 * indexes, so the capture stays stable across later appends, and it is the
 * cheapest truth at append time. REPLACE-TIME LIVE LOCATION is the fallback
 * for blocks whose capture could not run (session unreachable at commit, or
 * a ledger inherited/cloned without seqs): the block's firstId/lastId refs
 * are re-located over surface.nodes with the same count-anchored resolution
 * the view builder uses.
 *
 * Surface node seqs are MODEL-VISIBLE order, NOT log order: a replace op
 * splices a NEW (higher) seq into the middle of the list, so a span crossing
 * a replacement is legitimately NON-monotonic (a real fold captured
 * [376, 229, 230, ...] because event 376 replaced the range around it).
 * Captures and validators therefore treat a span as an ordered SET of unique
 * seqs — never as an ascending interval. The host validates the same way:
 * sourceEventSeqs only need to be earlier, unique, and cover every shadowed
 * node (core/session/src/surface.ts:329-363).
 *
 * A capture that EXISTS but no longer validates against the live surface
 * (endpoints missing, span not densely covered — e.g. a host compaction
 * already shadowed part of the range) is never silently re-targeted. The hard
 * skip is relaxed ONLY when the re-located range is provably the same fold:
 * the block's refs still resolve count-anchored on the visible surface, the
 * stored first/last seqs are still live surface nodes AND equal the located
 * span's endpoints (content-addressed refs make an EARLIER look-alike span
 * locate just as well), AND the located node span shares no event seq with
 * any range another block has already REPLACED (this block excepted; the
 * marker's shipped seq set when present, then the other block's capture, then
 * the numeric surfaceReplaced.startSeq..endSeq interval for legacy markers).
 * A capture-less legacy block keeps the plain live-location path. Anything
 * else keeps the `incomplete-seqs` tombstone: re-targeting a different range
 * would shadow messages the fold never covered.
 *
 * Protocol details mirrored from the host recon:
 * - sourceEventSeqs must densely cover EVERY shadowed surface node
 *   (core/session/src/surface.ts:329-363) — the span slice guarantees this.
 * - The metering event precedes the replacement SYNCHRONOUSLY-adjacent
 *   (shadow-price protocol; ToolResultPruner precedent,
 *   compaction-tool-result-pruner/src/index.ts:159-172). 'compaction/prune'
 *   is a core-known log-only type (core/session/src/known-event-types.ts:33)
 *   whose data shape carries shadowedRange/shadowedSeqs/shadowedTokenCount.
 * - The replacement message's source stays a plain {kind:'user'}. It used
 *   to clone the host compaction checkpoint marker {kind:'compact-checkpoint'}
 *   (compaction/src/checkpoint.ts), but the installed v4 session validator
 *   (session-format-v3-to-v4/src/relationships.ts) requires that kind to ride
 *   an open compaction/start..end pair and rejects the event otherwise
 *   ("compaction checkpoint has no matching compaction/start"). Downstream
 *   recognition of the summary row rides its acp_summary_ id prefix and its
 *   [SWITCHMAN:TRIM] content prefix (view.js summaryMessageOf), never the
 *   source kind.
 * - Never append while a durable compaction/start..compaction/end lock pair
 *   is open for the session (design constraint).
 *
 * LADDER SHIP (docs/ladder-fold.md): tier ≥ 2 blocks ride the same pair,
 * but their material is the REPLACEMENT NODES their consumed blocks shipped
 * (each consumed block's surfaceReplaced marker carries atSeq). The span
 * from the first to the last replacement node must contain EXACTLY the
 * consumed replacement nodes — engine folds are frontier-ordered, nothing
 * can legitimately interleave, and any mismatch tombstones
 * (ladder-span-mismatch / ladder-span-gone / ladder-consumed-skipped)
 * instead of guessing. A ladder block whose consumed blocks have not
 * shipped yet stays pending: they sit EARLIER in the same sweep (ledger
 * order) and ship before it is reached again on a later sweep.
 *
 * Everything fails open: a missing agents service / session.append / surface
 * support degrades to today's behavior (wire=raw banner + tally watermark),
 * and every no-op with pending work is logged to decisions.log.
 */

import { refOf, summaryMessageOf } from "./view.js";

/** Ladder-block probe (tier ≥ 2): a distillation whose surface material is
 * the REPLACEMENT NODES of its consumed blocks, not a raw ref range. */
function isLadderBlock(block) {
	return block !== null && typeof block === "object" && (block.tier === 2 || block.tier === 3);
}

// ---- tool-pair closure ------------------------------------------------------

/** Call ids OPENED by one message, across every wire shape the plugin can
 *  see: the DSH-native content block {type:'tool-call', id} (the shape that
 *  reaches real captures — packages/llm/llm/src/types.ts ToolCallBlock), the
 *  provider-shaped {type:'tool_use', id} block, and the OpenAI
 *  message.tool_calls array. Duplicate ids are kept — the caller only asks
 *  "is this id answered somewhere in the span". */
function toolCallIdsOf(message) {
	const ids = [];
	if (message === null || typeof message !== "object") return ids;
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (typeof call?.id === "string" && call.id !== "") ids.push(call.id);
		}
	}
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if ((block?.type === "tool-call" || block?.type === "tool_use") && typeof block.id === "string" && block.id !== "") ids.push(block.id);
		}
	}
	return ids;
}

/** Call ids ANSWERED by one message: the DSH-native role:'tool' message's
 *  toolCallId, the provider-shaped tool_call_id field, and tool_result /
 *  tool-result content blocks' tool_use_id. */
function toolResultIdsOf(message) {
	const ids = [];
	if (message === null || typeof message !== "object") return ids;
	if (typeof message.toolCallId === "string" && message.toolCallId !== "") ids.push(message.toolCallId);
	if (typeof message.tool_call_id === "string" && message.tool_call_id !== "") ids.push(message.tool_call_id);
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block?.type !== "tool_result" && block?.type !== "tool-result") continue;
			const id = block.tool_use_id ?? block.toolCallId ?? block.tool_call_id;
			if (typeof id === "string" && id !== "") ids.push(id);
		}
	}
	return ids;
}

/** Dense node-index-aligned message list built from derivingPairsOf: entry i
 *  is the message surface node i derives, or null for a node that derives
 *  none (empty assistant step, ...). closeToolPairSpan indexes this list by
 *  SURFACE NODE INDEX while derivingPairsOf compacts that space — this is the
 *  bridge, and it reuses the already-resolved messages. */
function denseMessagesOf(pairs, nodeCount) {
	const messages = new Array(nodeCount).fill(null);
	for (const pair of pairs) messages[pair.nodeIndex] = pair.message;
	return messages;
}

/** Close a surface span over complete tool pairs. A shipped fold must never
 *  separate an assistant tool call from its tool results: the provider wire
 *  serializers reject the orphan half ("DeepSeek Messages tool result has no
 *  matching call", llm-deepseek/src/serialize.ts:130-150), and the host's own
 *  compaction validates the same rule (dsh-compaction/lib/index.js:557).
 *  view.js segments pairwise, but a fold block's range can still be captured
 *  or resolved off a surface whose boundary sits between the two halves
 *  (trigger.js computeFoldableRange stops at a segment end; a pre-fix capture,
 *  a host compaction, or a later block all can leave the boundary there), so
 *  this pass re-closes the span against the LIVE node list.
 *
 *  pairs: DENSE message list aligned to surface node indexes (null entries for
 *  nodes that derive no message); nodeCount: surface node count (indices past
 *  pairs.length are treated as absent). Returns { startIdx, endIdx } or null
 *  when the span cannot be closed without leaving the surface.
 *
 *  FORWARD: every call opened INSIDE the span must be answered inside it;
 *  otherwise the results directly following the span end are pulled in (one
 *  node per iteration, so several consecutive role:'tool' nodes for one
 *  assistant step all land). A call whose next surface node does not answer it
 *  (the surface ends first, or a different message sits between) is
 *  unclosable: null.
 *
 *  BACKWARD: a result at the span start whose call still lives earlier on the
 *  surface pulls the start back over that assistant node (and the run of
 *  results after it), so shipping the fold cannot orphan a result it leaves
 *  behind. When that call node is already shadowed/absent, the leading result
 *  is a PRE-EXISTING orphan: removing it is the healing direction and the
 *  span stays as captured (the earlier fold's shadowed set already owns the
 *  call). A node that both opens calls and carries results is handled by both
 *  passes defensively. */
function closeToolPairSpan(pairs, startIdx, endIdx, nodeCount) {
	const count = Number.isInteger(nodeCount) ? nodeCount : pairs.length;
	if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) return null;
	if (startIdx < 0 || endIdx < startIdx || endIdx >= count) return null;
	const messageAt = (index) => (index >= 0 && index < count ? pairs[index] ?? null : null);
	let start = startIdx;
	let end = endIdx;

	// Backward pass (bounded by count: every step moves start strictly earlier).
	for (let guard = 0; guard <= count; guard++) {
		const resultIds = toolResultIdsOf(messageAt(start));
		if (resultIds.length === 0) break;
		let owner = -1;
		for (let i = start - 1; i >= 0; i--) {
			const callIds = toolCallIdsOf(messageAt(i));
			if (callIds.some((id) => resultIds.includes(id))) {
				owner = i;
				break;
			}
		}
		if (owner < 0) break; // call already shadowed/absent: healing direction, span unchanged
		start = owner;
	}

	// Forward pass: recompute the open calls over the current span each
	// iteration, so a multi-result assistant step extends over all of them.
	for (let guard = 0; guard <= count; guard++) {
		const open = new Set();
		for (let i = start; i <= end; i++) for (const id of toolCallIdsOf(messageAt(i))) open.add(id);
		for (let i = start; i <= end; i++) for (const id of toolResultIdsOf(messageAt(i))) open.delete(id);
		if (open.size === 0) return { startIdx: start, endIdx: end };
		const next = end + 1;
		if (next >= count) return null; // surface ends before the results: unclosable
		const nextIds = toolResultIdsOf(messageAt(next));
		if (!nextIds.some((id) => open.has(id))) return null; // next node answers a different call: unclosable
		end = next;
	}
	return null;
}

/** Config field reader (fail-open default), same pattern as index.js. */
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

/** Session id from an agent reference (object → agent.session.id, string →
 * itself). Local twin of index.js agentSessionIdOf — kept here to avoid an
 * import cycle (index.js already imports this module). */
function sessionIdOfAgent(agent) {
	if (typeof agent === "string") return agent !== "" ? agent : null;
	if (agent !== null && typeof agent === "object") {
		const id = agent.session?.id ?? agent.id;
		return typeof id === "string" && id !== "" ? id : null;
	}
	return null;
}

/** The replacement message event body: the block's rendered summary text in
 * a user message whose id carries the acp_summary_ prefix (downstream
 * tooling skips it) and a PLAIN {kind:'user'} source — a compact-checkpoint
 * source on a non-append surfaceOp is rejected by the v4 session validator
 * unless an open compaction/start..end pair covers it. The summary row stays
 * findable via its acp_summary_ id and [SWITCHMAN:TRIM] content prefix.
 * Deterministic — no timestamps (replay determinism constraint). */
function replacementMessageOf(block) {
	return {
		...summaryMessageOf(block),
		source: { kind: "user" },
	};
}

/** Derive the message of one session event without depending on host helper
 * availability: session.deriveEventMessage when present, else the same
 * projection rules inline (user/message IS the message; message events nest
 * it under data.message; empty content derives null). Returns the message or
 * null. */
function messageOfEvent(session, event) {
	try {
		if (typeof session?.deriveEventMessage === "function") return session.deriveEventMessage(event);
	} catch {
		/* fall through to the inline projection */
	}
	const type = event?.type;
	const data = event?.data;
	if (type === "user/message") return data ?? null;
	if (type === "system/message" || type === "developer/message" || type === "assistant/message" || type === "tool/result") {
		const message = data?.message;
		if (message === null || typeof message !== "object") return null;
		if (Array.isArray(message.content) && message.content.length === 0) return null;
		return message;
	}
	return null;
}

/** Full event snapshot of a session: snapshotEvents() when available (cached
 * host side), else a walk over eventAt up to session.seq. Null when neither
 * accessor exists (pre-surface host). Never throws. */
function eventsOf(session) {
	try {
		if (typeof session?.snapshotEvents === "function") return session.snapshotEvents();
		if (typeof session?.eventAt === "function" && Number.isFinite(session?.seq)) {
			const events = [];
			for (let seq = 0; seq < session.seq; seq++) {
				const event = session.eventAt(seq);
				if (event === undefined) break;
				events.push(event);
			}
			return events;
		}
	} catch {
		/* unreadable log → treat as no events (fail open) */
	}
	return null;
}

/** True while a durable compaction/start..compaction/end pair is open for
 * the session (log-only marker scan; the surface never shows them). Fail-open
 * false when the log is unreadable. */
function compactionLockOpen(session) {
	const events = eventsOf(session);
	if (events === null) return false;
	const open = new Set();
	try {
		for (const event of events) {
			const id = event?.data?.compactionId;
			if (typeof id !== "string" || id === "") continue;
			if (event.type === "compaction/start") open.add(id);
			else if (event.type === "compaction/end") open.delete(id);
		}
	} catch {
		return false;
	}
	return open.size > 0;
}

/** (nodeIndex, message) pairs for the surface nodes that derive a message,
 * in surface order — this subsequence corresponds 1:1 with deriveMessages
 * (which skips null-deriving nodes like empty assistant steps), so count
 * anchoring is valid in MESSAGE space while spans stay NODE space. */
function derivingPairsOf(session, nodes) {
	const pairs = [];
	for (let i = 0; i < nodes.length; i++) {
		const event = (() => {
			try {
				return typeof session?.eventAt === "function" ? session.eventAt(nodes[i]) : undefined;
			} catch {
				return undefined;
			}
		})();
		const message = event === undefined ? null : messageOfEvent(session, event);
		if (message !== null && message !== undefined) pairs.push({ nodeIndex: i, message });
	}
	return pairs;
}

/** Count-anchored ref resolution over the deriving pairs (same anchoring as
 * view.js locateBlock / state.js commitFold: duplicate content collides on
 * one content-addressed ref, so the pair is resolved anchored on block.count
 * rather than on occurrence extremes). Returns [firstNodeIndex, lastNodeIndex]
 * or null. */
function locateOnSurface(pairs, block) {
	const firstId = block?.refRange?.firstId;
	const lastId = block?.refRange?.lastId;
	if (typeof firstId !== "string" || typeof lastId !== "string") return null;
	const firstList = [];
	const lastList = [];
	pairs.forEach((pair, messageIndex) => {
		const ref = refOf(pair.message, messageIndex);
		if (ref === firstId) firstList.push(messageIndex);
		if (ref === lastId) lastList.push(messageIndex);
	});
	if (firstList.length === 0 || lastList.length === 0) return null;
	// Anchor strictly on block.count (matching view.js's anchored path). A
	// block without a usable count is a hard skip below (not-located), never
	// a guessed last-occurrence range — the fallback path only serves blocks
	// captured before the stored-seqs strategy existed, and guessing there
	// could shadow an unrelated range on a collided content-addressed ref.
	const count = Number.isInteger(block.count) && block.count > 0 ? block.count : null;
	if (count === null) return null;
	for (const start of firstList) {
		const end = start + count - 1;
		if (end >= start && lastList.includes(end)) return [pairs[start].nodeIndex, pairs[end].nodeIndex];
	}
	return null;
}

/** Validate a stored capture against the live surface: seqs must be unique
 * non-negative safe integers, both endpoints present in surface.nodes, the
 * covered node span must be EXACTLY the stored array (dense coverage — this
 * is what makes sourceEventSeqs complete, and what detects a surface that
 * moved on), and the events AT the endpoint seqs must still derive messages
 * whose refs equal the block's refRange endpoints (identity re-check: a
 * host log migration that renumbered events while the plugin ledger
 * survived would otherwise densely validate over UNRELATED events and
 * shadow the wrong range). Returns { startSeq, endSeq, seqs } or null.
 *
 * The seqs are NOT required to ascend: surface.nodes is model-visible order,
 * so a span crossing a replace op mixes a new replacement seq with older
 * seqs (see header). An ascending check here rejected captures that
 * captureFoldSeqs itself had just produced (the real 2026-11-05
 * incomplete-seqs deadlock). */
function validateStoredSeqs(session, nodes, stored, block) {
	if (!Array.isArray(stored) || stored.length === 0) return null;
	const seen = new Set();
	for (const seq of stored) {
		if (!Number.isInteger(seq) || seq < 0 || seen.has(seq)) return null;
		seen.add(seq);
	}
	const indexOfSeq = new Map(nodes.map((seq, index) => [seq, index]));
	const startIdx = indexOfSeq.get(stored[0]);
	const endIdx = indexOfSeq.get(stored[stored.length - 1]);
	if (startIdx === undefined || endIdx === undefined || startIdx > endIdx) return null;
	const span = nodes.slice(startIdx, endIdx + 1);
	if (span.length !== stored.length) return null;
	for (let i = 0; i < span.length; i++) if (span[i] !== stored[i]) return null;
	// Endpoint identity re-check (see header): the anchored refs must still
	// resolve at the stored endpoint seqs; any mismatch routes the block to
	// the incomplete-seqs hard skip — never a silent re-target. A
	// capture-clamped block (surfaceHeadClamped) deliberately dropped its
	// first endpoint (the system head seq), so only the last endpoint stays
	// identity-checked; the dense span check covers the clamped start.
	const firstId = block?.refRange?.firstId;
	const lastId = block?.refRange?.lastId;
	if (typeof firstId === "string" && typeof lastId === "string") {
		const endpoints = block?.surfaceHeadClamped === true
			? [[stored[stored.length - 1], lastId]]
			: [[stored[0], firstId], [stored[stored.length - 1], lastId]];
		for (const [seq, id] of endpoints) {
			let event = undefined;
			try {
				event = typeof session?.eventAt === "function" ? session.eventAt(seq) : undefined;
			} catch {
				event = undefined;
			}
			const message = event === undefined ? null : messageOfEvent(session, event);
			if (message === null || refOf(message, 0) !== id) return null;
		}
	}
	return { startIdx, endIdx, startSeq: stored[0], endSeq: stored[stored.length - 1], seqs: stored.slice() };
}

/** True when a re-located node span collides with a range ANOTHER block has
 * already replaced. Precedence: the marker's own shipped seq set
 * (surfaceReplaced.seqs, written at ship time), then the other block's
 * persisted capture, then a numeric start..end interval for legacy markers
 * that only recorded the endpoints. Only the last tier guesses, and it
 * over-approximates NON-monotonic spans (a span crossing a replacement mixes
 * a high seq with older ones), so it may tombstone a would-be valid
 * re-location — the safe direction: never ship a guessed range. Fails closed
 * (true) on an unreadable ledger: a safety check must never wave a collision
 * through. */
function overlapsReplacedRange(block, seqs, blocks) {
	try {
		const set = new Set(seqs);
		let lo = Infinity;
		let hi = -Infinity;
		for (const seq of seqs) {
			if (seq < lo) lo = seq;
			if (seq > hi) hi = seq;
		}
		for (const other of Array.isArray(blocks) ? blocks : []) {
			if (other === block) continue;
			const mark = other?.surfaceReplaced;
			if (mark === null || mark === undefined) continue;
			const exact = Array.isArray(mark.seqs) ? mark.seqs : Array.isArray(other.surfaceSeqs) ? other.surfaceSeqs : null;
			if (exact !== null) {
				if (exact.some((seq) => set.has(seq))) return true;
				continue; // exact shadow set known — no numeric guessing
			}
			const a = Math.min(mark.startSeq, mark.endSeq);
			const b = Math.max(mark.startSeq, mark.endSeq);
			if (Number.isFinite(a) && Number.isFinite(b) && lo <= b && a <= hi) return true;
		}
		return false;
	} catch {
		return true;
	}
}

/** Build the surface-replace pass. deps: { ctx, config, store, decisionLog,
 * warn }. Returns { sweep, captureFoldSeqs, supported } — sweep is async and
 * never rejects; all failures are contained and logged. Registers its own
 * agent/turn-stopping listener (serial boundary, no request in flight). */
export function createSurfaceFoldPass(deps = {}) {
	const ctx = deps.ctx;
	const config = deps.config;
	const store = deps.store;
	const decisionLog = typeof deps.decisionLog === "function" ? deps.decisionLog : () => {};
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};

	/** Whole-pass gate: surfaceFold flag AND the trim master switch. */
	const enabledNow = () => readBool(config, "surfaceFold", true) && readBool(config, "trimEnabled", true);

	/** Live session object for a session id (agents registry lookup). */
	function sessionOf(sessionId) {
		try {
			const session = ctx?.agents?.get?.(sessionId)?.session;
			return session !== null && typeof session === "object" ? session : null;
		} catch {
			return null;
		}
	}

	/** Feature detection (fail-open legacy when anything is missing): an
	 * agents registry that resolves the session, session.append, and the
	 * surface architecture (surface.nodes) whose presence implies surfaceOp
	 * support — deriveMessages/surfaceOp landed as one mechanism. */
	function surfaceCapable(session) {
		try {
			return session !== null
				&& typeof session === "object"
				&& typeof session.append === "function"
				&& session.surface !== null
				&& typeof session.surface === "object"
				&& Array.isArray(session.surface.nodes);
		} catch {
			return false;
		}
	}

	/** True when the surface's leading node derives the frozen system prompt
	 * (the host's protected head: the v4 validator rejects any prune whose
	 * shadowedSeqs contain it — "compaction cannot shadow the protected
	 * system head"). Fail-open false when the head is unreadable or not a
	 * system message: sessions without a leading system message fold their
	 * head node like any other. */
	function headNodeIsSystem(session, nodes) {
		if (!Array.isArray(nodes) || nodes.length === 0) return false;
		try {
			const event = typeof session?.eventAt === "function" ? session.eventAt(nodes[0]) : undefined;
			const message = event === undefined ? null : messageOfEvent(session, event);
			return message !== null && message !== undefined && message.role === "system";
		} catch {
			return false;
		}
	}

	/** Compaction-lock probe with a per-session cache keyed on session.seq.
	 * supported() runs on every idle boundary and a full log scan per call is
	 * wasted work on an unchanged log; the log is append-only, so "same seq →
	 * same lock state" holds and a changed seq invalidates. Bounded like the
	 * other registries. Fail-open false on any error (an unreadable log must
	 * not reinstate the fold deadlock). */
	const lockCache = new Map(); // sessionId -> { seq, locked }
	function lockOpenCached(sessionId, session) {
		try {
			const seq = Number.isFinite(session?.seq) ? session.seq : null;
			if (seq === null) return compactionLockOpen(session);
			const hit = lockCache.get(sessionId);
			if (hit !== undefined && hit.seq === seq) return hit.locked;
			const locked = compactionLockOpen(session);
			if (lockCache.size >= 200) lockCache.delete(lockCache.keys().next().value);
			lockCache.set(sessionId, { seq, locked });
			return locked;
		} catch {
			return false;
		}
	}

	/** In-memory idempotence belt over the durable block marker: the same
	 * (session, range, contentGeneration) is never replaced twice even if a
	 * crash lost the ledger persist. Bounded like the other registries. */
	const replacedKeys = new Map(); // key -> epoch ms
	function replacedKey(sessionId, startSeq, endSeq, generation) {
		return `${sessionId}:${startSeq}..${endSeq}:g${generation}`;
	}
	function rememberReplaced(key) {
		replacedKeys.set(key, Date.now());
		if (replacedKeys.size > 500) replacedKeys.delete(replacedKeys.keys().next().value);
	}
	function wasReplaced(key) {
		const at = replacedKeys.get(key);
		return at !== undefined && Date.now() - at < 3_600_000;
	}

	/** Commit-time capture (PRIMARY strategy): resolve the block's ref range
	 * against the live surface and store the covered event seqs on the block.
	 * Best-effort — a failed capture just leaves the fallback path. */
	function captureFoldSeqs(sessionId, block) {
		try {
			if (block === null || typeof block !== "object") return false;
			const session = sessionOf(sessionId);
			if (!surfaceCapable(session)) return false;
			const nodes = session.surface.nodes.slice();
			const pairs = derivingPairsOf(session, nodes);
			const located = locateOnSurface(pairs, block);
			if (located === null) return false;
			let startIdx = located[0];
			let endIdx = located[1];
			// Head clamp at CAPTURE time: the stored range must never include
			// the leading system message, so a block captured here stays clean
			// even when it ships from a later process. surfaceHeadClamped tells
			// validateStoredSeqs that stored[0] is deliberately no longer the
			// block's firstId endpoint (the head seq was dropped).
			if (headNodeIsSystem(session, nodes) && startIdx === 0) {
				if (endIdx < 1) return false; // head-only range: nothing shippable
				startIdx = 1;
				block.surfaceHeadClamped = true;
			}
			// NOTE: the capture stores the LOCATED span only — it must not be
			// pre-closed over tool pairs. The ship-time closure runs after
			// validateStoredSeqs re-checks the stored endpoints against the
			// block's refRange, so an extended capture (whose endpoints no
			// longer derive the ref ids) would fail validation, fall back to
			// live location and tombstone as a relocated range — a silently
			// unshippable block. The sweep is the authoritative closure pass.
			block.surfaceSeqs = nodes.slice(startIdx, endIdx + 1);
			try {
				store.persist(store.ledgerOf(sessionId));
			} catch {
				/* persist is best-effort; the in-memory block carries the capture */
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Per-block skip tombstone: contentGeneration-keyed, so a surface
	 * rewrite re-opens the attempt while a stable surface stays quiet (no
	 * per-turn spam for permanently unshippable blocks). */
	function tombstoneOf(block) {
		const mark = block?.surfaceSkip;
		return mark !== null && typeof mark === "object" && typeof mark.reason === "string" && mark.reason !== "" ? mark : null;
	}

	/** One no-op row (only when the pass had pending work — a vacuous sweep
	 * with nothing to ship stays silent, matching the early-return style of
	 * the fold cycle's own action=none rows). Whole-pass reasons (disabled /
	 * no-service / compaction-lock) repeat on EVERY turn-stopping + idle
	 * boundary while the state lasts, so identical signatures are logged
	 * once per state change — a fresh pending count re-opens the row. */
	const skipSeen = new Map(); // `${sessionId}:${reason}` -> last extra signature (FIFO-bounded)
	const skip = (sessionId, reason, via, extra = "", dedupe = true) => {
		if (dedupe) {
			const key = `${sessionId}:${reason}`;
			if (skipSeen.get(key) === extra) return;
			if (skipSeen.size >= 200) skipSeen.delete(skipSeen.keys().next().value);
			skipSeen.set(key, extra);
		}
		decisionLog(`session=${sessionId} surface-replace skipped reason=${reason} via=${via}${extra === "" ? "" : ` ${extra}`}`);
	};

	/** The replace pass for one session. Appends at most one metering +
	 * replacement pair per pending block; returns the number shipped. */
	async function sweep(sessionId, via = "idle", sessionHint = null) {
		if (typeof sessionId !== "string" || sessionId === "") return 0;
		const ledger = store.ledgerOf(sessionId);
		const blocks = Array.isArray(ledger.blocks) ? ledger.blocks : [];
		const generation = (() => {
			try {
				return Number.isFinite(sessionHint?.surface?.contentGeneration) ? sessionHint.surface.contentGeneration : null;
			} catch {
				return null;
			}
		})();
		const pending = blocks.filter((block) => {
			if (block?.surfaceReplaced !== null && block?.surfaceReplaced !== undefined) return false;
			const tomb = tombstoneOf(block);
			if (tomb === null) return true;
			// Re-open only when the surface content changed since the skip.
			return generation !== null && tomb.contentGeneration !== generation;
		});
		if (pending.length === 0) return 0;
		if (!enabledNow()) {
			skip(sessionId, "disabled", via, `blocks=${pending.length}`);
			return 0;
		}
		const session = surfaceCapable(sessionHint) ? sessionHint : sessionOf(sessionId);
		if (!surfaceCapable(session)) {
			// Legacy hosts (or unregistered sessions): keep today's behavior —
			// the wire=raw banner and the tally-driven watermark relief path.
			skip(sessionId, "no-service", via, `blocks=${pending.length}`);
			return 0;
		}
		const surface = session.surface;
		if (lockOpenCached(sessionId, session)) {
			skip(sessionId, "compaction-lock", via, `blocks=${pending.length}`);
			return 0;
		}
		// Live surface snapshot — REFRESHED after every successful ship: the
		// shadowed seqs leave surface.nodes, so the next pending block must
		// resolve/close against the new node list (a stale snapshot validated
		// or closed a span that no longer exists).
		let nodes = surface.nodes.slice();
		let pairs = derivingPairsOf(session, nodes);
		let nodeMessages = denseMessagesOf(pairs, nodes.length);
		// A ship is a replace op, which bumps surface.contentGeneration: refresh
		// it with the snapshot so a tombstone written later in this sweep keys
		// on the post-ship generation instead of re-opening on the next sweep.
		let liveGeneration = Number.isFinite(surface.contentGeneration) ? surface.contentGeneration : 0;
		// The host rejects a replace op over node 0 only when node 0 actually
		// carries the system prompt (assertSystemHeadRewrite). Resolve that
		// head role once per sweep — sessions without a leading system
		// message fold their head node like any other.
		let headIsSystem = headNodeIsSystem(session, nodes);
		let shipped = 0;
		for (const block of pending) {
			// ---- LADDER BRANCH (tier ≥ 2, docs/ladder-fold.md) --------------
			// A distillation's surface material is the REPLACEMENT NODES of its
			// consumed blocks (each carries a surfaceReplaced marker with the
			// replacement event seq). The span from the first to the last
			// replacement node must contain EXACTLY those nodes — engine folds
			// are frontier-ordered, so nothing can legitimately interleave —
			// and every mismatch tombstones instead of guessing.
			if (isLadderBlock(block)) {
				const consumedIds = Array.isArray(block.consumes) ? block.consumes : [];
				const byId = new Map(blocks.map((entry) => [entry?.id, entry]));
				const consumed = consumedIds.map((id) => byId.get(id));
				if (consumed.some((entry) => entry === undefined || entry === null)) {
					block.surfaceSkip = { reason: "ladder-consumed-skipped", contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, "ladder-consumed-skipped", via, `block=${block.id}`);
					continue;
				}
				const waiting = consumed.find((entry) => entry.surfaceReplaced === null || entry.surfaceReplaced === undefined);
				if (waiting !== undefined) {
					if (tombstoneOf(waiting) !== null) {
						// A consumed block is hard-skipped on this generation: its
						// replacement node can never materialize, so the ladder span
						// can never be exact. Generation-keyed like every skip — a
						// surface change re-opens both blocks.
						block.surfaceSkip = { reason: "ladder-consumed-skipped", contentGeneration: liveGeneration, at: Date.now() };
						try {
							store.persist(ledger);
						} catch {
							/* best effort */
						}
						skip(sessionId, "ladder-consumed-skipped", via, `block=${block.id} consumed=${waiting.id}`);
					}
					// Otherwise the consumed block is still pending and sits EARLIER
					// in this loop (ledger order): it ships — or skips — before this
					// iteration reaches the ladder block again on a later sweep.
					continue;
				}
				const indexOfSeq = new Map(nodes.map((seq, index) => [seq, index]));
				// Summary-message id positions on the LIVE surface: the
				// replacement message (acp_summary_<blockId>, deterministic body)
				// is content-stable, so a branch/compaction that re-projected the
				// surface invalidates the stored atSeqs but NOT the identity of
				// the replacement nodes — the same re-location-not-re-target rule
				// the T1 stale-capture path follows.
				// [2026-11-07]-[observed live: a DSH branch rebuilt the surface
				// projection, orphaning every T1 atSeq and tombstoning the pending
				// T2 as ladder-span-gone forever]-[id re-location lets the ladder
				// ship after any surface re-projection; the spanExact id-set check
				// below keeps it exact.]
				const idIndexOf = new Map();
				for (let i = 0; i < nodeMessages.length; i++) {
					const message = nodeMessages[i];
					if (message !== null && typeof message === "object" && typeof message.id === "string" && message.id.startsWith("acp_summary_")) {
						idIndexOf.set(message.id, i);
					}
				}
				const atSeqs = [];
				let unresolved = null;
				for (const entry of consumed) {
					const atSeq = Number.isFinite(entry.surfaceReplaced.atSeq) ? entry.surfaceReplaced.atSeq : null;
					if (atSeq !== null && indexOfSeq.has(atSeq)) {
						atSeqs.push(atSeq);
						continue;
					}
					const relocatedIdx = idIndexOf.get(`acp_summary_${entry.id}`);
					if (relocatedIdx === undefined) {
						unresolved = entry;
						break;
					}
					atSeqs.push(nodes[relocatedIdx]);
				}
				if (unresolved !== null) {
					// A consumed replacement node left the live surface (host
					// compaction shadowed it): the span is unreconstructable.
					block.surfaceSkip = { reason: "ladder-span-gone", contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, "ladder-span-gone", via, `block=${block.id} consumed=${unresolved.id}`);
					continue;
				}
				const nodeIndexes = atSeqs.map((seq) => indexOfSeq.get(seq));
				const ladderFirstIdx = Math.min(...nodeIndexes);
				const ladderLastIdx = Math.max(...nodeIndexes);
				const spanSeqs = nodes.slice(ladderFirstIdx, ladderLastIdx + 1);
				const expectedSeqs = new Set(atSeqs);
				let spanExact = spanSeqs.length === atSeqs.length && spanSeqs.every((seq) => expectedSeqs.has(seq));
				// Id-set exactness: after id re-location the span must contain
				// EXACTLY the consumed blocks' summary messages — a span that
				// picked up a stranger's acp_summary node is not this fold's
				// material (the length check alone cannot tell them apart).
				if (spanExact) {
					const expectedIds = new Set(consumed.map((entry) => `acp_summary_${entry.id}`));
					for (let i = ladderFirstIdx; i <= ladderLastIdx; i++) {
						const message = nodeMessages[i];
						if (message === null || message === undefined || typeof message.id !== "string" || !expectedIds.has(message.id)) {
							spanExact = false;
							break;
						}
					}
				}
				if (spanExact) {
					for (let i = ladderFirstIdx; i <= ladderLastIdx; i++) {
						const message = nodeMessages[i];
						if (message === null || message === undefined || typeof message.id !== "string" || !message.id.startsWith("acp_summary_")) {
							spanExact = false;
							break;
						}
					}
				}
				if (!spanExact) {
					block.surfaceSkip = { reason: "ladder-span-mismatch", contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, "ladder-span-mismatch", via, `block=${block.id}`);
					continue;
				}
				// Defensive system-head clamp (a summary node can never be node
				// 0 — T1 folds start after the head — but a drift-hostile guard
				// costs one comparison).
				if (headIsSystem && ladderFirstIdx === 0) {
					block.surfaceSkip = { reason: "system-head", contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, "system-head", via, `block=${block.id} ladder`);
					continue;
				}
				const ladderStartSeq = nodes[ladderFirstIdx];
				const ladderEndSeq = nodes[ladderLastIdx];
				const ladderKey = replacedKey(sessionId, ladderStartSeq, ladderEndSeq, liveGeneration);
				if (wasReplaced(ladderKey)) continue; // belt over the durable marker
				try {
					session.append("compaction/prune", {
						shadowedRange: { start: ladderStartSeq, end: ladderEndSeq },
						shadowedSeqs: spanSeqs,
						shadowedTokenCount: Number.isFinite(block.approxTokens) && block.approxTokens > 0 ? Math.round(block.approxTokens) : spanSeqs.length,
					});
					const event = session.append("user/message", replacementMessageOf(block), {
						surfaceOp: { op: "replace", startSeq: ladderStartSeq, endSeq: ladderEndSeq },
						sourceEventSeqs: spanSeqs,
					});
					block.surfaceReplaced = {
						startSeq: ladderStartSeq,
						endSeq: ladderEndSeq,
						seqs: spanSeqs.slice(),
						contentGeneration: liveGeneration,
						atSeq: Number.isFinite(event?.seq) ? event.seq : null,
						via,
						at: Date.now(),
					};
					delete block.surfaceSkip;
					rememberReplaced(ladderKey);
					shipped += 1;
					// Same post-ship snapshot refresh as the T1 branch: the
					// shadowed seqs left surface.nodes.
					nodes = surface.nodes.slice();
					pairs = derivingPairsOf(session, nodes);
					nodeMessages = denseMessagesOf(pairs, nodes.length);
					headIsSystem = headNodeIsSystem(session, nodes);
					liveGeneration = Number.isFinite(surface.contentGeneration) ? surface.contentGeneration : 0;
					decisionLog(`session=${sessionId} surface-replace startSeq=${ladderStartSeq} endSeq=${ladderEndSeq} seqs=${spanSeqs.length} tokens=${Number.isFinite(block.approxTokens) ? Math.round(block.approxTokens) : "?"} generation=${liveGeneration} ladder=${block.tier} via=${via}`);
					try {
						store.persist(ledger);
					} catch {
						/* the in-memory marker still guards this process */
					}
				} catch (error) {
					const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 160);
					block.surfaceSkip = { reason: `append-rejected:${message}`, contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, `append-rejected:${message}`, via, `block=${block.id} ladder=${block.tier}`);
				}
				continue;
			}
			// Resolve the shadow range: stored capture first (validated dense
			// against the LIVE surface). A stale/incomplete capture — or a
			// capture-less legacy block — falls back to live location, but ONLY
			// when the located span provably cannot collide with a range another
			// block already replaced (safety rule, header). Otherwise the block
			// tombstones as `incomplete-seqs` (or `not-located` when its refs
			// are simply gone): never a silent re-target onto a different range.
			let startSeq = null;
			let endSeq = null;
			let startIdx = null;
			let endIdx = null;
			let seqs = null;
			const stored = Array.isArray(block.surfaceSeqs) ? validateStoredSeqs(session, nodes, block.surfaceSeqs, block) : null;
			if (stored !== null) {
				({ startIdx, endIdx, startSeq, endSeq, seqs } = stored);
			} else {
				const located = locateOnSurface(pairs, block);
				if (located === null) {
					if (Array.isArray(block.surfaceSeqs)) {
						block.surfaceSkip = { reason: "incomplete-seqs", contentGeneration: liveGeneration, at: Date.now() };
						skip(sessionId, "incomplete-seqs", via, `block=${block.id}`, false);
					} else {
						block.surfaceSkip = { reason: "not-located", contentGeneration: liveGeneration, at: Date.now() };
						skip(sessionId, "not-located", via, `block=${block.id}`, false);
					}
					continue;
				}
				const locatedSeqs = nodes.slice(located[0], located[1] + 1);
				// A stale capture may only be re-located onto a provably IDENTICAL
				// span: refOf is content-addressed for messages without ids, so an
				// EARLIER look-alike span locates just as well (locateOnSurface
				// takes the first count-anchored occurrence) and re-targeting it
				// would shadow a range the fold never covered. Accept only when
				// the stored endpoints are still live surface nodes AND equal the
				// located endpoints; otherwise tombstone (never ship a guess).
				if (Array.isArray(block.surfaceSeqs)) {
					const storedFirst = block.surfaceSeqs[0];
					const storedLast = block.surfaceSeqs[block.surfaceSeqs.length - 1];
					const endpointsMatch = nodes.includes(storedFirst)
						&& nodes.includes(storedLast)
						&& nodes[located[0]] === storedFirst
						&& nodes[located[1]] === storedLast;
					if (!endpointsMatch) {
						block.surfaceSkip = { reason: "incomplete-seqs", contentGeneration: liveGeneration, at: Date.now() };
						skip(sessionId, "incomplete-seqs", via, `block=${block.id} relocated-range`, false);
						continue;
					}
				}
				if (overlapsReplacedRange(block, locatedSeqs, blocks)) {
					block.surfaceSkip = { reason: "incomplete-seqs", contentGeneration: liveGeneration, at: Date.now() };
					skip(sessionId, "incomplete-seqs", via, `block=${block.id} overlap`, false);
					continue;
				}
				startIdx = located[0];
				endIdx = located[1];
				startSeq = nodes[startIdx];
				endSeq = nodes[endIdx];
				seqs = locatedSeqs;
			}
			// Tool-pair closure over the LIVE surface (both resolution paths):
			// a shipped range must never separate an assistant's tool call from
			// its results — the provider wire serializers reject the orphan half
			// ("DeepSeek Messages tool result has no matching call",
			// llm-deepseek/src/serialize.ts:130-150). Extend forward over the
			// results of calls opened inside the range, and backward over the
			// live call of an orphan result at the range start. Unclosable (a
			// call with no result on this surface, a range whose next node
			// answers a different call) tombstones as tool-pair-unclosed — the
			// same safe hard-skip family as incomplete-seqs: never ship a
			// pair-splitting range. The block re-opens on the next surface
			// content change (tool-pair-unclosed is generation-keyed like every
			// other skip).
			const closed = closeToolPairSpan(nodeMessages, startIdx, endIdx, nodes.length);
			if (closed === null) {
				block.surfaceSkip = { reason: "tool-pair-unclosed", contentGeneration: liveGeneration, at: Date.now() };
				try {
					store.persist(ledger);
				} catch {
					/* best effort */
				}
				skip(sessionId, "tool-pair-unclosed", via, `block=${block.id}`);
				continue;
			}
			if (closed.startIdx !== startIdx || closed.endIdx !== endIdx) {
				startIdx = closed.startIdx;
				endIdx = closed.endIdx;
				startSeq = nodes[startIdx];
				endSeq = nodes[endIdx];
				seqs = nodes.slice(startIdx, endIdx + 1);
			}
			// System head clamp (ship time, BOTH resolution paths): when the
			// first surface node carries the system prompt, the v4 validator
			// rejects any prune whose shadowedSeqs contain it
			// (assertSystemHeadRewrite — node 0 may be rewritten only by a
			// system/message over exactly that node). Drop the head seq so the
			// rest of the range still ships; this re-runs over the LIVE surface
			// at every ship, so it also guards stored captures persisted by an
			// earlier process (legacy ranges that predate the capture clamp).
			// A range that is ONLY the head has nothing left: tombstone like an
			// append rejection instead of shipping an op that can never land;
			// a surface content change re-opens the attempt via the generation.
			if (headIsSystem && startSeq === nodes[0]) {
				if (endSeq === nodes[0]) {
					block.surfaceSkip = { reason: "system-head", contentGeneration: liveGeneration, at: Date.now() };
					try {
						store.persist(ledger);
					} catch {
						/* best effort */
					}
					skip(sessionId, "system-head", via, `block=${block.id}`);
					continue;
				}
				startSeq = nodes[1];
				seqs = seqs.slice(1);
			}
			const key = replacedKey(sessionId, startSeq, endSeq, liveGeneration);
			if (wasReplaced(key)) continue; // belt over the durable marker
			try {
				// Shadow-price protocol: the metering event and its replacement
				// are appended synchronously adjacent (pruner precedent). If the
				// replacement append throws after the metering event landed, the
				// orphan metering row is log-only and harmless — a pure consumer
				// pairs it with the replacement that never follows, pricing
				// nothing. Everything is pre-validated above, so this is a
				// host-drift backstop only.
				//
				// CRASH WINDOW (documented, deliberately not restructured): the
				// compaction/prune below is DURABLE the moment append() returns,
				// while surfaceReplaced only persists at the end of this try —
				// a process death in between leaves the pair half-written and
				// the block still pending. Recovery is safe without a reorder:
				// (1) an orphan compaction/prune pairs with no replacement and
				// prices nothing (above); (2) if the replacement DID land before
				// the crash, the shadowed seqs have left surface.nodes, so the
				// stored capture fails validateStoredSeqs' dense check on the
				// next sweep and the block hard-skips to the incomplete-seqs
				// tombstone instead of re-shipping over a moved surface; and
				// (3) within one process the replacedKeys belt blocks an
				// immediate replay. Worst case across a crash: one duplicated
				// log-only prune row.
				session.append("compaction/prune", {
					shadowedRange: { start: startSeq, end: endSeq },
					shadowedSeqs: seqs,
					shadowedTokenCount: Number.isFinite(block.approxTokens) && block.approxTokens > 0 ? Math.round(block.approxTokens) : seqs.length,
				});
				const event = session.append("user/message", replacementMessageOf(block), {
					surfaceOp: { op: "replace", startSeq, endSeq },
					sourceEventSeqs: seqs,
				});
				// Idempotence marker (durable, keyed by range + contentGeneration
				// per the design): a second sweep filters the block out here. The
				// exact shadowed seq set rides along so later re-location safety
				// checks can intersect exactly instead of guessing from
				// min/max (non-monotonic spans make the interval an over-approximation).
				block.surfaceReplaced = {
					startSeq,
					endSeq,
					seqs: seqs.slice(),
					contentGeneration: liveGeneration,
					atSeq: Number.isFinite(event?.seq) ? event.seq : null,
					via,
					at: Date.now(),
				};
				delete block.surfaceSkip;
				rememberReplaced(key);
				shipped += 1;
				// The shadowed seqs have just left surface.nodes: refresh the
				// snapshot every later pending block resolves against, so its
				// dense validation / re-location / pair closure reads the
				// POST-ship surface instead of a range that no longer exists.
				nodes = surface.nodes.slice();
				pairs = derivingPairsOf(session, nodes);
				nodeMessages = denseMessagesOf(pairs, nodes.length);
				headIsSystem = headNodeIsSystem(session, nodes);
				liveGeneration = Number.isFinite(surface.contentGeneration) ? surface.contentGeneration : 0;
				decisionLog(`session=${sessionId} surface-replace startSeq=${startSeq} endSeq=${endSeq} seqs=${seqs.length} tokens=${Number.isFinite(block.approxTokens) ? Math.round(block.approxTokens) : "?"} generation=${liveGeneration} via=${via}`);
				try {
					store.persist(ledger);
				} catch {
					/* the in-memory marker still guards this process */
				}
			} catch (error) {
				const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 160);
				// Tombstone like the resolution failures: a permanently
				// rejecting block must not retry (and re-log a full lock
				// scan) on every sweep; a surface content change re-opens it.
				block.surfaceSkip = { reason: `append-rejected:${message}`, contentGeneration: liveGeneration, at: Date.now() };
				try {
					store.persist(ledger);
				} catch {
					/* best effort */
				}
				skip(sessionId, `append-rejected:${message}`, via, `block=${block.id}`);
			}
		}
		if (shipped > 0) {
			try {
				store.persist(ledger);
			} catch {
				/* best effort */
			}
			warn(`[context-trim] ${sessionId}: surface-replace shipped ${shipped} fold block(s) via ${via}`);
		}
		return shipped;
	}

	/** Durable capability probe for the fold gate (index.js maybeFold): true
	 * when the surface-replace channel can carry a fold for this session right
	 * now — the pass is enabled, a surface-capable live session exists, AND no
	 * durable compaction lock is open. The lock matters: sweep defers under an
	 * open/orphaned compaction/start..end pair, so a supported() that ignored
	 * it would let maybeFold keep burning summary-model calls (≤6/hour) for
	 * folds that can never reach the wire. Lock state is cached per session
	 * seq, so idle-frequency calls stay O(1).
	 * Deliberately NOT a recency/freshness question: a channel that last
	 * shipped an hour ago (or before a process restart) and still exposes
	 * append + surface.nodes is capable, and the very next fold ships a new
	 * surface event. Recency must never gate folding — that deadlock is what
	 * froze real sessions at 135k tokens while decisions.log reported a 50k
	 * view (2026-11-05). */
	function supported(sessionId) {
		try {
			if (!enabledNow()) return false;
			const session = sessionOf(sessionId);
			if (!surfaceCapable(session)) return false;
			return !lockOpenCached(sessionId, session);
		} catch {
			return false;
		}
	}

	// Trigger 1: agent/turn-stopping — serial, no request in flight, and the
	// session object rides the payload (agent.session). Fail-open when the
	// host does not dispatch the event.
	try {
		ctx?.on?.("agent/turn-stopping", (payload) => {
			try {
				const sessionId = sessionIdOfAgent(payload?.agent);
				if (sessionId === null) return;
				const hint = payload?.agent !== null && typeof payload?.agent === "object" ? payload.agent.session : null;
				void sweep(sessionId, "turn-stopping", hint);
			} catch {
				/* listener must never throw */
			}
		});
	} catch (error) {
		warn(`[context-trim] agent/turn-stopping hook failed: ${error?.message ?? error}`);
	}

	return { sweep, captureFoldSeqs, enabledNow, supported };
}
