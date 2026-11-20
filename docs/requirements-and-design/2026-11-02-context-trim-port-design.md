# Porting billion-context's Context Trimming into dsh-switchman — Design Notes

Date: 2026-11-02. Status: proposal (analysis only, no code written).
Sources: read-only recon of billion-context v0.1.211 (dist bundle + live state) and dsh-switchman/DSH host internals.

## 0. TL;DR

Port billion-context's essential five pieces into a new in-host `host/context-trim` module:
**stable refs + append-only fold state + deterministic outbound view rebuild (via the documented `llm/stream` waterfall) + usage-driven miss accounting + native session binding**.
Upgrade the trigger from model-driven nudge to **system-driven folds** (watermark budgets + growth gate; summaries via a cheap side-model call at a turn boundary) — that is the "full automation" step billion-context deliberately does NOT take (it only automates trigger+measurement; execution stays model-driven).
Cache preservation is not "never break the prefix" — it is a **contract**: freeze the prefix below the fold frontier, rebuild deterministically, throttle fold cadence, exploit idle windows, and measure amortized economics.

## 1. What billion-context actually does (verified)

1. **Layer split**: a local HTTP proxy rebuilds the outbound request every turn from the client's re-sent full history + session state; the agent's stored conversation is NEVER mutated. Folds replace ranges with synthetic `role:"system"` summary messages in the wire view only.
2. **Model-driven execution**: growth-gated nudge (growth floor 22500 tok AND compressible increment > 50000 tok) injects a banner asking the model to call `compress` with `mNNNNN–mNNNNN` ranges; the main model writes the summary itself (optional external summarizer chain exists).
3. **Cache contract**: folds are append-only (monotonic frontier); protected tail (recent N msgs / X tokens never folded); deterministic rebuild ⇒ byte-identical serialized prefix between folds ⇒ one-time re-pay per fold, then hits resume (healthy sessions measured at 89–100% hit).
4. **Measurement loop**: per-request cached_tokens sampling; miss decomposition = newContent + compressionRepay + ttlRepay (identity: input = cached+new+compRepay+ttlRepay); per-fold breakeven economics (oneTimeCost = (w−r)·T + q·σ − r·S, defaults w=1, r=0.1, q=4) compared against measured fold cadence; seam forensics (byte-level LCP on unexplained misses).
5. **Incidental** (do NOT port): image shed/rescale, Anthropic keepalive pinger, CCR retrieval tooling, 23-CLI lanes, Web GUI, hash-chain session re-association (simhash adoption) — the last is replaced by native `conversationId` in DSH.

## 2. What dsh-switchman can host (verified)

- `llm/stream` waterfall fires on every model call with full `options.messages`; a listener may mutate messages in place (dsh-llm README:1758, lib:2397). This is the view-rebuild point.
- `agent/pre-step` can rewrite step-input messages (dsh-agent-loop:909); `tools/pre|post-execute` for gating/append; `ctx.tools.register` / `ctx.commands.register` (context-watch.js:976/931).
- `ctx.tokenMeter.measure()` per step is already the watermark's meter (context-watch.js:149).
- Static doctrine via `ctx.systemPrompt.section` (byte-stable, order-pinned) + dynamic facts via `ctx.systemPrompt.context` (tail snapshots — cache-safe append-only growth).
- Plugin runs in-process with full Node privileges; background loops already precedented (retry loops in context-watch).
- The plugin already ships a bundle.patch mechanism (cordis.patch.yml loader overrides) — the same mechanism billion-context uses to disable `dsh-compaction-basic`.
- Host compaction exists (`dsh-compaction-basic`, per-agent isolated groups + `tool-result-pruner`) — a competing trimmer that must be arbitrated (see §6).

## 3. Target architecture

New module `host/context-trim/` inside dsh-switchman:

```
tokenMeter (reuse) ──► trigger: watermark budgets + growth gate
        │                       │ fold decision (ranges, refs)
        ▼                       ▼
metrics loop ◄── fold state (append-only blocks, per conversationId) ──► view builder
(llm/stream: rewrite options.messages = history + spliced summaries; protect tail)
        │                                              ▲
        └── summarizer: side-model call (economy lane) at pre-step boundary
tools: ctx_trim / ctx_restore / ctx_trim_status (register via ctx.tools)
config: cordis.patch.yml rows + client settings card
```

Essential pieces mapping (bili → switchman):
| billion-context | dsh-switchman port |
|---|---|
| mNNNNN refs + byRaw/byRef content anchors | same scheme, keyed off append-only session log |
| fold blocks b1… (t1/t2/t3 tiers) | same, persisted in `.dsh-switchman/state/trim/<conversationId>.json` |
| proxy view rebuild | `llm/stream` listener rewriting `options.messages` |
| nudge banner + compress tool | `ctx.systemPrompt.context` mandate (L2) or auto-fold (L3) |
| acp_cache decomposition + breakeven | metrics loop writing `.dsh-switchman/state/trim/metrics.jsonl` |
| prefix-affinity hash-chain adoption | NOT needed (native conversationId); keep light hash-chain for seam forensics only |

## 4. Cache-preservation contract (invariants to enforce + test)

1. **Monotonic frontier**: folds only move forward; frozen zone is never edited again.
2. **Deterministic rebuild**: same (history, fold state) ⇒ byte-identical serialized messages; canonical JSON serialization, fixed tag rendering rules (text-only), stable ordering of injected sections. Golden test: fixture state ⇒ assert byte-equal output across runs.
3. **Protected tail**: recent N messages / X tokens exempt from folding.
4. **Cadence throttle**: growth floor between folds (start with bili defaults: 22500 tok growth + 50000 tok compressible increment), so one-time re-pay amortizes below breakeven.
5. **Idle-window folding**: if the session was idle beyond the route's cache TTL, the next request misses anyway — fold during idle = free re-pay. (DeepSeek/GLM prefix-cache TTL is route-specific; measure, don't assume.)
6. **Measure everything**: sample cached_tokens per request; decompose misses; alert on seam (unexpected prefix break) before blaming folds.
7. **Tool-pair balance**: fold boundaries must keep assistant tool_calls together with their tool results (never split a pair; never orphan a dangling result). The host's own compaction validates this (dsh-compaction/lib/index.js:557) — the view builder must enforce the same rule, otherwise the upstream API rejects the request.

Honest framing: a fold ALWAYS pays once. The objective is amortized cost (hit rate × re-pay frequency), not 100% hit rate — bili's breakeven formula is the objective function to port.

## 5. Automation levels

- **L1 — advisory (bili parity)**: nudge banner + `ctx_trim` tool; model chooses ranges and writes summaries. Ship first; zero regression risk.
- **L2 — system-decided, model-executed**: trigger auto-picks ranges (growth-gated, consumed increments only) and injects a per-step MANDATE via dynamic context; model must call the tool with those exact ranges within N turns.
- **L3 — fully automatic (the goal)**: system picks ranges AND generates summaries via a side-model call (economy lane, self-contained prompt carrying bili's summary rules: verbatim paths/signatures/errors, open-objectives carry-forward, one string per batch) at the next `agent/pre-step` boundary; fold committed to state; view builder applies it from then on. No model compliance required. Keep L1/L2 as config fallback for users who prefer model-written summaries (quality is often better when the author model summarizes its own consumption).

Guardrails for L3: never fold open-objective content without carry-forward; never fold inside protected tail; never fold while a fold is in flight; cap folds per session per hour; skip fold if estimated breakeven > expected remaining turns.

## 6. Coexistence with dsh-compaction-basic (the key engineering decision)

billion-context DISABLES stock compaction to avoid two trimmers racing the same surface. Options:
- **A. Single owner (recommended for parity)**: disable `dsh-compaction-basic` rows via dsh-switchman's existing bundle.patch mechanism (same trick bili uses); context-trim becomes the only semantic trimmer; keep `tool-result-pruner` (mechanical size trim) and the force-tier handover flow as-is.
- **B. Zoned coexistence (conservative)**: compaction-basic keeps overflow rescue inside per-agent isolated groups; context-trim only handles the advisory/L1–L2 layers and never rewrites the view. No parity with bili, but zero conflict risk.
Anti-goal (per docs/porting-plan.md): a second summarize path racing compaction-basic without an ownership decision.

## 7. Phased plan

- **Phase 0 — measurement only** (low risk, immediate value): llm/stream listener samples usage, writes miss decomposition + hit rates per session; no behavior change. Baseline for every later decision.
- **Phase 1 — L1/L2**: refs, fold state, view builder behind a config flag, tools + mandate; golden determinism test.
- **Phase 2 — L3**: side-model summarizer at pre-step; growth gate tied to watermark budgets; bundle.patch arbitration (option A) behind a setting.
- **Phase 3 — economics loop**: idle-window folding, breakeven-based threshold tuning, seam forensics light, optional per-route keepalive.
Verification discipline: view builder and fold-state commits are data-consistency-critical — reviewer pass required; golden tests must run on every change to serialization.

## 8. Risks / open questions

1. `llm/stream` mutation semantics: mutate-in-place is documented, but confirm chunk-stream wrapper compatibility for reshaped requests (e.g. token counting downstream of the waterfall).
2. bundle.patch retargeting non-switchman rows (compaction-basic disable) — proven possible (bili does it) but validate the loader accepts foreign row ids.
3. Determinism hazards: any non-deterministic content in messages (timestamps, dynamic context snapshots injected mid-history rather than tail) silently breaks the prefix — audit DSH's per-step injections before enabling L3.
4. Side-model summarizer latency at pre-step (one round-trip per fold; acceptable at fold cadence, but make it async-with-commit-barrier, not inline streaming).
5. Route differences: cached_tokens field names and cache TTLs differ per provider (openai/anthropic/zai) — the metrics loop needs per-route adapters.
6. dsh-session derived-surface APIs (`compactRegion` reach-across via pluginManager) remain undocumented — avoid; the llm/stream view path does not need them.
7. **Meter duality**: `ctx.tokenMeter.measure()` reads the STORED surface; after view-level folds the wire payload is smaller while the meter stays high → watermark could stay pinned at hard tier and re-trigger folds or premature handover. Split the signals: trim thresholds trigger on VIEW-estimated tokens (the view builder already counts them); watermark tiers + force-tier handover keep using STORED tokens (stored growth is real disk/context pressure that handover should still bound).
8. Without the §6 ownership decision (option A), the recon team's warning stands: an llm/stream trimmer racing compaction-basic bypasses compaction invariants and must not be the primary trim path. Option A dissolves the objection — one owner implements the invariants itself.
