/** dsh-switchman PTC direct-call guard layer.
 *
 * Symptom (observed 2026-11-12, session-level): in PTC sessions the model
 * calls a named tool DIRECTLY — e.g. `spawn_teammate` or `skill` after the
 * teams doctrine or the skill catalog names it — and the harness rejects the
 * whole call with `unknown tool "x": only \`run_code\` is callable directly`.
 * The PTC executor's own `PTC_ONLY` section (order 800) states the rule once
 * near the top, but every later doctrine that names tools directly erodes it.
 *
 * Second symptom (same day, session 22ced69f): the model sets `sandbox_permissions`
 * on a call while the session already runs `danger-full-access`; the escalation
 * request is rejected outright with `sandbox escalation to "workspace-write" is
 * not strictly wider than this call's current "danger-full-access" mode` — an
 * error with no correction hint. The clause below also states the never-set
 * default and the retry-without-the-field fix.
 *
 * Fix: one extra dynamic systemPrompt section (order 10510 — AFTER every
 * other dsh-switchman section: teams 10250, lang 10300, dispatch 10400,
 * context-trim 10450, context-watch 10500) that re-states the transport rule
 * as the LAST word whenever the viewing scope actually resolves to the PTC
 * executor. Native scopes render an empty string (status quo).
 *
 * Detection mirrors the ToolsService's own per-scope resolution: the section
 * text closure receives the assemble context, whose `scope` is the viewing
 * Agent/preset scope key; `ctx.tools.selectExecutor(scope)` (TS-private but
 * present at runtime — verified in the packaged app, `selectExecutor` survives
 * bundling) resolves the nearest scoped executor or the deployment default.
 * The executor is then discriminated BEHAVIORALLY via its public `describe()`:
 * the PTC executor declares `knownNames: ["run_code"]` exactly; the native
 * executor returns no `knownNames` at all. No class-name sniffing, no config
 * reads, no false positives for other executor implementations (they simply
 * get no guard).
 *
 * Fail-open everywhere: a missing/renamed private API, a throwing describe(),
 * or an unavailable executor selection all render "" — the session keeps its
 * current behavior and only loses the mitigation. Zero new dependencies.
 *
 * The clause is English, byte-stable protocol text (same convention as the
 * lang layer) with a `[SWITCHMAN:PTC]` anchor, `interpolate: false` because
 * the text contains braces.
 */

/** Reserved transport-tool name the PTC executor declares as its only direct call. */
const RUN_CODE_NAME = "run_code";

/** Final-say section position: after context-watch (10500), the last existing section. */
const PTC_GUARD_ORDER = 10510;

/** True when an executor description declares exactly the reserved run_code transport. */
function isPtcDescription(description) {
	if (description === null || typeof description !== "object") return false;
	const known = description.knownNames;
	return Array.isArray(known) && known.length === 1 && known[0] === RUN_CODE_NAME;
}

/** Selected executor for one assemble scope, or null when the private probe
 *  is unusable (missing service, missing/renamed method, unavailable selection). */
function selectedExecutor(ctx, scope) {
	const tools = ctx?.tools;
	if (tools === null || typeof tools !== "object") return null;
	if (typeof tools.selectExecutor !== "function") return null;
	try {
		const executor = tools.selectExecutor(scope);
		return executor === null || typeof executor !== "object" ? null : executor;
	} catch {
		return null;
	}
}

/** True when the scope's selected executor is the PTC executor. `describe([])`
 *  is safe for every known executor: the PTC implementation lazily creates its
 *  transport there (the ToolsService calls it on every model call anyway) and
 *  the native one maps over the empty list. */
function isPtcScope(ctx, scope) {
	const executor = selectedExecutor(ctx, scope);
	if (executor === null || typeof executor.describe !== "function") return false;
	try {
		return isPtcDescription(executor.describe([]));
	} catch {
		return false;
	}
}

/** Byte-stable protocol clause. The SDK call shape `await tools.name(args)` is
 *  quoted verbatim from the run_code tool's own model-facing description. */
function renderPtcGuard() {
	return [
		`[SWITCHMAN:PTC] This session runs in PTC (programmatic tool call) mode: \`${RUN_CODE_NAME}\` is the ONLY tool callable directly.`,
		`- Every other tool MUST be invoked as an awaited SDK function inside a ${RUN_CODE_NAME} program: \`await tools.name(args)\` — e.g. \`await tools.skill({ name: "git-commit-message" })\` or \`await tools.spawn_teammate({ ... })\`.`,
		`- A direct call fails with: unknown tool "x": only \`${RUN_CODE_NAME}\` is callable directly — call \`x\` from inside a \`${RUN_CODE_NAME}\` program instead. Never retry the direct form; wrap the call.`,
		`- Wherever this prompt says "call the X tool" (skill catalog, doctrines, per-turn reminders), read it as "call X inside a ${RUN_CODE_NAME} program". Batch independent calls as parallel awaits inside ONE program.`,
		`- \`grep.pattern\` is a regular expression. In a normal JavaScript string inside \`${RUN_CODE_NAME}\`, double backslashes: write \`"\\\\("\` to pass \`\\(\` to grep; \`String.raw\` tagged templates also preserve backslashes. If grep reports \`unclosed group\`, fix the pattern before retrying; never repeat it unchanged.`,
		`- Top-level declarations persist across \`${RUN_CODE_NAME}\` calls in this Agent: never redeclare an existing \`const\`/\`let\`/\`class\` binding; use a fresh identifier or reuse a mutable \`var\`. If you see \`Identifier ... has already been declared\`, retry with a fresh name—the SyntaxError happens before the program body runs.`,
		`- Never set \`sandbox_permissions\` on any call, direct or SDK: it is a privilege-escalation request and fails with "not strictly wider than this call's current ... mode" whenever the session already runs at least that access level — retry without the field.`,
	].join("\n");
}

/** Mount the PTC guard section. Section registration itself relies on the
 *  injected systemPrompt service (same as every other layer); the text closure
 *  is fully defensive so an assembly in an unexpected shape renders "". */
function applyPtcGuard(ctx) {
	ctx.systemPrompt.section({
		name: "switchman:ptc-guard",
		order: PTC_GUARD_ORDER,
		interpolate: false,
		text: (context) => {
			try {
				return isPtcScope(ctx, context?.scope) ? renderPtcGuard() : "";
			} catch {
				return "";
			}
		},
	});
}

export { applyPtcGuard, isPtcDescription, isPtcScope, renderPtcGuard, selectedExecutor };
