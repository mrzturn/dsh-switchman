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

/** All dsh-switchman settings. Field names are the settings mutation paths. */
export const Config = z.object({
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
	wmSoftTokens: z.number().min(1000).default(50000).volatile(),
	/** Hard watermark: read budget tightens, wrap-up advised (tokens). */
	wmHardTokens: z.number().min(2000).default(90000).volatile(),
	/** Force watermark: backup + compaction handover (tokens). */
	wmForceTokens: z.number().min(3000).default(130000).volatile(),
	/** Per-call read budget for read/glob/grep (tokens). */
	wmReadBudgetTokens: z.number().min(200).default(1500).volatile(),
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
});

/** The six dispatch lanes, in display order. */
export const LANES = ["economy", "mechanical", "main", "hard", "vision", "review"];

/** Settings field name for one lane. */
export const laneField = (lane) => `pool${lane[0].toUpperCase()}${lane.slice(1)}`;

/** Manual-order flag field name for one lane. */
export const laneManualField = (lane) => `${laneField(lane)}Manual`;

/** Per-model effort-pin list field name for one lane. */
export const laneEffortsField = (lane) => `${laneField(lane)}Efforts`;
