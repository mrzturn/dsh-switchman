# Compaction arbitration — option A (`auto: false` on compaction-basic)

Status: implemented. Evidence base: installed DSH 0.2.1-rc.5 (fresh asar extraction at /tmp/dsh-src, byte-identical to the installed app.asar copy of dsh-compaction-basic).

## Conflict being arbitrated

dsh-switchman's context-trim engine (`host/context-trim/`) is the single semantic trimmer: it folds the llm/stream VIEW at the request boundary with cache-frontier preservation (`host/context-trim/index.js:265-271`) and folds at the idle boundary (`agent/status` hook `host/context-trim/index.js:416-427` → `maybeFold` :327-360; tiers growth/pressure/emergency :200-207; mechanical emergency fallback :305-307).

The DSH host ships its own AUTOMATIC compaction: `@deepseek-ai/dsh-compaction-basic` registers two listeners in `_registerAutomaticCompaction` (`dsh-compaction-basic/lib/index.js:834-888`):

- `agent/pre-step` → pressure compaction when the token threshold is crossed;
- `agent/request-error` (`CONTEXT_WINDOW_EXCEEDED`) → overflow-recovery compaction + `{ kind: "retry" }`.

Both rewrite the STORED surface via LLM summarization. If they ran on top of context-trim: double summarization of the same history, cache-frontier destruction (compaction rewrites mid-history while trim preserves a frontier), and two independent threshold regimes fighting over one context.

## Decision

Disable ONLY the automatic triggers via the engine's first-class `auto` config key; keep the compaction SERVICE mounted. Evidence (dsh 0.2.1-rc.5):

- `dsh-compaction-basic/lib/index.js:824-828` — `if (this.config.auto) this._registerAutomaticCompaction();` → `auto: false` skips ONLY listener registration.
- `resolveConfig` :85 — `auto: config.auto ?? true` (default true; z.boolean() validation :62 rejects non-boolean).
- `compactNow` :985-1011 (the manual path) never consults `this.config.auto` — `/compact` keeps working with `auto: false`.
- `dsh-command-compact/lib/index.js` — the `/compact` command handler calls `ctx.compaction.compactNow(...)`; unaffected.
- `host/context-watch.js:392-415` — the handover flow borrows the per-agent `/compact` command via `ctx.commands.find(agent, "compact")` (header L22-44) and invokes it with a fresh signal. Manual path preserved ⇒ handover path preserved.

## Why config, not runtime code

No runtime API path exists:

- The compaction engine is constructed inside each per-agent isolated group (`isolate: { compaction: true }`); a root plugin cannot reach or veto that composition (the reason `host/context-watch.js` borrows the command instead of the service).
- `agent/pre-step` is a shared waterfall: blocking `next()` breaks the turn loop; there is no selective cross-plugin listener veto, and listener order across plugins is uncontrollable.

Transport: the repo's existing declarative preset-patch mechanism, `cordis.patch.yml` (loader overrides of the four shipped web presets — not asar/binary surgery). A loader override replaces the target row's `config` wholesale; the shipped compaction-basic rows carry NO config block, so adding exactly `config: { auto: false }` is the minimal well-formed override.

## Change

All four presets (standard / ptc / minimal / cordis) in `cordis.patch.yml`: the `compaction-basic` row gains `config: { auto: false }` plus an explanatory comment. Nothing else changes: `command-compact` untouched, `tool-result-pruner` untouched, compaction groups stay isolated and mounted (`isolate.compaction: true`).

## Side effects, assessed

1. **tool-result-pruner goes dormant.** `pruneSession` is called ONLY inside `compactIfNeeded` (`dsh-compaction-basic/lib/index.js:914-961`) as a pre-compaction shrink optimization; `compactNow` never calls it (manual `/compact` never pruned tool results even before this change). It only ever ran immediately before the wholesale summarization now disabled. The pruner service stays mounted and harmless; its config rows remain for future re-enable.
2. **Overflow recovery moves to trim.** With `auto: false` the official `CONTEXT_WINDOW_EXCEEDED` retry listener no longer registers. The failed turn surfaces its error; at the idle boundary context-trim's emergency tier (`viewTokens ≥ 95%` window) mechanically folds the view so the NEXT attempt fits (`host/context-trim/index.js:305-307, :200-207`). Residual risk: the in-flight attempt is lost once (view folds apply on the next request). This is one visible interruption per overflow — the price of single-trimmer arbitration.
3. **Stored surface growth.** Trim folds the view; stored history keeps growing until a manual `/compact` or a context-watch handover. Intended semantics: machine-driven summarization happens only at the idle boundary by trim, or explicitly by the user / handover.

## Guards and fragility

- `scripts/validate.mjs` — `neutralizeAutoOff` asserts every compaction-basic row's config is EXACTLY `{ auto: false }` (an extra key or a truthy `auto` fails loudly), then strips it before the verbatim shipped comparison — no deviation allowlist was added to the field-by-field check.
- **Drift guard** (`scripts/validate.mjs` + `scripts/test/compaction-arbitration.test.mjs`): reads the INSTALLED engine source (app tree, else app.asar) and asserts `if (this.config.auto)` and `auto: config.auto ?? true` still exist. A DSH upgrade that renames or re-shapes the gate turns the silent re-enable (unknown config keys are ignored; the default is true) into a loud validation failure instead of a live-session surprise.
- Scope: the patch covers the four shipped presets only; a custom preset in the profile patch layer keeps the shipped `auto: true` — the same scope limit as the doctrine suffix itself. Web preset editor edits land in the profile patch layer, which wins over this bundle (documented in the `cordis.patch.yml` header); a user-side row edit can re-enable auto compaction and is out of scope for arbitration defaults.
- After a DSH upgrade: re-sync `cordis.patch.yml` from the new preset files (existing repo doctrine) — `validate.mjs` will fail loudly on any drift, including the compaction arbitration.

## Verification

- `node --test scripts/test/*.test.mjs` — new `compaction-arbitration.test.mjs` (patch shape, manual-path preservation, handover borrow, installed-engine drift guard).
- `node scripts/validate.mjs` — arbitration-aware verbatim comparison + engine drift guard.
- `node --check` on touched files.
