/** Host-side HTTP routes for the dsh-switchman client half.
 *
 * The browser half of this bundle runs inside the restricted dynamic-module
 * runtime: it has no `configForms`/`remote` services and no direct network —
 * the sanctioned bridge is same-origin `fetch` against routes the Host half
 * registers on `ctx.webServer` (the pattern the shipped skill-explorer
 * plugin established). This module owns that route family:
 *
 *   GET  /api/dsh-switchman/health   — liveness probe for the client page.
 *   GET  /api/dsh-switchman/config   — current settings values snapshot plus
 *                                      `whitelistSync` (null unless teamsMode
 *                                      && syncWhitelist, else the teams
 *                                      layer's last replace-sync outcome).
 *   POST /api/dsh-switchman/config   — { expected, values } fenced write
 *                                      through ctx.settings.update; a stale
 *                                      `expected` answers 409 + fresh values.
 *                                      A successful write schedules the teams
 *                                      orchestration (fire-and-forget).
 *   GET  /api/dsh-switchman/models   — model-catalog pass-through from the
 *                                      host sessionController (degrades to
 *                                      llm.listProviders, then []).
 *   GET  /api/dsh-switchman/authorized — the session's DSH-authorized child
 *                                      models ({enabled, routes}; both null
 *                                      when the host service is unreadable).
 *   GET  /api/dsh-switchman/vision-state — composer-dock hint; the optional
 *                                      `session` query parameter judges image
 *                                      capability against THAT session's
 *                                      model (unknown/missing → root model).
 *   POST /api/dsh-switchman/ui-locale — the client half reports its active
 *                                      UI locale (feeds the ask guidance's
 *                                      question language; no settings write).
 *
 * Every route carries the shared trust fence (loopback + same-origin browser
 * markers; a live remoteWebUiPairing cookie is an extra allow path), mirroring
 * skill-explorer's access model: the write route changes real persisted
 * settings, so unpaired LAN clients must not reach it.
 */

import { authorizedChildRoutes } from "./dispatch.js";
import { handoverSnapshot } from "./handover-state.js";
import { pumpTeamsOrchestration, scheduleTeamsOrchestration, SWITCHMAN_SETTINGS_NS, teamsBundleState, teamsSyncSnapshot } from "./teams.js";
import { reportedUiLocale, setReportedUiLocale } from "./ui-locale.js";
import { visionStateOf } from "./vision.js";

/** Route paths (client.js mirrors these literals). */
const ROUTES = {
	health: "/api/dsh-switchman/health",
	config: "/api/dsh-switchman/config",
	models: "/api/dsh-switchman/models",
	authorized: "/api/dsh-switchman/authorized",
	handoverState: "/api/dsh-switchman/handover-state",
	visionState: "/api/dsh-switchman/vision-state",
	uiLocale: "/api/dsh-switchman/ui-locale",
};

/** Settings namespace this plugin's writes target: the LOADER ENTRY id from
 * cordis.patch.yml (`- id: dsh-switchman-host`), not the plugin's `name`
 * export — dsh-settings' write() looks entries up by entry.options.id.
 * Single-sourced as SWITCHMAN_SETTINGS_NS in host/teams.js (whose
 * settings/document-updated listener keys on it); aliased here for the
 * write call sites below. */
const NS = SWITCHMAN_SETTINGS_NS;

/** All settings field names, grouped for coercion (mirrors host/config.js). */
const STRING_FIELDS = ["langConversation", "langComments", "langDocs"];
const POOL_FIELDS = [
	"poolEconomy",
	"poolMechanical",
	"poolMain",
	"poolHard",
	"poolVision",
	"poolReview",
];
const NUMBER_FIELDS = [
	"wmSoftTokens",
	"wmHardTokens",
	"wmForceTokens",
	"wmReadBudgetTokens",
	"wmSubagentForceTokens",
];
const BOOLEAN_FIELDS = [
	"wmAutoHandover",
	"wmSubagentCap",
	// The following six mirror the pool*Manual switches in host/config.js
	"poolEconomyManual",
	"poolMechanicalManual",
	"poolMainManual",
	"poolHardManual",
	"poolVisionManual",
	"poolReviewManual",
	// Teams switches (mirrors the teams* group in host/config.js)
	"teamsMode",
	"syncWhitelist",
];
/** Per-pool effort-route lists (mirrors host/config.js pool*Efforts). */
const EFFORTS_FIELDS = [
	"poolEconomyEfforts",
	"poolMechanicalEfforts",
	"poolMainEfforts",
	"poolHardEfforts",
	"poolVisionEfforts",
	"poolReviewEfforts",
];
const ENUM_FIELDS = {
	uiLocale: ["auto", "en", "zh", "zh-TW", "ja", "ko", "de", "es", "fr", "it", "pt", "ru"],
	langScope: ["global", "project"],
	dispatchEnforce: ["off", "advice", "enforce"],
	wmDenyMode: ["cap", "deny"],
};

/** JSON response helper. */
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

/** Read and parse one JSON request body (size-capped at 1 MiB). */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 1024 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error(`invalid JSON body: ${error?.message ?? error}`));
			}
		});
		req.on("error", reject);
	});
}

/** Whether a Host-header hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	if (!hostname || hostname.startsWith("[")) return false;
	const parts = hostname.split(".");
	return parts.length === 4 && parts.every((p) => /^\d+$/u.test(p)) && parts[0] === "127";
}

/** Whether this request comes from this machine's own browser page. */
function isLoopbackRequest(request) {
	const host = request.headers?.host;
	if (typeof host !== "string" || host === "") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/**
 * Whether this request may enter the plugin's host routes: loopback by
 * default, or a live paired-device cookie when remote-web-ui is loaded.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host context.
 * @param {import("node:http").IncomingMessage} request - incoming request.
 */
function isAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	const pairing = typeof ctx.get === "function" ? ctx.get("remoteWebUiPairing", false) : undefined;
	return (
		pairing !== undefined &&
		pairing !== null &&
		typeof pairing.isPairedDevice === "function" &&
		pairing.isPairedDevice(request) === true
	);
}

/** Read one volatile settings field's raw value (live `.get()` reference;
 * undefined when the getter itself throws — same guard as teams.js's
 * readValue, kept on this GET-config hot path). */
function rawOf(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get();
		} catch {
			return undefined;
		}
	}
	return field;
}

/** Coerce one route candidate `{provider, model}` entry; null when invalid. */
function cleanRoute(entry) {
	if (entry === null || typeof entry !== "object") return null;
	const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	const model = typeof entry.model === "string" ? entry.model.trim() : "";
	return provider !== "" && model !== "" ? { provider, model } : null;
}

/** Coerce one route candidate rank entry (tier optional). */
function cleanRank(entry) {
	const route = cleanRoute(entry);
	if (route === null) return null;
	const tier =
		entry.tier === undefined || entry.tier === null || entry.tier === ""
			? undefined
			: ["S", "A", "B", "C"].includes(entry.tier)
				? entry.tier
				: undefined;
	return tier === undefined ? route : { ...route, tier };
}

/** Coerce one effort candidate `{provider, model, effort}` entry; null when invalid. */
function cleanEffortEntry(entry) {
	if (entry === null || typeof entry !== "object") return null;
	const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	const model = typeof entry.model === "string" ? entry.model.trim() : "";
	const effort = typeof entry.effort === "string" ? entry.effort.trim() : "";
	return provider !== "" && model !== "" && effort !== "" ? { provider, model, effort } : null;
}

/** Snapshot the plugin's live volatile config into plain JSON values. */
export function snapshotOf(config) {
	const values = {};
	for (const field of STRING_FIELDS) values[field] = String(rawOf(config?.[field]) ?? "");
	for (const field of POOL_FIELDS)
		values[field] = Array.isArray(rawOf(config?.[field]))
			? rawOf(config[field]).map(cleanRoute).filter(Boolean)
			: [];
	const rank = rawOf(config?.modelRank);
	values.modelRank = Array.isArray(rank) ? rank.map(cleanRank).filter(Boolean) : [];
	for (const field of EFFORTS_FIELDS)
		values[field] = Array.isArray(rawOf(config?.[field]))
			? rawOf(config[field]).map(cleanEffortEntry).filter(Boolean)
			: [];
	values.uiLocale = ENUM_FIELDS.uiLocale.includes(rawOf(config?.uiLocale)) ? rawOf(config.uiLocale) : "auto";
	values.langScope = ENUM_FIELDS.langScope.includes(rawOf(config?.langScope)) ? rawOf(config.langScope) : "global";
	values.dispatchEnforce = ENUM_FIELDS.dispatchEnforce.includes(rawOf(config?.dispatchEnforce))
		? rawOf(config.dispatchEnforce)
		: "advice";
	for (const field of NUMBER_FIELDS) {
		const raw = Number(rawOf(config?.[field]));
		values[field] = Number.isFinite(raw) ? raw : 0;
	}
	values.wmDenyMode = ENUM_FIELDS.wmDenyMode.includes(rawOf(config?.wmDenyMode))
		? rawOf(config.wmDenyMode)
		: "cap";
	for (const field of BOOLEAN_FIELDS) values[field] = Boolean(rawOf(config?.[field]));
	return values;
}

/** The whitelistSync status for config responses: null unless syncWhitelist
 *  is ON (an INDEPENDENT switch — teamsMode is not required), else the teams
 *  layer's last replace-sync outcome ({ ok, count, at, error? } — itself
 *  null before the first sync). */
function whitelistSyncOf(config) {
	if (rawOf(config?.syncWhitelist) !== true) return null;
	return teamsSyncSnapshot();
}

/** Coerce and validate a client-submitted values object; null when invalid. */
function coerceValues(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
	const values = {};
	for (const field of STRING_FIELDS) {
		if (typeof input[field] !== "string") return null;
		values[field] = input[field];
	}
	for (const field of POOL_FIELDS) {
		if (!Array.isArray(input[field])) return null;
		const routes = input[field].map(cleanRoute);
		if (routes.some((route) => route === null)) return null;
		values[field] = routes;
	}
	if (!Array.isArray(input.modelRank)) return null;
	const rank = input.modelRank.map(cleanRank);
	if (rank.some((entry) => entry === null)) return null;
	values.modelRank = rank;
	for (const field of EFFORTS_FIELDS) {
		if (!Array.isArray(input[field])) return null;
		const efforts = input[field].map(cleanEffortEntry);
		if (efforts.some((entry) => entry === null)) return null;
		values[field] = efforts;
	}
	if (!ENUM_FIELDS.uiLocale.includes(input.uiLocale)) return null;
	values.uiLocale = input.uiLocale;
	if (!ENUM_FIELDS.langScope.includes(input.langScope)) return null;
	values.langScope = input.langScope;
	if (!ENUM_FIELDS.dispatchEnforce.includes(input.dispatchEnforce)) return null;
	values.dispatchEnforce = input.dispatchEnforce;
	for (const field of NUMBER_FIELDS) {
		const raw = Number(input[field]);
		if (!Number.isFinite(raw) || raw < 0) return null;
		values[field] = raw;
	}
	if (!ENUM_FIELDS.wmDenyMode.includes(input.wmDenyMode)) return null;
	values.wmDenyMode = input.wmDenyMode;
	for (const field of BOOLEAN_FIELDS) {
		if (typeof input[field] !== "boolean") return null;
		values[field] = input[field];
	}
	return values;
}

/** Deep-equal on the plain-JSON value shapes this module exchanges. */
function sameValues(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Enumerate the model catalog from the host session controller. */
async function modelCatalogOf(ctx) {
	const controller = typeof ctx.get === "function" ? ctx.get("sessionController", false) : undefined;
	if (controller !== undefined && typeof controller.modelCatalog === "function") {
		const catalog = await controller.modelCatalog();
		if (catalog !== null && typeof catalog === "object") return catalog;
	}
	const llm = typeof ctx.get === "function" ? ctx.get("llm", false) : undefined;
	if (llm !== undefined && typeof llm.listProviders === "function") {
		const providers = await llm.listProviders();
		return {
			groups: Array.isArray(providers)
				? providers.map((info) => ({
						provider: info?.id ?? info?.name ?? "unknown",
						models: Array.isArray(info?.models) ? info.models : [],
					}))
				: [],
			failures: [],
		};
	}
	return { groups: [], failures: [] };
}

/**
 * Build the /api/dsh-switchman route family (exact paths).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 * @returns {Array<{kind: "exact", path: string, handler: Function}>} routes
 *          for ctx.webServer.register.
 */
export function makeRoutes(ctx, config) {
	/** Guard helper: fence + method check. */
	const guard = (req, res, method) => {
		if (!isAllowed(ctx, req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};

	return [
		{
			kind: "exact",
			path: ROUTES.health,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, { ok: true, ns: NS });
			},
		},
		{
			kind: "exact",
			path: ROUTES.config,
			handler: async (req, res) => {
				if (!isAllowed(ctx, req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method === "GET") {
					// Clean-context retry pump: HTTP handlers never run inside an
					// HMR transaction, so an orchestration deferred by the nested
					// rejection re-runs here (no-op when nothing is pending).
					pumpTeamsOrchestration(ctx, config);
					writeJson(res, 200, { values: snapshotOf(config), whitelistSync: whitelistSyncOf(config), teamsBundle: teamsBundleState() });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeJson(res, 400, { error: error?.message ?? String(error) });
					return;
				}
				const values = coerceValues(body?.values);
				if (values === null) {
					writeJson(res, 400, { error: "invalid values payload" });
					return;
				}
				// Optimistic-concurrency fence: when the client submits the
				// snapshot it loaded (`expected`), require it to still match.
				const current = snapshotOf(config);
				if (body.expected !== undefined) {
					const expected = coerceValues(body.expected);
					if (expected === null || !sameValues(expected, current)) {
						writeJson(res, 409, { error: "conflict: settings changed since load", values: current });
						return;
					}
				}
				try {
					await ctx.settings.update(NS, values);
				} catch (error) {
					ctx.logger.warn(`dsh-switchman: settings write failed: ${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
					return;
				}
				// Teams orchestration hook (fire-and-forget: the teams layer defers
				// the real work to a setImmediate turn, so the bundle enable +
				// optional whitelist replace-sync never block this response; a
				// nested-HMR rejection is retried from the next clean trigger —
				// see host/teams.js). Runs when EITHER switch is on (they are
				// independent); each half gates itself inside the orchestration.
				scheduleTeamsOrchestration(ctx, config);
				writeJson(res, 200, { values: snapshotOf(config), whitelistSync: whitelistSyncOf(config), teamsBundle: teamsBundleState() });
			},
		},
		{
			kind: "exact",
			path: ROUTES.models,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					writeJson(res, 200, await modelCatalogOf(ctx));
				} catch (error) {
					ctx.logger.warn(`dsh-switchman: model catalog failed: ${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
				}
			},
		},
		{
			kind: "exact",
			path: ROUTES.authorized,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					const snapshot = authorizedChildRoutes(ctx);
					writeJson(
						res,
						200,
						snapshot === null
							? { enabled: null, routes: null }
							: { enabled: snapshot.enabled, routes: snapshot.routes },
					);
				} catch (error) {
					ctx.logger.warn(`dsh-switchman: authorized-models read failed: ${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
				}
			},
		},
		{
			kind: "exact",
			path: ROUTES.handoverState,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				// Read-only live registry: the client badge polls this during
				// the otherwise-silent fork+compact window ({count, handovers}),
				// so the GUI shows an animated "handover in progress" cue.
				const handovers = handoverSnapshot();
				writeJson(res, 200, { count: handovers.length, handovers });
			},
		},
		{
			kind: "exact",
			path: ROUTES.visionState,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				pumpTeamsOrchestration(ctx, config); // clean-context retry pump (see GET config)
				try {
					// Optional `session` query parameter (a child session id):
					// judge image capability against THAT session's model
					// instead of the root's (the root verdict misreported for
					// children on a different route). A missing or unknown
					// session falls back to the root verdict.
					const session = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
					writeJson(res, 200, await visionStateOf(ctx, config, typeof session === "string" && session !== "" ? session : null));
				} catch (error) {
					ctx.logger.warn(`dsh-switchman: vision-state read failed: ${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
				}
			},
		},
		{
			kind: "exact",
			path: ROUTES.uiLocale,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeJson(res, 400, { error: error?.message ?? String(error) });
					return;
				}
				setReportedUiLocale(body?.locale);
				writeJson(res, 200, { ok: true, locale: reportedUiLocale() });
			},
		},
	];
}

/**
 * Mount the route family on the webServer (disposable through ctx.effect).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {object} config - this plugin's live volatile config.
 */
export function applyRoutes(ctx, config) {
	const routes = makeRoutes(ctx, config);
	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-switchman: client routes");
}
