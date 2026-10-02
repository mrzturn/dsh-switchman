# dsh-switchman

**English** | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **The switchman family**, same author, same orchestration: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (the OpenCode original) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (the ZCode port) · **dsh-switchman** (this repo, for DeepSeek Harness).

![dsh-switchman — the context water level drives the switchman and throws the route](docs/assets/hero.svg)

> Context on a meter. Tasks dispatch themselves.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Once installed, your primary model stops doing everything itself and becomes a dispatcher: measure the water level, pick the lane, hand out the task, check the work. Four things:

**1. Context water-level control.** Every turn measures live session tokens. Soft (default 50k) advises delegating, hard (90k) tightens the per-turn read budget and nudges wrap-up, force (130k) backs the session up and hands it over to compaction — automatically. Run a session all day; your context never drowns in its own history. Every dispatched subagent carries its own hard cap and exits with a HANDOFF summary when it's reached.

**2. Six-lane dispatch.** economy / mechanical / main / hard / vision / review — six cognitive lanes. Pick candidate models per lane in the settings page, rank them strongest-first (optional S/A/B/C tier anchoring), and pin a reasoning effort per route — the dropdown lists the levels each model *actually* supports, not a generic three. A `[SWITCHMAN:POOLS]` table ships with every prompt so the model knows who to call; `enforce` mode rejects out-of-pool models outright.

**3. Language preferences.** One dropdown each for replies, code comments, and authored docs. Unset? You get asked once, it's remembered forever, and every later session follows it.

**4. Delegate-by-default doctrine.** Replaces DSH's shipped conservative team policy ("only create teammates when asked"): trivia stays hands-on (<200 lines read, <50 changed), real work gets delegated by default; every change gets verified — >20 lines goes to a tester, >300 lines or core logic goes to a reviewer. Say "don't use teams" and it steps aside instantly.

Only one model? Still worth it — water-level control and the doctrine don't care how many models you have.

## Bundled skills

- **db-query** — read-only MySQL/Redis verification: run SQL to check records, cache keys / TTLs, cross-store consistency. Refuses all writes. One-time setup below.
- **git-commit-message** — convention-compliant commit text. Text only; never touches git.
- **requirement-docs** — one spec for requirements / PRD / design docs, archived to `docs/requirements-and-design/`.

## Quick start

1. **Install** — from any agent session, or the Web plugin manager:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   or from a local checkout (linked; re-run `remove_bundle` + `install_bundle` after pulling changes):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   or from a terminal via the `dsh` CLI — pick the profile that matches how you run DSH:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # desktop app
   ```

2. **Restart DSH** — quit the app entirely and reopen (a page reload is not enough) so the client-module table picks up the bundle.

3. **Open the settings page** — Settings → dsh-switchman. The first screen is language preferences: a scope dropdown — profile-wide, or per project (`.switchman/lang.json`) — plus one dropdown each for replies / comments / docs, each with a live `current: …` line. Skip them if you like — you'll be asked once and remembered (asked in your DSH UI language).

   ![Settings page and language preferences](docs/assets/conf-demo1.png)

4. **Fill the six pools** — each pool card lists candidates grouped by provider; tick the ones you want. Tick **manual order** and the card becomes a numbered priority list with ↑ ↓ × controls. The effort dropdown beside each selected route defaults to *follow lane*; pinning it lists the levels that model actually supports (Low / High / Max…). A summary line tracks progress live: “6/6 pools set · 3 ranked · mode advice”.

   ![Dispatch pools](docs/assets/conf-demo2.png)

5. **Ranking and watermark** — the ranking table's order is capability order (strongest first), with optional S/A/B/C tiers; execution mode is `off` / advice / enforce (enforce = out-of-pool models are rejected). Below it, the watermark section tightens behavior by token usage: three thresholds, a per-call read budget, hard-mode behavior (cap / deny), an auto-handover toggle, and a separate cap for subagents. The bottom line carries the commands: `/ctx-pause` to stop intervening · `/ctx-resume` to resume · `/ctx-handover` to back up and hand over now.

   ![Ranking and context watermark](docs/assets/conf-demo3.png)

6. **Verify** — the ⚡ badge appears beside the preset chip in any session header; ask the model “what does the last section of your system prompt say?” — it should mention the dsh-switchman doctrine.

**db-query one-time setup** (script dependencies live inside the skill directory):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## How it works

- The Host half (`index.js` + `host/`) injects three dynamic system-prompt sections, the read-budget and enforce gates, automatic answer capture, and three slash commands. All settings are volatile fields — saved changes apply to the next prompt assembly, no restart.
- The Client half (`client.js`) renders the ⚡ badge beside the preset chip and the settings page, through official settings-form services.
- `cordis.patch.yml` restates each shipped preset's plugin list verbatim and only extends the persona suffix; the Agent Teams tools themselves still come from the shipped `@deepseek-ai/dsh-experimental-agent-team-profile`.

## Maintenance

- After a DSH upgrade that changes shipped preset plugin lists, re-sync `cordis.patch.yml` from the new `presets/*.patch.yml` (keep the doctrine suffix), then reinstall.
- Model-facing protocol lines (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) are deliberately English and byte-stable — do not localize them.
- `npm pack --dry-run` must stay at the audited 43-file / ~138 kB shape (the `docs/` screenshots never ship).

## License

MIT
