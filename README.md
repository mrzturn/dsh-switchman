# dsh-switchman

**English** | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **The switchman family**, same author, same dispatch doctrine: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (the OpenCode original) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (the ZCode port) · **dsh-switchman** (this repo, the DeepSeek Harness edition).

![dsh-switchman — the context watermark throws the switches and drops each task into the right lane](docs/assets/hero.svg)

> A water meter on the context; every task finds its own lane.

## Why you need it

Two pains creep in once you've worked in DSH for a while. First, sessions get heavier the longer they run: history bloats the context into hundreds of thousands of tokens, the model starts forgetting, slowing down, costing more — and a manual /compact loses detail. Second, the main model does everything itself: chasing files, running tests, reconciling data — most of that work belongs on a cheaper model.

dsh-switchman is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Once installed, the main model stops doing and starts dispatching: measure the watermark, pick a lane, hand out tasks, check acceptance. It's not a new model — it's a dispatch doctrine hooked onto DSH plus a settings page, and it does eight things:

**1. Context watermark: long sessions don't blow up.** Every turn counts session tokens in real time, and three escalating lines tighten the screws: 80k (soft, adjustable) nudges "time to delegate"; 95k (hard) shrinks the single-read budget and steers toward wrap-up; 150k (force) hands over automatically — writes the handover document (the append-only session log is the full-fidelity backup), compacts the context, wakes the session to continue, task unbroken. Background subagents still running at handover aren't lost either: their ids, tasks, and report paths go into the handover document, so the resumed session knows where to collect reports and never dispatches twice. Every subagent carries its own hard cap and exits after writing its HANDOFF summary. When the automatic intervention doesn't suit you, take over manually: `/ctx-pause` stops all watermark actions (measurement keeps running, the live watermark line switches to paused — it just stops acting), `/ctx-resume` restores them at any time — after a DSH restart the enforcement also comes back on its own, a temporary let-go, not a permanent off; `/ctx-handover` doesn't wait for the watermark to hit the ceiling and starts the same handover on demand: write the handover document, compact the context, wake the continuation (the session is first steered to an idle boundary, so the result can take a few minutes).

**2. Six dispatch pools: the right model for every job.** Economy (batch small chores), mechanical (template rewrites), main (day-to-day coding), hard (hard reasoning and large refactors), vision (images), review (independent verification). On the settings page you tick candidates, order priorities, grade S/A/B/C, and pin a per-route thinking effort — the effort dropdown lists the levels that model actually supports, not a generic three. Every turn's prompt carries a `[SWITCHMAN:POOLS]` recommendation table, and the main model dispatches by it. Three enforcement modes: off / advice / force (force = out-of-pool models get rejected outright).

**3. Agent Teams mode: from solo to a team.** Off by default — after install it's lightweight subagent dispatch. Two independent toggles on the settings page:

- **Agent teams** — once on, the team doctrine is injected (delegate by default + tiered verification + shared task-board discipline) and DSH's Agent Teams is enabled automatically: the main model can pull standing teammates (`spawn_teammate`), put work on a shared task board (`team_task_*`), and message teammates. When to form a team follows clear discipline: parallelizable independent subtasks, bulky self-contained work, high main-context watermark, need for role separation; one-off single-point investigations still go to a subagent. Turn the toggle off and the team clauses vanish without residue, and team tools are never yanked from sessions still running.
- **Subagent model whitelist sync** — DSH keeps an authorization whitelist "allow agents to pick models for subagents": routes chosen in a pool but not authorized get rejected when dispatched by name (marked ⚠ in teams mode). Flip this toggle and the union of all six pools is written into that whitelist wholesale — switchman becomes the single source of truth, no double configuration. The whitelist takes effect as a per-new-session snapshot; the sync only affects sessions started afterwards.

The session header gives at-a-glance feedback: the ⚡ "autonomous team" badge and ◇ with the session's actual model; while an auto-handover runs, a live indicator shows "handover in progress · writing handover doc / compacting context / waking the successor".

**4. Language preferences: ask once, remember forever.** One dropdown each for replies, code comments, and documents; scope is global or per-project (`.switchman/lang.json`). Skipping is fine — on first use you're asked once in your DSH interface language, and every session obeys the answer afterwards.

**5. Interface language: the plugin itself speaks your language.** In the "Interface" section atop the settings page sits the "Interface language" dropdown (setting key `uiLocale`): Auto (default, follows the DeepSeek Harness app language), or any built-in interface language picked by hand — options always appear under the language's own endonym, never translated. It switches only the plugin's own interface (badge, home panel, settings page), never the DSH app language: selecting previews live with no restart, the choice is remembered after save and restored on the next launch, and any failure falls back to the app language; the dictionaries ship inline in the plugin bundle, nothing to download.

**6. Tiered verification: every change gets checked.** Changes over 20 lines go to a tester; over 300 lines, or touching core / security / data-consistency logic, additionally to an independent reviewer. The review model is picked anchored on the model of "the agent that wrote the diff", avoiding it where possible; when the pool can't, the conclusion declares DOWNGRADED. Say "don't use the team" once and it drops back to solo instantly.

**7. `/vision`: text-only models can still handle images.** When the main model can't read images, DSH rejects image-bearing messages at the gate. Paste the image, type `/vision what's wrong with this image`, and the image goes to a vision-pool model; the verdict comes back into the current session. A heads-up "current model can't read images" appears above the input box; when a direct image send is rejected, the message is rewritten as `/vision` and resent automatically — no manual redo; with no vision pool configured the command refuses and points to the settings.

**8. Intent routing: the right model picks itself.** A new "Intent Routing" group on the settings page: a master switch (off by default — enabling requires a classifier and at least one candidate), the classifier's small-model route (provider + model + optional effort — TypeSafe Jev-style decision models and general chat models both work, with tolerant output parsing), a classifier type three-way choice (auto / decision / chat), an independent candidate list (each candidate: provider + model + optional effort + a one-line capability note), cache window seconds (default 300, aligned to the ~5-minute prompt caches vendors provide), a switch confidence threshold (default 80), a classification timeout (default 60000 ms), history message count (default 6) and character budget (default 2400), plus an optional fallback model. The model picker gains an "Auto" entry under the "Auto · Switchman" group (the client renders it localized — "Auto (intent routing)" in English); once selected, every user message is classified to pick the best-fitting candidate and the decision is locked for that turn: when confidence is lacking or the cache window is still open, the current model stays (its cache keeps being reused); switching happens only when confidence is high enough or the current model isn't among the candidates. The switch completes silently at the call layer — no "model switched" message is inserted into the session. A status chip sits above the input box (during auto routing it shows the current routed model and the last decision's confidence); candidates and thresholds can always be checked on the settings page.

Worth installing even with a single model — watermark control and tiered verification don't care how many models you have, and long single-model sessions benefit just the same.

## Bundled skills

- **db-query** — read-only MySQL / Redis verification: run SQL to reconcile data, inspect cache keys / TTL, cross-database consistency checks; every write refused. Needs one-time initialization before first use (see below).
- **git-commit-message** — generates disciplined commit messages; text only, never runs git for you.
- **requirement-docs** — the house standard for requirement analysis / PRD / design docs; output is archived to `docs/requirements-and-design/`.

## Quick start

1. **Install** — have an agent run it in any session, or use the Web plugin management page:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   Or install from a local checkout (link mode; after an update, `remove_bundle` + `install_bundle` again):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   Or with the `dsh` CLI in a terminal — pick the profile matching how you run it:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # desktop app
   ```

2. **Restart DSH** — quit the app completely and reopen it (a page refresh doesn't count); only then does the client module table recognize the bundle.

3. **Configure** — Settings → dsh-switchman, or "Switchman Dispatch Center" in the home sidebar. It's a single page of config and looks like this — walk it top to bottom and you're done:

   ![The dsh-switchman settings page in full: interface language, language preferences, six dispatch pools, capability ranking and enforcement mode, team toggles, context watermark and commands](docs/assets/conf-interface-en.png)

   - **Interface** — the plugin's own UI language. The dropdown in the shot sits at English — a live preview of switching; the shipped default is Auto (follows the DSH app language). Picking a language flips the whole page on the spot and is remembered after save; switch back to Auto anytime.
   - **Languages** — the languages of agent output. The scope in the shot is "Global (this profile)" (per-project works too, each reading `.switchman/lang.json`); the reply / code comments / documents dropdowns in the shot all sit at English, each displayed as "endonym (tag)" — e.g. "English (en)" — with a "current: …" status line beneath each. Leaving all three unset is fine too: asked once on first use, remembered from then on.
   - **Dispatch pools** — six cards in two rows of three: economy, mechanical, main on top; hard, vision, review below. Tick candidate models grouped by provider; tick "manual order" and a card becomes a numbered priority list reorderable with ↑ ↓ ×; every route can pin a thinking effort (default "follow lane"). The summary line at the top updates live — in the shot: "4/6 pools configured · 2 ranked · mode advice".
   - **Capability ranking + enforcement mode** — the union of selected models across the six pools, ranked by capability, strongest first (the shot anchors glm-5.3 at S and glm-5.3-flash at A), reorderable and removable; enforcement mode advice / force (force = out-of-pool models rejected outright).
   - **Agent teams** — the two toggles for team mode and whitelist sync, both off by default; in the shot they're on, with a sync status line beneath the toggle.
   - **Context watermark** — the three thresholds (80000 / 120000 / 150000 in the shot), the single-read budget (3000), hard-tier behavior (throttle-pass / block), the auto-handover toggle, and subagent independent caps all live here. Bottom command row: `/ctx-pause` pause intervention · `/ctx-resume` resume · `/ctx-handover` write the handover doc and compact now (it steers the session to an idle boundary before compacting — the result can take a few minutes).
   - **Intent Routing** — the master switch, the classifier's small-model route, the classifier type (auto / decision / chat), the independent candidate list (each with a one-line capability note), cache window / confidence threshold / classification timeout / history budget, and an optional fallback model. Once enabled, the model picker gains the localized "Auto (intent routing)" entry, and a status chip above the input box shows the routed model and confidence.

4. **Verify** — the ⚡ "autonomous team" badge appears in the session header (with ◇ beside it showing the session's current model); or simply ask the model "what's the heading of the last section of your system prompt" — the answer should mention the dsh-switchman doctrine.

**db-query one-time initialization** (script dependencies install inside the skill directory, nothing pollutes your project):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

**Classifier model tips:** to run the decision model locally, serve `d3:4b-mxfp8` with Ollama — set the classifier kind to the decision endpoint (systemone), fill the endpoint with `http://127.0.0.1:11434/v1/systemone`, and set the model name to `d3:4b-mxfp8`. For the chat classifier from the LLM catalog, prefer a small cloud model, or a small local model without thinking (reasoning) — turning thinking off lowers both latency and the classification-timeout failure rate.

## Default configuration

Everything below is the full set of defaults after a fresh install (authoritative source: the zod schema in `host/config.js`).

**Interface and languages**: `uiLocale` = `auto` (follows the DSH app language); `langScope` = `global`; `langConversation/Comments/Docs` = empty (asked once in the first session and then remembered; the comment and document languages follow the conversation language).

**Dispatch pools**: all six lanes (economy/mechanical/main/hard/vision/review) start with empty candidates (= the system default models, no intervention); manual ordering and pinned effort are off/empty; `dispatchEnforce` = `advice` (advisory only, nothing enforced).

**Context watermark**: soft `80000` / hard `95000` / force `150000` tokens; single-read budget `3000`; over-budget behavior `cap` (truncate with a warning); `wmAutoHandover` = on (at force, automatic handover: write doc + compact); the subagent hard cap = on (sharing 150k).

**Agent Teams**: `teamsMode` = off; `syncWhitelist` = off (the two toggles are independent of each other).

**Intent routing** (unavailable by default; needs a classifier + at least one candidate + the master switch on): `intentEnabled` = off (while off, the Auto entry stays hidden and sessions already on Auto fall through the fallback chain); the classifier route is unset; the classifier type is `chat`; the candidate list is empty (the preset categories join routing only once given a model); cache window `300` s / switch confidence threshold `80` / classification timeout `60000` ms; history `6` messages / `2400` characters; `intentContextWindow` = `200000`.

**Context trim**: `trimEnabled` = on; `trimMode` = `auto` (fully automatic); growth gate `22500` tokens + increment `50000` tokens; pressure `60%` / emergency `95%`; protected tail `6` messages; fold cadence cap `6` per hour; side model unset (inherits the session model); **ladder folding on** — T2 distills accumulated T1 summaries (8000-token mass, ≥3 blocks), T3 distills T2 (6000-token mass, ≥2 blocks); the engine never shows the model a water level, percentage, or progress number — details in the "Automatic context trim" section below and [docs/ladder-fold.md](./docs/ladder-fold.md).

**Out-of-the-box notes**: ① intent routing being unavailable out of the box is by design — three steps to switch it on (classifier, candidates, the master switch); ② Auto's effective window is 200000 out of the box — the guardrail guarantees 0.8×window ≥ force (150000), so the core compaction line (160000) always sits after the smooth-handover line (150000); ③ the most tangible out-of-the-box effect is the watermark trio: 80k nudges delegation / 95k tightens reading / 150k backs up and hands over automatically — no configuration needed.

## Automatic context trim

Long sessions stay cheap: consumed conversation ranges are folded into compact deterministic summaries — fully automatically, without breaking the provider prompt cache. At an idle boundary the trim engine (`host/context-trim/`) picks the ranges worth folding, a side model writes the summary (only under emergency pressure does a mechanical fold run instead — no side-model call), and the fold is committed to the session's fold state. From then on every outbound request is rebuilt from that state — summary blocks replace the folded ranges, the live tail stays untouched. The stored session is never rewritten, and nothing ever happens mid-stream.

Automation levels (`trimMode`):

- **`off`** — measure only: usage and cache-hit sampling still runs; no banner, no folds.
- **`advisory`** — the session model folds itself: the `ctx_trim_fold` and `ctx_trim_status` tools plus the protocol head are exposed for it.
- **`auto`** (default) — everything above plus automatic folds at the idle boundary, in three tiers: a growth gate (growth > `trimGrowthTokens` measured from the last fold's post-fold low — the anchor that keeps the gate armed after folds committing at high view points — AND a contiguous compressible increment ≥ `trimIncrementTokens`; the increment floor is what actually binds), a pressure tier (`trimPressurePercent` of the context window), and an emergency tier (`trimEmergencyPercent` — a mechanical fold with its own cooldown). Pressure and emergency usage is measured on `max(view, wire)`, i.e. on the real provider prompt when it is known.

All keys live in Settings → dsh-switchman; defaults from `host/config.js`:

| Key | Default | Meaning |
| --- | --- | --- |
| `trimEnabled` | `true` | Master switch. OFF disables folding and metrics entirely (the listener degrades to a pure pass-through). |
| `trimMode` | `auto` | `off` measure only / `advisory` model-driven folds / `auto` system-driven folds. |
| `trimGrowthTokens` | `22500` | Growth gate: fold when the outbound view grew this much since the last fold. |
| `trimIncrementTokens` | `50000` | Gate companion: the contiguous compressible increment must also reach this size. |
| `trimPressurePercent` | `60` | Pressure tier: fold when view usage reaches this percent of the context window. |
| `trimEmergencyPercent` | `95` | Emergency tier: forced mechanical fold (no side-model call) at this percent. |
| `trimWindowTokens` | `0` | Effective-window cap for tier math: tiers are computed against min(model window, cap). `0` = follow `wmForceTokens`. |
| `trimProtectedTail` | `6` | The last N messages are never folded. |
| `trimMaxFoldsPerHour` | `6` | Side-model fold cadence cap per rolling hour (emergency folds are exempt). |
| `trimSideModel` | unset | Route for the summary side model. Empty = inherit the session's current model. |
| `trimStateDir` | unset | Fold-state directory override. Empty = `<dshHome>/.dsh-switchman/state/trim/`. |
| `surfaceFold` | `true` | Ship committed folds onto the session surface (shadow-price + `surfaceOp` replace event pair). OFF keeps the splice-only view. |

**Trigger paths.** Tier checks run at the idle boundary and, as a fallback for hosts where idle status events are unreachable, after each model-stream completion (throttled to one evaluation per 60 s per session). Every decision — folds and no-ops alike — is appended as one timestamped `key=value` line to `decisions.log` in the trim state directory (see `trimStateDir`), giving folds an offline audit trail; the row vocabulary (`view-applied`, fold decision/outcome rows, `surface-replace`, `surface-replace skipped reason=…`) is catalogued in [docs/context-trim.md](./docs/context-trim.md).

**Wire truth and steady state.** Decision rows carry `view=<n>` and, once a response has landed, `wire=<n>` — the real provider prompt (uncached input + cache read + cache write, sampled from the stream's usage event). The view estimate counts the messages array only and always reads smaller than the wire by the fixed overhead (measured ≈ 17.3k: system prompt + tool schemas + persona), so pressure and emergency tiers evaluate on `max(view, wire)`, and only `wire` is a prompt-size reading. On a 150k window the healthy sawtooth runs wire ≈ 40k just after a fold ↔ 88–90k at the next one (≈27%–60% of the window), one fold per ~50k of raw growth, with the ceiling pinned near 90k by the pressure tier rather than by the window. If `view` climbs while no `surface-replace` row ever appears, read the skip rows (`incomplete-seqs`, `no-service`, `compaction-lock`).

**Host-compaction epochs.** Fold refs are anchored in message ids and content hashes, so a host-side compaction that replaces the re-send history ages the whole ledger out at once: no block locates, the view silently falls back to raw history (fail-open — the decision log records `view-applied applied=0`), and the plugin re-anchors its growth baseline at the post-compaction view on the next request. The host compaction is thus the backstop trim layer, and plugin folds do the fine-grained work within one host epoch. Some dispatches hand out fully frozen request arrays or option objects (the current agent loop deep-freezes assembled requests); for those `injectView` reports the outcome in the decision log: `nothing-to-apply` (no located fold blocks — raw history IS the view), `in-place`/`swapped` (the fold view shipped), or `none` (a fold existed but the frozen dispatch could not carry it — the wire ships raw history). **Surface replace is the shipping path when available** (`surfaceFold`, default on): at the serial `agent/turn-stopping` boundary plus an idle sweep, the plugin appends the host-style shadow-price metering event and ONE `user/message` replacement carrying `surfaceOp {op:'replace', startSeq, endSeq}` with `sourceEventSeqs` covering every shadowed surface node — the same mechanism the host's own compaction uses — so a committed fold reaches the wire from the source level, frozen dispatches included. While a session's recent dispatches log `none`, the view is meter-only: the watermark measures the provider-reported tally instead (so the force tier and the auto-handover keep working). Folding pauses only when the surface channel is unusable as well — a durable capability probe (live session exposing `append`/`surface.nodes`, no open compaction lock), never a recency window, so a restart no longer freezes the engine. The banner marks the line with `wire=raw` only when no fold block has ever shipped a surface replacement, so a session with a shipped block stays quiet across restarts; hosts without the surface mechanism (or with the flag off) keep exactly the legacy behavior.

**How folds preserve cache hits.** Every fold re-pays the prefix once; the goal is amortized cost, not a perfect hit rate. The engine enforces the cache contract: folds are append-only — the frontier only moves forward and the frozen zone is never edited again; the view is rebuilt deterministically from (history, fold state), so the serialized prefix stays byte-identical between folds and the provider cache keeps hitting; fold boundaries never split an assistant tool-call from its tool result; the last `trimProtectedTail` messages are exempt; and everything fails open — an internal error degrades to a pass-through, never a broken request.

**Compaction arbitration.** Two automatic trimmers over one history would double-summarize and destroy each other's frontier, so `cordis.patch.yml` sets `auto: false` on the host's `dsh-compaction-basic` rows: context-trim becomes the single semantic trimmer. Manual `/compact` keeps working, and the force-tier handover (which borrows that same manual path) is untouched. Overflow recovery moves to trim: an over-window attempt fails once, then the emergency tier folds the view so the next attempt fits.

**The ladder (v1.11): T1/T2/T3 tiered folding.** Every raw-range fold produces a T1 block. As T1 summaries themselves accumulate (≥8000 tokens of summary mass across ≥3 blocks), the engine distills them into ONE T2 block; T2s condense into a T3 the same way — month-long sessions stop drifting upward, because the folded floor no longer grows with every fold. Consumed blocks deactivate (never deleted), so coverage stays expressible and the ledger stays inspectable. Distillation runs through the same side model, on its own 120 s cadence, mass-gated so it stays rare (each distill rewrites the wire from its anchor onward — the mass gates keep that cost rare on purpose).

**Nothing leaks to the model.** The engine never tells the session model a water level, a fill percentage, a window size, or a growth number — judgment stays rooted in the task (a model told "you're at 20%" anchors on "looks healthy" and refuses to fold). What the model MAY see, on demand, is `ctx_trim_status`: concrete compressible ranges with their true sizes. All metering lives in `decisions.log` and the settings-page badge — human channels.

**Fork inheritance.** A forked session (a subagent fork) inherits the parent's fold state copy-on-fork — but only when the parent state exists and the child's history actually resolves the parent's frontier; otherwise the child starts clean. One inheritance per child, idempotent across restarts.

**The watermark reads the view.** The watermark banner reports the outbound view's token count (what the model actually sees after folding) instead of the stored tally, so a heavily folded session no longer pins the watermark at the hard tier.

## How it works

- The host half (`index.js` + `host/`) injects the byte-stable system-prompt sections (language / lanes / watermark protocol / teams) plus the live watermark line through the tail runtime-context snapshot (a channel that appends instead of rewriting the prompt head, so the provider prompt cache stays intact), the read-budget plus enforce double gate, and four slash commands (the ctx trio + `/vision`). A saved setting takes effect at the very next prompt assembly — no restart.
- The client half (`client.js`) renders the settings page, the ⚡ badge and ◇ model marker in the session header, and the live handover indicator; config snapshots are read and written through the Host route family.
- The "Switchman Dispatch Center" entry in the home sidebar opens that same settings page as a center panel in one click; the original settings entry stays.
- `cordis.patch.yml` keeps the factory preset plugin list fully intact and only extends the persona suffix; the Agent Teams tools themselves come from the factory bundle and switch on automatically with teams mode.

## Maintenance notes

- After a DSH upgrade, if the factory preset plugin list changed, re-sync `cordis.patch.yml` from the new `presets/*.patch.yml` (keeping the doctrine suffix and the compaction arbitration — `auto: false` on the `compaction-basic` rows), then reinstall.
- Protocol lines (`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`) are deliberately English and byte-stable — don't localize them.
- `npm pack --dry-run` should keep the audited 60-file / ~380 kB tarball shape (~1.26 MB unpacked). `docs/` stays out of the package (it is not in `package.json files`), while the 11 `README.*` translations are always shipped by npm.
- **Zero runtime dependencies — a hard invariant.** Host-plane packages (`@deepseek-ai/schemastery`, cordis, …) are declared as `peerDependencies` only, and the running DSH satisfies them from its own copy. An ordinary `dependencies` entry is physically installed into the profile workspace (`<profile>/node_modules/…`), where it shadows the host's copy for every other profile-resident plugin — this is exactly what crashed the dshmarket plugin market while 1.7.0 carried schemastery as a dependency (two schemastery instances in one process; the market's schemas no longer matched the host's). `scripts/validate.mjs` fails if a `dependencies` entry ever reappears, so installing, updating, or removing dsh-switchman can never touch what dshmarket or any other community bundle resolves at runtime.

## Acknowledgments

The tiered folding design (T1/T2/T3) was inspired by [billion-context](https://github.com/ranxianglei/billion-context) — thank you for open-sourcing the idea.

## License

MIT
