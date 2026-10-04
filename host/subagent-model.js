/** dsh-switchman subagent model-visibility layer.
 *
 * Parent-side model annotation for delegation results: a `tools/post-execute`
 * waterfall listener (registered exactly like host/lang.js's capture) watches
 * the `subagent` / `subagent_fork` tools and, when the call succeeded, reads
 * the child session's `modelSelection` projection through the `sessionQuery`
 * service (`observeSession` — cold sessions resolve without activating the
 * child) and appends one `model: provider/model@effort` line to the accepted
 * result content. DSH's own UI shows a child's model nowhere, so this line is
 * the only place the parent learns which model actually runs each child.
 *
 * Shapes verified against dsh 0.2.1-alpha.1 sources:
 * - Tool result values: `{kind:"continuable", subagentId}` (background
 *   continuable — subagentId IS the durable child session id,
 *   subagents.startContinuable's childId), `{kind:"foreground", runId,
 *   output}` (SubagentRun.id equals the published child session id for local
 *   providers; remote providers mint parent-namespaced ids, which simply fail
 *   the cold read and pass through unannotated), and `{kind:"background",
 *   jobId}` (a jobs id, not a session id — skipped).
 * - `PostToolDecision` accept: `content` replaces the model-visible content
 *   and cannot coexist with a `value` replacement (the runtime throws on
 *   both), so only value-less accepts gain the line. `next()` is always
 *   awaited first and its decision passed through untouched otherwise —
 *   best-effort fail-open: an unreadable child projection means no
 *   annotation, never an altered result.
 */

/** Child session id out of one subagent tool result value; null for shapes
 *  without a session id (one-shot background jobs) or malformed values. */
function childSessionIdOf(value) {
	if (value === null || typeof value !== "object") return null;
	if (value.kind === "continuable" && typeof value.subagentId === "string" && value.subagentId !== "")
		return value.subagentId;
	if (value.kind === "foreground" && typeof value.runId === "string" && value.runId !== "")
		return value.runId;
	return null;
}

/** Release one observation lease (explicit-resource-management protocol; both
 *  the native Symbol.dispose and the TS-downlevel Symbol.for key are tried).
 *  Prepared cuts pin an LRU cache entry, so a dropped lease would leak. */
function disposeObservation(observation) {
	if (observation === null || observation === undefined) return;
	for (const key of [Symbol.dispose, Symbol.for("Symbol.dispose")]) {
		const dispose = key === undefined ? undefined : observation[key];
		if (typeof dispose === "function") {
			try {
				dispose.call(observation);
			} catch {
				/* lease release is best-effort */
			}
			return;
		}
	}
}

/**
 * The effective model selection of one session, via the session-query
 * observeSession channel (shared with host/vision.js's per-session verdict).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {string} sessionId - session id (live or persisted).
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string} | null>}
 *          null when the session is unknown, unreadable, or unselected yet.
 */
async function sessionModelSelectionOf(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return null;
	let query;
	try {
		query = ctx.get?.("sessionQuery", false);
	} catch {
		return null;
	}
	if (query === undefined || query === null || typeof query.observeSession !== "function") return null;
	let observation = null;
	try {
		observation = await query.observeSession(sessionId);
		const selection = observation?.projections?.values?.modelSelection;
		const route = selection?.next ?? selection?.lastUsed; // next already falls back to lastUsed
		if (route === null || typeof route !== "object") return null;
		if (typeof route.provider !== "string" || route.provider === "" || typeof route.model !== "string" || route.model === "")
			return null;
		return typeof route.reasoningEffort === "string" && route.reasoningEffort !== ""
			? { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
			: { provider: route.provider, model: route.model };
	} catch {
		return null;
	} finally {
		disposeObservation(observation);
	}
}

/** The appended annotation line, or null when the child's model is unknown. */
function modelLineOf(selection) {
	if (selection === null || typeof selection !== "object") return null;
	const effort =
		typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== ""
			? `@${selection.reasoningEffort}`
			: "";
	return `model: ${selection.provider}/${selection.model}${effort}`;
}

/** Await the downstream decision, then append the annotation line to a
 *  value-less accept decision only. A next() rejection propagates (the
 *  pipeline's own containment turns it into an error result); a failure in
 *  the annotation logic after next() settled degrades to the untouched
 *  decision — never a lost or re-run outcome. */
async function annotate(ctx, exec, result, next, warn) {
	const downstream = await next();
	try {
		if (downstream === null || typeof downstream !== "object" || downstream.kind !== "accept") return downstream;
		// A value-replacing accept cannot also carry content (the runtime
		// throws "cannot replace both value and content").
		if (Object.hasOwn(downstream, "value")) return downstream;
		const sessionId = childSessionIdOf(result?.value);
		if (sessionId === null) return downstream;
		const line = modelLineOf(await sessionModelSelectionOf(ctx, sessionId));
		if (line === null) return downstream; // projection not ready/known — passthrough
		const base = Array.isArray(downstream.content)
			? downstream.content
			: Array.isArray(result?.content)
				? result.content
				: [];
		if (base.length === 0) return downstream; // nothing rendered to append to — never fabricate content
		return { ...downstream, content: [...base, { type: "text", text: line }] };
	} catch (error) {
		// next() already settled — pass its decision through untouched (a
		// failed annotation must never alter or fabricate an outcome).
		warn(`subagent model annotation failed: ${error?.message ?? error}`);
		return downstream;
	}
}

/**
 * Mount the subagent model-visibility layer (one post-execute listener).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 */
function applySubagentModel(ctx) {
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	ctx.on("tools/post-execute", (exec, result, next) => {
		// Fast path: every non-subagent tool and every failed call stays
		// exactly on the current pipeline (promise pass-through).
		if ((exec?.name !== "subagent" && exec?.name !== "subagent_fork") || result?.isError === true) return next();
		return annotate(ctx, exec, result, next, warn);
	});
}

export { applySubagentModel, sessionModelSelectionOf };
