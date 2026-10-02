/** dsh-switchman capability ranking (Phase 2), pure functions + one cached
 * bundled-data read.
 *
 * Ported from opencode-switchman src/capability.ts (normalizeModelKey:68-74,
 * tierOfScore:81-86, apiMatch:382-391) and the pool-lane ordering of
 * scoring.rankCandidates, reduced to what DSH needs: normalize model
 * references onto the bundled capability snapshot's keys, grade them into
 * S/A/B/C tiers, and order one dispatch pool (modelRank-anchored entries
 * first, then default capability score descending, input order as the
 * stable fallback). All functions are defensive — malformed input degrades
 * to a lower-information result, never throws.
 */

import { readFileSync } from "node:fs";

/** Minimum length for a prefix match (avoids false hits on short keys). */
const MIN_PREFIX_LEN = 4;

/** Absolute index thresholds; a spec that is not S>A>B falls back to these. */
const DEFAULT_THRESHOLDS = { S: 62, A: 55, B: 45 };

/** Valid tier letters (RankEntrySchema's enum). */
const TIERS = ["S", "A", "B", "C"];

/** Normalize one model reference to its capability-table key: lowercase,
 *  strip a `provider/model` / `provider:model` prefix, drop `(...)`/`[...]`
 *  variant segments, fold illegal chars into "-" (capability.ts:68-74).
 *  Accepts (provider, model) routes or a single combined string; the model
 *  part wins when both are given. The `:` form is stripped only when the
 *  prefix looks like a bare provider word (no "-"), so dated variants such
 *  as `gpt-4o:latest` survive intact. */
function normalizeModelKey(provider, model) {
	let s = typeof model === "string" ? model : typeof provider === "string" ? provider : "";
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

/** True for a plain `{ provider, model }` route shape. */
function isModelRoute(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof value.provider === "string" &&
		value.provider !== "" &&
		typeof value.model === "string" &&
		value.model !== ""
	);
}

/** Resolve the snapshot's thresholds: finite numbers with S>A>B, else defaults. */
function resolveThresholds(spec) {
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const t = {
		S: num(spec?.S) ?? DEFAULT_THRESHOLDS.S,
		A: num(spec?.A) ?? DEFAULT_THRESHOLDS.A,
		B: num(spec?.B) ?? DEFAULT_THRESHOLDS.B,
	};
	return t.S > t.A && t.A > t.B ? t : { ...DEFAULT_THRESHOLDS };
}

/** Index → tier (S/A/B/C; score ≥ threshold takes the higher tier). */
function tierOfScore(score, thresholds) {
	if (score >= thresholds.S) return "S";
	if (score >= thresholds.A) return "A";
	if (score >= thresholds.B) return "B";
	return "C";
}

/** Build the Map<key, {score, tier}> capability table from a parsed
 *  capability-default.json (keys are pre-normalized by the generator).
 *  Anything unexpected yields a smaller table, never an error. */
function defaultTiers(data) {
	const table = new Map();
	if (data === null || typeof data !== "object") return table;
	const models = data.models;
	if (models === null || typeof models !== "object" || Array.isArray(models)) return table;
	const thresholds = resolveThresholds(data.thresholds);
	for (const [key, entry] of Object.entries(models)) {
		if (typeof entry !== "object" || entry === null || !Number.isFinite(entry.score)) continue;
		table.set(key, { score: entry.score, tier: tierOfScore(entry.score, thresholds) });
	}
	return table;
}

/** Exact → longest-prefix (≥ MIN_PREFIX_LEN) match against a capability
 *  table; null when nothing matches (apiMatch:382-391). */
function matchKey(table, normKey) {
	if (typeof normKey !== "string" || normKey === "") return null;
	const exact = table.get(normKey);
	if (exact !== undefined) return { score: exact.score, tier: exact.tier, matchedAs: normKey };
	let bestKey = null;
	for (const [key] of table) {
		if (key.length >= MIN_PREFIX_LEN && normKey.startsWith(key) && (bestKey === null || key.length > bestKey.length))
			bestKey = key;
	}
	if (bestKey === null) return null;
	const entry = table.get(bestKey);
	return { score: entry.score, tier: entry.tier, matchedAs: bestKey };
}

/** Look one route (or combined string) up in a capability table. */
function capabilityOf(table, provider, model) {
	if (!(table instanceof Map)) return null;
	return matchKey(table, normalizeModelKey(provider, model));
}

/** Order one dispatch pool's routes. With manual=false (default): entries
 *  anchored in modelRank keep the array order and come first (their anchored
 *  tier is display-only); the rest fall back to default capability score
 *  descending, input order as the final tiebreak. With manual=true: the
 *  stored input order IS the dispatch priority — no re-sorting, tiers are
 *  still resolved for display. Each returned entry carries
 *  { provider, model, tier } with tier = anchored ?? capability ?? null. */
function orderedPool(poolRoutes, modelRank, table, manual = false) {
	const routes = (Array.isArray(poolRoutes) ? poolRoutes : []).filter(isModelRoute);
	const rank = (Array.isArray(modelRank) ? modelRank : []).filter(isModelRoute);
	const anchorTier = new Map();
	rank.forEach((entry) => {
		const key = normalizeModelKey(entry.provider, entry.model);
		if (key === "" || anchorTier.has(key)) return;
		if (TIERS.includes(entry.tier)) anchorTier.set(key, entry.tier);
	});
	const resolveTier = (key) => anchorTier.get(key) ?? matchKey(table instanceof Map ? table : new Map(), key)?.tier ?? null;
	if (manual) return routes.map((route) => ({ provider: route.provider, model: route.model, tier: resolveTier(normalizeModelKey(route.provider, route.model)) }));
	const anchorIndex = new Map();
	rank.forEach((entry, index) => {
		const key = normalizeModelKey(entry.provider, entry.model);
		if (key === "" || anchorIndex.has(key)) return;
		anchorIndex.set(key, index);
	});
	const decorated = routes.map((route, index) => {
		const key = normalizeModelKey(route.provider, route.model);
		const anchor = anchorIndex.get(key) ?? Number.POSITIVE_INFINITY;
		const capability = matchKey(table instanceof Map ? table : new Map(), key);
		return {
			provider: route.provider,
			model: route.model,
			tier: anchorTier.get(key) ?? capability?.tier ?? null,
			anchor,
			score: capability?.score ?? Number.NEGATIVE_INFINITY,
			fallback: index,
		};
	});
	decorated.sort((a, b) => a.anchor - b.anchor || b.score - a.score || a.fallback - b.fallback);
	return decorated.map(({ provider, model, tier }) => ({ provider, model, tier }));
}

/** Module-level cache for the bundled snapshot (undefined = not loaded yet). */
let defaultsCache;

/** Whether the load-failure warning already fired (warn once). */
let defaultsWarned = false;

/** Read host/data/capability-default.json into a capability table (cached).
 *  On any read/parse failure the failure is cached as an empty table, the
 *  warning fires once, and pool ordering degrades gracefully. */
function loadCapabilityDefaults(logger) {
	if (defaultsCache !== undefined) return defaultsCache;
	try {
		const raw = readFileSync(new URL("../data/capability-default.json", import.meta.url), "utf8");
		defaultsCache = defaultTiers(JSON.parse(raw));
	} catch (error) {
		defaultsCache = new Map();
		if (!defaultsWarned) {
			defaultsWarned = true;
			const warn = typeof logger?.warn === "function" ? logger.warn.bind(logger) : console.warn;
			warn(`dsh-switchman: capability defaults unavailable (${error?.message ?? error}); pools fall back to configured order`);
		}
	}
	return defaultsCache;
}

export {
	capabilityOf,
	defaultTiers,
	isModelRoute,
	loadCapabilityDefaults,
	normalizeModelKey,
	orderedPool,
};
