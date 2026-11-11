/** dsh-switchman dispatch-pool layer (Phase 2).
 *
 * Ported from opencode-switchman's pool lanes and model ranking onto DSH
 * services: one dynamic systemPrompt section (order 10400, after the
 * language section at 10300) renders the `[SWITCHMAN:POOLS]` recommendation
 * table from the live volatile settings, and — only in enforce mode — a
 * `tools/pre-execute` waterfall listener denies `subagent` calls that name
 * a provider+model outside every configured pool and modelRank.
 *
 * The same listener also runs an annotation sanitation pass in EVERY mode:
 * a model id copied verbatim off the rendered table can embed its
 * display-only `(TIER)`/`@effort` annotations (the recommendation table is
 * the one string an LLM is most tempted to copy), which DSH's exact-match
 * child-route whitelist then rejects with a generic binding error that
 * pushes the caller back to implicit dispatch — silently losing the lane's
 * route. The sanitation denies such calls with the exact corrected
 * arguments instead (exec.arguments is deep-frozen by the runtime, so a
 * deny is the only correction channel `tools/pre-execute` offers). The
 * same pass covers the field-shape failures production logs show models
 * repeating (a merged "provider/model" string with the provider field
 * omitted, a bare model with the provider field omitted, a model still
 * carrying its "provider/" prefix, and a provider-less
 * list_subagent_models call) — every such call is rejected by DSH
 * outright, so each deny carries the exact corrected fields and turns
 * 2-4 blind retries into one immediate re-dispatch.
 *
 * Model-facing text is English and byte-stable for a given configuration
 * (the anchor line never varies with UI locale). All reads go through the
 * live volatile references, so settings edits apply without a plugin
 * restart. Fail-open everywhere: a crashing gate or unreadable capability
 * snapshot degrades to advice, never blocks a tool.
 */

import { LANES, laneEffortsField, laneField, laneManualField } from "./config.js";
import { isModelRoute, loadCapabilityDefaults, normalizeModelKey, orderedPool } from "./lib/rank.js";

/** True for a well-formed {provider, model, effort} pin; the effort value
 *  is free-form — its valid set is the DSH adapter's reported efforts. */
function isEffortEntry(value) {
	return isModelRoute(value) && typeof value.effort === "string" && value.effort !== "";
}

/** Read one volatile settings field as a plain string (live `.get()` reference;
 *  mirrors host/lang.js's helper — the files stay independently mountable). */
function readField(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = field.get();
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}
	return typeof field === "string" ? field : "";
}

/** Read one volatile settings field as an array (non-arrays degrade to []). */
function readList(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			const value = field.get();
			return Array.isArray(value) ? value : [];
		} catch {
			return [];
		}
	}
	return Array.isArray(field) ? field : [];
}

/** Boolean volatile-field read (false on any malformed value). */
function readBool(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get() === true;
		} catch {
			return false;
		}
	}
	return field === true;
}

/** The rank.js model-segment extraction, verbatim (rank.js's
 *  normalizeModelKey ~lines 32-44): lowercase/trim, strip a `provider/` or
 *  bare-provider `provider:` prefix, drop `(...)`/`[...]` variant segments,
 *  fold illegal chars into "-" and trim edge punctuation. */
function modelSegment(model) {
	let s = typeof model === "string" ? model : "";
	s = s.toLowerCase().trim();
	if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
	else if (s.includes(":")) {
		const cut = s.lastIndexOf(":");
		if (!s.slice(0, cut).includes("-")) s = s.slice(cut + 1);
	}
	s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
	s = s.replace(/[^a-z0-9.]+/g, "-");
	return s.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Provider-exact identity of one (provider, model) route for the drift
 *  comparison ONLY. normalizeModelKey builds capability-table keys: it
 *  folds away the provider and keeps just the model's last segment, so an
 *  authorized `b/m` would falsely clear pool entry `a/m` — but DSH
 *  authorizes exact (provider, model) pairs. Returns
 *  `provider + "\u0000" + modelSegment`, or "" when either side is empty
 *  ("" never matches an authorized key). */
function routeIdentity(provider, model) {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = modelSegment(model);
	return p === "" || m === "" ? "" : `${p}\u0000${m}`;
}

/** The session's child-model authorization snapshot, read from the DSH
 *  host's `subagentModelSelection` service WITHOUT declaring inject (the
 *  same fail-open pattern routes.js's modelCatalogOf uses). The persisted
 *  shape names the list `allowedModels` while the inspect contract says
 *  `routes` — both are accepted. Keys are provider-exact route identities
 *  (routeIdentity), NOT capability-table keys: DSH authorizes exact
 *  (provider, model) pairs. Any missing service, error, or malformed
 *  value degrades to null: unknown means "render nothing", and this file
 *  family never throws on degraded capability. When enabled === false no
 *  explicit child model selection is allowed at all, so every pool route
 *  counts as unauthorized. */
function authorizedChildRoutes(ctx) {
	let service;
	try {
		service = typeof ctx?.get === "function" ? ctx.get("subagentModelSelection", false) : undefined;
	} catch {
		return null;
	}
	if (service === undefined || service === null || typeof service.current !== "function") return null;
	try {
		const snapshot = service.current();
		if (snapshot === null || typeof snapshot !== "object" || typeof snapshot.enabled !== "boolean") return null;
		const listed = Array.isArray(snapshot.routes)
			? snapshot.routes
			: Array.isArray(snapshot.allowedModels)
				? snapshot.allowedModels
				: [];
		const routes = [];
		const keys = new Set();
		for (const entry of listed) {
			if (!isModelRoute(entry)) continue;
			const key = routeIdentity(entry.provider, entry.model);
			if (key === "") continue;
			keys.add(key);
			routes.push({ provider: entry.provider, model: entry.model });
		}
		return { enabled: snapshot.enabled, keys, routes };
	} catch {
		return null;
	}
}

/** Live snapshot of the dispatch settings plus the bundled capability table.
 *  Each lane carries its manual-order flag: manual=true lanes dispatch in
 *  stored array order, auto lanes use the modelRank+capability ordering;
 *  `efforts` holds the lane's manually pinned reasoning efforts.
 *  `authorized` is the DSH-side child-model whitelist snapshot (null when
 *  unreadable — drift markers are then omitted). The detection only runs
 *  while teamsMode is ON: OFF removes it entirely (authorized stays null, so
 *  the ⚠not-authorized markers and their guidance never render), while the
 *  dispatchEnforce pool gate below is untouched. */
function readDispatchState(ctx, config) {
	const lanePools = LANES.map((lane) => ({
		lane,
		routes: readList(config[laneField(lane)]).filter(isModelRoute),
		manual: readBool(config[laneManualField(lane)]),
		efforts: readList(config[laneEffortsField(lane)]).filter(isEffortEntry),
	}));
	return {
		lanePools,
		modelRank: readList(config.modelRank).filter(isModelRoute),
		enforce: readField(config.dispatchEnforce),
		defaults: loadCapabilityDefaults(ctx?.logger),
		authorized: readBool(config.teamsMode) === true ? authorizedChildRoutes(ctx) : null,
	};
}

/** Render `provider/model(T)` for one ordered pool entry, with a `@effort`
 *  suffix when the route carries a manually pinned reasoning effort (tier
 *  omitted when unknown). */
function renderRoute(entry, effort = null) {
	const base = entry.tier === null ? `${entry.provider}/${entry.model}` : `${entry.provider}/${entry.model}(${entry.tier})`;
	return effort === null ? base : `${base}@${effort}`;
}

/** Key → pinned effort for one lane (first entry wins on duplicate keys). */
function effortMapOf(pool) {
	const effortOf = new Map();
	for (const pin of pool.efforts) {
		const key = normalizeModelKey(pin.provider, pin.model);
		if (key !== "" && !effortOf.has(key)) effortOf.set(key, pin.effort);
	}
	return effortOf;
}

/** Trailing display annotations renderPoolsBlock appends to a pool entry:
 *  the `(S)/(A)/(B)/(C)` capability-grade parenthetical (uppercase only —
 *  that is what renderRoute emits), the `@effort` pin, and the
 *  `⚠not-authorized` drift marker. */
const TRAILING_EFFORT = /@([A-Za-z0-9._-]+)$/;
const TRAILING_TIER = /\([SABC]\)$/;
const TRAILING_MARKER = /\s*⚠not-authorized$/u;

/** Strip every trailing display annotation from a model id
 *  ("m(A)@high" → "m"), looped so any order reduces; an unannotated id
 *  round-trips unchanged. */
function stripTrailingAnnotations(model) {
	let s = model.trim();
	for (;;) {
		const next = s.replace(TRAILING_MARKER, "").replace(TRAILING_EFFORT, "").replace(TRAILING_TIER, "").trim();
		if (next === s) return s;
		s = next;
	}
}

/** Folded-key → first configured {provider, model} route over every lane
 *  and modelRank — the enforce gate's matcher, factored out so the
 *  sanitation pass shares it. Empty when nothing is configured. */
function configuredRoutes(config) {
	const routes = new Map();
	const add = (route) => {
		if (!isModelRoute(route)) return;
		const key = normalizeModelKey(route.provider, route.model);
		if (key !== "" && !routes.has(key)) routes.set(key, { provider: route.provider, model: route.model });
	};
	for (const lane of LANES) for (const route of readList(config[laneField(lane)])) add(route);
	for (const entry of readList(config.modelRank)) add(entry);
	return routes;
}

/** First effort pin configured for one folded route key, across every
 *  lane's effort list (null when the route carries no pin) — completes a
 *  corrective hint whose copied id kept only the (TIER) annotation. */
function configuredEffortPin(config, key) {
	for (const lane of LANES) {
		for (const entry of readList(config[laneEffortsField(lane)])) {
			if (!isEffortEntry(entry)) continue;
			if (normalizeModelKey(entry.provider, entry.model) === key) return entry.effort;
		}
	}
	return null;
}

/** Corrective deny reason for one delegation call whose model argument
 *  embeds pool-table display annotations, or null to pass through. The
 *  stripped id must match a configured route (folded, like the enforce
 *  gate) — an unknown id is left to DSH's own route validation, so an
 *  exotic-but-real id that merely looks annotated never gets denied.
 *  Covers the plain suffix copy ("m(A)", "m(A)@high"), the whole-cell copy
 *  including the ⚠not-authorized drift marker, and the provider-combined
 *  copy ("provider/m(A)" with provider left empty). The reasoning_effort
 *  hint rides along when the copied string carried the @effort annotation
 *  or the matched route holds a configured pin, and the call did not
 *  already set reasoning_effort itself. */
function annotationFixOf(args, config) {
	const model = typeof args?.model === "string" ? args.model.trim() : "";
	if (model === "") return null;
	const providerGiven = typeof args?.provider === "string" && args.provider.trim() !== "";
	let provider = providerGiven ? args.provider.trim() : "";
	let modelPart = model;
	if (!providerGiven && modelPart.includes("/")) {
		const cut = modelPart.lastIndexOf("/");
		provider = modelPart.slice(0, cut).trim();
		modelPart = modelPart.slice(cut + 1).trim();
	}
	modelPart = modelPart.replace(TRAILING_MARKER, "").trim();
	const effortMatch = TRAILING_EFFORT.exec(modelPart);
	const stripped = stripTrailingAnnotations(modelPart);
	if (stripped === modelPart || stripped === "") return null;
	const key = normalizeModelKey(provider, stripped);
	const matched = key === "" ? undefined : configuredRoutes(config).get(key);
	if (matched === undefined) return null;
	// The re-dispatch must name BOTH fields whenever the original call left
	// provider empty (provider+model go together on these tools), even when
	// the provider was recoverable from a combined "provider/model(…)" copy.
	// A provider-given whole-cell copy still carries its "provider/" prefix
	// inside the stripped id — the matched route's clean model is the only
	// suggestion DSH's exact-match whitelist will actually accept.
	const modelFix = stripped.includes("/") ? matched.model : stripped;
	const fields = providerGiven
		? `model "${modelFix}"`
		: `provider "${provider !== "" ? provider : matched.provider}", model "${modelFix}"`;
	const hasExplicitEffort = typeof args?.reasoning_effort === "string" && args.reasoning_effort.trim() !== "";
	const pinned = effortMatch !== null ? effortMatch[1] : configuredEffortPin(config, key);
	const effort = hasExplicitEffort || pinned === null ? "" : ` and reasoning_effort "${pinned}"`;
	return (
		`[SWITCHMAN:POOLS] the model argument "${args.model}" embeds pool-table display annotations — ` +
		`the (S/A/B/C) capability grade and any @effort suffix are annotations, NOT parts of the model id. ` +
		`Re-dispatch this call with ${fields}${effort}, keeping every other argument unchanged.`
	);
}

/** Every configured {provider, model} route across all lanes and
 *  modelRank, in config order. Unlike configuredRoutes (whose folded key
 *  is first-wins per model segment — right for route MATCHING, where
 *  duplicates would collapse), this keeps every entry: provider-candidate
 *  hints must see all providers offering the same model id. */
function allConfiguredRoutes(config) {
	const routes = [];
	const add = (route) => {
		if (isModelRoute(route)) routes.push(route);
	};
	for (const lane of LANES) for (const route of readList(config[laneField(lane)])) add(route);
	for (const entry of readList(config.modelRank)) add(entry);
	return routes;
}

/** Distinct configured providers whose folded model key matches one bare
 *  model id, in config order — completes a corrective hint for a
 *  delegation or enumeration call that omitted the provider field. */
function modelProviderMatches(config, model) {
	const key = normalizeModelKey("", model);
	if (key === "") return [];
	const seen = new Set();
	const providers = [];
	for (const route of allConfiguredRoutes(config)) {
		if (normalizeModelKey("", route.model) !== key || seen.has(route.provider)) continue;
		seen.add(route.provider);
		providers.push(route.provider);
	}
	return providers;
}

/** Canonical pool spelling for a folded model-id hit (caller casing
 *  and annotation tail vary); the trimmed input when no pool route
 *  folds to it. */
function canonicalPoolModel(config, providers, model) {
	const hit = allConfiguredRoutes(config).find(
		(route) =>
			providers.includes(route.provider) &&
			normalizeModelKey("", route.model) === normalizeModelKey("", model),
	);
	return hit !== undefined ? hit.model : model;
}

/** Corrective deny reason for one delegation call whose provider/model
 *  field SPLIT is malformed, or null to pass through. Covers the field
 *  failures observed in production session logs (each burned 2-4 blind
 *  retries before a manual fix):
 *
 *  - provider omitted, model a merged "provider/model" string: DSH rejects
 *    EVERY such call with "`provider` and `model` must be supplied
 *    together" before any route check, so denying with the split fields is
 *    a strict improvement even when the split is not a configured route —
 *    a deliberate exception to the annotated-copy rule that unknown ids
 *    pass through (that rule protects calls DSH would ACCEPT; these can
 *    never succeed);
 *  - provider given, model still carrying that same "provider/" prefix:
 *    DSH joins provider + "/" + model itself, so the resolved route
 *    double-encodes the provider and misses the exact-match whitelist;
 *  - provider omitted, model a bare id: resolved against the pool table —
 *    exactly one configured provider → the pair; several → the candidate
 *    list; none → pass through (DSH's own error already says what's wrong);
 *  - provider given, model naming a DIFFERENT provider's configured route:
 *    denied with that route's pair; anything else passes untouched. */
function routeFixOf(args, config) {
	const model = typeof args?.model === "string" ? args.model.trim() : "";
	if (model === "") return null;
	const providerGiven = typeof args?.provider === "string" && args.provider.trim() !== "";
	const provider = providerGiven ? args.provider.trim() : "";

	// Provider given, model still prefixed: the double-encoded route can
	// never match the exact whitelist, so the correction is unconditional.
	if (providerGiven && model.startsWith(`${provider}/`)) {
		const fixed = model.slice(provider.length + 1).trim();
		if (fixed === "" || fixed.includes("/")) return null;
		return (
			`[SWITCHMAN:POOLS] the model argument already carries the provider prefix — DSH joins provider + "/" + model itself, so this call resolves to the route "${provider}/${model}" and is rejected. ` +
			`Re-dispatch with provider "${provider}", model "${fixed}", keeping every other argument unchanged.`
		);
	}

	const cut = model.lastIndexOf("/");

	// Provider given, model names another provider's configured route.
	if (providerGiven && cut > 0) {
		const prefix = model.slice(0, cut).trim();
		const known =
			prefix === ""
				? undefined
				: allConfiguredRoutes(config).find(
					(route) =>
						route.provider.toLowerCase() === prefix.toLowerCase() &&
						normalizeModelKey("", route.model) === normalizeModelKey("", model.slice(cut + 1).trim()),
				);
		// No configured route under that prefix: not a shape we can correct
		// — pass through for DSH's own rejection, without tripping the
		// fail-open catch.
		if (known === undefined) return null;
		return (
			`[SWITCHMAN:POOLS] the model argument embeds another provider's route — with provider "${provider}" this resolves to "${provider}/${model}", which no authorized route matches. ` +
			`Re-dispatch with provider "${known.provider}", model "${known.model}", keeping every other argument unchanged.`
		);
	}

	if (providerGiven) return null;

	// Provider omitted, merged "provider/model" string: always rejected by
	// DSH (both fields are required together), deny with the split fields.
	if (cut > 0) {
		// A merged copy of the already-prefixed id ("prov/prov/model") —
		// the repeated head segment is the giveaway; recommend the inner
		// pair directly. Other mid-slash shapes stay uncorrectable.
		const segments = model.split("/");
		const doubled =
			segments.length === 3 &&
			segments[0].trim().toLowerCase() === segments[1].trim().toLowerCase();
		const providerFix = (doubled ? segments[0] : model.slice(0, cut)).trim();
		const modelFix = stripTrailingAnnotations((doubled ? segments[2] : model.slice(cut + 1)).trim());
		// Segments still malformed after the split (a mid-slash provider,
		// a leading-slash or nested model) cannot be corrected into a call
		// DSH would accept — pass through.
		if (
			providerFix === "" ||
			modelFix === "" ||
			providerFix.includes("/") ||
			modelFix.includes("/")
		)
			return null;
		const matched = allConfiguredRoutes(config).find(
			(route) =>
				route.provider.toLowerCase() === providerFix.toLowerCase() &&
				normalizeModelKey("", route.model) === normalizeModelKey("", modelFix),
		);
		// Recommend the pool's canonical spelling on a folded hit so
		// case-variant or annotated copies resolve on the first retry.
		const shownProvider = matched !== undefined ? matched.provider : providerFix;
		const shownModel = matched !== undefined ? matched.model : modelFix;
		const note =
			matched === undefined
				? `If "${shownProvider}/${shownModel}" is not authorized for this session, the re-dispatch error will say so precisely.`
				: `This is the configured pool route ${shownProvider}/${shownModel}.`;
		return (
			`[SWITCHMAN:POOLS] the model argument merges provider and model into one string — subagent calls take SEPARATE provider and model fields, and DSH rejects every call that omits either. ` +
			`Re-dispatch with provider "${shownProvider}", model "${shownModel}", keeping every other argument unchanged. ${note}`
		);
	}

	// A leading "/" (cut === 0) is malformed beyond folding: the pool
	// matcher would silently strip it and recommend the malformed id back.
	// Pass through and let DSH's own schema error surface.
	if (cut === 0) return null;

	// Provider omitted, bare model id: resolve the provider from the pool
	// table; pass through when the id names no configured provider.
	const providers = modelProviderMatches(config, model);
	if (providers.length === 0) return null;
	const shownModel = canonicalPoolModel(config, providers, model);
	if (providers.length === 1) {
		return (
			`[SWITCHMAN:POOLS] the provider field is missing — subagent calls take SEPARATE provider and model fields, and DSH rejects every call that omits either. ` +
			`The model id "${model}" is configured under exactly one provider. Re-dispatch with provider "${providers[0]}", model "${shownModel}", keeping every other argument unchanged.`
		);
	}
	return (
		`[SWITCHMAN:POOLS] the provider field is missing and the model id "${model}" is configured under several providers (${providers.join(", ")}). ` +
		`Re-dispatch with one of those providers as the provider field, model "${shownModel}", keeping every other argument unchanged.`
	);
}

/** Corrective deny reason for a malformed list_subagent_models call, or
 *  null to pass through. DSH's own schema rejects {} and {model}-only
 *  calls with a bare "`provider` must be non-empty"; production logs show
 *  that error costing 2-4 blind probes (empty, empty, provider-only,
 *  provider+model). One deny carrying the pool table's provider list
 *  turns that into a single corrected call. provider-given calls always
 *  pass. */
function enumerationFixOf(args, config) {
	const provider = typeof args?.provider === "string" ? args.provider.trim() : "";
	if (provider !== "") return null;
	const model = typeof args?.model === "string" ? args.model.trim() : "";
	if (model === "") {
		const providers = [...new Set(allConfiguredRoutes(config).map((route) => route.provider))];
		const list = providers.length > 0 ? ` Providers configured on this session's pools: ${providers.join(", ")}.` : "";
		return (
			`[SWITCHMAN:POOLS] list_subagent_models requires a non-empty provider — a call without one is rejected, not a listing of everything. ` +
			`Call it with {"provider":"<provider>"} to enumerate that provider's selectable models, then add "model" for one route's details.${list}`
		);
	}
	const providers = modelProviderMatches(config, model);
	if (providers.length === 0) return null;
	const shownModel = canonicalPoolModel(config, providers, model);
	if (providers.length === 1) {
		return (
			`[SWITCHMAN:POOLS] list_subagent_models requires a non-empty provider. The model id "${model}" is configured under exactly one provider — ` +
			`call it with provider "${providers[0]}", model "${shownModel}" for that route's details.`
		);
	}
	return (
		`[SWITCHMAN:POOLS] list_subagent_models requires a non-empty provider. The model id "${model}" is configured under several providers (${providers.join(", ")}) — ` +
		`call it with one of those providers as the provider field, model "${shownModel}".`
	);
}

/** The assembling session's own route, from the DSH agent-loop's assemble
 *  context (`agent.ts` passes `modelSelection` with every turn assembly;
 *  older builds and non-agent assemblies omit it). Null when absent or
 *  malformed — the session-route line then does not render (fail-open,
 *  like every capability read in this file family). */
function sessionRouteOf(context) {
	const route = context === null || typeof context !== "object" ? undefined : context.modelSelection;
	if (route === null || typeof route !== "object") return null;
	const provider = typeof route.provider === "string" ? route.provider.trim() : "";
	const model = typeof route.model === "string" ? route.model.trim() : "";
	if (provider === "" || model === "") return null;
	const effort = typeof route.reasoningEffort === "string" && route.reasoningEffort !== "" ? route.reasoningEffort : null;

	return { provider, model, effort };
}


/** The `[SWITCHMAN:POOLS]` block: anchor line, one line per configured lane,
 *  then the guidance lines (byte-stable for a given configuration). Routes
 *  outside the session's DSH-authorized child models carry a ⚠not-authorized
 *  marker (after any @effort suffix) — teams mode only: with teamsMode OFF
 *  the whitelist is never read, `state.authorized` stays null, and neither
 *  the markers nor the drift guidance lines render. When the assembling
 *  context carries the session's own model selection, a `session route:`
 *  line follows the anchor. */
function renderPoolsBlock(state, sessionRoute = null) {
	const configured = state.lanePools.filter((pool) => pool.routes.length > 0);
	const lines = [`[SWITCHMAN:POOLS] configured=${configured.length}/6 enforce=${state.enforce}`];
	if (sessionRoute !== null) {
		lines.push(
			`session route: ${sessionRoute.provider}/${sessionRoute.model}${sessionRoute.effort === null ? "" : `@${sessionRoute.effort}`}` +
				` — implicit dispatch (omitting provider/model/effort) gives the child THIS route; when it differs from the lane entries, only an explicit dispatch lands a lane model.`,
		);
	}
	let anyUnauthorized = false;
	for (const pool of state.lanePools) {
		if (pool.routes.length === 0) continue;
		const effortOf = effortMapOf(pool);
		const routes = orderedPool(pool.routes, state.modelRank, state.defaults, pool.manual)
			.map((entry) => {
				const rendered = renderRoute(entry, effortOf.get(normalizeModelKey(entry.provider, entry.model)) ?? null);
				if (state.authorized === null) return rendered;
				if (state.authorized.enabled === false || !state.authorized.keys.has(routeIdentity(entry.provider, entry.model))) {
					anyUnauthorized = true;
					return `${rendered} ⚠not-authorized`;
				}
				return rendered;
			})
			.join(", ");
		lines.push(`${pool.lane}${pool.manual ? "*" : ""}: ${routes}`);
	}
	lines.push(
		`When delegating via subagent/workflow, pick a model from the lane matching the task category; spawn_teammate takes no model argument (lanes do not apply to it).`,
		`Lanes marked * are in manual order: dispatch follows the listed order exactly (the head is the first choice).`,
		`effort: economy=medium mechanical=medium main=medium (high for complex tasks) hard=high vision=multimodal-capable model review=high; an unconfigured lane uses the system default model.`,
		`Entries render as provider/model(TIER)@effort: (TIER) is the S/A/B/C capability grade and @effort a manually pinned reasoning effort — both are display-only annotations, NEVER parts of the model id.`,
		`Decompose into SEPARATE tool fields: provider/model(TIER)@effort → {"provider":"<provider>","model":"<model>","reasoning_effort":"<effort>"} (a pin overrides the lane default; a route without @effort carries no per-route pin — fall back to the lane's default effort above).`,
		`The table cell is ONE display string, never a field value: "model":"provider/model" (provider field omitted) is rejected, and model NEVER carries a "provider/" prefix — DSH joins provider + "/" + model itself, so a prefixed model double-encodes the provider and misses the whitelist.`,
		`Review delegations: anchor independence on the code AUTHOR's model, not the main session's (author = the agent that produced the diff: its explicit dispatch route, or the inherited session model when unspecified). Prefer a reviewer model different from the author's; also avoiding the session model is a bonus (its integration pass already covers that angle). If no pool entry differs from the author, same-model review is allowed — declare DOWNGRADED and state whether it is relative to the author or the session.`,
		`Explicit lane dispatch is the DEFAULT for subagent/workflow: name provider+model+reasoning_effort decomposed from the lane row (validated against this session's DSH-authorized child models — DSH Settings: allow agents to choose subagent models — NOT against this table). Implicit dispatch (omitting all three fields) is a LAST-RESORT fallback, never a shortcut: use it only after an explicit attempt was denied or list_subagent_models confirmed no authorized route, and declare IMPLICIT-DOWNGRADED in your report when you do — the child then uses configured defaults or inherits the parent route, so the lane's model is lost.`,
		`list_subagent_models verifies authorized routes before dispatching: {"provider":"<provider>"} lists that provider's models, {"provider":"<provider>","model":"<model>"} returns one route's details — {} and {"model"} alone are rejected (provider is required and non-empty).`,
	);
	if (anyUnauthorized) {
		lines.push(
			state.authorized.enabled === false
				? `All routes above are marked ⚠not-authorized because explicit child model selection is currently disabled in DSH Settings (subagents: model selection) — every explicit provider/model/effort dispatch is denied; dispatch implicitly by omitting those fields until it is re-enabled.`
				: `Routes marked ⚠not-authorized are pool entries outside this session's DSH-authorized child models — authorize them in DSH Settings (subagents: model selection), or dispatch them implicitly by omitting provider/model/effort.`,
		);
	}
	lines.push(
		`This table does not restrict models outside the pools${
			state.enforce === "enforce"
				? ". In addition, in enforce mode: subagent calls naming a provider+model outside the pools or modelRank are denied"
				: ""
		}.`,
	);
	return lines.join("\n");
}

/** The first recommended route right now: the head of the first configured
 *  lane in display order (already ordered — manual lanes use stored order,
 *  auto lanes the modelRank+capability ordering), else the modelRank head. */
function topRecommendation(state) {
	for (const pool of state.lanePools) {
		if (pool.routes.length === 0) continue;
		return orderedPool(pool.routes, state.modelRank, state.defaults, pool.manual)[0] ?? null;
	}
	return state.modelRank.length > 0 ? state.modelRank[0] : null;
}

/** Mount the dispatch-pool layer: dynamic prompt section + enforce gate. */
function applyDispatch(ctx, config) {
	ctx.systemPrompt.section({
		name: "switchman:dispatch",
		order: 10400,
		interpolate: false,
		text: (context) => {
			const state = readDispatchState(ctx, config);
			const anyConfigured = state.lanePools.some((pool) => pool.routes.length > 0) || state.modelRank.length > 0;
			if (!anyConfigured) return "";
			return renderPoolsBlock(state, sessionRouteOf(context));
		},
	});

	// Annotation sanitation (every mode) + enforce gate (enforce mode only).
	// Both are tools/pre-execute waterfall listeners in one registration:
	// deny decisions are returned directly WITHOUT calling next() —
	// { kind: "deny", reason } — while every other path must call and
	// return next(). The sanitation covers subagent and subagent_fork; the
	// enforce gate below stays subagent-only with both provider and model
	// named; model-less calls use the system default and pass through.
	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			if (exec?.name === "list_subagent_models") {
				// Enumeration sanitation: DSH rejects provider-less calls with a
				// bare "`provider` must be non-empty"; deny once with the pool
				// table's provider list instead (fail-open wrapper below).
				const fix = enumerationFixOf(exec.arguments, config);
				return fix === null ? next() : { kind: "deny", reason: fix };
			}
			if (exec?.name !== "subagent" && exec?.name !== "subagent_fork") return next();
			const args = exec.arguments;

			// Annotation sanitation: a model id copied verbatim off the
			// rendered table embeds its display-only (TIER)/@effort/⚠
			// annotations; DSH's exact-match whitelist would reject it with
			// a generic binding error that pushes the caller back to
			// implicit dispatch, losing the lane's route. Deny with the
			// exact corrected arguments instead — one immediate retry on
			// the intended route.
			const fix = annotationFixOf(args, config) ?? routeFixOf(args, config);
			if (fix !== null) return { kind: "deny", reason: fix };

			// Enforce gate: unchanged semantics, now sharing the factored
			// configuredRoutes matcher (same folded keys as before).
			if (readField(config.dispatchEnforce) !== "enforce") return next();
			if (exec?.name !== "subagent") return next();
			if (typeof args?.provider !== "string" || args.provider === "") return next();
			if (typeof args?.model !== "string" || args.model === "") return next();
			const key = normalizeModelKey(args.provider, args.model);
			if (key === "") return next();

			const allowed = configuredRoutes(config);
			if (allowed.size === 0 || allowed.has(key)) return next();

			const state = readDispatchState(ctx, config);
			const recommendation = topRecommendation(state);
			const recommended =
				recommendation === null
					? ""
					: ` Recommended instead: ${recommendation.provider}/${recommendation.model}.`;
			return {
				kind: "deny",
				reason:
					`[SWITCHMAN:POOLS] enforce: route "${args.provider}/${args.model}" is outside every configured pool and modelRank.` +
					`${recommended} Adjust the dispatch pools in the dsh-switchman settings page,` +
					` or delegate without naming provider+model to use the system default.`,
			};
		} catch (error) {
			ctx.logger.warn(`dsh-switchman: dispatch enforce gate failed open: ${error?.message ?? error}`);
			return next();
		}
	});
}

export { applyDispatch, authorizedChildRoutes };
