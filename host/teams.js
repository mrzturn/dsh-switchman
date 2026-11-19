/** dsh-switchman Agent Teams layer (teams mode).
 *
 * Owns both switchman-side halves of the teams mode:
 *
 * - The dynamic `[SWITCHMAN:TEAMS]` systemPrompt section (order 10250, after
 *   the persona suffix at 10200, before the language section at 10300). It
 *   carries BOTH doctrine halves gated by the live `teamsMode` setting, so
 *   OFF renders zero bytes and the DSH factory conservative team policy
 *   takes over with zero residue (same live-reference pattern as
 *   dispatch.js's POOLS): (1) the `## 一` delegate-by-default block,
 *   extracted VERBATIM from the shared persona-suffix anchor in
 *   cordis.patch.yml (the same extraction precedent as the team clauses in
 *   6304fa9) and rendered byte-for-byte in every ON-mode variant; (2) the
 *   team clauses (also extracted in 6304fa9), whose trigger-policy lines
 *   are conditional on the §4.4.1 structural-tag conjunction
 *   (parallelizable / permission_boundary / capability_gap — ≥2 of 3
 *   suggests a resident team; constraint layer OFF falls back to the
 *   original unconditional text).
 * - The ON-mode async orchestration, ALWAYS deferred through setImmediate so
 *   it never runs synchronously inside plugin apply (bundle changes must not
 *   nest inside the apply HMR transaction — boot/hmr forbids it): first
 *   `pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-agent-
 *   team-profile', true)` (never disabled on OFF; re-verified every run),
 *   then — only when `syncWhitelist` is also ON — one replace-sync of the
 *   dispatch model union (six pools + modelRank) into DSH's
 *   `subagent-model-selection-settings` whitelist
 *   (`settings.describe()` → `settings.mutate(...)`, re-describing and
 *   retrying up to 3 attempts on SettingsConflictError). Replace semantics:
 *   switchman is the single source of truth, so the deduplicated exact
 *   (provider, model) union overwrites allowedModels wholesale; an empty
 *   union skips the write (DSH rejects enabled=true with an empty list).
 *   Enforcement is a per-new-session snapshot, so a sync only affects
 *   top-level sessions composed after it.
 *
 * - The teams-gated `child_message` bridge tool: enabling the agent-team
 *   bundle REPLACES the global send_message with a team variant that
 *   resolves TEAMMATE NAMES only, after which subagent child session UUIDs
 *   are not addressable at all. The bridge restores child addressing through
 *   ctx.subagents.sendMessage (sender = the exact live calling agent,
 *   exec.agent), registered while the live `teamsMode` setting reads ON and
 *   disposed again the moment it reads OFF (same live-reference gating as
 *   the doctrine section).
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
import { classifierConstraintsForTurn } from "./constraints.js";
import { sessionIdOf } from "./context-watch.js";

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

/** The `## 一` delegate-by-default delegation block, extracted VERBATIM from
 *  the cordis.patch.yml persona-suffix anchor (extraction precedent: the team
 *  clauses left the same anchor in 6304fa9). teamsMode is its only gate: ON
 *  renders this text byte-for-byte in every ON-mode variant, OFF removes it
 *  entirely; the constraint layer NEVER rewrites these lines — conditionality
 *  lives only in the teams trigger-policy lines below. */
const DELEGATION_SECTION_TEXT = [
	"## 一、默认委派，例外亲做（delegate by default）",
	"- 委派只消耗一个全新子上下文、只收回一份摘要；亲自读写每一份都会膨胀本会话上下文，长期更贵。长或重的上下文偏向委派，琐碎小事留在手里。",
	"- 仅当满足全部条件才亲自做：认知负载低或中、读取合计 <200 行、改动 <50 行；强迭代小步试错（每步都要立刻用上一步结果）；期望收益 <3k token 的收尾。",
	"- 位置不确定的检索、跨多文件调查、大范围重构、独立研究或方案对比：一律委派，侦察优先派 economy 泳道。",
	"- 任务开始时判断一次，中途规模或结构变化时重做；结论不必请示用户。",
].join("\n");

/** Fixed marker line of the `[SWITCHMAN:TEAMS]` section (glue text, shared
 *  by every variant). */
const TEAMS_HEADER =
	"[SWITCHMAN:TEAMS] Agent Teams 模式已启用。本段是 persona suffix 调度规程动态注入的团队分支（编号续接其「四、边界」）。";

/** Trigger-policy lines per variant. The legacy pair is byte-identical to
 *  the pre-§4.4 text; the constraint-aware pair replaces ONLY the
 *  "when are teams suggested" lines (guide §4.4.1), keeping every other
 *  clause untouched. */
const TEAMS_INTRO_LEGACY =
	"系统提示词前文的默认团队策略写的是「仅当用户明确要求时才创建 teammate」。该默认策略在当前 profile 下不适用：用户安装 dsh-switchman 即预先授权，你应当自主判断、自主触发，无需再询问用户。";
const TEAMS_PRIORITY_LEGACY =
	"- 派发通道优先级（取代前文「一次性、无需共享状态的单点调查用 subagent」的默认分工）：本会话工具目录里有 spawn_teammate/list_agents（Agent Teams 已启用）时，一切子任务委派默认走 Agent Teams——spawn_teammate 组队、team_task_* 落共享任务板、send_message/wait_agent 协作；subagent/subagent_fork 单智能体派发退为后备通道，仅在本条下一条所述的不可用场景使用。";

/** Fixed discipline clauses (verbatim legacy text) plus the §4.4.2
 *  spawn-justification soft requirement appended once for every variant:
 *  declaring which constraint fired is advisory doctrine, not a tool-level
 *  gate — an undeclared spawn still goes through (guide: the first version
 *  is doctrine-level soft, no hard interception). */
const TEAMS_DISCIPLINE_LINES = [
	"- teams 不可用即降级，不重试：工具目录没有 spawn_teammate/list_agents（bundle 未生效或本会话不支持），或 spawn_teammate 报 provisioning failed / 创建失败时，直接改用 subagent/subagent_fork 派发并继续工作，不要反复重试 teams 通道。你自身是 teammate（非 Lead）时维持原规则：不 spawn_teammate，需要子委派时用 subagent。workflow 仅在用户明确要求工作流或脚本化大规模编排时使用，默认不主动使用。",
	"- 写作域隔离：共享任务上写明互不重叠的 write_scopes；用 team_task_* 维护任务板与依赖顺序；Lead 汇总最终 diff、复核关键改动并运行测试；用 wait_agent 等到必需的 teammate 完成，绝不在结果未回前下最终结论。",
	"- 子智能体消息通道：subagent/workflow 返回的子会话 id 只能经 child_message 桥接送达——send_message 只解析 teammate 名字，对子会话 id 必报 active teammate「…」not found；该报错不代表子会话死亡，先改用 child_message，不要据此重派或判定死亡。",
	"- run_code 并行隔离：spawn_teammate / send_message 这类会改变团队环境（成员目录、工具表）的调用不要与文件/搜索工具放进同一 run_code 程序里 Promise.all 并行——并发窗口内其它工具绑定可能误报 unknown tool「…」（UNKNOWN_TOOL）；让这类调用单独占一步执行。某工具此前可用却突然报 UNKNOWN_TOOL 时，下一步原样重试即可，不要换工具名或放弃任务。",
	"- 常驻成员先声明约束理由（advisory 软约束）：spawn_teammate 前声明触发了哪条约束标签（如「命中 parallelizable + permission_boundary」）；约束层未启用（无 [SWITCHMAN:CONSTRAINTS] 行）时改为声明不可替代的结构性理由（并行独立子任务 / 权限隔离 / 持续协作）。缺失声明不拦截派发——本条只是声明要求，不改变 spawn 通道可用性。",
];

/** Structural tags whose CONJUNCTION (≥2 of 3) suggests a resident team
 *  (guide §4.4.1): parallelizable = genuinely parallel independent
 *  subtasks; permission_boundary = isolated authority per member;
 *  capability_gap = sustained multi-role collaboration a single stateless
 *  subagent cannot cover. The other three tags deliberately do NOT count:
 *  context_pressure argues for ANY delegation (stateless subagents
 *  suffice), verification_required demands stateless isolation for review
 *  (§4.4.3 — reviewers never join the team), skill_match points at
 *  on-demand skills (the default path). Today only the classifier can
 *  produce these three tags, so deterministic signals never trigger a team
 *  suggestion. */
const TEAMS_STRUCTURAL_TAGS = Object.freeze(["parallelizable", "permission_boundary", "capability_gap"]);

/** Hit list of structural tags, or [] when the §4.4.1 conjunction (≥2) is
 *  not met. Pure and fail-closed to [] — junk input never suggests a team. */
function structuralTeamHits(tags) {
	const seen = new Set(Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : []);
	const hits = TEAMS_STRUCTURAL_TAGS.filter((tag) => seen.has(tag));
	return hits.length >= 2 ? hits : [];
}

/** The ON-mode teams section body for one constraint state: legacy bytes
 *  when the constraint layer is off (conservative fallback — the original
 *  unconditional teams preference), otherwise the two trigger-policy lines
 *  swap to the hit/miss variants (guide §4.4.1). */
function teamsSectionText(constraintsEnabled, hitTags) {
	const tags = structuralTeamHits(hitTags);
	let intro = TEAMS_INTRO_LEGACY;
	let priority = TEAMS_PRIORITY_LEGACY;
	if (constraintsEnabled === true) {
		if (tags.length > 0) {
			const joined = tags.join(" + ");
			intro = `[SWITCHMAN:CONSTRAINTS] 命中团队约束组合（${joined}）：满足进入 Agent Teams 的建议条件（≥2 条结构性标签），本会话按下方条款自主组队，无需再询问用户。`;
			priority = `- 派发通道优先级（约束命中）：本会话已命中 ${joined}，子任务委派默认走 Agent Teams——spawn_teammate 组队、team_task_* 落共享任务板、send_message/wait_agent 协作；subagent/subagent_fork 退为后备通道，仅在下方降级条款所述的不可用场景使用。`;
		} else {
			intro = "[SWITCHMAN:CONSTRAINTS] 本轮未命中团队约束组合（结构性标签 parallelizable / permission_boundary / capability_gap 命中不足 2 条）：不建议进入常驻 Agent Teams。";
			priority = "- 派发通道优先级（约束未命中）：无状态 subagent / subagent_fork 单次派发加按需 skill 是默认委派路径，不为用团队而用团队；Agent Teams（spawn_teammate 组队）仅当用户在会话中明确要求时使用，使用后仍遵守下方协作纪律。";
		}
	}
	return [TEAMS_HEADER, "", intro, "", "## 五、团队触发与协作纪律", priority, ...TEAMS_DISCIPLINE_LINES].join("\n");
}

/** Full ON-mode doctrine body: the delegation block plus the teams section
 *  (the same byte sequence the persona suffix used to carry inline). The
 *  legacy state reproduces the pre-extraction text byte-for-byte. */
function teamsDoctrineText({ constraintsEnabled = false, hitTags = [] } = {}) {
	return `${DELEGATION_SECTION_TEXT}\n\n${teamsSectionText(constraintsEnabled, hitTags)}`;
}

/** The original ON-mode teams section text (legacy variant), kept under the
 *  historical export name for existing readers and byte-snapshot tests. */
const TEAMS_SECTION_TEXT = teamsSectionText(false, []);

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
 *  field; null when no sync has run in this process. The synced set is the
 *  dispatch model union (six pools + modelRank). Shape:
 *  { ok: boolean, count: number, at: number, error?: string }. */
let lastSync = null;

/** Last bundle-ensure outcome for routes.js's teamsBundle field; null before
 *  the first orchestration. Shape: { ok, at, state, error? } with state in
 *  selected | applied | restart-required | not-offered | failed | cancelled
 *  | <unknown application value> | unavailable. */
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

/** Deduplicated exact (provider, model) union of the six pools PLUS
 *  modelRank. modelRank belongs in the whitelist union: its head is the
 *  dispatch fallback route (orderedPool head / modelRank[0] in dispatch.js),
 *  enforce mode denies any route outside "pools or modelRank", and a
 *  rank-only head would otherwise leave subagent dispatch unable to name
 *  its own fallback (the whitelist silently strips it). Rank entries are
 *  { provider, model, tier? }; tier is ignored here. Exact string identity
 *  (trimmed) — DSH's whitelist authorizes exact pairs and its
 *  assertAllowedModelRoutes rejects repeated provider/model routes outright. */
function dispatchModelUnion(config) {
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
	const rank = readValue(config?.modelRank);
	if (Array.isArray(rank)) {
		for (const entry of rank) {
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
 *  A bundle this DSH installation does not offer at all (absent from the
 *  listBundles inventory) is terminal, not a failure: enabling it could
 *  never succeed, so the orchestration records not-offered once and does
 *  not arm a retry. A missing pluginManager service only warns; the
 *  doctrine section still renders, the tools simply stay absent. */
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
			if (selected === undefined) {
				// Not in the inventory at all. listBundles enumerates the manifest
				// selection ∪ recorded dependencies ∪ the installation manifest ∪
				// the official on-demand catalog; app-boot strips retired bundles
				// from the manifest, and bundleManifest() resolves packages only
				// from those same sources. A name absent from all of them cannot
				// be enabled — DSH's toggle would resolve application:'failed'
				// (not-bundle) on every attempt — so record the terminal state
				// once and leave pendingNestedRetry untouched (no retry loop
				// against a fact; a future DSH update that ships the bundle
				// re-enters this function at the next orchestration trigger).
				lastBundleState = {
					ok: false,
					at: Date.now(),
					state: "not-offered",
					error: TEAMS_BUNDLE + " is not offered by this DSH installation"
						+ " (absent from the profile manifest, dependencies, and the"
						+ " official catalog); enable skipped",
				};
				ctx.logger?.warn?.("dsh-switchman: agent-team bundle not offered by this installation; enable skipped (teams tools stay absent)");
				return;
			}
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

/** One replace-sync of the dispatch model union into the DSH whitelist. describe →
 *  mutate with the fresh revision; SettingsConflictError retries (re-describe
 *  first) up to MAX_MUTATE_ATTEMPTS total. Every terminal outcome lands in
 *  the module-level lastSync status; nothing throws. */
async function syncWhitelist(ctx, config) {
	const routes = dispatchModelUnion(config);
	if (routes.length === 0) {
		// DSH's invariant: enabled=true with an empty allowedModels breaks
		// every new session's composition — skipping is the only safe move.
		lastSync = {
			ok: false,
			count: 0,
			at: Date.now(),
			error: "dispatch model union (six pools + modelRank) is empty; sync skipped (enabled=true requires a non-empty allowedModels)",
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

// ---- child_message bridge tool ----------------------------------------------

/** Map one ctx.subagents.sendMessage rejection to a readable reason. The
 *  continuation runtime throws typed SubagentErrors whose stable `code`
 *  names the failure mode: UNAUTHORIZED (the sender is not the exact live
 *  agent, or the target is not the sender's direct continuable child /
 *  direct parent), NOT_RESUMABLE (no continuable session resolves to the
 *  id), CONTINUATION_UNAVAILABLE (this composition exposes no continuation
 *  runtime), DRAINING (admission is closing), and ACTIVATION_CLOSING (the
 *  resident child is mid-disposal). */
function describeChildMessageError(error) {
	const message = error?.message ?? String(error);
	switch (typeof error?.code === "string" ? error.code : "") {
		case "UNAUTHORIZED":
			return `wrong sender or lineage: ${message} (childId must be one of your own direct continuable children — teammate names and other agents' children are not addressable here)`;
		case "NOT_RESUMABLE":
			return `unknown or non-continuable child: ${message}`;
		case "CONTINUATION_UNAVAILABLE":
			return `service unavailable: ${message}`;
		case "DRAINING":
			return `continuable subagents are draining: ${message}`;
		case "ACTIVATION_CLOSING":
			return `the child is closing: ${message}`;
		default:
			return error?.name === "AbortError" ? `cancelled before delivery: ${message}` : message;
	}
}

/** WHY this tool exists: enabling the agent-team-profile bundle REPLACES the
 *  global send_message with a team variant that resolves TEAMMATE NAMES
 *  only, after which subagent child session UUIDs are not addressable at
 *  all — background children dispatched before the switch (or recorded by a
 *  context handover) would become uncollectable silos. This bridge restores
 *  child addressing through the subagents service's public sendMessage,
 *  passing the exact live calling agent (exec.agent) as the sender — the
 *  same authority contract the factory send_message tool uses; the service
 *  itself validates the sender identity and the direct-child lineage.
 *  Registration uses the register-level shape (bare ctx.tools.register runs
 *  no defineTool DSL compilation, so parameters is a full object-root JSON
 *  Schema), mirroring context-watch.js's ctx_handover tool.
 *  @returns the registration disposer. */
function registerChildMessageTool(ctx) {
	if (typeof ctx.tools?.register !== "function") throw new Error("the tools registry is unavailable");
	const dispose = ctx.tools.register({
		name: "child_message",
		description:
			"Send a message to one of your subagent child sessions by its session UUID. Needed while Agent Teams mode is active: the team send_message resolves teammate names only, so subagent child ids must go through this bridge. Delivers to a direct continuable child — a running child takes the message at its nearest step boundary, an idle child starts a turn, and an absent continuable child is cold-resumed from persistence. Returns delivery confirmation, not the child's answer.",
		parameters: {
			type: "object",
			properties: {
				childId: {
					type: "string",
					description: "The child session UUID to address (the id returned when the subagent was started).",
				},
				content: {
					type: "string",
					description: "The message to deliver to the child.",
				},
			},
			required: ["childId", "content"],
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args, exec) {
			const sender = exec?.agent;
			if (sender === undefined || sender === null)
				return "child_message failed: no calling agent (exec.agent was undefined) — the subagents service requires the exact live sender.";
			const childId = typeof args?.childId === "string" ? args.childId.trim() : "";
			const content = typeof args?.content === "string" ? args.content : "";
			if (childId === "" || content === "")
				return "child_message failed: childId and content are required non-empty strings.";
			const service = ctx.subagents;
			if (service === undefined || service === null || typeof service.sendMessage !== "function")
				return "child_message failed: the subagents service is unavailable in this composition.";
			try {
				const messageId = await service.sendMessage(
					sender,
					childId,
					[{ type: "text", text: content }],
					// The service requires options.signal (it calls
					// throwIfAborted unconditionally); the tool turn's own
					// signal cancels only pre-acceptance work.
					{ signal: exec?.signal ?? new AbortController().signal },
				);
				return `child_message: message ${messageId} accepted for child ${childId} — a running child takes it at the nearest step boundary, an idle or absent continuable child starts (or cold-resumes into) a turn. This confirms delivery only, not the child's answer.`;
			} catch (error) {
				return `child_message failed: ${describeChildMessageError(error)}`;
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Switchman child message",
			kind: "other",
			rawInput: args,
		}),
	});
	// If the registry registered the tool but handed back a non-function
	// disposer, latch a no-op instead of throwing: throwing would leave a
	// live tool unlatched, and a later retry would register it twice.
	return typeof dispose === "function" ? dispose : () => {};
}

/** Mount the teams layer: the dynamic `[SWITCHMAN:TEAMS]` section (empty
 *  while OFF — the live reference makes toggling instant), the child_message
 *  bridge tool (same live teamsMode gating: registered while ON, disposed
 *  the moment it reads OFF), plus the orchestration triggers (apply-time
 *  scheduling and settings-document updates for this plugin's own
 *  namespace). */
function applyTeams(ctx, config) {
	ctx.systemPrompt.section({
		name: "switchman:teams",
		order: 10250,
		interpolate: false,
		text: (context) => {
			try {
				if (readBool(config.teamsMode) !== true) return "";
				const constraintsOn = readBool(config.constraintsEnabled) === true;
				let hitTags = [];
				if (constraintsOn) {
					const sessionKey = sessionIdOf(context?.agent);
					if (sessionKey !== null) {
						hitTags = structuralTeamHits(classifierConstraintsForTurn(sessionKey).map((entry) => entry.tag));
					}
				}
				return teamsDoctrineText({ constraintsEnabled: constraintsOn, hitTags });
			} catch {
				// Fail-open toward the guide's risk table ("prefer loose, never
				// miss a real teams case"): any internal error falls back to the
				// legacy ON-mode doctrine (delegate-by-default + unconditional
				// teams preference), never to silence.
				return teamsDoctrineText({ constraintsEnabled: false, hitTags: [] });
			}
		},
	});
	// child_message lifecycle: reconcile the registration against the live
	// teamsMode read (idempotent — a no-op whenever the state already
	// matches). The closure holds the disposer so every plugin mount starts
	// clean; the registry entry itself is scope-tracked to this fiber, so a
	// remount never leaves a stale tool behind. A registration failure only
	// warns and leaves the state unlatched, and a failed removal keeps the
	// latch — the next toggle retries either way.
	let childMessageDispose = null;
	const syncChildMessageTool = () => {
		const wanted = readBool(config?.teamsMode) === true;
		if (wanted === (childMessageDispose !== null)) return;
		if (!wanted) {
			// Clear the latch only after a successful dispose: a throwing
			// disposer keeps the latch set, so the next OFF sync retries the
			// removal instead of no-oping while the tool stays live.
			const dispose = childMessageDispose;
			try {
				dispose();
				childMessageDispose = null;
				ctx.logger?.info?.("dsh-switchman: child_message tool removed (teams mode off)");
			} catch (error) {
				ctx.logger?.warn?.(`dsh-switchman: child_message removal failed: ${error?.message ?? error}`);
			}
			return;
		}
		try {
			childMessageDispose = registerChildMessageTool(ctx);
			ctx.logger?.info?.("dsh-switchman: child_message tool registered (teams mode on)");
		} catch (error) {
			childMessageDispose = null;
			ctx.logger?.warn?.(`dsh-switchman: child_message registration failed: ${error?.message ?? error}`);
		}
	};
	// Volatile commits never remount the plugin, so teamsMode/syncWhitelist
	// (or pool) edits through DSH's OWN settings UI — which bypass our POST
	// config route — must re-trigger the orchestration (and re-sync the
	// child_message tool) too. The settings service emits this app-wide with
	// no emitting thisArg, so a listener on this plugin's context receives
	// every namespace's event; filter on ns.
	ctx.on("settings/document-updated", (ns) => {
		if (ns === SWITCHMAN_SETTINGS_NS) {
			scheduleTeamsOrchestration(ctx, config);
			syncChildMessageTool();
		}
	});
	scheduleTeamsOrchestration(ctx, config);
	syncChildMessageTool();
}

export { applyTeams, dispatchModelUnion, ensureTeamsBundle, pumpTeamsOrchestration, SWITCHMAN_SETTINGS_NS, DELEGATION_SECTION_TEXT, TEAMS_STRUCTURAL_TAGS, TEAMS_SECTION_TEXT, structuralTeamHits, teamsDoctrineText, scheduleTeamsOrchestration, teamsBundleState, teamsSyncSnapshot };
