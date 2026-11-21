# Cache-safe prompt injection — migrating all session-dynamic content to tail-append channels

> Version: v2.1　　Date: 2026-11-21　　Status: ready for implementation
> Related modules: `host/tail-context.js` (NEW), `host/ptc-guard.js`, `host/constraints.js`, `host/pool-feedback.js`, `host/pool-differentiation.js`, `host/dispatch.js`, `host/teams.js`, `host/lang.js`, `host/context-watch.js` (reference only, do not modify), `host/context-trim/index.js` (interaction only, do not modify), `scripts/test/*.test.mjs`, `CHANGELOG.md`
>
> **Confirmed decisions (2026-11-21, user-approved)**:
> - **Repo-wide cache-stability invariant (§4.1)**: from now on, ALL session-dynamic prompt content must be delivered through tail-append channels. Head system-prompt sections may only contain byte-stable (per-session) text. The ONLY sanctioned full-prefix invalidation events are: trim fold rebuilds (folding is what decides what is kept/folded), user config edits, teamsMode toggle (tool-list change), and host-level events outside this plugin's control.
> - **Migration scope is fixed**: the six volatile head sections S1/S3/S4/S5/S6/S9 (§2.2) move their volatile payload to `ctx.systemPrompt.context` tail snapshots. `switchman:lang` ask-guidance (S2) also migrates (it latches on/off mid-session). `switchman:trim` (S7) and `switchman:watermark` (S8) already comply.
> - **The target mechanism is already proven in-repo**: `host/context-watch.js:570-594` (watermark) uses exactly the head-doctrine + tail-live-line split this doc generalizes.
> - **Behavior-preserving refactor**: no config knobs added, no render wording changed, no module added/removed from `index.js` inject lists beyond mounting the new helper module. On hosts without `systemPrompt.context`, the helper falls back to today's exact section-embedding behavior.
> - **Zero runtime dependencies invariant** (AGENTS.md): pure intra-package ESM imports only.
> - **Quality process** (`cordis.patch.yml` §3): total change 300–450 lines touching core prompt-pipeline semantics → an **independent reviewer** MUST review the complete change set (T9). Every task ships with updated tests and green `npm test` + `node scripts/validate.mjs`.

---

## 0. Background primer (read this first — the fresh session has no other context)

A model provider caches the KV state of the prompt prefix (system prompt + message history). **Any byte change in the head system prompt invalidates the entire cached prefix** — every subsequent turn re-derives full price until a new prefix stabilizes. The DSH host offers two injection channels with opposite cache profiles:

1. **Head sections** — `ctx.systemPrompt.section({ name, order, interpolate: false, text: (context) => string })`. Rendered into the head system message. Part of the cached prefix. Byte-stable text = free; changing text = full-prefix miss **every time it changes**.
2. **Tail runtime context** — `ctx.systemPrompt.context({ name, order, required, interpolate: false, text: (context) => string })`. DSH joins all entries (by `order`) into one snapshot text: `"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n<entry texts in order>"` and **appends it as a NEW user message at the tail only when the joined snapshot text changes** (`surfaceOp: 'append'`). The cached prefix is never touched. When every entry renders empty, DSH appends the one-time CLEARED snapshot `"Current runtime context: none. Earlier runtime-context snapshots no longer apply."`.

Verified against the DSH checkout (`/Users/mrzturn/Documents/code/my/GitHub/deepseek-harness`, and the installed copy at `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`):
- `packages/core/agent-loop/src/runtime-context.ts:21` — CLEARED constant.
- `packages/core/agent-loop/tests/runtime-context.spec.ts:127,143` — `session.append('user/message', <snapshot>, { surfaceOp: 'append' })`.
- `packages/core/system-prompt/tests/system-prompt.spec.ts:145,302` — `renderContextSnapshot` joins entries by order into the single snapshot text.

**Native skill loading is already cache-safe — do not touch it.** The skill catalog is emitted by DSH itself as tail user messages: first publication appended (`packages/skill/tool-skill/src/index.ts:253`), re-published only when the entries digest changes (`:241`, `:247-254`), and a skill's `<skill_content>` block arrives as a tail tool result. The plugin-side skill registry (`host/skill-registry.js`) only feeds catalog entries (tail). **However**, two plugin head sections react to skill/session state and churn the head (constraints skill-match table, pool-feedback load stats) — they are in the migration scope (S4, S5).

**Why fold rebuilds stay exempt**: `host/context-trim/index.js` rewrites history when folding; a one-time full miss is the design cost of folding, and folding is precisely the mechanism that decides what is kept/folded. This is user-ratified policy, not a defect.

## 1. Goal

Make every ordinary session activity (per-turn constraint hits, PTC ledger growth, dispatch statistics, session route, teams hits, skill loads, language ask latch) **byte-invisible to the head system prompt**. After this refactor:

- head section closures produce byte-identical output across all per-turn / per-event variation within one session;
- volatile content flows exclusively through tail channels: runtime-context snapshots (only-on-change appends), post-execute result rewrites, pre-execute argument fixes;
- on hosts lacking `systemPrompt.context`, behavior degrades to exactly today's section-embedding (legacy mode), with one warning per module.

## 2. Current state (evidence-backed; verified 2026-11-21 — do not re-audit, spot-check anchors only)

### 2.1 Section inventory and verdicts

| # | Section | Order | Registration anchor | Volatile source | Verdict |
|---|---|---|---|---|---|
| S1 | `switchman:teams` | 10250 | `host/teams.js:655-677` (closure calls `teamsDoctrineText({constraintsEnabled, hitTags})`, `teams.js:170`) | `hitTags` from `classifierConstraintsForTurn()` per turn; teamsMode toggle | ❌ migrate hits to tail (T6) |
| S2 | `switchman:lang` | 10300 | `host/lang.js:280-301` | ask-guidance appears at session start then latches off (`askedSessions`/`asked`); configured-language block is config-stable | ❌ migrate ask-guidance to tail (T7); keep language block in head |
| S3 | `switchman:dispatch` | 10400 | `host/dispatch.js:588-597` (`applyDispatch` → `renderPoolsBlock(state, sessionRouteOf(context))`, `dispatch.js:521`) | per-turn `session route:` line (`sessionRouteOf` reads `context.modelSelection`, `dispatch.js:501-508`) mixed into config-stable pools table | ❌ migrate route line to tail (T5) |
| S4 | `switchman:constraints` | 10405 (`CONSTRAINTS_ORDER`) | `host/constraints.js:418-450` — whole section is per-turn: `renderConstraintsLine(hits)` (`:216`) + `renderSkillsTable` (`:233`), hits from `deterministicPressureHits` + `classifierConstraintsForTurn` + `skill_match` | ❌ migrate entirely to tail (T3); head keeps one static anchor line |
| S5 | `switchman:pool-feedback` | 10406 | `host/pool-feedback.js:165-186` → `renderPoolFeedbackBlock(skills, stats.entries)` (exported, `pool-feedback.js:96`) | skill-load stats accumulate | ❌ migrate to tail (T4); head anchor line |
| S6 | `switchman:pool-differentiation` | 10407 | `host/pool-differentiation.js:241-255` → `renderPoolDifferentiationBlock(stats.entries)` (exported, `:173`) | dispatch stats accumulate | ❌ migrate to tail (T4); head anchor line |
| S7 | `switchman:trim` | 10450 | `host/context-trim/index.js:1584` | `TRIM_PROTOCOL_TEXT` constant; bytes change only on enable/mode config change | ✅ compliant — keep |
| S8 | `switchman:watermark` | 10500 | `host/context-watch.js:574-594` — head = `PROTOCOL_ROOT_TEXT`/`PROTOCOL_SUB_TEXT` constants; live tier line = context entry order 300 | — | ✅ compliant — **the reference implementation, do not modify** |
| S9 | `switchman:ptc-guard` | 10510 (`PTC_GUARD_ORDER`) | `host/ptc-guard.js:108-120` — `renderPtcGuard()` (static) + `"\n\n" + renderPtcLedgerClause(sessionKeyOf(context?.agent))` (`host/ptc-bindings.js:413`) | ledger grows per successful `run_code` — **worst offender** | ❌ migrate ledger clause to tail (T2) |

### 2.2 Non-section injections (audited — all compliant, out of scope)

- `host/subagent-model.js:144` and `host/edit-feedback.js`: post-execute rewrites of the current tail tool result — bytes fixed once written → safe.
- `host/tool-args-sanitize.js:90`, dispatch pre-execute gates, `host/ptc-bindings.js` runtime self-heal: mutate call arguments only, never enter history → safe.
- `teams.js:684+` `syncChildMessageTool`: tool-list change on teamsMode toggle → sanctioned config-change event.
- `host/intent.js`: no prompt injection → safe.

### 2.3 Reference implementation to copy (watermark dual-channel)

`host/context-watch.js`:
- `:574-578` head section renders only byte-stable protocol text;
- `:583-584` availability check `typeof ctx.systemPrompt?.context !== "function"` → warn once, degrade;
- `:587-594` context entry `{ name: "switchman:watermark", order: 300, required: true, interpolate: false, text: (context) => renderWatermarkContext(ctx, config, state, context?.agent) }` — order 300 sits after DSH core entries (WORKING_DIRECTORY 100 … WEB_SURFACE 210). Context closures receive the same `context` shape as section closures (watermark uses `context?.agent` at `:592` — confirmed working in production sessions).

## 3. Gap table

| # | Gap | Current | Required |
|---|---|---|---|
| D1 | PTC ledger growth busts the whole prefix per `run_code` | ledger clause inside head section S9 | ledger clause as tail context entry; guard rules stay head |
| D2 | constraints section is 100% per-turn bytes | line + skills table in head S4 | per-turn payload as tail entry; head keeps one static anchor line |
| D3 | pool-feedback block churns per skill load | block in head S5 | block as tail entry; head anchor line |
| D4 | pool-differentiation block churns per delegation | block in head S6 | block as tail entry; head anchor line |
| D5 | per-turn session route mixed with config-stable pools table | `renderPoolsBlock(state, sessionRoute)` S3 | pools table stays head; route line becomes tail entry |
| D6 | per-turn teams hitTags mixed with doctrine | `teamsDoctrineText({constraintsEnabled, hitTags})` S1 | doctrine (hitTags: []) stays head; hit-delta fragment becomes tail entry |
| D7 | lang ask-guidance appears then latches off mid-session | guidance in head S2 | guidance becomes tail entry; configured-language block stays head |
| D8 | no shared helper — fallback/availability logic would be duplicated 6× | per-module ad-hoc registration | new `host/tail-context.js` factory used by all six modules |

## 4. Design

### 4.1 Repo-wide cache-stability invariant (add as a comment block in `host/tail-context.js`; enforce in review)

1. Head `systemPrompt.section` closures MUST render byte-stable text within a session. Only user config changes (or the sanctioned toggle events of §0) may alter head bytes.
2. ALL session-dynamic prompt content MUST use one of: (a) `ctx.systemPrompt.context` tail snapshots; (b) post-execute result rewrites; (c) pre-execute argument fixes.
3. Sanctioned full-prefix invalidations: trim fold rebuild (folding decides what is kept/folded), config edits, teamsMode toggle, host-level events.
4. New features introducing head-dynamic content are a review-blocker.
5. **Language policy (repo rule, AGENTS.md 2026-11-21)**: all plugin-facing content is written in **English only** — orchestration, rules, behavior definitions, every injected prompt byte (head doctrine, tail payload, anchor lines), tool deny/fix messages, telemetry markers, code comments, docstrings, and test assertion strings. Exceptions: conversation with the user, and user-facing multilingual Markdown docs (README / CHANGELOG / release notes). This matters for this refactor specifically: anchor lines and payloads are part of the cache prefix and of the model's protocol parsing — they must be byte-stable English.

### 4.2 Shared helper — new `host/tail-context.js` (implements D8)

```js
registerTailContext(ctx, {
  sectionName,     // head slot name, e.g. "switchman:constraints" (UNCHANGED from today)
  sectionOrder,    // head slot order, UNCHANGED (10250/10300/10400/10405/10406/10407/10510)
  contextName,     // new tail slot name, e.g. "switchman:constraints-live"
  contextOrder,    // new tail slot order, from the table in §4.3
  doctrine,        // (context) => string — byte-stable head text (may be an anchor line)
  payload,         // (context) => string — volatile tail text ("" when off/idle)
})
```

Behavior (all try/catch, fail-open, mirroring `context-watch.js:583-594`):
1. If `typeof ctx.systemPrompt?.context !== "function"`: register ONLY the head section with text = `doctrine(context)` + `"\n\n" + payload(context)` when payload non-empty (today's exact legacy shape), and warn once per registration. Skip the context entry. This is the legacy fallback — behavior identical to pre-refactor.
2. Otherwise: register the head section with text = `doctrine(context)` only, AND register the context entry `{ name: contextName, order: contextOrder, required: true, interpolate: false, text: payload }` inside try/catch — if that registration throws, warn and fall back to rule 1's embedding ( unregister-and-reembed is NOT required: DSH section registration is idempotent per name/order; simply register the section with the legacy text shape and log).
3. Both closures wrap bodies in try/catch returning `""` (existing convention, e.g. `teams.js:676-679`).
4. All registrations use `interpolate: false` (repo-wide convention).
5. No `host/config.js` changes. No new settings. `cordis.patch.yml` untouched.

Module docstring of `tail-context.js` must carry the §4.1 invariant text and cite the watermark precedent + DSH evidence paths of §0.

### 4.3 Tail context orders (name / order / payload source)

DSH joins all context entries into ONE snapshot ordered by `order`. Watermark occupies 300 (after core 100–210). New entries:

| Context entry | Order | Payload closure | Module / task |
|---|---|---|---|
| `switchman:ptc-ledger` | 310 | `renderPtcLedgerClause(sessionKeyOf(context?.agent))` — gated by `isPtcScope(ctx, context?.scope)` exactly as today (`ptc-guard.js:111`) | T2 |
| `switchman:constraints-live` | 320 | new exported `renderConstraintsLive(context)` — encapsulates today's S4 closure body verbatim (`constraints.js:423-447`: master switch, skills resolve, `lastUserBySession`/`matchedSkillNames`/`mergeConstraints`, line + table, `logHitsOnce`) | T3 |
| `switchman:pool-feedback-live` | 330 | `renderPoolFeedbackBlock(skills, getSkillLoadStats()?.entries)` with today's master switch (`pool-feedback.js:172-179`) | T4 |
| `switchman:pool-diff-live` | 340 | `renderPoolDifferentiationBlock(stats?.entries)` with today's master switch (`pool-differentiation.js:245-253`) | T4 |
| `switchman:dispatch-route` | 350 | new `renderSessionRouteLine(sessionRoute)` — the route line extracted from `renderPoolsBlock` (`dispatch.js:525-527`); gate: `anyConfigured` && route non-null (preserves today's rendering conditions) | T5 |
| `switchman:teams-hits` | 360 | new `renderTeamsHitsDelta(hitTags)` — the hitTags-dependent fragment of `teamsDoctrineText`, rendered only when hits non-empty | T6 |
| `switchman:lang-ask` | 370 | today's ask-guidance branch of S2 (`lang.js:287-299`: latch checks + `isRoot` + `renderAskGuidance(...)`) | T7 |

### 4.4 Head doctrine after migration

| Module | Head `doctrine` closure |
|---|---|
| ptc-guard | `renderPtcGuard()` unchanged (static rules). Drop the clause concatenation at `ptc-guard.js:116-118`. |
| constraints | One static anchor line, e.g. `"Per-turn constraint hits and the matched-skills table are delivered in the Current runtime context snapshot at the tail of the conversation; treat them as binding for this turn."` |
| pool-feedback / pool-differentiation | One static anchor line each (same pattern as constraints). |
| dispatch | `renderPoolsBlock(state)` with the route-line branch removed — i.e. byte-identical to today's output whenever `sessionRouteOf(context)` returns null. Gate `anyConfigured` unchanged (`dispatch.js:594`). |
| teams | `teamsDoctrineText({ constraintsEnabled: <as today>, hitTags: [] })` — byte-stable per config. |
| lang | `renderLangBlock(pref)` when configured (config-stable); `""` otherwise. The ask-guidance branch moves entirely to the tail payload. |

Anchor lines are constant string literals — never interpolate anything into them.

### 4.5 Semantics preserved / changed

- **Empty payload** renders `""` → the entry contributes no bytes; if ALL entries are empty DSH appends the one-time CLEARED snapshot (§0) — same as watermark, acceptable.
- **Master switches** gate payloads exactly as they gate sections today (OFF = zero bytes in both channels).
- **No wording changes**: payload closures reuse the exact render functions called today. The ONLY permitted textual novelty is the three static anchor lines and the mechanical split of the dispatch route line / teams hit-delta into standalone renderers producing byte-identical fragments.
- **Information completeness**: head doctrine + tail payload together must convey the same information as today's single section text (T6 teams is the risky one — reviewer must diff the split).

### 4.6 Interplay with trim folding and watermark

- Fold rebuilds re-run section closures (now config-stable → byte-stable across rebuilds) and fold historical snapshot messages like any content. The one full miss per fold is sanctioned (§4.1 rule 3). No `context-trim/` changes.
- Multiple plugin context entries join with watermark's entry 300 into one snapshot; any change appends ONE small tail message per turn at most. Verify join ordering (300 < 310–370) in T8.

### 4.7 Host compatibility

Legacy fallback (§4.2 rule 1) reproduces today's behavior on hosts without `systemPrompt.context`. No host version requirement changes. Follow `context-watch.js:583-585`'s warn-once pattern so degradation stays diagnosable.

## 5. Task breakdown — authoritative dispatch table

**All later dispatch MUST follow this table.** Work in dependency order: T0 → T1 → (T2‖T3‖T4‖T5‖T6‖T7) → T8 → T9. Every task ends with: `npm test` green + `node scripts/validate.mjs` green + updated tests committed in the same change.

### T0 — Orientation (read-only, no code)
Read: this document, `AGENTS.md`, `host/context-watch.js:560-600` (reference implementation), the anchors of §2.1 you will touch. If any file:line anchor has drifted, re-locate by symbol name (`applyPtcGuard`, `applyDispatch`, `renderPoolsBlock`, `teamsDoctrineText`, `CONSTRAINTS_ORDER`, etc.) — do NOT redesign, do NOT re-audit the whole repo.

### T1 — Helper (new files only)
- Create `host/tail-context.js` per §4.2, with the §4.1 invariant in its docstring.
- Create `scripts/test/tail-context.test.mjs` covering: (a) with context API → head renders doctrine only, context entry registered with payload; (b) without API → head renders legacy `doctrine + "\n\n" + payload`, warn once, no context entry; (c) context registration throws → legacy embedding fallback; (d) doctrine/payload closure throwing → `""` both channels (fail-open); (e) payload `""` → context entry still registered, renders zero bytes.
- Boundary: NO other file changes. Fake `ctx.systemPrompt` records registrations (same fake style existing tests use).
- Size ~120 lines total. **Must land before T2–T7.**

### T2 — PTC ledger (D1)
- `host/ptc-guard.js`: replace the section registration (`:108-120`) with `registerTailContext`: doctrine = `renderPtcGuard()` under the `isPtcScope` gate; payload = ledger clause under the same gate (`renderPtcLedgerClause(sessionKeyOf(context?.agent))`, `contextName: "switchman:ptc-ledger"`, order 310).
- Update `scripts/test/ptc-guard.test.mjs` (+ `ptc-bindings.test.mjs` if it asserts section text): head closure output CONSTANT across simulated ledger growth (record declarations → grow ledger → head bytes identical); payload closure output equals today's clause; legacy fallback reproduces today's exact `guard\n\nclause` concat.
- Boundary: do NOT touch `host/ptc-bindings.js` (storage/self-heal logic). Size ~60 lines.

### T3 — Constraints (D2)
- `host/constraints.js`: export new pure `renderConstraintsLive(context)` = today's S4 closure body verbatim (`:423-447`, including `logHitsOnce` side effect — keep it inside the payload closure, NOT the head). Replace section with `registerTailContext`: doctrine = static anchor line (§4.4); payload = `renderConstraintsLive`.
- Update `scripts/test/constraints.test.mjs`: golden section strings from existing tests must now assert the PAYLOAD closure; new assertion: head anchor bytes constant across turns with varying hits/tables.
- Boundary: no changes to hit computation (`deterministicPressureHits`, `classifierConstraintsForTurn`, `matchedSkillNames`); render fns stay module-private. Size ~70 lines.

### T4 — Pool feedback + differentiation (D3/D4)
- `host/pool-feedback.js` + `host/pool-differentiation.js`: replace sections with `registerTailContext` (orders 330/340); doctrine = static anchor lines; payloads reuse the already-exported render fns with today's master switches and stats reads. Keep `logFeedbackChange`/`logDiffChange` side effects in the payload path.
- Update `scripts/test/pool-feedback.test.mjs`, `pool-differentiation.test.mjs`: block assertions move to payload closure; OFF renders zero bytes in BOTH channels; head anchors constant while stats grow.
- Size ~60 lines.

### T5 — Dispatch route line (D5)
- `host/dispatch.js`: split `renderPoolsBlock(state, sessionRoute)` (`:521`) into `renderPoolsBlock(state)` (route branch removed) + new `renderSessionRouteLine(sessionRoute)` producing byte-identical route-line text (`:525-527`). Replace S3 with `registerTailContext`: doctrine = `anyConfigured ? renderPoolsBlock(state) : ""`; payload = `anyConfigured && sessionRouteOf(context) ? renderSessionRouteLine(...) : ""`.
- Update `scripts/test/dispatch-pools.test.mjs` (+ `dispatch-fix.test.mjs` if it asserts section text): head equals today's output for null-route cases; tail line equals today's route line; pre-execute enforce/deny messages UNCHANGED.
- Boundary: pre-execute gates (`routeFixOf`, `annotationFixOf`, enforce deny) untouched. Size ~80 lines.

### T6 — Teams hit delta (D6) — highest care
- First read `host/teams.js:140-230` (`structuralTeamHits`, `teamsDoctrineText`). Split the hitTags-dependent fragment of `teamsDoctrineText` into new `renderTeamsHitsDelta(hitTags)` producing byte-identical fragment text. Replace S1 with `registerTailContext`: doctrine = `teamsDoctrineText({ constraintsEnabled: <as today>, hitTags: [] })`; payload = delta when hits non-empty (order 360).
- Update `scripts/test/teams-doctrine.test.mjs`: head constant across simulated tag variation; combined head+tail covers the same cases as today's full text — **no information loss** (enumerate each hitTag case in the test).
- Boundary: `child_message` tool sync (`:684+`) and orchestration untouched. Size ~100 lines. **Reviewer must diff the split (§4.5).**

### T7 — Lang ask guidance (D7)
- `host/lang.js`: replace S2 with `registerTailContext`: doctrine = `renderLangBlock(pref)` when configured else `""`; payload = today's ask-guidance branch (`:287-299`: latch checks via `askedSessions`/`asked`, `isRoot`, `renderAskGuidance(askLanguageOf(ctx, localeCache))`) — the latch-marking side effect (post-execute `ask_user_question` listener at `:303+`) stays unchanged. Order 370.
- Create `scripts/test/lang-tail.test.mjs` (no lang test exists today): head never renders ask guidance; payload renders once then latches to `""`; subagents never see it; configured-language block still in head.
- Size ~70 lines.

### T8 — Cross-module integration test
- Create `scripts/test/cache-stability.test.mjs`: mount ALL migrated modules + watermark on one fake ctx; assert (a) context orders join as 300 (watermark) + 310–370 in order; (b) head section closures are byte-stable across a scripted turn sequence (ledger growth, hits variation, stats growth, route change, tags variation, latch transitions); (c) payload closures reproduce golden per-turn outputs; (d) legacy-fallback mode on a ctx without `systemPrompt.context` reproduces pre-refactor section text for every module (golden strings).
- Size ~150 lines. **Requires T2–T7 all landed.**

### T9 — Whole-set quality gate
- Run `npm test` and `node scripts/validate.mjs` — both green.
- Add `CHANGELOG.md` entry (user-facing: prompt-prefix cache preservation; behavior unchanged on older hosts).
- Request an **independent reviewer** (mandatory per `cordis.patch.yml` §3: core prompt-pipeline logic, >300 lines). Reviewer checklist: §4.1 invariant holds everywhere; §4.5 no-wording-change honored (diff render outputs before/after via golden tests); T6 split information loss check; legacy fallback completeness; zero-dependency invariant; no `host/config.js`/`cordis.patch.yml` drift; language compliance (§4.1 rule 5: every injected/doctrine/anchor/test-assertion string in English).

## 6. Risks and mitigations

| Risk | Explanation | Mitigation |
|---|---|---|
| R1 Snapshot accumulation in history | every payload change appends a small tail message | snapshots are tiny (single lines/small blocks); trim folding absorbs them; DSH marks superseded snapshots for the model |
| R2 Authority downgrade | payload moves from system prompt to user-channel system-reminder | watermark precedent in production since 2026-11; anchor lines state binding-ness; ledger is a reminder list, not instruction change |
| R3 Partial-API failure | context registration throws after section registration | helper rule 2 fallback + T1 tests |
| R4 Multi-entry snapshot joins | plugin owns 8 context entries in one snapshot | DSH joins by order (§0 evidence); T8 asserts ordering |
| R5 T6 information loss | doctrine/hit-delta split may drop conditional wording | byte-identical fragment requirement + per-tag test cases + reviewer diff |
| R6 Test churn | existing tests assert exact section text | golden strings move to payload assertions in the same change; both gates per task |

## 7. Open questions

1. **[Decided] `required: true` on new context entries** — mirror `context-watch.js:590` exactly (2026-11-21).
2. **[Decided] Migrate lang ask-guidance (D7)** — yes; the strict invariant (§4.1) forbids mid-session head variation, and the latch causes two one-shot misses (2026-11-21).
3. **[Pending] Whether `switchman:dispatch-route` payload should later also carry pool ⚠not-authorized markers if audit shows they are session-stable** — lean: no; keep T5 scope as specified. Decide only with evidence after T9.

## 8. Out of scope (do NOT touch)

- `host/context-trim/**`, `host/context-watch.js`, `host/ptc-bindings.js` storage logic, `host/subagent-model.js`, `host/edit-feedback.js`, `host/tool-args-sanitize.js`, `host/intent.js`, `host/skill-registry.js`, `index.js` (except, if the bundler requires it, adding `host/tail-context.js` to any explicit module list — check `index.js` import style first; ESM imports are per-file so likely NO change), `cordis.patch.yml`, `host/config.js`, native skill catalog behavior, CHANGELOG beyond one entry, version bump (release flow is separate per AGENTS.md).

## Appendix A — file:line quick reference

| Content | Location |
|---|---|
| PTC guard section + ledger concat | `host/ptc-guard.js:108-120` (`applyPtcGuard`), `PTC_GUARD_ORDER = 10510` |
| Ledger clause renderer | `host/ptc-bindings.js:413` (`renderPtcLedgerClause`), import at `ptc-guard.js` top |
| Constraints section body | `host/constraints.js:418-450`; render fns `:216`/`:233`; `CONSTRAINTS_ORDER = 10405` |
| Pool-feedback section | `host/pool-feedback.js:165-186`; exported renderer `:96`; order 10406 |
| Pool-differentiation section | `host/pool-differentiation.js:241-255`; exported renderer `:173`; order 10407 |
| Dispatch section + pools block + route line | `host/dispatch.js:588-597` (`applyDispatch`), `:521` (`renderPoolsBlock`), `:501-508` (`sessionRouteOf`), `:525-527` (route line); order 10400 |
| Teams section + doctrine + hits | `host/teams.js:655-677` (section), `:170` (`teamsDoctrineText`), `:140` (`structuralTeamHits`); order 10250 |
| Lang section + latch | `host/lang.js:280-301` (section), `:303+` (latch listener); order 10300 |
| Trim section (compliant) | `host/context-trim/index.js:1584`; order 10450 |
| Watermark reference implementation | `host/context-watch.js:570-594` |
| DSH tail-append semantics | `deepseek-harness`: `packages/core/agent-loop/src/runtime-context.ts:21`; `packages/core/agent-loop/tests/runtime-context.spec.ts:127,143`; `packages/core/system-prompt/tests/system-prompt.spec.ts:145,302` |
| DSH native skill catalog tail behavior | `packages/skill/tool-skill/src/index.ts:241,247-254,259-327` |
| Test command | `npm test` = `node --test scripts/test/*.test.mjs` (33 existing files) |

