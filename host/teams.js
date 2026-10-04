/** dsh-switchman Agent Teams layer (teams mode).
 *
 * Owns both switchman-side halves of the teams mode:
 *
 * - The dynamic `[SWITCHMAN:TEAMS]` systemPrompt section (order 10250, after
 *   the persona suffix at 10200, before the language section at 10300). The
 *   clauses it renders are exactly the team-specific parts extracted from
 *   the shared persona-suffix anchor in cordis.patch.yml (conservative-team-
 *   policy reversal, spawn_teammate trigger conditions, shared task-board
 *   discipline); they are injected only while the live `teamsMode` setting
 *   is ON, so OFF falls back to the DSH factory conservative team policy
 *   with zero residue (same live-reference pattern as dispatch.js's POOLS).
 * - The ON-mode async orchestration, ALWAYS deferred through setImmediate so
 *   it never runs synchronously inside plugin apply (bundle changes must not
 *   nest inside the apply HMR transaction — boot/hmr forbids it): first
 *   `pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-agent-
 *   team-profile', true)` (latched per process; never disabled on OFF), then
 *   — only when `syncWhitelist` is also ON — one replace-sync of the six-
 *   pool union into DSH's `subagent-model-selection-settings` whitelist
 *   (`settings.describe()` → `settings.mutate(...)`, re-describing and
 *   retrying up to 3 attempts on SettingsConflictError). Replace semantics:
 *   switchman is the single source of truth, so the deduplicated exact
 *   (provider, model) union overwrites allowedModels wholesale; an empty
 *   union skips the write (DSH rejects enabled=true with an empty list).
 *   Enforcement is a per-new-session snapshot, so a sync only affects
 *   top-level sessions composed after it.
 *
 * Trigger points: plugin apply (applyTeams schedules once), every successful
 * POST /api/dsh-switchman/config (routes.js calls scheduleTeamsOrchestration),
 * and settings/document-updated for this plugin's own namespace (volatile
 * commits never remount the plugin, so edits through DSH's own settings UI
 * must also trigger). Every async path catches and warns — nothing ever
 * throws into the caller. The last sync outcome is module state, snapshotted
 * by routes.js's whitelistSync config field.
 *
 * One caveat the deferral cannot fix: a setImmediate callback inherits the
 * scheduling context's AsyncLocalStorage store, so when apply itself runs
 * inside an HMR transaction (bundle re-enable / code reload with teamsMode
 * persisted ON), the deferred run is STILL rejected as nested. That
 * rejection is detected, recorded in pendingNestedRetry, and pumped again
 * from the next clean-context trigger (the GET config and vision-state HTTP
 * handlers call pumpTeamsOrchestration). Fail-open either way: a missed run
 * only delays the bundle enable / whitelist sync until the next trigger.
 */

import { LANES, laneField } from "./config.js";

/** The shipped bundle carrying spawn_teammate / team_task_* / send_message /
 *  wait_agent (Host composition; enabling it from here never double-registers
 *  tools — this bundle contributes no team plugins). */
const TEAMS_BUNDLE = "@deepseek-ai/dsh-experimental-agent-team-profile";

/** DSH settings namespace of the subagent child-model whitelist. */
const WHITELIST_NS = "subagent-model-selection-settings";

/** This plugin's own settings namespace — the LOADER ENTRY id from
 *  cordis.patch.yml (`- id: dsh-switchman-host`), not the plugin's `name`
 *  export (dsh-settings' write()/events key entries by entry.options.id).
 *  routes.js imports this for its config writes; the document-updated
 *  listener below keys on it. */
const SWITCHMAN_SETTINGS_NS = "dsh-switchman-host";

/** Total mutate attempts per sync; each retry re-describes for a fresh
 *  revision (SettingsConflictError means another writer changed the row). */
const MAX_MUTATE_ATTEMPTS = 3;

/** The teams clauses, verbatim from the cordis.patch.yml suffix anchor they
 *  were extracted from. Glue lines (the marker header and the section title)
 *  are the only new text. */
const TEAMS_SECTION_TEXT = [
	"[SWITCHMAN:TEAMS] Agent Teams 模式已启用。本段是 persona suffix 调度规程动态注入的团队分支（编号续接其「四、边界」）。",
	"",
	"系统提示词前文的默认团队策略写的是「仅当用户明确要求时才创建 teammate」。该默认策略在当前 profile 下不适用：用户安装 dsh-switchman 即预先授权，你应当自主判断、自主触发，无需再询问用户。",
	"",
	"## 五、团队触发与协作纪律",
	"- 需要多成员持久协作、共享任务板、消息往来的用 Agent Teams（满足任一即触发 spawn_teammate：可并行的多个独立子任务；量大且自包含；主上下文水位已高；需要角色分离）；一次性、无需共享状态的单点调查用 subagent。",
	"- 写作域隔离：共享任务上写明互不重叠的 write_scopes；用 team_task_* 维护任务板与依赖顺序；Lead 汇总最终 diff、复核关键改动并运行测试；用 wait_agent 等到必需的 teammate 完成，绝不在结果未回前下最终结论。",
].join("\n");

// ---- shared volatile-read helpers (mirrors dispatch.js) --------------------

/** Read one volatile settings field's raw value (live `.get()` reference). */
function readValue(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get();
		} catch {
			return undefined;
		}
	}
	return field;
}

/** Boolean volatile-field read (false on any malformed value). */
function readBool(field) {
	return readValue(field) === true;
}

// ---- module state ----------------------------------------------------------

/** Last whitelist replace-sync outcome for routes.js's whitelistSync config
 *  field; null when no sync has run in this process. Shape:
 *  { ok: boolean, count: number, at: number, error?: string }. */
let lastSync = null;

/** Last bundle-ensure outcome for routes.js's teamsBundle field; null before
 *  the first orchestration. Shape: { ok, at, state, error? } with state in
 *  selected | applied | restart-required | failed | cancelled | <unknown
 *  application value> | unavailable. */
let lastBundleState = null;

/** Set when a run must be retried from a clean context: either it was
 *  rejected as "HMR transactions cannot be nested" (the setImmediate
 *  deferral cannot escape the AsyncLocalStorage store the scheduling context
 *  carried — boot/hmr's runExclusive checks that store), or
 *  pluginManager.setBundleEnabled RESOLVED with a failed/cancelled
 *  application (no exception ever reaches the central catch). The next
 *  clean-context HTTP trigger pumps a retry; retries are strictly
 *  request-driven, never self-scheduling, so there is no retry loop. */
let pendingNestedRetry = false;

/** Single-flight guard: the apply + POST + document-updated triggers may
 *  overlap, but at most one orchestration runs at a time — requests
 *  arriving mid-run collapse into one rerun. */
let orchestrating = false;
let rerunRequested = false;

// ---- orchestration ---------------------------------------------------------

/** Whether an error is the HMR nesting rejection: boot/hmr's runExclusive
 *  throws exactly "HMR transactions cannot be nested" when the AsyncLocalStorage
 *  store is already set, and setImmediate callbacks inherit that store from
 *  the scheduling context (e.g. an apply that itself ran in a transaction). */
function isNestedHmrError(error) {
	return /cannot be nested/iu.test(String(error?.message ?? ""));
}

/** Deduplicated exact (provider, model) union of the six pools. Exact string
 *  identity (trimmed) — DSH's whitelist authorizes exact pairs and its
 *  assertAllowedModelRoutes rejects repeated provider/model routes outright. */
function poolUnion(config) {
	const seen = new Set();
	const routes = [];
	for (const lane of LANES) {
		const raw = readValue(config?.[laneField(lane)]);
		if (!Array.isArray(raw)) continue;
		for (const entry of raw) {
			if (entry === null || typeof entry !== "object") continue;
			const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
			const model = typeof entry.model === "string" ? entry.model.trim() : "";
			if (provider === "" || model === "") continue;
			const key = `${provider}\u0000${model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			routes.push({ provider, model });
		}
	}
	return routes;
}

/** Ensure the shipped agent-team-profile bundle layer is selected in the
 *  profile. pluginManager.setBundleEnabled NEVER rejects: its change
 *  transaction swallows every error into a resolved
 *  {application:'failed', error} (cancellations into 'cancelled'), while
 *  'restart-required' means the manifest was persisted and the tools
 *  activate after a host restart (boot/plugin-manager/src/index.ts:795-819).
 *  Treating that resolved value as success latches a false positive and
 *  suppresses every later retry — so only verified outcomes latch, and a
 *  listBundles pre-check both short-circuits the already-enabled case and
 *  converges with disk truth after a late failure (selectBundle persists
 *  before reload can throw). There is deliberately NO process-level success
 *  latch — the DSH-side toggle can be flipped off at any time, so every
 *  orchestration re-verifies via listBundles and re-enables when needed.
 *  A missing pluginManager service only warns; the doctrine section still
 *  renders, the tools simply stay absent. */
async function ensureTeamsBundle(ctx) {
	const manager = ctx.get?.("pluginManager", false);
	if (manager === undefined || manager === null || typeof manager.setBundleEnabled !== "function") {
		lastBundleState = { ok: false, at: Date.now(), state: "unavailable" };
		ctx.logger?.warn?.("dsh-switchman: pluginManager service unavailable; agent-team bundle not enabled");
		return;
	}
	if (typeof manager.listBundles === "function") {
		try {
			const bundles = await manager.listBundles();
			const selected = Array.isArray(bundles)
				? bundles.find((item) => item?.name === TEAMS_BUNDLE)
				: undefined;
			if (selected?.enabled === true) {
				// Already selected in the profile manifest: no call, no reload —
				// and deliberately NO process-level latch. The user may flip the
				// DSH-side toggle off at any moment; every orchestration re-reads
				// this disk truth instead (live-verified regression: a boot-time
				// latch froze the state right before the user toggled DSH off).
				lastBundleState = { ok: true, at: Date.now(), state: "selected" };
				return;
			}
		} catch {
			// Unreadable manifest: fall through and let setBundleEnabled decide.
		}
	}
	const result = await manager.setBundleEnabled(TEAMS_BUNDLE, true);
	// Whitelist latch: only the two verified-persisted outcomes count. Anything
	// else — failed, cancelled, or a future unknown application value — warns
	// and stays unlatched so the next trigger retries (unknown values must NOT
	// be assumed successful; that is exactly the false-positive this fix ends).
	const outcome = typeof result?.application === "string" ? result.application : "applied";
	if (outcome !== "applied" && outcome !== "restart-required") {
		// A resolved failure raises no exception, so isNestedHmrError and
		// orchestrateTeams' central catch never see it. Arm the clean-context
		// pump here: the next GET (Switchman page view, post-save refresh)
		// retries from a plain HTTP context, where transient causes — an HMR
		// transaction around reload(), a package.json lock held by a boot-time
		// pnpm/refresh — are gone. Verified live: the identical call succeeds
		// when made from a clean context moments after failing in-page.
		pendingNestedRetry = true;
		lastBundleState = {
			ok: false,
			at: Date.now(),
			state: outcome,
			error: typeof result?.error === "string" ? result.error : result?.error?.message,
		};
		ctx.logger?.warn?.(
			`dsh-switchman: agent-team bundle enable ${outcome}: `
			+ `${result?.error?.message ?? result?.error ?? "unknown error"} — retrying on the next trigger`,
		);
		return;
	}
	lastBundleState = { ok: true, at: Date.now(), state: outcome };
	if (outcome === "restart-required") {
		ctx.logger?.info?.("dsh-switchman: agent-team bundle persisted; restart DSH to activate team tools in new sessions");
	} else {
		ctx.logger?.info?.(`dsh-switchman: agent-team bundle enabled (${TEAMS_BUNDLE})`);
	}
}

/** One replace-sync of the six-pool union into the DSH whitelist. describe →
 *  mutate with the fresh revision; SettingsConflictError retries (re-describe
 *  first) up to MAX_MUTATE_ATTEMPTS total. Every terminal outcome lands in
 *  the module-level lastSync status; nothing throws. */
async function syncWhitelist(ctx, config) {
	const routes = poolUnion(config);
	if (routes.length === 0) {
		// DSH's invariant: enabled=true with an empty allowedModels breaks
		// every new session's composition — skipping is the only safe move.
		lastSync = {
			ok: false,
			count: 0,
			at: Date.now(),
			error: "six-pool union is empty; sync skipped (enabled=true requires a non-empty allowedModels)",
		};
		ctx.logger?.warn?.(`dsh-switchman: whitelist sync skipped: ${lastSync.error}`);
		return;
	}
	const settings = ctx.settings;
	if (settings === null || typeof settings !== "object" || typeof settings.describe !== "function" || typeof settings.mutate !== "function") {
		lastSync = { ok: false, count: routes.length, at: Date.now(), error: "settings service unavailable" };
		ctx.logger?.warn?.(`dsh-switchman: whitelist sync failed: ${lastSync.error}`);
		return;
	}
	for (let attempt = 1; attempt <= MAX_MUTATE_ATTEMPTS; attempt += 1) {
		let revision;
		try {
			const described = settings.describe();
			const row = Array.isArray(described) ? described.find((entry) => entry?.ns === WHITELIST_NS) : undefined;
			if (row === undefined || !Number.isFinite(row.revision)) {
				lastSync = {
					ok: false,
					count: routes.length,
					at: Date.now(),
					error: `settings namespace "${WHITELIST_NS}" not found or carries no revision`,
				};
				ctx.logger?.warn?.(`dsh-switchman: whitelist sync failed: ${lastSync.error}`);
				return;
			}
			revision = row.revision;
		} catch (error) {
			// Drift-guard: describe() is a synchronous file read in current DSH
			// (it never crosses runExclusive), so this branch is unreachable
			// today — kept in case a future revision routes it through the
			// editor lock.
			if (isNestedHmrError(error)) {
				pendingNestedRetry = true;
				ctx.logger?.info?.("dsh-switchman: whitelist describe deferred (HMR transaction active); the next clean-context trigger retries");
				return;
			}
			lastSync = { ok: false, count: routes.length, at: Date.now(), error: error?.message ?? String(error) };
			ctx.logger?.warn?.(`dsh-switchman: whitelist describe failed: ${lastSync.error}`);
			return;
		}
		try {
			await settings.mutate(
				WHITELIST_NS,
				[
					{ op: "set", path: ["enabled"], value: true },
					{ op: "set", path: ["allowedModels"], value: routes },
				],
				revision,
			);
			lastSync = { ok: true, count: routes.length, at: Date.now() };
			ctx.logger?.info?.(
				`dsh-switchman: whitelist replace-synced (${routes.length} routes; applies to newly composed top-level sessions only)`,
			);
			return;
		} catch (error) {
			// Conflict = another writer changed the row between describe and
			// mutate: re-describe and retry. A nested-HMR rejection defers the
			// whole sync to the next clean trigger (transient — no failure
			// status is recorded). Anything else is terminal.
			if (isNestedHmrError(error)) {
				pendingNestedRetry = true;
				ctx.logger?.info?.("dsh-switchman: whitelist sync deferred (HMR transaction active); the next clean-context trigger retries");
				return;
			}
			if (error?.name === "SettingsConflictError" && attempt < MAX_MUTATE_ATTEMPTS) continue;
			lastSync = { ok: false, count: routes.length, at: Date.now(), error: error?.message ?? String(error) };
			ctx.logger?.warn?.(`dsh-switchman: whitelist sync failed after ${attempt} attempt(s): ${lastSync.error}`);
			return;
		}
	}
}

/** The orchestration behind the two INDEPENDENT switches: teamsMode drives
 *  the bundle ensure (+ the doctrine section, handled elsewhere);
 *  syncWhitelist drives the whitelist replace-sync — either may be on alone.
 *  Single-flight (see orchestrating); every failure is caught and warned —
 *  a nested-HMR rejection arms the clean-context retry pump instead —
 *  never rethrown. */
async function orchestrateTeams(ctx, config) {
	if (orchestrating) {
		rerunRequested = true;
		return;
	}
	orchestrating = true;
	try {
		if (readBool(config?.teamsMode) === true) {
			await ensureTeamsBundle(ctx).catch((error) => {
				// A nested rejection must defer the WHOLE run (the whitelist
				// sync would hit the same wall) — rethrow to the central catch.
				if (isNestedHmrError(error)) throw error;
				ctx.logger?.warn?.(`dsh-switchman: agent-team bundle enable failed: ${error?.message ?? error}`);
			});
		}
		if (readBool(config?.syncWhitelist) === true) await syncWhitelist(ctx, config);
	} catch (error) {
		if (isNestedHmrError(error)) {
			pendingNestedRetry = true;
			ctx.logger?.info?.("dsh-switchman: teams orchestration deferred (HMR transaction active); the next clean-context trigger retries");
			return;
		}
		ctx.logger?.warn?.(`dsh-switchman: teams orchestration failed: ${error?.message ?? error}`);
	} finally {
		orchestrating = false;
		if (rerunRequested) {
			rerunRequested = false;
			scheduleTeamsOrchestration(ctx, config);
		}
	}
}

/** Last whitelist replace-sync outcome ({ ok, count, at, error? } | null).
 *  Raw module state — routes.js gates exposure on teamsMode && syncWhitelist. */
function teamsBundleState() {
	return lastBundleState === null ? null : { ...lastBundleState };
}

function teamsSyncSnapshot() {
	return lastSync;
}

/** Fire-and-forget orchestration trigger. Safe from any code path (plugin
 *  apply, HTTP handlers): the work always lands on a setImmediate turn, so
 *  nothing runs synchronously inside apply or a route handler. The deferral
 *  does NOT escape an enclosing HMR transaction's AsyncLocalStorage store —
 *  a nested rejection is detected here and retried from the next clean
 *  trigger (see pendingNestedRetry / pumpTeamsOrchestration). */
function scheduleTeamsOrchestration(ctx, config) {
	try {
		// Either switch alone is a reason to run (they are independent).
		if (readBool(config?.teamsMode) !== true && readBool(config?.syncWhitelist) !== true) return;
		setImmediate(() => {
			Promise.resolve(orchestrateTeams(ctx, config)).catch((error) => {
				ctx.logger?.warn?.(`dsh-switchman: teams orchestration crashed: ${error?.message ?? error}`);
			});
		});
	} catch (error) {
		ctx.logger?.warn?.(`dsh-switchman: teams orchestration scheduling failed: ${error?.message ?? error}`);
	}
}

/** Retry pump for runs rejected as nested: call from clean-context code
 *  paths (HTTP handlers never run inside an HMR transaction). A no-op
 *  single-boolean check when nothing is pending; a retry that fails nested
 *  again simply re-arms the flag, so retries stay request-driven. */
function pumpTeamsOrchestration(ctx, config) {
	if (!pendingNestedRetry) return;
	pendingNestedRetry = false;
	scheduleTeamsOrchestration(ctx, config);
}

/** Mount the teams layer: the dynamic `[SWITCHMAN:TEAMS]` section (empty
 *  while OFF — the live reference makes toggling instant) plus the
 *  orchestration triggers (apply-time scheduling and settings-document
 *  updates for this plugin's own namespace). */
function applyTeams(ctx, config) {
	ctx.systemPrompt.section({
		name: "switchman:teams",
		order: 10250,
		interpolate: false,
		text: () => {
			try {
				if (readBool(config.teamsMode) !== true) return "";
				return TEAMS_SECTION_TEXT;
			} catch {
				return "";
			}
		},
	});
	// Volatile commits never remount the plugin, so teamsMode/syncWhitelist
	// (or pool) edits through DSH's OWN settings UI — which bypass our POST
	// config route — must re-trigger the orchestration too. The settings
	// service emits this app-wide with no emitting thisArg, so a listener on
	// this plugin's context receives every namespace's event; filter on ns.
	ctx.on("settings/document-updated", (ns) => {
		if (ns === SWITCHMAN_SETTINGS_NS) scheduleTeamsOrchestration(ctx, config);
	});
	scheduleTeamsOrchestration(ctx, config);
}

export { applyTeams, pumpTeamsOrchestration, SWITCHMAN_SETTINGS_NS, scheduleTeamsOrchestration, teamsBundleState, teamsSyncSnapshot };
