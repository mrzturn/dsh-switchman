# Context-trim design — inject contract, wire-truth gate, surface shipping

Status: reflects the shipped design as of **v1.11.0** — v1.9.1 (inject contract
+ wire-truth gate), v1.10.0 (surface-replace ship pass), the 2026-11-05
post-1.10.1 fixes (durable-capability fold gate, live re-location of stale
captures, provider-tally wire metrics), and v1.11.0 (T1/T2/T3 ladder folding +
the model-invisibility invariant — see
[docs/ladder-fold.md](./ladder-fold.md); this page keeps the pre-ladder
mechanics that still apply verbatim). Authoritative implementation:
`host/context-trim/index.js`, `host/context-trim/surface.js` and
`host/context-trim/metrics.js`; the surface pass, its post-fix behavior and
the trigger-math nits are specified in depth in
[docs/surface-fold.md](./surface-fold.md).

The trim engine folds consumed conversation ranges into deterministic summaries
and rebuilds every outbound request view from an append-only fold ledger. The
plain splice path (`llm/stream` view rewrite) covers most dispatches, but two
host realities forced the design below: the current agent loop deep-freezes the
request arrays / option objects it assembles, and the watermark must never
report tokens the model cannot actually see.

## The four-value `injectView` contract

Why it exists: some dispatches hand out fully frozen request arrays or option
objects (the agent loop deep-freezes assembled requests before they reach the
`llm/stream` waterfall). A listener cannot splice summaries into a frozen
object, so "the view was applied" is not a yes/no fact — the plugin must record
what actually happened. For every dispatch, the view application step reports
one of four outcomes into `decisions.log`:

- `nothing-to-apply` — no fold blocks located inside this history; the raw
  history IS the view. Not an error, not a gate signal.
- `in-place` / `swapped` — the fold view shipped with the dispatch (mutated
  messages in place, or replaced the options object). The wire carries the
  folded view.
- `none` — a fold existed but the frozen dispatch could not carry it; the wire
  ships raw history. This is the input to the wire-truth gate below.

The value recorded per dispatch is kept in the per-session view registry as
`inject`, together with `lastNoneAt` (the timestamp of the most recent `none`).

## The wire-truth gate

Problem (observed 2026-11-04): a session whose view read ~80k tokens while the
wire actually carried 176k — folds committed to the ledger but blocked by frozen
dispatches. The watermark, reading the view, sat far below the force tier: no
forced handover ever fired, on a session that genuinely needed one.

Rule: a view that never reaches the wire must not drive the watermark.
`recentTrimPromptTokensOf()` (the watermark's meter source) returns the
watermark's wire-domain meter — `max(view estimate, last sampled
main-dispatch prompt)`, the same number the trim pressure tiers evaluate —
only when all of the following hold; otherwise it returns `null` and the
watermark falls back to the provider-reported tally (which keeps the force
tier and the auto-handover working):

- the entry exists and is fresher than `TRIM_VIEW_MAX_AGE_MS` (10 minutes);
- the entry's `inject` is not `none`;
- no `none` has occurred within the TTL window (`lastNoneAt` check).

The gate is deliberately sticky on `lastNoneAt`: a single mutable dispatch right
after frozen ones re-arms the fold trigger, but the watermark keeps falling back
to the tally until a full TTL passes with no `none` (real sessions mix — one
logged 46 `none` next to 14 `swapped`). The gate itself is fail-open: any
malformed entry degrades to `null`, i.e. tally-based metering.

### The wire-domain meter (why max, not the bare view)

The watermark's meter is `max(view, wire)` — deliberately the SAME expression
the trim pressure tiers evaluate in `maybeFold`. Each pure source has one
bias: the bare view never counts the system/tool sections (a
session-shape-dependent mass; live decision-log pairs drift −5k…+6k between
view and wire in steady state), so a view-only watermark tightens every
protective tier late by exactly that mass — and the `wmHardTokens` 95k ≙
trim-pressure 90k alignment silently loses its meaning in units. The stored
tally is wire-domain but never re-prices splice-level folds (it keeps
counting material the model no longer receives), so it is only the
gate-rejected fallback, never a max operand. The 2026-11-04 incident above is
the view-only bias in extremity; `max(view, wire)` is the structural answer
(inspection P1-3, adjudicated 2026-11-07). The wire half is sampled from
accepted MAIN dispatches only (`noteTrimWireTokens`): side dispatches sample
usage on the same session id, and a tiny inherited-id prompt must never LOWER
the wire floor below the main history's real prompt. The bare-view accessor
`recentTrimViewTokensOf()` remains exported (gate primitive, diagnostics,
tests); the watermark no longer reads it.

Whether folding pauses is a SEPARATE, durable capability question
(`host/context-trim/index.js:690`). A cycle is skipped with
`reason=injection-unavailable` only when the last dispatch logged
`injected=none` AND `surfaceChannelCapable(sessionId)` is false — i.e. the
surface pass is enabled, the live session exposes `append` + `surface.nodes`,
and no compaction lock is open (`surface.js:706` `supported()`,
`index.js:272-278`). Recency never gates folding: the old in-memory "did the
surface ship within 10 minutes" test deadlocked resumed sessions, because
resumed dispatches always report `injected=none`, no fold meant no ship, and
the window expired while the prompt kept growing. `TRIM_VIEW_MAX_AGE_MS`
(10 min, `index.js:56`) is display freshness for the watermark and banner only.

The banner marker `wire=raw (folds not shipping; watermark reads the tally)` is
emitted only when `injected=none` AND no fold block has EVER shipped a
replacement (`ledgerShowsShippedReplacement`, `index.js:285`; rendered at
`index.js:231`). A ledger block carrying `surfaceReplaced` is durable proof the
channel reaches the wire, so such a session keeps the marker off even after a
restart; a commit-time capture (`surfaceSeqs`) is NOT proof and does not
silence the warning. While the gate is closed the watermark still reads the
provider tally.

### Side-dispatch guard

The meter that records `inject`/`lastNoneAt` must only see the session's main
history. Auxiliary llm calls (web-search summaries, title generation) inherit
the session id but arrive as 1–6 message arrays; letting them through would
clobber every per-session measurement. The guard skips any dispatch below
`SIDE_DISPATCH_MIN_MESSAGES` (12) when blocks exist but nothing locates, plus
fold-span dispatches (a cycle's own re-sends). Two constants keep it honest:

- `SIDE_DISPATCH_SKIP_BUDGET` = 2 — consecutive skips tolerated before a
  dispatch is accepted as main history anyway. This is the release valve for a
  genuine host-compaction epoch, which also shrinks history below the floor;
  without the budget the guard would stick forever (no capture refresh, no
  epoch reset, folds running against a stale capture). The skip counter resets
  on every accepted main dispatch.
- `SIDE_DISPATCH_MIN_MESSAGES` = 12 — the floor itself.

All guard state lives in bounded maps (200 sessions), same as the view registry.

## The surface-replace ship pass (v1.10.0)

The splice path is closed by design for frozen dispatches, so folds need a
source-level shipping path. The host's own compaction provides the precedent:
history is a derived projection of the append-only event log, and appending an
event with `surfaceOp: {op:'replace', startSeq, endSeq}` shadows a range in the
projection. The trim engine clones that mechanism to push committed folds onto
the session surface — full design, host recon evidence and test plan in
[docs/surface-fold.md](./surface-fold.md). Summary of the shipped shape:

- **Trigger timing**: the serial `agent/turn-stopping` boundary (no request in
  flight) plus an idle sweep for child/idle sessions. The idle hook runs the
  fold cycle first and the sweep after it, so a block committed on that boundary
  ships on the same boundary (`index.js:807-816`).
- **Replace-event shape**: per pending fold block, a synchronously adjacent
  pair — a `compaction/prune` shadow-price metering event
  (`shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`), then ONE
  `user/message` replacement whose body is the block's rendered summary and
  which carries `surfaceOp {op:'replace', startSeq, endSeq}` with
  `sourceEventSeqs` covering EVERY shadowed surface node (`surface.js:635-643`).
  The replacement's source is a plain `{kind:'user'}`, NOT a cloned compaction
  checkpoint: the v4 session validator rejects a `compact-checkpoint` source
  with no matching `compaction/start`. Downstream recognition rides the
  `acp_summary_` id prefix and the `[SWITCHMAN:TRIM]` content prefix
  (`surface.js:105-117`). `sourceEventSeqs` must be unique and cover the
  shadowed set exactly; there is no ordering requirement (a span that crosses a
  replacement is legitimately non-monotonic).
- **System head is never shadowed**: when the first surface node derives the
  system prompt, the ship path drops that node from the range
  (`surface.js:596-609`); a head-only range tombstones as `system-head`
  (`surface.js:598`). The same clamp runs at capture time
  (`surface.js:441-445`).
- **Idempotency**: a per-block tombstone keyed by `startSeq..endSeq` +
  contentGeneration; the same range is never replaced twice, and a re-open only
  happens when the surface content actually changed. Every skip is logged to
  `decisions.log` as `surface-replace skipped reason=…` (deduplicated, bounded).
  Skip reasons (`surface.js:480`): whole-pass `disabled` / `no-service` /
  `compaction-lock`, then per block `incomplete-seqs`, `not-located`,
  `system-head`, `append-rejected:<message>`.
- **A stale capture is re-located, not tombstoned** (v1.10.2): when a stored
  capture no longer validates against the live surface (`validateStoredSeqs`,
  `surface.js:249` — unique seqs, exact dense live span, endpoint ref identity,
  deliberately NO ordering assumption because `surface.nodes` is model-visible
  order), the block is re-located over the LIVE visible surface with its
  count-anchored refs (`surface.js:540-584`). A stale capture is re-targeted
  only when its stored endpoints are still live surface nodes AND equal the
  located span's endpoints, and the located span shares no seq with a range
  another block already replaced; otherwise the `incomplete-seqs` tombstone
  stands — never a guessed range. Live evidence: a block skipped as
  `reason=incomplete-seqs` at 07:29:39 shipped at 07:46:21 as
  `surface-replace startSeq=728 endSeq=938 seqs=83 tokens=67933 generation=2`.
- **Fail-open chain**: surface service or `surfaceOp` unavailable (older host),
  compaction lock open (`compaction/start`..`compaction/end`), version drift on
  surfaceOp semantics — every one of these degrades to the legacy behavior:
  splice-only view, `wire=raw` banner, tally-driven watermark. Never a broken
  request.
- **Flag**: `surfaceFold` (default `true`). OFF keeps exactly the pre-1.10.0
  behavior; with the gate above unchanged, the watermark simply stays on the
  tally for frozen-dispatch sessions.

After a successful surface replace, the meter view and the wire converge
naturally and the banner stops showing `wire=raw` from the next step on. Because
the stand-down condition is the durable `surfaceReplaced` marker, it stays off
across restarts; the `injectView` telemetry remains in the log for
observability.

## Provider wire metrics (v1.10.2)

Two numbers, deliberately kept apart:

- **wire** — the real provider prompt size, sampled from the LLM stream's usage
  event (`metrics.js:26` `extractUsage`, `metrics.js:96` `recordUsage`) and
  summed as uncached `inputTokens` + `cacheReadTokens` + `cacheWriteTokens`
  (`metrics.js:50` `promptTokensOf`, `index.js:303` `wireTokensOf`). The host's
  camelCase `TokenUsage` buckets do not overlap, so summing is correct;
  providers without a separate write bucket report 0/absent there. Unknown until
  the session's first response has landed.
- **view** — the messages-only estimate of the rebuilt view
  (`estimateTokensOf(view.messages)`). Because it omits those sections it reads
  smaller than the wire by the fixed overhead O ≈ 17.3k (system prompt + tool
  schemas + persona/context sections never ride the messages array); the two
  only converge at the instant a view is rebuilt from the same history the wire
  carried. Only `wire` is a truthful prompt-size reading; the view is the meter
  the fold logic controls.

Consequences:

- every `view-applied` row carries `wire=<n>` once a tally exists
  (`index.js:543`), e.g.
  `view-applied applied=1 foldedMsgs=12 view=20800 blocks=2 injected=swapped wire=39400`;
- pressure and emergency tiers evaluate on `max(view, wire)` (`index.js:705`), so
  a heavily cached session (~130k of a 136k prompt cached) no longer reads as the
  uncached delta and silently skips its tiers;
- the growth tier still subtracts the VIEW-unit anchor `lastFoldLowTokens` (see
  Known limitations);
- the former banner (`view ~Nk tokens (P% of window W)` + folds + growth) is
  removed in v1.11: no trim numbers reach the model; the `wire=raw` marker is
  gone with it — the injected=none rows in `decisions.log` carry that truth.

## Triggers and constants

Defaults, no overrides (`host/config.js` holds the schema; the numbers below are
the effective values). v1.11 adds the ladder tiers AFTER these (docs/
ladder-fold.md): ladder T2/T3 distillation, gated on active-summary token
mass (8000/6000) and block-count floors (3/2), each on a 120 s interval after
any fold; they fire only when the raw tiers stay quiet.

| Gate / constant | Value | Code | Notes |
| --- | --- | --- | --- |
| Growth anchor | `max(view, wire) − lastFoldLowTokens > 22500` | `index.js:705`, `trigger.js:120-124`; default `index.js:446`, `config.js:238` | strict `>` |
| Foldable-increment floor | contiguous increment ≥ 50000 | `trigger.js:116`, `index.js:447`, `config.js:241` | binds first in practice |
| Pressure tier | usage ≥ 60% of window (90k of 150k) | `trigger.js:106`, `config.js:244` | side-model fold |
| Emergency tier | usage ≥ 95% (142.5k of 150k) | `trigger.js:88`, `config.js:247` | mechanical fold, no side-model call |
| Emergency cooldown | 90 s | `trigger.js:31` `EMERGENCY_COOLDOWN_MS` | also applies to a rejected emergency commit |
| Min interval, side-model folds | 60 s | `trigger.js:28` `FOLD_MIN_INTERVAL_MS` | |
| Hourly cap | 16 side-model folds per rolling hour | `trigger.js:101-102`, `config.js:257` | emergency exempt: evaluated before the cap AND before the 60 s min-interval (it has its own 90 s cooldown) |
| Protected tail | 6 messages | `trigger.js:40`, `config.js:254` | never folded |
| Window | model-resolved (150000 for deepseek-flash), capped by `trimWindowTokens` (0 ⇒ `wmForceTokens`) | `index.js:204`, `index.js:455-483` | `null` disables pressure/emergency tiers |
| Fold-failure backoff | 60 s × 2^(n−1), 15 min ceiling | `index.js:323-324` | failures advance no cadence gate |

Which gate binds: at a 150k window the 60% pressure line (90k wire) sits just
above the ~88k wire point where the growth gate's 50000 increment is reached, so
growth fires first in the normal case and pressure pins the ceiling. The 50000
increment floor is the binding constraint, not the 22500 growth delta.

## decisions.log vocabulary

One line per decision in `<trimStateDir>/decisions.log`: ISO timestamp followed
by space-separated `key=value` pairs, rotated once at 2 MB (`index.js:356`).
Operators diagnose from these rows:

| Row | Shape | Meaning |
| --- | --- | --- |
| dispatch | `view-applied applied=<n> foldedMsgs=<n> view=<n> blocks=<n> injected=<outcome> [wire=<n>]` | per `llm/stream` dispatch; `applied` counts blocks located in THIS re-send |
| fold decision | `via=<idle\|stream> action=<none\|fold\|emergency> tier=<tier\|-> reason=<…> view=<n> [wire=<n>] window=<n\|null>` | why a cycle did or did not run |
| fold outcome | `outcome=<folded:<tier>:<msgs> msgs (~<n> tokens) \| summary-unavailable \| reload-aborted \| commit-rejected:<reason> \| no-capture \| empty-slice> tier=<tier>` | what the cycle did |
| gate | `action=none reason=injection-unavailable view=<n>` | neither the splice nor the surface channel can reach the wire |
| ship | `surface-replace startSeq=<n> endSeq=<n> seqs=<n> tokens=<n> generation=<n> via=<turn-stopping\|idle>` | a fold block reached the surface |
| ship skip | `surface-replace skipped reason=<…> via=<…> [block=<id>]` | deduplicated; reasons listed above |
| guard | `side-dispatch skipped n=<n> msgs=<n> view=<n> blocks=<n>` | auxiliary llm call ignored |
| epoch | `ledger-stale blocks=<n> view=<n> growth-baseline-reset` | host compaction aged the whole ledger out |

`reason=` values emitted by the trigger (`trigger.js`): `nothing-foldable`,
`empty-increment`, `usage <p>% >= <emergency>%` or `emergency-cooldown`,
`hourly-cap`, `min-interval`, `usage <p>% >= <pressure>%`,
`growth ~<n> > 22500 and increment ~<n> >= 50000`, `below-thresholds` — plus
`injection-unavailable` from the fold gate.

## Expected steady state

Measured on live deepseek-flash sessions (150k window, defaults):

| Point in the cycle | view | wire |
| --- | --- | --- |
| just after a fold | ≈ 20.8k | ≈ 39–42k |
| growth gate re-arms (foldable span ≈ 50k) | ≈ 70.8k | ≈ 88k |
| pressure tier (60% of 150k) | ≈ 72.7k | ≈ 90k |

So the healthy sawtooth is wire ≈ 40k ↔ 88–90k (≈27%–60% of the window), one
fold per ~50k of raw conversation growth; under normal load the prompt never
approaches the window (for the heavy-load exception see Known limitations). The
ceiling is effectively pinned at 90k by the pressure tier; the floor creeps
upward by +0.5–2k per cycle, because each fold's summary absorbs the previous
summary and the 6 protected tail messages stay raw.

A session reading `view ~70k, growth ~50k` with no `surface-replace` rows is NOT
in steady state: check the skip rows (`incomplete-seqs`, `no-service`,
`compaction-lock`, `append-rejected:…`) and whether fold-decision rows appear at
all.

## Known limitations

- **Pre-fix tombstoned blocks cannot be revived.** A block tombstoned before
  v1.10.2 had its refs invalidated by a moved surface; re-location cannot
  re-prove identity, so the block is skipped silently (deduplicated rows) for the
  rest of the session. Its summary still renders in the view, but nothing ships,
  so on a frozen-dispatch session those tokens stay on the wire: the fold was
  paid for and its relief is lost. Expected, not a bug.
- **Hourly cap + emergency exemption.** At most 16 side-model folds per hour, with
  the emergency tier exempt from that cap; under very heavy use the prompt can
  spike to the emergency line (142.5k of a 150k window) before a fold lands.
- **Growth-anchor unit mix.** `lastFoldLowTokens` is stored in VIEW units while
  the growth comparison runs on `max(view, wire)`, so in wire terms the gate arms
  ~17k early. Harmless today because the 50000 increment floor binds first; an
  open nit, not a per-number patch target.
- **The view is not the prompt.** The view estimate is messages-only and, in
  steady state, reads smaller than the wire by O ≈ 17.3k. Never use it as a
  prompt-size reading; use `wire`.
- **Wire metrics are per-process and short-lived.** The metrics store prunes to
  the 50 most recently active sessions (`metrics.js:78`); a session absent from
  it reports no `wire=` until its next response lands, and a restart starts the
  tally empty. Missing `wire=` is not evidence of a broken channel.
- **v1.11 note:** the model-visible `[SWITCHMAN:TRIM]` context line (view
  tokens / % of window / folds / growth) is GONE — the engine never reports
  sizes or progress to the model (docs/ladder-fold.md). The human reads
  `decisions.log` and the client badge. The task-intent line (the first user
  message) is protected from folding.

## What the current design supersedes

- **"Mutable dispatch still receives the folded view."** The pre-1.9.1 claim
  that the dispatch producing the model response always carries the fold view
  is false for frozen dispatches; it is replaced by the four-value contract
  above. No documentation or banner may promise fold delivery through the
  splice path alone.
- **Meter duality, old split.** The original porting notes proposed keeping the
  watermark on the STORED tally forever and using view estimates only for trim
  triggers. Superseded: the watermark reads the trim layer's wire-domain meter
  `max(view, last sampled main prompt)` (so folding relieves the watermark AND
  the system/tool mass is no longer lost), with the wire-truth gate as the
  correctness backstop — meter reads are allowed only while the view provably
  reaches the wire, otherwise the tally takes over. Stored tallies still bound
  disk/context pressure but no longer drive tiers. (An intermediate state —
  watermark on the bare view alone — is also superseded: it under-tightened
  every tier by the system/tool mass; see "The wire-domain meter" above.)
- **Splice as the only shipping path.** v1.9.1 shipped the contract and gate
  with folds effectively meter-only on frozen dispatches; v1.10.0 added surface
  replace as the shipping path. Design work on "ship folds through `llm/stream`
  despite freezing" is closed — the source level is upstream of the freeze and
  is the only sane place to ship.

## Invariants unchanged

Everything in the cache-preservation contract stands: append-only fold frontier,
deterministic view rebuild, protected tail, tool-pair-balanced fold boundaries,
cadence throttle, host-compaction epoch re-anchoring, and unconditional
fail-open on internal errors (degrade to pass-through, never a broken request).
Fork inheritance of fold state (copy-on-fork, idempotent) is likewise
unchanged.
