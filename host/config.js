/** dsh-switchman host-side configuration schema.
 *
 * One flat set of `.volatile()` fields so every value is individually editable
 * through the DSH settings system (`ctx.settings` forms keyed by this plugin's
 * `name` export, persisted into the profile's cordis.patch.yml row) and is a
 * live reference on the host side (`config.<field>.get()` re-reads without a
 * plugin restart). Flat names keep settings-mutation paths single-segment,
 * which the hand-written settings page relies on.
 *
 * Groups:
 * - lang*        project language preference (Phase 1)
 * - pool/rank    dispatch pools and capability ranking (Phase 2)
 * - wm*          context watermark control (Phase 3)
 * - teams*       Agent Teams doctrine mode + whitelist sync (teams mode)
 * - intent*      intent-routing "auto" pseudo-model (classifier + candidates)
 *
 * Ported from opencode-switchman's opencode-switchman.jsonc surface
 * (oc/src/config.ts:23-51, oc/src/types.ts:281-344) onto DSH settings.
 */

import z from "@deepseek-ai/schemastery";

/** One addressable provider/model route (same shape the platform uses). */
export const ModelRouteSchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required(),
});

/** One rank entry: a route plus the optional anchored capability tier.
 *  (String enums are `z.union([...])` here — the shipped schemastery 3.18.4
 *  build has no `z.enum`; same idiom as dsh-tool-ask-user's Config.) */
export const RankEntrySchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required(),
	tier: z.union(["S", "A", "B", "C"]),
});

/** One per-model effort pin: a route plus the reasoning effort to use when
 *  dispatching that model (overrides the lane's default effort). The value
 *  is free-form on purpose — the valid set is whatever the DSH adapter for
 *  that model reports (low/medium/high, off, …). */
export const EffortEntrySchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required(),
	effort: z.string().min(1).required(),
});

/** One intent-routing candidate: a real model route the classifier may pick,
 *  plus an optional reasoning-effort pin and a capability note the classifier
 *  reads. Every row carries a stable id; preset rows (id owned by
 *  host/intent-presets.js) keep a code-owned immutable note, while enabled /
 *  provider / model / effort are user-configured — provider/model may be
 *  empty while a preset waits for its route. effort/note follow
 *  RankEntrySchema.tier's optional style (no `.required()`: schemastery
 *  passes undefined through, so entries may omit either key). */
export const IntentCandidateSchema = z.object({
	id: z.string(),
	preset: z.boolean(),
	enabled: z.boolean(),
	provider: z.string(),
	model: z.string(),
	effort: z.string(),
	note: z.string(),
});

/** One intent-layer route reference (classifier or fallback). Unlike
 *  ModelRouteSchema this accepts the "unset" `{provider:"", model:""}`
 *  pair the settings page round-trips — ModelRouteSchema's `.min(1)`
 *  would reject that exact declared default on every settings write.
 *  Consumers validate non-empty before trusting the route. */
const IntentRouteSchema = z.object({
	provider: z.string(),
	model: z.string(),
});

/** All dsh-switchman settings. Field names are the settings mutation paths. */
export const Config = z.object({
	// --- Phase 0: UI locale ------------------------------------------------
	/** Display language for this plugin's own UI (badge, panel, settings
	 *  page): "auto" follows the DSH app language; any other value forces
	 *  the plugin UI into that locale (extra locales resolve
	 *  client-side from the inline EXTRA_UI_DICTS table, falling back
	 *  to English). */
	uiLocale: z.union(["auto", "en", "zh", "zh-TW", "ja", "ko", "de", "es", "fr", "it", "pt", "ru"]).default("auto").volatile(),

	// --- Phase 1: project language preference -----------------------------
	/** Where the three language slots live: "global" = these profile-level
	 *  fields below; "project" = each project's .switchman/lang.json (per
	 *  session cwd; missing file = ask once per session and save there). */
	langScope: z.union(["global", "project"]).default("global").volatile(),
	/** Language for conversational replies. Empty = ask once, then remember. */
	langConversation: z.string().default("").volatile(),
	/** Language for code comments. Empty = follow langConversation. */
	langComments: z.string().default("").volatile(),
	/** Language for documents the agent authors. Empty = follow langConversation. */
	langDocs: z.string().default("").volatile(),

	// --- Phase 2: dispatch pools & model ranking ---------------------------
	/** Candidate routes per cognitive lane. Empty lane = system default. */
	poolEconomy: z.array(ModelRouteSchema).default([]).volatile(),
	poolMechanical: z.array(ModelRouteSchema).default([]).volatile(),
	poolMain: z.array(ModelRouteSchema).default([]).volatile(),
	poolHard: z.array(ModelRouteSchema).default([]).volatile(),
	poolVision: z.array(ModelRouteSchema).default([]).volatile(),
	poolReview: z.array(ModelRouteSchema).default([]).volatile(),
	/** Per-lane manual ordering: true = the lane's stored array order IS the
	 *  dispatch priority (host skips the capability/modelRank re-sort); false
	 *  = auto ordering (modelRank anchors first, then capability score). */
	poolEconomyManual: z.boolean().default(false).volatile(),
	poolMechanicalManual: z.boolean().default(false).volatile(),
	poolMainManual: z.boolean().default(false).volatile(),
	poolHardManual: z.boolean().default(false).volatile(),
	poolVisionManual: z.boolean().default(false).volatile(),
	poolReviewManual: z.boolean().default(false).volatile(),
	/** Per-lane manually pinned reasoning efforts: one {provider, model,
	 *  effort} entry per route the user pinned; routes without an entry use
	 *  the lane's default effort. */
	poolEconomyEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	poolMechanicalEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	poolMainEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	poolHardEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	poolVisionEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	poolReviewEfforts: z.array(EffortEntrySchema).default([]).volatile(),
	/** Capability ranking, strongest first; manual order overrides defaults. */
	modelRank: z.array(RankEntrySchema).default([]).volatile(),
	/** How pool guidance is enforced on delegation tools. */
	dispatchEnforce: z.union(["off", "advice", "enforce"]).default("advice").volatile(),

	// --- Phase 3: context watermark control --------------------------------
	/** Soft watermark: advisory banner + delegation nudge (tokens). */
	wmSoftTokens: z.number().min(1000).default(80000).volatile(),
	/** Hard watermark: read budget tightens, wrap-up advised (tokens). */
	wmHardTokens: z.number().min(2000).default(120000).volatile(),
	/** Force watermark: backup + compaction handover (tokens). */
	wmForceTokens: z.number().min(3000).default(150000).volatile(),
	/** Per-call read budget for read/glob/grep (tokens). */
	wmReadBudgetTokens: z.number().min(200).default(3000).volatile(),
	/** Hard-tier behavior: cap reads and advise, or deny outright. */
	wmDenyMode: z.union(["cap", "deny"]).default("cap").volatile(),
	/** Force tier triggers backup + compaction automatically. */
	wmAutoHandover: z.boolean().default(true).volatile(),
	/** Cap subagent contexts at wmSubagentForceTokens. */
	wmSubagentCap: z.boolean().default(true).volatile(),
	/** Subagent hard cap; 0 = share wmForceTokens. */
	wmSubagentForceTokens: z.number().min(0).default(0).volatile(),

	// --- Teams mode: doctrine injection + whitelist sync -------------------
	/** Agent Teams master switch. ON = inject the `[SWITCHMAN:TEAMS]` doctrine
	 *  section (order 10250), keep the DSH child-model whitelist detection in
	 *  the pools table, and asynchronously ensure the agent-team-profile
	 *  bundle is enabled. OFF = plain subagent dispatch mode: no teams
	 *  doctrine, no whitelist detection (the DSH factory conservative team
	 *  policy takes over); the bundle is never disabled and the whitelist is
	 *  never cleared. */
	teamsMode: z.boolean().default(false).volatile(),
	/** Replace-sync the six-pool union into DSH's subagent model-selection
	 *  whitelist (`subagent-model-selection-settings`) whenever the teams
	 *  orchestration runs — an INDEPENDENT switch: it does not require
	 *  teamsMode, and teamsMode alone does not sync. switchman is the single
	 *  source of truth: the deduplicated union overwrites allowedModels
	 *  wholesale. The whitelist only applies to top-level sessions composed
	 *  afterwards. */
	syncWhitelist: z.boolean().default(false).volatile(),

	// --- Intent recognition: classifier-routed "auto" model ----------------
	/** Master switch for intent routing (design: .dsh-switchman/plans/
	 *  intent-routing.md §2). The adapter stays mounted either way; OFF
	 *  only hides the catalog entry (listModels returns [], the selector
	 *  drops the empty group) — a session already on Auto routes through
	 *  the documented fallback chain (routedCurrent → intentFallbackRoute
	 *  → first candidate) with NO classifier call. */
	intentEnabled: z.boolean().default(false).volatile(),
	/** Small-model route that classifies the conversation against the
	 *  candidates. Empty = unset; classification is skipped (fail-open). */
	intentClassifierRoute: IntentRouteSchema.default({ provider: "", model: "" }).volatile(),
	/** Optional reasoning-effort pin for the classifier call ("" = adapter
	 *  default). */
	intentClassifierEffort: z.string().default("").volatile(),
	/** Classifier channel; must be an explicit choice. "chat" calls the
	 *  intentClassifierRoute above through its provider's standard chat
	 *  API with a strict-JSON instruction. "systemone" = direct HTTP to a
	 *  hand-configured ollama /v1/systemone decision endpoint — no
	 *  provider, uses intentClassifierEndpoint +
	 *  intentClassifierSystemoneModel. */
	intentClassifierKind: z.union(["chat", "systemone"]).default("chat").volatile(),
	/** Full URL of the ollama /v1/systemone endpoint for kind "systemone"
	 *  (e.g. http://127.0.0.1:11434/v1/systemone). Empty = unset; that
	 *  kind fails open to the fallback chain. */
	intentClassifierEndpoint: z.string().default("").volatile(),
	/** Model name sent to the decision endpoint for kind "systemone"
	 *  (free text, e.g. tev1:4b-mxfp8). Independent of the llm provider
	 *  catalog — no provider registration needed. Empty = unset; that
	 *  kind fails open to the fallback chain. */
	intentClassifierSystemoneModel: z.string().default("").volatile(),
	/** Independent candidate list the "auto" pseudo-model may route to (NOT
	 *  poolMain). Each entry: {id, preset?, enabled?, provider, model,
	 *  effort?, note?}; readers merge the built-in presets from
	 *  host/intent-presets.js (see mergeIntentCandidates). */
	intentCandidates: z.array(IntentCandidateSchema).default([]).volatile(),
	/** Provider prompt-cache reuse window: while the current route stays
	 *  below the switch-confidence threshold, keep it for this many
	 *  seconds since the last applied routing. */
	intentCacheTtlSeconds: z.number().min(0).default(300).volatile(),
	/** Classifier confidence (0-100) required to leave the current model. */
	intentSwitchConfidence: z.number().min(0).max(100).default(80).volatile(),
	/** Classification-call budget in ms; timeout/abort fails open to the
	 *  fallback chain. */
	intentTimeoutMs: z.number().min(200).default(60000).volatile(),
	/** Recent user/assistant messages fed to the classifier. */
	intentHistoryMessages: z.number().min(1).max(20).default(6).volatile(),
	/** Total character budget for that conversation excerpt. */
	intentHistoryMaxChars: z.number().min(200).max(20000).default(2400).volatile(),
	/** Context window (tokens) declared by the "auto" pseudo-model. Purely
	 *  advisory metadata: drives the usage popover and the auto-compaction
	 *  pressure math for sessions routed through Auto. While wmAutoHandover
	 *  is on, the effective declared value is floored at
	 *  ceil(wmForceTokens / 0.8) so the smooth handover always fires before
	 *  the 0.8×-window auto-compaction (see effectiveContextWindow in
	 *  host/intent.js). */
	intentContextWindow: z.number().min(1024).default(200000).volatile(),
	/** Optional last-resort route when the classifier fails and no previous
	 *  routed model exists; empty = the first candidate. */
	intentFallbackRoute: IntentRouteSchema.default({ provider: "", model: "" }).volatile(),
});

/** The six dispatch lanes, in display order. */
export const LANES = ["economy", "mechanical", "main", "hard", "vision", "review"];

/** Settings field name for one lane. */
export const laneField = (lane) => `pool${lane[0].toUpperCase()}${lane.slice(1)}`;

/** Manual-order flag field name for one lane. */
export const laneManualField = (lane) => `${laneField(lane)}Manual`;

/** Per-model effort-pin list field name for one lane. */
export const laneEffortsField = (lane) => `${laneField(lane)}Efforts`;
