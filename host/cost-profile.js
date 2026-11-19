/** Cost attribution profile (guide §5 P2 ① "成本归因画像").
 *
 * Folds the per-turn usage samples ALREADY flowing through the context-trim
 * metrics seam (host/context-trim/index.js streamListener → extractUsage →
 * metrics.recordUsage) into a bounded per-session aggregate, and renders it
 * under the handoff_full "cost profile" line of the handover document
 * (guide §4.6). Before this module that line was model-self-filled "if
 * cheaply known"; the plugin now supplies the measured totals. No new
 * collection points: one fold call at the existing stream-end edge.
 *
 * Dimension availability (honest accounting, nothing invented):
 * - pool: derivable — laneOfRoute semantics shared with dispatch-stats.js
 *   (first matching configured lane wins; a route in no lane →
 *   "unattributed"; no route at all → "unknown").
 * - model: derivable — the dispatch route (options.provider/model) frozen
 *   at stream end.
 * - type "model output": derivable — outputTokens per turn.
 * - type "miss spike" (guide §4.3's dominant continuation cost: the whole
 *   prefix re-paid after a cache-TTL gap or a compaction): derivable — a
 *   turn whose UNCACHED input is both ≥ MISS_SPIKE_MIN_UNCACHED and
 *   ≥ MISS_SPIKE_SHARE of its prompt total. Spikes whose gap since the
 *   previous sampled turn crosses CACHE_TTL_MS are counted separately.
 * - type "tool output": NOT derivable at this seam — tool results land in
 *   the NEXT turn's prompt conflated with injected doctrine/protocol lines
 *   and fold deductions; no per-tool token record exists on the stream
 *   surface and this pack adds no collection points. The rendered block
 *   says so in one line instead of guessing a number.
 * - skill: NOT derivable per turn — skill loads are tool/call events
 *   (skill-registry's process-global stats, dispatch-stats' per-session
 *   first-load fact) with no turn correlation to a usage sample; attributing
 *   this session's cost to a globally-counted skill would fabricate data.
 *   Omitted entirely.
 *
 * MODEL-VISIBILITY: unlike the watermark/pool-feedback blocks (host log
 * only), handoff_full is a model-visible document BY DESIGN (guide §4.6) —
 * so the numbers here are deliberately restrained: aggregates and
 * percentages, top contributors only, hard-capped at PROFILE_MAX_LINES /
 * PROFILE_MAX_BYTES.
 *
 * Fail-open everywhere: a malformed sample, corrupt record, or render error
 * yields zero extra bytes and never blocks the handover document (guide §6
 * risk table). Records are cumulative session-to-date (LRU-evicted after
 * COST_PROFILE_SESSIONS_CAP distinct sessions; compaction does not reset
 * them — the next handover's profile then spans the whole session, which is
 * the informative direction).
 */

import { CACHE_TTL_MS } from "./watermark-estimate.js";
import { laneOfRoute } from "./dispatch-stats.js";

/** Distinct sessions kept (insertion-order LRU, same discipline as the
 *  context-trim side maps and SKILL_LOAD_CAP). */
export const COST_PROFILE_SESSIONS_CAP = 200;
/** Distinct model keys kept per record; a further distinct model folds into
 *  the "other" bucket (bounded record, bounded render). */
export const COST_PROFILE_MODELS_CAP = 8;
/** A turn is a miss spike only when its uncached input is a real spike:
 *  at least this many tokens... */
export const MISS_SPIKE_MIN_UNCACHED = 10_000;
/** ...AND at least this share of the turn's prompt total (most of the
 *  prefix re-paid, not just steady drift). */
export const MISS_SPIKE_SHARE = 0.5;
/** Rendered profile block caps (guide: restrained, structured, short). */
export const PROFILE_MAX_LINES = 12;
export const PROFILE_MAX_BYTES = 600;

/** sessionId → cumulative record. */
const turnsBySession = new Map();

const emptyBuckets = () => ({ turns: 0, prompt: 0, output: 0 });
const emptyRecord = () => ({
	turns: 0,
	promptTokens: 0,
	cachedTokens: 0,
	outputTokens: 0,
	perPool: new Map(),
	perModel: new Map(),
	spikes: { count: 0, uncached: 0, idleCount: 0 },
	lastAt: null,
});

/** Per-field null-safe merge of two usage samples from one stream: providers
 *  emit usage across several chunks (start carries input, deltas carry
 *  output), so a later sample must FILL missing buckets, never replace
 *  non-null ones. Exported for tests. */
export function mergeUsageTurn(prev, next) {
	const pick = (a, b) => (Number.isFinite(a) ? a : Number.isFinite(b) ? b : null);
	if (prev === null || typeof prev !== "object") {
		return {
			inputTokens: pick(null, next?.inputTokens),
			cachedTokens: pick(null, next?.cachedTokens),
			cacheWriteTokens: pick(null, next?.cacheWriteTokens),
			outputTokens: pick(null, next?.outputTokens),
		};
	}
	return {
		inputTokens: pick(prev.inputTokens, next?.inputTokens),
		cachedTokens: pick(prev.cachedTokens, next?.cachedTokens),
		cacheWriteTokens: pick(prev.cacheWriteTokens, next?.cacheWriteTokens),
		outputTokens: pick(prev.outputTokens, next?.outputTokens),
	};
}

/** Fold one sampled turn into `record`. Pure-ish core (mutates `record`,
 *  returns it), exported for tests — callers wrap it in fail-open try/catch
 *  (recordCostTurn does; the body catches too so even direct test calls on
 *  corrupt records stay harmless). `entry` = { route: {provider, model},
 *  usage: {inputTokens, cachedTokens, cacheWriteTokens, outputTokens}, at }.
 *  Returns `record` unchanged when the sample carries no numeric signal. */
export function foldCostTurn(record, entry, config) {
	try {
		if (record === null || typeof record !== "object") return record;
		const usage = entry?.usage;
		if (usage === null || typeof usage !== "object") return record;
		const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
		const input = num(usage.inputTokens);
		const cached = num(usage.cachedTokens);
		const cacheWrite = num(usage.cacheWriteTokens);
		const output = num(usage.outputTokens);
		const prompt = input + cached + cacheWrite;
		if (prompt <= 0 && output <= 0) return record; // no wire signal
		const at = Number.isFinite(entry?.at) ? entry.at : Date.now();
		const provider = typeof entry?.route?.provider === "string" && entry.route.provider !== "" ? entry.route.provider : null;
		const model = typeof entry?.route?.model === "string" && entry.route.model !== "" ? entry.route.model : null;
		const hasRoute = provider !== null && model !== null;
		// Pool attribution: same semantics as dispatch-stats settleRun.
		const pool = hasRoute ? (laneOfRoute({ provider, model }, config) ?? "unattributed") : "unknown";
		// Miss spike: most of the prefix re-paid this turn (§4.3), above an
		// absolute floor so steady drift never reads as a spike. The FIRST
		// sampled turn of a session qualifies on the share test alone — a
		// post-compaction re-read IS the handoff cost the guide names.
		if (input >= MISS_SPIKE_MIN_UNCACHED && prompt > 0 && input >= MISS_SPIKE_SHARE * prompt) {
			record.spikes.count += 1;
			record.spikes.uncached += input;
			if (Number.isFinite(record.lastAt) && at - record.lastAt >= CACHE_TTL_MS) record.spikes.idleCount += 1;
		}
		record.turns += 1;
		record.promptTokens += prompt;
		record.cachedTokens += cached;
		record.outputTokens += output;
		foldBuckets(record.perPool, pool, prompt, output);
		foldBuckets(record.perModel, hasRoute ? `${provider}/${model}` : "unknown", prompt, output);
		record.lastAt = at;
		return record;
	} catch {
		return record; // fail-open: a bad sample never poisons the record
	}
}


/** Fold {turns, prompt, output} buckets under `key`, keeping the map bounded
 *  (models only — pools are bounded by construction: ≤6 lanes + 2 fallback
 *  labels). The overflow bucket "other" absorbs further distinct keys. */
function foldBuckets(map, key, prompt, output) {
	if (!(map instanceof Map)) return;
	if (!map.has(key) && map.size >= COST_PROFILE_MODELS_CAP && key !== "other") {
		key = "other";
	}
	const bucket = map.get(key) ?? emptyBuckets();
	bucket.turns += 1;
	bucket.prompt += prompt;
	bucket.output += output;
	map.set(key, bucket);
}

/** Record one sampled turn for `sessionId` (the LRU write edge). Gates on
 *  the master switch INSIDE, so OFF = zero reads and zero writes even if a
 *  caller forgets to gate. Fail-open, returns the record (or null). */
export function recordCostTurn(sessionId, entry, config) {
	try {
		if (config?.costProfileEnabled !== true) return null;
		if (typeof sessionId !== "string" || sessionId === "") return null;
		let record = turnsBySession.get(sessionId);
		if (record === undefined) record = emptyRecord();
		turnsBySession.delete(sessionId); // refresh LRU recency before re-insert
		turnsBySession.set(sessionId, record);
		foldCostTurn(record, entry, config);
		while (turnsBySession.size > COST_PROFILE_SESSIONS_CAP) {
			const oldest = turnsBySession.keys().next().value;
			if (oldest === undefined || oldest === sessionId) break;
			turnsBySession.delete(oldest);
		}
		return record;
	} catch {
		return null;
	}
}

/** Rendered lines for one session's profile block (indented sub-lines of the
 *  handoff_full cost-profile bullet). Zero lines when: master switch off,
 *  split off (no handoff_full section to fill), session never sampled, or
 *  any error — OFF and empty both mean byte-identical handoff_full. */
export function costProfileSection(sessionId, config) {
	try {
		if (config?.costProfileEnabled !== true || config?.wmHandoffSplit !== true) return [];
		if (typeof sessionId !== "string" || sessionId === "") return [];
		const record = turnsBySession.get(sessionId);
		if (record === undefined || record === null) return [];
		return renderProfileLines(record);
	} catch {
		return [];
	}
}

/** Compact deterministic token formatting: 96k / 1.81M / 2300. Pure ASCII so
 *  the byte cap equals the string-length cap. */
function fmtTokens(n) {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = Math.round((n / 1000) * 10) / 10;
		if (k >= 1000) return `${Math.round((n / 1_000_000) * 100) / 100}M`;
		return `${k}k`;
	}
	return `${Math.round((n / 1_000_000) * 100) / 100}M`;
}

/** Share as a short deterministic percent; sub-1% shares read "<1%"; any
 *  non-finite part/total (corrupt record) reads "0%". */
function fmtPercent(part, total) {
	if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "0%";
	const pct = Math.round((part / total) * 100);
	return pct === 0 ? "<1%" : `${pct}%`;
}

/** Top-N bucket names by prompt desc (output as the tiebreak base when the
 *  session shipped no measurable prompt), name asc for byte-stable output. */
function topBuckets(map, total, n) {
	const base = total > 0 ? "prompt" : "output";
	return [...map.entries()]
		.sort((a, b) => b[1][base] - a[1][base] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.slice(0, Math.max(0, n));
}

/** Render the block (≤ PROFILE_MAX_LINES lines, ≤ PROFILE_MAX_BYTES bytes —
 *  truncation drops from the tail, the measured totals line never moves). */
function renderProfileLines(record) {
	const lines = [];
	const prompt = Number.isFinite(record.promptTokens) ? record.promptTokens : 0;
	const cached = Number.isFinite(record.cachedTokens) ? record.cachedTokens : 0;
	const output = Number.isFinite(record.outputTokens) ? record.outputTokens : 0;
	const turns = Number.isFinite(record.turns) ? record.turns : 0;
	if (turns < 1) return []; // never folded (or corrupt) → zero bytes, byte-identical handoff_full
	lines.push(`  - measured (dsh-switchman, session-to-date): ${turns} model turns, ${fmtTokens(prompt)} prompt (${fmtPercent(cached, prompt)} cache hit), ${fmtTokens(output)} output`);
	// One honest denominator for the whole block: prompt when the session
	// shipped any, else output. A bucket with none of that dimension shows
	// "<1%" instead of a cross-dimensional mix.
	const base = prompt > 0 ? "prompt" : "output";
	const total = base === "prompt" ? prompt : output;
	const poolLine = topBuckets(record.perPool, prompt, 3)
		.map(([name, bucket]) => `${name} ${fmtPercent(bucket?.[base], total)}`)
		.join(", ");
	if (poolLine !== "") lines.push(`  - by pool, share of ${base}: ${poolLine}`);
	const modelLine = topBuckets(record.perModel, prompt, 2)
		.map(([name, bucket]) => `${name} ${fmtPercent(bucket?.[base], total)}`)
		.join(", ");
	if (modelLine !== "") lines.push(`  - by model, share of ${base}: ${modelLine}`);
	const spikes = record.spikes;
	if (spikes !== null && typeof spikes === "object" && Number.isFinite(spikes.count) && spikes.count > 0) {
		lines.push(
			`  - miss spikes: ${spikes.count} turn${spikes.count === 1 ? "" : "s"} re-paid ${fmtTokens(spikes.uncached)} uncached input` +
				(Number.isFinite(spikes.idleCount) && spikes.idleCount > 0 ? ` (${spikes.idleCount} after an idle gap over the cache window)` : ""),
		);
	}
	lines.push("  - scope: stream-usage sampling only; per-tool-output cost is not separately recorded at this seam");
	// Caps, deterministic from the tail: the totals line is the one number a
	// resuming agent must keep; analysis lines drop first.
	while (lines.length > PROFILE_MAX_LINES && lines.length > 1) lines.pop();
	let joined = lines.join("\n");
	while (joined.length > PROFILE_MAX_BYTES && lines.length > 1) {
		lines.pop();
		joined = lines.join("\n");
	}
	return lines;
}

/** Clear all captured state (tests and future admin surfaces). */
export function resetCostProfiles() {
	try {
		turnsBySession.clear();
	} catch {
		/* fail open */
	}
}
