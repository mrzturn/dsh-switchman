/** dsh-switchman dispatch-pool layer (Phase 2).
 *
 * Ported from opencode-switchman's pool lanes and model ranking onto DSH
 * services: one dynamic systemPrompt section (order 10400, after the
 * language section at 10300) renders the `[SWITCHMAN:POOLS]` recommendation
 * table from the live volatile settings, and — only in enforce mode — a
 * `tools/pre-execute` waterfall listener denies `subagent` calls that name
 * a provider+model outside every configured pool and modelRank.
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

/** The `[SWITCHMAN:POOLS]` block: anchor line, one line per configured lane,
 *  then the guidance lines (byte-stable for a given configuration). Routes
 *  outside the session's DSH-authorized child models carry a ⚠not-authorized
 *  marker (after any @effort suffix) — teams mode only: with teamsMode OFF
 *  the whitelist is never read, `state.authorized` stays null, and neither
 *  the markers nor the drift guidance lines render. */
function renderPoolsBlock(state) {
	const configured = state.lanePools.filter((pool) => pool.routes.length > 0);
	const lines = [`[SWITCHMAN:POOLS] configured=${configured.length}/6 enforce=${state.enforce}`];
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
		`A route suffixed @effort has a manually pinned reasoning effort — pass it as reasoning_effort when delegating to that model (it overrides the lane default).`,
		`Review delegations: anchor independence on the code AUTHOR's model, not the main session's (author = the agent that produced the diff: its explicit dispatch route, or the inherited session model when unspecified). Prefer a reviewer model different from the author's; also avoiding the session model is a bonus (its integration pass already covers that angle). If no pool entry differs from the author, same-model review is allowed — declare DOWNGRADED and state whether it is relative to the author or the session.`,
		`Explicit provider/model/effort on subagent/workflow calls is validated against this session's DSH-authorized child models (DSH Settings: allow agents to choose subagent models) — NOT against this table; when denied, discover allowed routes via list_subagent_models, or dispatch implicitly by omitting all three fields (the child then uses configured defaults or inherits the parent route).`,
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
		text: () => {
			const state = readDispatchState(ctx, config);
			const anyConfigured = state.lanePools.some((pool) => pool.routes.length > 0) || state.modelRank.length > 0;
			if (!anyConfigured) return "";
			return renderPoolsBlock(state);
		},
	});

	// Enforce gate (tools/pre-execute waterfall): deny decisions are returned
	// directly WITHOUT calling next() — { kind: "deny", reason } — while every
	// other path must call and return next(). Only subagent calls that name
	// both provider and model are checked; model-less calls use the system
	// default and pass through untouched.
	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			if (readField(config.dispatchEnforce) !== "enforce") return next();
			if (exec?.name !== "subagent") return next();
			const args = exec.arguments;
			if (typeof args?.provider !== "string" || args.provider === "") return next();
			if (typeof args?.model !== "string" || args.model === "") return next();
			const key = normalizeModelKey(args.provider, args.model);
			if (key === "") return next();

			const allowed = new Set();
			for (const lane of LANES) {
				for (const route of readList(config[laneField(lane)])) {
					if (!isModelRoute(route)) continue;
					const routeKey = normalizeModelKey(route.provider, route.model);
					if (routeKey !== "") allowed.add(routeKey);
				}
			}
			for (const entry of readList(config.modelRank)) {
				if (!isModelRoute(entry)) continue;
				const rankKey = normalizeModelKey(entry.provider, entry.model);
				if (rankKey !== "") allowed.add(rankKey);
			}
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
