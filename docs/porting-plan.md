# dsh-switchman Capability Porting Analysis and Implementation Plan

> Status: **draft, pending review** (this document is analysis and planning only; no implementation was touched)
> Date: 2026-10-01
> Method: four parallel investigation tracks (opencode-switchman's three capability mechanisms ×1 each, DSH platform extension points ×1) + live queries of the running Host/Client via Cordis Inspect (Service / Event / Slots catalogs).
> Citation legend: `oc/…` = `~/Documents/code/my/GitHub/opencode-switchman/…`; the `dsh-platform` findings come from live Inspect queries and the local DSH 0.2.0-rc.2 source checkout (`app.asar!dsh/`); line references appear in each section.

---

## 0. Conclusions at a Glance

| # | Capability | Verdict | One-line summary |
|---|------|------|-----------|
| 1 | Multilingual support (UI copy layer) | ✅ **Replicable, low cost** | The DSH client natively ships `locale.register/addLanguage/resolveText`; opencode's 11-language key–value tables can be mounted wholesale |
| 2 | Multilingual support (project language-preference layer) | ✅ **Replicable, different carrier surface** | The `[LANG]` iron-rule line becomes a Host dynamic systemPrompt section; the ask flow reuses DSH's existing `ask_user_question`; **the hard gate is recommended to soften into a first-time prompt** |
| 3 | Language-aware skills | ✅ **Replicable, near-zero code** | The truth is a convention of "SKILL.md deference clause + language iron-rule line" with no code involved; the DSH skill system is isomorphic; opencode's skill-sync is **not needed** on DSH |
| 4 | Context watermark control | ⚠️ **Compatible (policy-layer overlay)** | DSH already has tokenMeter + compaction-basic + pruners; **do not rebuild metering/compression** — what gets ported is the "three-tier watermark policy + read budget + delegation steering + subagent hard cap" skin, and every opencode hook has a DSH-equivalent event |
| 5 | GUI pools → model settings page | ✅ **Replicable (data model) + newly built (carrier surface)** | The pool-config/capability-rank data structures and the pure-function layer port over directly; the settings page hangs on the officially reserved `settings.section` slot as a hand-written form (official schema auto-rendering is not implemented yet) |
| 6 | Model capability priority ranking | ✅ Same as above | The capability-default.json snapshot + four-tier fallback chain + `applyRankMove` semantics port over verbatim; DSH has no ranking concept, so keep a self-owned volatile Config ns |
| 7 | TUI / tmux / quota scraping / ROUTE_META six gates / shell registration surface | ❌ **Not recommended for porting** | See §4; each has an environment mismatch or a ready-made replacement |

---

## 1. Platform Foundation: the Primitives DSH Already Has (the root of "compatible")

The investigation confirmed that both the DSH Host and Client sides already provide almost every mount point the port needs:

**Host services (ctx.*, confirmed live via Inspect)**
- `tokenMeter.measure(session)` / `estimateMessage` + session projections `tokenUsage` / `contextPressure{pressureTokens, projectedTokens, contextWindow}` / `contextBreakdown` — no need to build metering ourselves
- The three `compaction` abstractions `compactIfNeeded / compactNow / compactRegion`; compaction-basic already has auto compaction (thresholdRatio 0.8), the `/compact` command, and per-route `modelPolicies` — no need to build compaction ourselves
- `systemPrompt.section() / context() / variable()` + the `system-prompt/assemble` waterfall — the injection point for banners / iron-rule lines (the existing persona suffix travels this route, order 10200)
- `tools/pre-execute` (allow/deny/cancel/ask), `tools/post-execute`, `tools/result` — the interception points for the read budget and hard caps
- `agent/pre-step` (can rewrite the messages entering a step), `agent/request` (can replace the frozen call config), `llm/stream` (a waterfall per model call), `agent/request-error`
- `commands.register` — the slash-command registry (the carrier of `/ctx-pause` and the like)
- `llm.listProviders() / listModels() / resolveModelInfo` (model metadata carries contextWindow and reasoning.efforts)
- `subagentModelSelection` (an `allowedModels` whitelist, already enforced in subagent/workflow route validation, but with **no ranking concept**)
- `skills.registerProvider` (already in use by this bundle), `configEditor` (config persistence), `storage` (Domain persistence), `hmr.watchConfig` (config hot reload)
- The full `subagents` + `agentTeams` set (spawn / teammate / task board)

**Client side**
- `locale`: factory zh/en; plugins can contribute copy via `register(ns, dicts)`, contribute **brand-new languages** via `addLanguage({id,label,fallback:'en'})`, and call `resolveText({zh,en,…})`; language detection goes through navigator.languages + Host preference
- Slots (officially reserved, safe seats marked `replaceRisk: none`): `settings.section` (**an entire settings page**), `settings.plugins.tab`, `plugins.bundle.config` (the bundle's own config page), `plugins.row.config`, `settings.models.footer` / `settings.models.provider-card` (**the third-party extension area of the model settings page**), `settings.general.item` (single-line preference), `conversation.session.header.actions` (the current badge position), `conversation.input.dock` / `conversation.composer.dock`
- A plugin volatile Config (schemastery `static Config`) automatically enters the settings-form descriptors and persists into the profile patch — **but official schema→UI auto-rendering is not implemented in the client yet**, so the settings page must carry its own semi-hand-written client form (ui-primitives' SettingsFormModel is reusable)

---

## 2. Capability-by-Capability Analysis

### 2.1 Multilingual Support

**opencode mechanism (two layers — do not conflate them)**
- Layer A · project language preference: `lang.{conversation,comments,docs}` in `settings.json` (oc/src/lang-config.ts:20-48); first-time setup goes through three question-tool prompts plus plugin-side capture for persistence (oc/src/index.ts:1597-1604, 2021-2035); while unconfigured a **hard gate rejects bash/edit/write/task** (oc/src/lang-config.ts:243-257); once configured, a `[LANG] … IRON RULE` line is injected every turn (oc/src/index.ts:1594-1596).
- Layer B · UI display language: 11 locale files, 263 keys, en as the source of truth, and a fallback chain unknown→en→fallback→key that never throws (oc/src/i18n.ts:33-41); tests enforce full coverage plus placeholder consistency (oc/test/i18n.test.ts:14-31). **Model-facing protocol copy is deliberately left untranslated** (anchors like `[LANG]`/`[WATERMARK]` must be byte-stable, oc/src/i18n.ts:1-6).
- The 11-language README is maintained purely by hand with no sync script; docs are en/zh only.

**DSH status quo**: layer B's infrastructure exists as-is (§1); layer A needs a newly built injection surface.

**Verdict and plan**
- Layer B → **replicable**: mount the whole en/zh-CN/zh-TW/ja/ko/es/fr/de/it/pt/ru set from oc/src/locales/ as the plugin's locale ns; trim the three TUI-only key groups sidebar/dialogs/palette and keep notices/quota/cli. Start with zh/en and follow up with the remaining languages from the translations already in the locales files (tests lock them in, so maintenance cost stays manageable).
- Layer A → **replicable (different carrier surface)**: store the three-field language preference in the plugin volatile Config; do first-time setup with `ask_user_question` (multiple questions + options, far more robust than parsing opencode's text pairs) in a single shot; inject the language iron-rule line per step via a dynamic `systemPrompt` section (order later than the 10200 persona suffix). The client locale can prefill defaults.
- Hard gate → **not recommended to copy as-is**: DSH is a resident GUI with profile-based configuration, so language can be prefilled and then gently confirmed; "refuse write tools until a language is configured" is too heavy an experience. It can remain an optional strict mode.
- The anchor-stability principle of keeping protocol copy in English → **keep as-is** (both cross-language capture and tests depend on it).

### 2.2 Language-Aware Skills

**The truth**: the skill bodies themselves are **not localized** — all three SKILL.md files are English-only; the "association" = an in-document deference clause ("English by default, use the project's configured language when a switchman [LANG] line specifies") plus the per-turn injected language line; runtime language follows along, zero code. skill-sync.ts merely materializes the packaged skills into opencode's global skill directory (marker-gated, add/overwrite-only, fail-open — oc/src/skill-sync.ts:97-137) — that is a patch for opencode's "host scans a global directory" model, which DSH's `registerProvider` model does not need at all.

**Verdict and plan**: **replicable with near-zero code**. dsh-switchman already registers a bundled skills provider; all it takes is (1) adding the language deference clause to the three SKILL.md files and (2) waiting for 2.1's language-line injection to take effect. **skill-sync is not ported** (no matching need).

### 2.3 Context Watermark Control

**opencode mechanism summary**
- Metering: assistant-message usage (input+output+reasoning+cache.read), dual Maps updated per message (main session / shell), capped at 90% of the model window (oc/src/context-watch.ts:25-51).
- Three watermark tiers default to 50k/90k/130k: soft = a delegation suggestion, hard = close read tools + wrap up, force = automatic handover; the banner is injected every turn via system transform (oc/src/index.ts:386-421, 1655-1658).
- Read budget: per-read R*=1500 and 2×R* per turn, 64KB head-sampling estimation + post-hoc accounting + a tolerance band + continuation-read merging + a 15-minute idle reset (oc/src/context-watch.ts:154-368).
- Handover: a `session.fork` backup (`[backup]` titles auto-numbered) + `session.summarize` compaction; **never await the compact leg** (self-deadlock lesson); 10-minute cooldown (oc/src/handover-core.ts:26-86, oc/src/index.ts:2066-2110).
- Subagent hard cap: shares forceTokens by default; once the cap is hit, every tool call in that session is denied, and the deny text itself is the wrap-up instruction (requiring a HANDOFF summary), with a persistent registration that survives restarts (oc/src/index.ts:1756-1777, 2202-2226).

**DSH status quo and gap**: DSH already has "single-threshold auto compaction" (compaction-basic thresholdRatio 0.8 + overflow recovery + the GUI's "context used %"). What is missing is not compression but switchman's **policy layer**: tiered watermark banners, the read budget, watermark-driven delegation steering, the subagent hard cap, and the pause switch.

**Hook mapping table (every row has an equivalent)**

| opencode | DSH equivalent | Purpose |
|---|---|---|
| message.updated tokens | `tokenMeter.measure` + session projection `contextPressure` | watermark metering (not self-built) |
| chat.system.transform | `systemPrompt.context()/section()` (order>10200) | banner injection |
| tool.execute.before | `tools/pre-execute` | read-budget gate / hard-cap gate |
| tool.execute.after | `tools/post-execute` + `tools/result` | post-hoc accounting / force triggering |
| session.fork | client `sessions.fork` / compaction checkpoint | backup leg |
| session.summarize | `compaction.compactNow/compactIfNeeded` | compaction leg (not self-built) |
| /ctx-pause marker capture | `commands.register` + session-scoped state | pause switch (+ GUI toggle) |
| shell-session events | `subagent/start` / `subagent/end` | subagent hard cap |
| models.dev window | `llm.resolveModelInfo().contextWindow` | window cap |

**Verdict and plan**: **compatible — as a policy-layer overlay**. The decision core (the pure-function part of oc/src/context-watch.ts: threshold checks / budget allocation / the estimator) ports over nearly verbatim; the execution layer switches entirely to DSH services. The force tier calls the compaction service directly and takes a checkpoint backup first, staying fire-detached. **Not recommended**: self-built metering, a self-built summarize, or starting a second compression path around compaction-basic (races); for the hard tier, the blanket deny is recommended to default to "cap + strong suggestion", with the deny made an option (coordinated with the DSH approval experience).

### 2.4 GUI Pools → Models + Capability Priority Ranking

**opencode data model (the core asset that ports wholesale)**
- `pool-config.json`: `{pools:{lane→[modelId]}}`, six lanes economy/mechanical/main/hard/vision/review (oc/src/user-overrides.ts:34-40; oc/src/lane-policy.ts:53-64).
- `capability-rank.json`: `{models:[…ordered], scores:{key→{tier,raw}}}`; anchored scores may interleave with base scores (oc/src/user-overrides.ts:15-32); move semantics live in the `applyRankMove` pure function (:212-271).
- Capability data with a four-tier fallback: manual→api (24h TTL)→bundled snapshot (179 models)→curated table (oc/src/capability.ts:400-408).
- Scoring product formula + cost tiebreak (oc/src/scoring.ts:124-149, 338-343).
- Setup hard gate: dispatch is released only once each of the six pools has ≥1 entry and the ranking has ≥1 (oc/src/setup-gate.ts:21-36).
- Interaction: /poolConfig tick-and-persist, /modelRank move up/down, the /switchman-setup wizard (oc/src/tui.tsx:447-932).

**DSH status quo**: model enumeration and metadata are better than opencode's (built into `ctx.llm`, no models.dev window scraping needed); the route consumption surface is the provider/model parameters of subagent/workflow/spawn_teammate plus the `subagentModelSelection` whitelist (an admission layer, no ranking); the GUI has officially reserved slots (`settings.section`, `settings.models.footer`, `plugins.bundle.config`); persistence goes through the volatile Config; **but there is no "task type → model" mapping layer, no priority concept, and the settings page must be hand-written**.

**Verdict and plan**: the data model and pure-function layer (lane-policy/scoring/capability/user-overrides/setup-gate, plus their tests as behavior locks) **replicates**; the carrier surface is **newly built**:
- Host half, a newly added plugin (e.g. `dsh-switchman-dispatch`): `static Config` declares `pools` / `rank` (volatile) and packages capability-default.json; two consumption paths — (1) a dynamic systemPrompt section emitting the "pool recommendation table" (steering the Lead's spawn_teammate/subagent/workflow model choice, dovetailing seamlessly with the existing autonomous-team doctrine); (2) an optional `tools` guard that prompts when a subagent/workflow model is not in the target pool (advice by default, enforce optional).
- Client half, a settings page (`settings.section` registering a whole page, or starting light on `settings.models.footer`): six pool cards (candidates = llm.listModels via remote), tick-to-save, drag-to-rank (anchored tier display), a setup-completeness banner; the form reuses ui-primitives.
- The division of labor with `subagentModelSelection` must be explicit: **whitelist = admission (whether a route may be used), pools = recommendation and ranking (which route to prefer)**; the two complement each other without syncing or rewriting each other, and the page carries an explanation.
- **Not recommended for porting**: the ROUTE_META prompt six-key protocol and the full six gates (DSH dispatch uses structured parameters, so simplify to pool-membership validation), shell registration tri-state / matrix probing / dual-file watching of the activation surface (opencode-specific), the shells.json "model × effort" face expansion and -ro aliases (DSH's reasoning_effort is a per-call parameter), and three-provider quota scraping with peak-window (degrade first to a billing-config-driven coefficient, optional later).

---

## 3. Hook/Event Wiring Master Table (Watermark + Dispatch Combined Quick Reference)

See the §2.3 mapping table; dispatch-side additions:
- Failure awareness (a health factor for later): `agent/request-error` + `llm/stream` → failure classification → a health coefficient in the ranking (opencode's circuit-breaker 600s×2, quarantine 5m/10m/6h, and retirement 1h×3 logic can be ported after simplification, oc/src/breaker.ts:1-84).
- Config hot updates: a volatile Config change → the `settings/document-updated` event → recompute the recommendation table.

---

## 4. Do-Not-Port List (Summary)

| Item | Reason |
|---|---|
| The full TUI set (@opentui dialogs, sidebar, palette, tmux mirroring) | DSH is a Web GUI; the equivalents are the settings page + conversation slots |
| GLM/Copilot/DS three-provider quota HTTP scraping, peak-window awareness | Environment mismatch (DSH has the deepseekAccount system); degrade first to a billing-config coefficient |
| Full replication of the ROUTE_META six-key protocol + six gates | DSH dispatch uses structured parameters; simplify to pool-membership validation + the whitelist |
| Shell registration tri-state / matrix probing / dual-file watching of the activation surface | opencode-host-specific; DSH has no named-shell concept |
| shells.json model × effort face expansion, -ro aliases | DSH's reasoning_effort is a per-call parameter |
| The lang hard gate (refusing write tools while language is unconfigured) | Too heavy an experience in a GUI environment; switch to a gentle first-time prompt + locale prefill |
| Self-built token metering, self-built compaction summarize | Duplicate construction against tokenMeter / compaction-basic, with race risks |
| Fully manual maintenance of the 11-language README | Upstream docs are en/zh only; start with en/zh, language packs (locales) tracked separately |
| skill-sync.ts | The DSH registerProvider model needs no materialization into a global directory |
| builtinAgents.mode, copilot-thinking shape caching, etc. | No corresponding host artifact |

---

## 5. Phased Implementation Plan

> Each phase is independently deliverable, verifiable, and reversible (reinstalling the bundle is the rollback). Size tags are rough one-person-day estimates.

### Phase 0 · Foundation (≈0.5d)
- Client-half modularization cleanup (a single module registering multiple slots suffices); bring the locales build in (en/zh); the plugin volatile Config ns skeleton; extend `scripts/validate.mjs` to validate the new structure.
- Acceptance: after a reinstall the badge copy comes from the locale ns; `settings.describe()` shows the new ns.

### Phase 1 · Multilingual (≈1.5d)
- Register the locale ns in full (zh/en to start); (optional) mount the existing ja/ko/es etc. translations via `addLanguage`.
- The three session language-preference fields: settings-page configuration + client-locale prefill + a gentle one-time `ask_user_question` confirmation on the first session.
- A Host dynamic systemPrompt section injects the language iron-rule line (order>10200); the three SKILL.md files gain the deference clause.
- Acceptance: new-session prompts contain the language line; switching the UI language carries all plugin copy along; skill output follows the configured language.

### Phase 2 · GUI Pools and Ranking (≈3d)
- Host: the `dsh-switchman-dispatch` plugin entry (static Config: pools/rank) + capability-default.json packaging + porting of the pure-function layer and tests (lane-policy / user-overrides / setup-gate / applyRankMove; scoring can be trimmed to the subset rank synthesis needs).
- Client: the settings page (`settings.section`) — six-pool ticking, drag-to-rank, setup completeness; candidates come from `ctx.llm.listModels`.
- Consumption: dynamic systemPrompt injection of the "pool recommendation table"; an optional guard (advice by default / enforce optional).
- Acceptance: page configuration → the new session's recommendation table changes; in enforce mode out-of-pool dispatch gets flagged; when setup is incomplete the recommendation table annotates the unconfigured state (no hard blocking — the DSH side recommends a soft gate, see §6-Q3).

### Phase 3 · Context Watermark (≈4d)
- Watcher: tokenMeter + session projections → the watermark state machine (decision core ported) → dynamic banner injection.
- Read budget: `tools/pre+post-execute` (read/glob/grep estimation + post-hoc accounting + continuation-read merging + a 15min reset).
- Force tier: compaction service trigger + checkpoint backup (fire-detached); coordinate with the compaction-basic threshold (§6-Q4).
- `/ctx-pause` `/ctx-resume`: commands registration + session-scoped state + a composer dock GUI toggle.
- Subagent hard cap: `subagent/start|end` + a pre-execute deny wrap-up instruction + persistent storage registration.
- Acceptance: in long sessions the banner tracks the watermark; over-budget reads get capped with retry parameters given; the force tier auto-compacts and leaves a backup; subagents hitting the cap output a HANDOFF summary and stop.

### Phase 4 · Optional Enhancements (unscheduled, on demand)
- Health factor (request-error/llm-stream failure classification → rank); billing/peak config coefficients; more language packs; README en/zh; a setup hard-gate switch.

---

## 6. Risks and Open Questions Pending Decision

- **Q1 dual-source configuration**: pools/rank (this plugin) and `subagent-model-selection.allowedModels` (factory) coexist. The plan splits the labor as "whitelist = admission, pools = recommendation", with an in-page explanation and no rewriting of either side. Open question: accept this, or should the pools page manage the whitelist on its behalf?
- **Q2 static/dynamic layering**: the persona suffix (static YAML, order 10200) and the runtime-injected sections (language line / watermark banner / recommendation table) coexist in layers; the dynamic sections' order values must be coordinated to avoid mutual overwriting with the factory TEAM_POLICY section. Implementation validates via `getSectionOrder`.
- **Q3 setup hard gate**: opencode hard-blocks dispatch while unconfigured; the DSH side recommends a soft gate by default (recommendation-table annotation + hints), with enforce behind a switch. Open question: the preferred default?
- **Q4 coordination with compaction-basic**: if the force-tier threshold sits below the tokens corresponding to thresholdRatio (0.8), both fire. The plan aligns force at or above the 0.8 watermark by default, or reuses modelPolicies directly. Open question: which option?
- **Q5 hard-tier deny strength**: default "cap + strong suggestion" (the read budget stays enforced), with the blanket deny as an optional strict mode. Open question: the preferred default?
- **Q6 language scope**: locale translations already cover 11 languages; the suggestion is to open zh/en first (+ optional ja) for the UI and release the rest gradually along with the language packs. Open question: is that pace acceptable?
- **Risks**: DSH version drift (local 0.2.0-rc.2; factory preset plugin changes require re-syncing cordis.patch.yml per README:79); after changing `dsh.client` in `package.json` a full Host restart is needed (module-determination cache); the settings page is a hand-written form, so the workload concentrates in Phase 2.

---

## 7. Investigation Sources

- Four investigation reports — oc-i18n / oc-context / oc-routing / dsh-platform (team messages from the original session, with full file:line citations).
- Live Cordis Inspect queries: the Host Service/Event catalogs and the Client Service/Slots catalogs (including the `settings.section`, `plugins.bundle.config`, and `settings.models.*` seats with their `replaceRisk` annotations).
- The current dsh-switchman repo: README.md, index.js (skills provider), client.js (badge + locale mode), cordis.patch.yml (four preset overrides + plugin insert lines).

---

## 8. Implementation Decision Log (2026-10-01, at Phase 0 Completion)

### 8.1 Platform Verification Findings (Source-Level Evidence, Beyond the Investigation Reports)

- **Marketplace / plugin-page display**: `readPluginMeta` (dsh-app-boot) reads `<pkg>/locale/en.json` plus the sibling `<lang>.json` files (each holding `meta.title/description`) and the package.json `icon` (SVG/PNG/JPEG/WebP ≤256KiB). → This package added `locale/{en,zh}.json` + `icon.svg` + exports `./locale/*.json`.
- **Install channel**: `plugin_manager install_bundle` accepts an npm spec (registry falls back to npmmirror); **incompatible peerDependencies versions are rejected before pnpm runs**. → This package has zero peer dependencies and a single dependency: `@deepseek-ai/schemastery@3.18.4` (the same version as the host).
- **settings ns mechanism**: ns = the plugin module's `name` export (exhibit: `subagent-model-selection-settings`); the schema uses schemastery `z.object({...}).volatile()`; volatile fields are live references on the Host side (`config.<field>.get()`); persistence lands in the profile's cordis.patch.yml line config. → This package's ns = `dsh-switchman`, flat fields (host/config.js).
- **Client form API**: `ctx.configForms.get(ns)` → a scope (`getSnapshot(){status,writable,value,revision}` / `subscribe` / `mutate([{op:'set', path, value}], revision)`); `ctx.configForms.whileServed([ns], register)` gates availability; model candidates come from `ctx.remote.session.modelCatalog()` (`{groups:[{models:[{provider,model}]}], failures}`); refresh listens on `ctx.remote.$on('llm/adapters-updated')`. ui-primitives sits in the platform's frozen module table and can be required directly (including `SettingsFormModel`).
- **systemPrompt dynamic sections**: `section({name, order, text})`, where text may be a function evaluated at each assembly; external plugins may use any finite order (the existing persona suffix = 10200; we start at 10300).
- **client single-file constraint**: the client bundle is a single self-contained entry and cannot synchronously require other client-relative files → client.js stays a single file, hand-written with React.createElement.
- **Runtime state directory**: the DSH data root = `$DSH_HOME` else `~/.dsh` (dsh-home-paths); after an npm publish the package directory is in a non-writable state → runtime state (subagent cap registrations etc.) goes under `~/.dsh/dsh-switchman/`.

### 8.2 Added Constraints (Appended by the User on 2026-10-01)

1. **Official npm release + dsh-market compatibility**: marketplace installs go through the `install_bundle` npm-spec channel; release readiness = validate.mjs all green + a `npm pack` dry-run content audit.
2. **Redaction**: an audit before release (credentials / internal hostnames / personal paths / account information). Pre-audit: the db-query skill has no hardcoded credentials (default host 127.0.0.1, passwords via environment variables, docs use placeholder examples).
3. **Development done, release deferred for now**: the publish action (npm publish) is explicitly deferred; Phase 5 stops at the dry run.

### 8.3 Phase 5 (Added): Release Readiness (No Actual Release)

- `npm pack` + a tarball content audit (files complete, no stray files, no .git / state files).
- Redaction scan: grep credential patterns (password/secret/token/api-key/internal IPs/personal paths) → a manual-review checklist.
- README bilingualization (en primary + zh) + verification of the repository/homepage fields.
- `plugin_manager inspect` (local tarball) + fresh-profile install verification.
- Produce `docs/release-checklist.md`; wait for an explicit user instruction before publishing.

### 8.4 Phase 0 Completion Status

- [x] package.json marketplace hardening (icon/locale/engines.dsh/manifestVersion/files/exports/dependency pinning; removed private)
- [x] locale/en.json + locale/zh.json (display meta)
- [x] icon.svg
- [x] host/config.js: the full flat volatile Config (lang ×3 / pool ×6 / modelRank / dispatchEnforce / wm ×8)
- [x] index.js re-exports Config; client.js moved onto the locale ns (badge copy into the dictionary)
- [x] validate.mjs extended (marketplace checks), currently all green

### 8.5 Phase 1 Completion Status (2026-10-01)

- [x] host/lang.js: the `[SWITCHMAN:LANG]` dynamic section (order 10300, a byte-stable anchor) + gentle one-time ask guidance (marker `switchman-lang`) + `tools/post-execute` answer capture → `settings.update` persistence; a one-shot latch; fully defensive
- [x] index.js wiring (inject += systemPrompt/settings)
- [x] the three SKILL.md files gain the `## Language` deference clause
- [x] client.js: a settings.section settings page (three language-preference rows + suggested values + the official-style draft/revision save model)
- [x] dsh.client.inject += @deepseek-ai/dsh-client-ui-settings (the configForms service loads first)
- Verification: validate.mjs all green + node --check all passing + two-sided mock smoke tests; live end-to-end verification pending a DSH restart by the user
- The hard gate is not ported (per the settled decision: gentle prompt + settings-page prefill)

### 8.6 Phase 2 Completion Status (2026-10-01)

- [x] host/lib/rank.js: normalizeModelKey / defaultTiers / orderedPool / loadCapabilityDefaults (pure functions + a 179-model snapshot)
- [x] host/dispatch.js: the `[SWITCHMAN:POOLS]` dynamic section (order 10400, silent when unconfigured, configured=n/6 anchor) + the enforce gate (only subagent with an explicit provider+model; out-of-pool yields `{kind:"deny",reason}`)
- [x] host/data/capability-default.json data asset
- [x] client.js: six-pool editor (catalog ∪ stored-but-unavailable items, provider grouping, select-all/clear) + ranking editor (universe filter, tier dropdown, move-up/move-down/remove, WYSIWYG commit) + enforce tri-state + a progress line; 11-field atomic save
- [x] fixed three load-time crash bugs in config.js (a block-comment terminator, z.enum→z.union ×3 — the shipped schemastery 3.18.4 has no z.enum, proven by the implementer via asar unpacking)
- Verification: validate.mjs all green + node --check over 4+1 files + 30+ rank assertions + 8 dispatch mock groups + a full client mini-React regression + wiring tests in a real schemastery environment

### 8.7 Phase 3 Completion Status (2026-10-01)

- [x] host/context-watch.js (~430 lines): the `[SWITCHMAN:WATERMARK]` banner (order 10500; five tiers for the root session / three stages for sub-sessions: <50% silent → economize → HANDOFF → cap reached), the read-budget double gate (post-execute accounting at len/3.5 + per-inbox-turn reset + 15min self-clean; pre-execute deny (≥hard, 2.4×R*) or cap (enrich appends a warning line, landed after shape verification)), force auto-handover (fire-and-forget compactIfNeeded(agent,"pressure"), idempotently coordinated with the compaction-basic 0.8 threshold = the settled Q4), /ctx-pause /ctx-resume /ctx-handover
- [x] five shapes verified at source level: AssembleContext{agent,scope}, TokenMeasurement.totalTokens, exec.agent as the full Agent, compactIfNeeded(agent, trigger∈{pressure,context-overflow}), commands handler {commandId,agent,rawInput}→{kind,text}
- [x] client.js: the watermark section (8 fields + min / strictly-increasing validation + a numeric-edit overlay + command copy); 19-field atomic save; 94 zh/en dictionary pairs aligned programmatically
- [x] inject widened to 7 services (+tokenMeter/compaction/commands/agents)
- Verification: 14 mock groups + full-chain mounting + Phase 1/2 regression; differences vs oc: persistent cap registration not needed (DSH measures live); the title/compaction internal agents may receive the root banner (to be observed on a live machine)

### 8.8 Phase 5 Completion Status (Release-Ready, Unpublished)

- [x] `npm pack --dry-run` audit: **32 files / 97.2 kB / zero node_modules** (files precisely enumerated, excluding skill-local dependencies; `.npmignore` proven ineffective against the files whitelist and removed)
- [x] Redaction scan: clean (only public GitHub URLs; docs/ does not ship with the package)
- [x] README.md (English) + README.zh.md (Chinese) rewritten
- [x] docs/release-checklist.md: the release-day procedure + known boundaries
- [x] validate.mjs files check synced with the files enumeration
- [ ] `npm publish`: **deferred at the user's request**, awaiting an explicit instruction

### 8.9 Live-Machine Integration Notes (2026-10-01, Local Desktop Profile)

1. **link-mode dev dependencies**: for a link:-installed package, its dependencies must be installed in **the repository's own** node_modules (Node resolves by real path) — one `npm install` fixes it (the root cause of the `failed to import` error on first install). Official npm installs do not hit this (dependencies land in the profile's node_modules).
2. **The compaction root-injection trap**: the compaction service exists only inside each preset's per-agent isolated group with `isolate: {compaction: true}`; the root composition has none — a root-level plugin's `inject: ['compaction']` stays pending forever. Fixed: inject removed; `host/context-watch.js`'s `compactionOf(agent)` resolves via `agent.ctx` (the preset-composition scope) and falls back to the plugin ctx.
3. **Module-generation cache**: a running Host keeps a module-generation cache for package code replacement (stated explicitly in the plugin-manager README), so still seeing the old error after a reinstall following a code change is expected — the new generation loads only after **fully quitting and reopening DSH Desktop**; the client module table's package.json metadata cache likewise lasts only until the process restarts.
4. **Probe verification method**: a subagent probe quoting its own system prompt determines whether the injection layer took effect (root-level sections such as the DSH checkout note reach subagents; ours not arriving ⇒ the plugin is pending, consistent with item 3). After a restart, expect: the `[SWITCHMAN:LANG]` one-time ask guidance + the `[SWITCHMAN:WATERMARK] level=ok` line + the doctrine section returning.
5. **Tarball recognition**: the `npm pack` artifact is 98KB; `plugin_manager` list_bundles correctly shows dsh-switchman 1.3.0 (4 preset overrides + the host line + rows).
6. **Marketplace confirmation**: the user's dsh-market = `dshmarket` v1.66.7 (the DSH visual plugin marketplace, installed locally); its listing format is exactly an npm package + description/icon, fully aligned with this package's marketplace hardening.

### 8.10 Root-Cause Fix: The Restricted Client Runtime (2026-10-01 — the Real Reason the Config Page Never Appeared)

- **Symptom**: after the restart, the badge, settings.section, and plugins.bundle.config all failed to appear; the Slots keyDomain showed the `dsh-switchman` key was never registered.
- **Root cause**: the service-level `inject` exported by the client.js module included `remote`/`remote.session`/`configForms` — these belong to **the context of the Web app's internal plugins** and are not part of the service catalog available to dynamic client modules (the measured catalog holds only layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces). The browser-side vendored loader **waits silently forever** for missing services (isomorphic to the host-side compaction pending). For comparison: skill-explorer injects `['slots','locale','layout']` and dshmarket injects `['slots','locale','theme']`, all ⊆ the catalog.
- **Communication-channel fix**: the restricted runtime has no direct network (fetch sits on the deny list in dsh-cordis-client-runner: `network belongs to the HOST half`); boot-graph clients (packages declaring `dsh.client`) follow the skill-explorer pattern — **the Host half registers `/api/<pkg>/*` routes via `ctx.webServer.register({kind:'exact',path,handler})` (a loopback + same-origin trust fence), and the client fetches document-relative** (no leading slash, base href).
- **Implemented**: added `host/routes.js` (GET/POST `/api/dsh-switchman/config` with an expected-value optimistic-concurrency fence (409 returns the new value); `/models` via `sessionController.modelCatalog()` falling back to `llm.listProviders()`; `/health`); index.js inject += `webServer`; client.js: the module inject shrunk to `['slots','locale']`, all configForms/remote/whileServed usage deleted, the page state layer switched to fetch loading + 409-conflict adoption, the catalog rerouted through the routes, and settings.section plus plugins.bundle.config **registered unconditionally**.
- **Verification method**: after a restart, check whether `dsh-switchman` appears under the `plugins.bundle.config` keyDomain in the Slots catalog; save inside the page, reopen the settings page, and confirm the values persist.

### 8.11 Integration Wrap-Up (2026-10-01, Save-Loop Fix)

- **Empty candidates**: sessionController.modelCatalog's model entries have fields `{id, name}`, while the client's indexCatalog looks for `model.model` — every entry was skipped. Fixed to the dual-shape compatibility `model.model ?? model.id` (client.js indexCatalog).
- **Save reported "this deployment did not accept these values"**: `ctx.settings.update` looks the ns up by **the loaded entry id** (dsh-settings write(): `entry.options.id === ns`), i.e. cordis.patch.yml's `- id: dsh-switchman-host`, not the plugin's `name` export. routes.js and lang.js were both repointed at `dsh-switchman-host` in sync (the latter had been silently failing all along, so language capture had never actually persisted).
- **Verification loop closed**: POST /api/dsh-switchman/config writes succeed; GET reads back identical values; writes land in the profile patch layer's `dsh-switchman-host` line config (persistent across restarts); values confirmed persisting via the user's GUI save/reopen.
- Lesson distilled — **three iron rules of the restricted client runtime**: (1) a module's inject may only list keys inside the browser service catalog; (2) all networking goes through Host-half webServer routes + same-origin fetch; (3) the settings-write namespace = the loaded entry id (the patch-line id), not the plugin name.
