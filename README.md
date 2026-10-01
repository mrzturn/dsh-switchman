# dsh-switchman

English | [简体中文](./README.zh.md)

> One bundle, four presets, autonomous teams — plus language preferences, dispatch pools with model ranking, and context watermark control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

## What it is

**dsh-switchman** extends the four shipped DSH presets (`standard` / `ptc` / `minimal` / `cordis`) with:

1. **Autonomous Agent Teams doctrine** — the shipped conservative team policy ("only create teammates when the user asks") is replaced by a self-directed dispatching regime: the Lead judges every task against four trigger conditions (parallelizable subtasks, large self-contained chunks, high main-context pressure, role separation) and spawns, coordinates, and collects results on its own. User overrides ("don't use teams") always win.
2. **Language preferences** — a `[SWITCHMAN:LANG]` protocol line in every system prompt pins the language for replies, code comments, and authored documents. Unconfigured projects get one gentle ask (via `ask_user_question`); answers are captured and persisted automatically. Bundled skills follow the same preference.
3. **Dispatch pools & model ranking** — configure which models serve six cognitive lanes (economy / mechanical / main / hard / vision / review) in the Switchman settings page, and rank models strongest-first. A `[SWITCHMAN:POOLS]` recommendation table guides every delegation; an optional `enforce` mode denies `subagent` calls naming models outside the pools. Bundled capability snapshot (179 models) pre-ranks candidates.
4. **Context watermark control** — a `[SWITCHMAN:WATERMARK]` banner tracks live context against soft/hard/force thresholds: soft advises delegation, hard caps the per-turn read budget and nudges wrap-up, force triggers an automatic backup-and-compact handover through DSH's compaction service. Every subagent gets its own hard cap and a HANDOFF-block wrap-up. `/ctx-pause`, `/ctx-resume`, `/ctx-handover` give manual control.

Three bundled skills ship with every install: `db-query` (read-only MySQL/Redis verification), `git-commit-message`, `requirement-docs`.

## Install

From an agent session, or the Web UI's plugin manager:

```
plugin_manager: install_bundle  target=dsh-switchman
```

or install from a local checkout (linked; re-run `remove_bundle` + `install_bundle` after pulling changes):

```
plugin_manager: install_bundle  target=/path/to/dsh-switchman
```

**db-query one-time setup** (its script dependencies live inside the skill directory):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

After any install or update, fully restart DSH (quit the app, not just reload the page) so the client-module table picks up the bundle.

## The Switchman settings page

Settings → **dsh-switchman** (its own section, localized zh/en):

- **Language** — conversation / comments / docs languages, with a suggestion from your UI language.
- **Dispatch pools** — per-lane candidate checklists (fed by the live model catalog, including saved-but-currently-unavailable routes), a rank editor (order = priority, optional S/A/B/C tier anchoring), enforce mode (`off` / `advice` / `enforce`), and a setup progress line.
- **Context watermark** — soft/hard/force thresholds (strictly increasing), per-call read budget, `cap` vs `deny` enforcement, auto-handover toggle, and per-subagent caps.

## How it works

- The Host half (`index.js` + `host/`) contributes three dynamic system-prompt sections (orders 10300/10400/10500, after the persona suffix), a `tools/pre|post-execute` pair for read-budget and enforce gates, automatic answer capture, and three slash commands. All settings are live `volatile` fields — changes apply to the next prompt assembly without a restart.
- The Client half (`client.js`) renders the ⚡ badge beside the preset chip and the settings page, through official settings-form services with revision-fenced saves.
- The preset overrides in `cordis.patch.yml` restate each shipped preset's plugin list verbatim and only extend the persona suffix (shared YAML anchor). The Agent Teams tools themselves still come from the shipped `@deepseek-ai/dsh-experimental-agent-team-profile`.

## Verify

- ⚡ badge beside the preset chip in any session header.
- Ask the model: "what does the last section of your system prompt say?" — it should mention the dsh-switchman doctrine.
- The `[SWITCHMAN:...]` lines appear in behavior: language answers stick, pool recommendations shape delegation, and long sessions show watermark levels.
- `node scripts/validate.mjs` — patch integrity, market surface, skills, locale meta.

## Maintenance

- **After a DSH upgrade** that changes shipped preset plugin lists, re-sync `cordis.patch.yml` from the new `presets/*.patch.yml` (keep the doctrine suffix), then reinstall.
- Model-facing protocol lines (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) are deliberately English and byte-stable — do not localize them.
- `npm pack --dry-run` must stay at the audited 32-file / ~97 kB shape (skill `node_modules` never ships).

## License

MIT
