/** Host half of the dsh-switchman bundle.
 *
 * Mounts the bundle's skills on `ctx.skills` through one static provider:
 * every bundled `skills/<name>/SKILL.md` (source "bundled", rank
 * BUNDLED_SKILL_RANK, directory resource base so the skill tool tells the
 * Agent where `scripts/` and `references/` live) plus — while the constraint
 * layer is ON — the open workspace registry scanned per session cwd by
 * host/skill-registry.js (refactor guide §5.2.2; source "local", same rank,
 * bundled names win conflicts). Every provider get() records a bounded
 * skill_loaded stat (§5.2.1) feeding the P1 pool-feedback loop. The preset
 * overrides live in cordis.patch.yml; the Client half in
 * client.js renders the "team autonomy" badge beside the preset chip.
 *
 * Phase 1 additionally mounts the language-preference layer (host/lang.js):
 * a dynamic systemPrompt section carrying the `[SWITCHMAN:LANG]` protocol
 * block plus a `tools/post-execute` listener that captures ask_user_question
 * answers and persists them into this plugin's settings namespace.
 *
 * Phase 2 mounts the dispatch-pool layer (host/dispatch.js + host/lib/rank.js):
 * a `[SWITCHMAN:POOLS]` recommendation section ordered by modelRank anchors
 * and the bundled capability snapshot, plus an optional (enforce mode only)
 * `tools/pre-execute` gate that denies subagent routes outside the pools.
 *
 * Phase 3 mounts the context-watermark layer (host/context-watch.js): the
 * `[SWITCHMAN:WATERMARK]` tiered banner from the live token meter, a per-turn
 * read budget with deny/cap gates, the force-tier handover
 * (document + compaction + continuation) plus the
 * ctx_handover agent tool, and the /ctx-pause, /ctx-resume,
 * /ctx-handover commands.
 *
 * The tool-argument sanitation layer (host/tool-args-sanitize.js) is a
 * `tools/pre-execute` waterfall listener that transparently coerces known
 * broken argument shapes — stringified-JSON composites ("[100, 145]" instead
 * of [100, 145]) and empty-string enum fields (encoding: "") — before the
 * tool implementations validate them, eliminating a recurring class of
 * self-correcting tool-call retries observed in production session logs.
 * Teams mode mounts two more layers: host/teams.js carries the team clauses
 * extracted from the cordis.patch.yml suffix in a `[SWITCHMAN:TEAMS]` section
 * (order 10250, injected only while teamsMode is ON) plus the deferred ON
 * orchestration (agent-team bundle enable, then the optional dispatch-model
 * union — six pools + modelRank — → DSH whitelist replace-sync);
 * host/subagent-model.js annotates successful
 * subagent / subagent_fork results with one `model: provider/model@effort`
 * line from the child session's modelSelection projection (the same channel
 * host/vision.js reuses for the per-session vision-state verdict).
 *
 * The intent layer (host/intent.js) adds the "auto" pseudo-model: a
 * `dsh-switchman-auto` adapter registered on `ctx.llm` (native catalog entry,
 * composer dropdown) plus an `agent/request` waterfall listener that rewrites
 * the pseudo route onto a real model — a small classifier model scores the
 * recent conversation against the configured candidate list once per turn,
 * the decision pins for the turn's retries and later steps, and a
 * provider-cache window keeps the current model while confidence stays below
 * the switch threshold. The llm/sessions services are reached through
 * defensive ctx.get reads (NOT declared in inject): a deployment without the
 * llm service leaves this layer a warn-once no-op — a documented runtime
 * precondition, like sessionQuery/pluginManager above.
 * The PTC direct-call guard (host/ptc-guard.js) is a final-say prompt section
 * (order 10510) rendered only when the viewing scope resolves to the PTC tool
 * executor — detected per assembly via ctx.tools.selectExecutor(context.scope)
 * plus the executor's describe() knownNames — restating that every named tool
 * must be called inside a run_code program (`await tools.name(args)`), so
 * doctrines and skill catalogs that name tools directly can no longer trigger
 * `unknown tool` rejections in PTC sessions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Plugin settings schema: flat `.volatile()` fields exposed as the
// "dsh-switchman" settings namespace (forms + profile-patch persistence).
export { Config, LANES, laneField } from "./host/config.js";

// Language-preference layer (dynamic prompt section + answer capture).
import { applyLanguage } from "./host/lang.js";

// Dispatch-pool layer (pools recommendation section + enforce gate).
import { applyDispatch } from "./host/dispatch.js";

// Agent Teams layer (teams-mode doctrine section + bundle/whitelist
// orchestration; the clause text extracted from the cordis.patch.yml suffix).
import { applyTeams } from "./host/teams.js";
// PTC direct-call guard (final-say transport rule for PTC-executor scopes).
import { applyPtcGuard } from "./host/ptc-guard.js";
import { applyPtcBindings } from "./host/ptc-bindings.js";
// Subagent model-visibility layer (post-execute `model:` annotation).
import { applySubagentModel } from "./host/subagent-model.js";

// Context-watermark layer (banner + read budget + handover + /ctx-* commands).
import { applyContextWatch } from "./host/context-watch.js";
// Constraint recognition + skill annotations (refactor guide §4.1/§4.2):
// per-turn advisory tag line near the pools table + annotated-skills table;
// advice only, off by default (constraintsEnabled).
import { applyConstraints, annotateSkillCandidates } from "./host/constraints.js";
// Pool-feedback loop (guide §4.5, P1 item 3): maps the skill_loaded stats
// onto pool_hint lanes as advisory tier-label feedback rows beside the
// pools table; OFF (default) renders "" (zero prompt diff).
import { applyPoolFeedback } from "./host/pool-feedback.js";
// Dispatch-result observability (guide §4.5/§4.3, P2 pack B0): per-run
// pool×model×skill counters for the host logger + getters; OFF (default)
// captures nothing. No injection surface (MODEL-VISIBILITY).
import { applyDispatchStats } from "./host/dispatch-stats.js";
// Per-lane differentiation advice (guide §5 P2 ②, "分池/分 skill 的切换置信度
// 与思考强度差异化"): advisory [SWITCHMAN:POOLS-DIFF] rows from the pack-B0
// telemetry; OFF (default) = zero bytes AND zero computation.
import { applyPoolDifferentiation } from "./host/pool-differentiation.js";
// Open skill registry + skill-load observability (guide §5.2.1/§5.2.2):
// workspace `<cwd>/.dsh-switchman/skills/` scanning (source "local"),
// name-conflict merging, and the bounded skill_loaded stats.
import {
	BUNDLED_SKILL_RANK,
	PROVIDER_NAME,
	candidatesWithRegistry,
	parseSkillFile,
	recordSkillLoad,
} from "./host/skill-registry.js";
// Context-trim layer (deterministic outbound-view folding + idle-boundary
// automatic folds + ctx_trim_fold/ctx_trim_status advisory tools).
import { applyContextTrim } from "./host/context-trim/index.js";
// Vision dispatch gate (/vision command + vision-state route for the
// composer-dock hint): unlocks image sending on text-only models.
import { applyVision } from "./host/vision.js";
// Intent-routing layer ("auto" pseudo-model: classifier-routed real model,
// per-turn pin + prompt-cache window; intent-state/intent-reset routes).
import { applyIntent } from "./host/intent.js";
// Client-bridge routes (config snapshot/fenced write + model catalog for the
// restricted browser half, which has no configForms/remote services).
import { applyRoutes } from "./host/routes.js";
// Tool-argument sanitation (transparent coercion of stringified-JSON and
// empty-string argument shapes before tool validation).
import { applyToolArgsSanitize } from "./host/tool-args-sanitize.js";
// Edit-tool feedback watcher (rewrites native edit-tool miss failures into
// self-contained corrective feedback; diagnosis-only, fail-open).
import { applyEditFeedback } from "./host/edit-feedback.js";

/** Cordis plugin name. */
const name = "dsh-switchman";

/** Services this plugin contributes to: the bundled-skill registry, the
 * system-prompt section registry, the settings store it writes back to, the
 * token meter and agent registry the watermark reads, the command registry
 * for /ctx-*, the tools registry for the ctx_handover agent tool, the
 * subagents service the teams layer dispatch goes through, the sessions
 * persistence the handover's continuation flush uses, the plugin-manager
 * service the teams layer's bundle enable goes through, and the session
 * query engine the subagent model annotation + per-session vision verdicts
 * read child modelSelection projections from. pluginManager and
 * sessionQuery are profile-composition services (the plugin-manager bundle
 * is disabled without profileContext; session-query ships in the base
 * patch): deployments lacking them leave this fiber INACTIVE — a documented
 * runtime precondition, not a degraded mode. The defensive ctx.get calls
 * inside teams.js / subagent-model.js guard API drift, not absence.
 * Compaction is deliberately NOT injected: the desktop profile provides it
 * only inside each preset's per-agent isolated group (isolate: { compaction:
 * true }), never at this root — host/context-watch.js reaches it by borrowing
 * the session's own per-agent /compact handler through
 * ctx.commands.find(agent, "compact").
 *
 * The context-trim layer (host/context-trim/) adds fully-automatic context
 * compression: an llm/stream listener rebuilds a deterministic outbound
 * view (folded ranges replaced by ONE synthetic summary message each,
 * per-session ledger) in place before every agent-loop model call, an
 * agent/status idle hook runs the fold decisions (growth gate / pressure /
 * emergency tiers; side-model summaries with mechanical emergency
 * fallback), and the ctx_trim_fold / ctx_trim_status tools expose the
 * advisory surface. Fail-open throughout: the listener always calls
 * next(), and trimming degrades to a no-op on any internal failure. */
const inject = ["skills", "systemPrompt", "settings", "tokenMeter", "commands", "tools", "agents", "webServer", "subagents", "sessions", "pluginManager", "sessionQuery"];

/** Build one bundled-skill candidate from a skill directory. */
function loadSkillCandidate(directory) {
	const path = join(directory, "SKILL.md");
	const parsed = parseSkillFile(readFileSync(path, "utf8"), path);
	return {
		name: parsed.name,
		description: parsed.description,
		invocation: { modelInvocable: true, userInvocable: true },
		provider: PROVIDER_NAME,
		source: "bundled",
		rank: BUNDLED_SKILL_RANK,
		resourceBase: { kind: "directory", path: `${directory}/` },
		locator: path,
	};
}

/** Scan ./skills at apply time; broken entries warn and drop, never throw. */
function loadSkillCandidates(root, warn) {
	const candidates = [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		warn(`skills directory missing or unreadable: ${root}`);
		return candidates;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const directory = join(root, entry.name);
		try {
			candidates.push(loadSkillCandidate(directory));
		} catch (error) {
			warn(`skill directory ${directory} ignored: ${error?.message ?? error}`);
		}
	}
	return candidates;
}

/** Register the bundled dsh-switchman skill provider on `ctx.skills` and
 *  mount the language (lang), dispatch (dispatch), teams (teams), watermark
 *  (context-watch), constraints (constraint-recognition + skill annotations),
 *  vision (vision), intent routing (intent), subagent model
 *  visibility (subagent-model), client-bridge (routes), and the PTC
 *  direct-call guard (ptc-guard) layers. */
function apply(ctx, config) {
	const root = fileURLToPath(new URL("./skills/", import.meta.url));
	const warn = (message) => ctx.logger.warn(`dsh-switchman: ${message}`);
	const candidates = loadSkillCandidates(root, warn);
	const provider = {
		name: PROVIDER_NAME,
		// §5.2.2 open registry: the host passes the session cwd in the lookup
		// options; candidatesWithRegistry returns the bundled list untouched
		// while the constraint layer is OFF (no filesystem scan — review F1)
		// and merges the workspace registry under it when ON (bundled names
		// win conflicts, broken entries warn and skip).
		list: (options) => Promise.resolve(candidatesWithRegistry(candidates, options?.cwd, config, warn)),
		async get(candidate) {
			// §5.2.1 observability: the triggering turn is not observable at
			// the provider layer, so the event records the provider-level fact
			// only (skill name + bundled/local source). OFF records nothing.
			recordSkillLoad(candidate, config?.constraintsEnabled?.get() === true, (message) => ctx.logger?.info?.(message));
			const { rank: _rank, locator, ...summary } = candidate;
			return { ...summary, content: parseSkillFile(readFileSync(locator, "utf8"), locator).content };
		},
	};
	ctx.skills.registerProvider(() => provider);
	applyLanguage(ctx, config);
	applyDispatch(ctx, config);
	applyTeams(ctx, config);
	applyPtcGuard(ctx);
	applyPtcBindings(ctx);
	applyContextWatch(ctx, config);
	applyContextTrim(ctx, config);
	// §4.2 annotation layer: only skills WITH constraints annotations enter
	// the [SWITCHMAN:SKILLS] table. Passed as a per-assembly closure (plain
	// arrays stay supported for tests) so locally registered skills —
	// discovered per session cwd — get the same parse+measure path as the
	// bundled ones; OFF returns [] without touching the filesystem (review
	// F1 short-circuit).
	// One per-assembly annotation view shared by BOTH consumers: the
	// [SWITCHMAN:SKILLS] table (§4.2) and the pool-feedback rows (§4.5).
	// Plain arrays stay supported for tests; OFF returns [] without touching
	// the filesystem (review F1 short-circuit).
	const annotatedSkills = (agent) => {
		if (config?.constraintsEnabled?.get() !== true) return [];
		const cwd = agent?.session?.header?.cwd;
		return annotateSkillCandidates(candidatesWithRegistry(candidates, typeof cwd === "string" ? cwd : "", config, warn));
	};
	applyConstraints(ctx, config, annotatedSkills);
	// Same closure (resolved per assembly inside each section, never stored:
	// review F6), so feedback tiers track the exact annotations the table prints.
	applyPoolFeedback(ctx, config, annotatedSkills);
	// Dispatch telemetry listeners (host-only data layer; gated OFF by
	// default, zero capture while disabled).
	applyDispatchStats(ctx, config);
	// §5 P2 ② differentiation advice (order 10407; advice-only, off by default).
	applyPoolDifferentiation(ctx, config);
	applyVision(ctx, config);
	applyIntent(ctx, config);
	applySubagentModel(ctx);
	applyRoutes(ctx, config);
	applyToolArgsSanitize(ctx, config);
	// Edit-feedback watcher (post-execute; fires only on already-failing
	// edit calls; fail-open passthrough when disabled or on internal errors).
	applyEditFeedback(ctx, config);
}

export { apply, inject, name };
