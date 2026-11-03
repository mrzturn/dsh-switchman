/** dsh-switchman context-trim stream metrics.
 *
 * Meter duality (design §8): trim thresholds run on VIEW-estimated tokens
 * (buildView output, the meter the fold logic controls), while the
 * watermark keeps its STORED-token meter — the two signals are kept
 * separate on purpose. This module wraps the llm/stream result generator
 * so every provider response is sampled for usage (input/cached/output)
 * without ever breaking the stream: sampling errors are swallowed, the
 * chunk always flows through untouched.
 */

/** Extract usage fields from a stream chunk. Returns
 * { inputTokens, cachedTokens, outputTokens } or null when the chunk
 * carries none. Defensive field walk — providers shape usage differently
 * (usage.input_tokens, usage.prompt_tokens, cached_tokens,
 * cache_read_input_tokens, ...). */
export function extractUsage(chunk) {
	if (chunk === null || typeof chunk !== "object") return null;
	const candidates = [chunk.usage, chunk.metadata?.usage, chunk.response?.usage];
	for (const usage of candidates) {
		if (usage === null || typeof usage !== "object") continue;
		const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
		const cached = usage.cache_read_input_tokens ?? usage.cached_tokens ?? usage.cachedTokens ?? usage.prompt_tokens_details?.cached_tokens;
		const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens;
		if (!Number.isFinite(input) && !Number.isFinite(cached) && !Number.isFinite(output)) continue;
		return {
			inputTokens: Number.isFinite(input) ? input : null,
			cachedTokens: Number.isFinite(cached) ? cached : null,
			outputTokens: Number.isFinite(output) ? output : null,
		};
	}
	return null;
}

/** Per-session metrics store. */
export function createMetrics() {
	const sessions = new Map(); // sessionId -> record

	function recordOf(sessionId) {
		let record = sessions.get(sessionId);
		if (record === undefined) {
			record = {
				lastInputTokens: null,
				cachedTokens: null,
				outputTokens: null,
				viewTokens: null, // view estimate noted by the listener pre-request
				lastModel: null, // { provider, model } of the last stream
				lastStreamAt: 0,
				totalStreams: 0,
			};
		}
		sessions.delete(sessionId); // drop first so re-insert refreshes recency order
		sessions.set(sessionId, record);
		// Prune: keep only the 50 most recently active sessions (bounded memory).
		if (sessions.size > 50) {
			const oldest = sessions.keys().next().value;
			if (oldest !== undefined && oldest !== sessionId) sessions.delete(oldest);
		}
		return record;
	}

	return {
		/** Note the outbound-view estimate + model before/around a request. */
		noteView(sessionId, viewTokens, model) {
			const record = recordOf(sessionId);
			if (Number.isFinite(viewTokens)) record.viewTokens = Math.round(viewTokens);
			if (model !== null && typeof model === "object") record.lastModel = { provider: model.provider ?? null, model: model.model ?? null };
			record.lastStreamAt = Date.now();
			record.totalStreams += 1;
			return record;
		},
		/** Merge a usage sample (from extractUsage) into the record. */
		recordUsage(sessionId, usage) {
			if (usage === null) return null;
			const record = recordOf(sessionId);
			if (usage.inputTokens !== null) record.lastInputTokens = usage.inputTokens;
			if (usage.cachedTokens !== null) record.cachedTokens = usage.cachedTokens;
			if (usage.outputTokens !== null) record.outputTokens = usage.outputTokens;
			return record;
		},
		/** Record of one session (or null when never streamed). */
		of(sessionId) {
			return sessions.get(sessionId) ?? null;
		},
	};
}

/** Wrap a stream result so each chunk flows through a (failing-open)
 * sampler before being yielded. Returns the original value untouched when
 * it is not an async iterable (non-stream fallbacks must pass through). */
export function wrapStreamForMetrics(result, onChunk) {
	if (result === null || typeof result !== "object" || typeof result[Symbol.asyncIterator] !== "function") return result;
	async function* sampled() {
		for await (const chunk of result) {
			try {
				onChunk(chunk);
			} catch {
				/* sampling must never break the stream */
			}
			yield chunk;
		}
	}
	return sampled();
}
