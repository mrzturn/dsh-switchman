/** dsh-switchman cache-safe tail-context helper.
 *
 * Repo-wide cache-stability invariant (user-approved 2026-11-21; authoritative
 * spec: docs/requirements-and-design/2026-11-21-cache-safe-injection-design.md
 * §4.1 — enforced in review):
 *
 * 1. Head `systemPrompt.section` closures MUST render byte-stable text within
 *    a session. Only user config changes (or the sanctioned toggle events of
 *    rule 3) may alter head bytes. Any byte change in the head system prompt
 *    invalidates the entire cached prefix — every subsequent turn re-derives
 *    full price until a new prefix stabilizes.
 * 2. ALL session-dynamic prompt content MUST use one of: (a) `ctx.systemPrompt.context`
 *    tail snapshots (only-on-change appends); (b) post-execute result rewrites;
 *    (c) pre-execute argument fixes.
 * 3. The ONLY sanctioned full-prefix invalidation events: trim fold rebuilds
 *    (folding is what decides what is kept/folded), user config edits,
 *    teamsMode toggle (tool-list change), and host-level events outside this
 *    plugin's control.
 * 4. New features introducing head-dynamic content are a review-blocker.
 * 5. Language policy (repo rule, AGENTS.md 2026-11-21): all plugin-facing
 *    content is written in English only — orchestration, rules, behavior
 *    definitions, every injected prompt byte (head doctrine, tail payload,
 *    anchor lines), tool deny/fix messages, telemetry markers, code comments,
 *    docstrings, and test assertion strings.
 *
 * Precedent this helper generalizes: host/context-watch.js:574-598 mounts the
 * byte-stable watermark protocol (head section, order 10500) while the live
 * watermark line travels as a `systemPrompt.context` entry (order 300,
 * required: true, interpolate: false). DSH joins ALL context entries into one
 * "Current runtime context" snapshot and appends it as a NEW tail user message
 * only when the joined snapshot text changes (`surfaceOp: "append"`) — the
 * cached prefix is never touched. DSH evidence (checkout and installed copy):
 * - packages/core/agent-loop/src/runtime-context.ts:21 (CLEARED constant)
 * - packages/core/agent-loop/tests/runtime-context.spec.ts:127,143 (append)
 * - packages/core/system-prompt/tests/system-prompt.spec.ts:145,302 (join by order)
 *
 * Contract (one call per migrated section, at mount time):
 *
 *   registerTailContext(ctx, {
 *     sectionName,   // head slot name, UNCHANGED from today (e.g. "switchman:constraints")
 *     sectionOrder,  // head slot order, UNCHANGED (10250/10300/10400/10405/10406/10407/10510)
 *     contextName,   // new tail slot name (e.g. "switchman:constraints-live")
 *     contextOrder,  // new tail slot order (310..370, after watermark's 300)
 *     doctrine,      // (context) => string — byte-stable head text (anchor line or static block)
 *     payload,       // (context) => string — volatile tail text ("" when off/idle)
 *   })
 *
 * Behavior (all defensive, fail-open, mirroring context-watch.js):
 * 1. Host WITHOUT `systemPrompt.context`: register ONLY the head section with
 *    the legacy embedding — doctrine text, payload appended after a blank line
 *    whenever non-empty (today's exact pre-refactor shape) — and warn once per
 *    registration so degradation stays diagnosable. No context entry.
 * 2. Host WITH the API: register the head section with doctrine text only, AND
 *    register the context entry `{ name, order, required: true, interpolate:
 *    false, text: payload }`. If that registration throws, warn and fall back
 *    to rule 1's embedding — unregister-and-reembed is NOT required: DSH
 *    section registration is idempotent per name/order, so the head slot is
 *    simply re-registered with the legacy text shape.
 * 3. Both closures wrap their bodies in try/catch returning "" (existing
 *    convention, e.g. teams.js' section closure); a non-string result also
 *    normalizes to "".
 * 4. All registrations use `interpolate: false` (repo-wide convention).
 * 5. No config knobs, no new settings, no cordis.patch.yml changes.
 */

/** Mount one migrated section as a byte-stable head doctrine plus a volatile
 *  tail payload (see the module docstring for the full contract). Never throws. */
function registerTailContext(ctx, { sectionName, sectionOrder, contextName, contextOrder, doctrine, payload }) {
	const warn = (message) => ctx?.logger?.warn?.(`dsh-switchman: ${message}`);
	if (typeof doctrine !== "function" || typeof payload !== "function") {
		warn(`registerTailContext: doctrine and payload must be functions — ${sectionName ?? "(unnamed)"} not mounted`);
		return;
	}

	/** Fail-open closure wrapper: throw or non-string result renders "". */
	const safe = (fn) => (context) => {
		try {
			const text = fn(context);
			return typeof text === "string" ? text : "";
		} catch {
			return "";
		}
	};
	const headText = safe(doctrine);
	const tailText = safe(payload);

	/** Today's exact legacy shape: doctrine text, payload appended after a
	 *  blank line whenever non-empty. */
	const legacyText = (context) => {
		const head = headText(context);
		const tail = tailText(context);
		return tail === "" ? head : `${head}\n\n${tail}`;
	};

	/** Register the head section slot; a failure warns and disables the layer
	 *  (same convention as every existing section mount). */
	const mountSection = (text) => {
		ctx.systemPrompt.section({
			name: sectionName,
			order: sectionOrder,
			interpolate: false,
			text,
		});
	};

	if (typeof ctx?.systemPrompt?.context !== "function") {
		// Legacy fallback — behavior identical to pre-refactor; warn once per
		// registration so the degradation stays diagnosable (mirrors
		// context-watch.js' capability check).
		warn(
			`systemPrompt.context API unavailable on this DSH host — ${sectionName} keeps its payload embedded in the head section (legacy mode; per-turn head bytes there break prompt-prefix caching)`,
		);
		try {
			mountSection(legacyText);
		} catch (error) {
			warn(`systemPrompt.section registration failed — ${sectionName} disabled: ${error?.message ?? error}`);
		}
		return;
	}

	try {
		mountSection(headText);
	} catch (error) {
		warn(`systemPrompt.section registration failed — ${sectionName} disabled: ${error?.message ?? error}`);
		return;
	}
	try {
		ctx.systemPrompt.context({
			name: contextName,
			order: contextOrder,
			required: true,
			interpolate: false,
			text: tailText,
		});
	} catch (error) {
		// Section registration is idempotent per name/order, so falling back to
		// the legacy embedding needs no unregister-and-reembed: re-register the
		// head slot with the combined text and keep going.
		warn(
			`context entry registration failed — ${sectionName} falls back to legacy head embedding: ${error?.message ?? error}`,
		);
		try {
			mountSection(legacyText);
		} catch (fallbackError) {
			warn(`legacy fallback registration failed — ${sectionName} renders doctrine only: ${fallbackError?.message ?? fallbackError}`);
		}
	}
}

export { registerTailContext };
