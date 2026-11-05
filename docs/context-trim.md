# Context-trim design — inject contract, wire-truth gate, surface shipping

Status: reflects the shipped design as of v1.9.1 (inject contract + wire-truth
gate) and v1.10.0 (surface-replace ship pass). Authoritative implementation:
`host/context-trim/index.js` and `host/context-trim/surface.js`; the surface
pass is specified in depth in [docs/surface-fold.md](./surface-fold.md).

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
`recentTrimViewTokensOf()` (the watermark's view source) returns the view
estimate only when all of the following hold; otherwise it returns `null` and
the watermark falls back to the provider-reported tally (which keeps the force
tier and the auto-handover working):

- the entry exists and is fresher than `TRIM_VIEW_MAX_AGE_MS` (10 minutes);
- the entry's `inject` is not `none`;
- no `none` has occurred within the TTL window (`lastNoneAt` check).

The gate is deliberately sticky on `lastNoneAt`: a single mutable dispatch right
after frozen ones re-arms the fold trigger, but the watermark keeps falling back
to the tally until a full TTL passes with no `none` (real sessions mix — one
logged 46 `none` next to 14 `swapped`). The gate itself is fail-open: any
malformed entry degrades to `null`, i.e. tally-based metering.

While the gate is closed for a session, the trim engine also pauses fold cycles
(they would only burn side-model summarizer calls whose output cannot ship) and
the trim banner marks the watermark line with
`wire=raw (folds not shipping; watermark reads the tally)`.

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
  flight) plus an idle sweep for child/idle sessions.
- **Replace-event shape**: per pending fold block, a synchronously adjacent
  pair — the shadow-price metering event, then ONE `user/message` replacement
  whose source clones the host compaction checkpoint and which carries
  `surfaceOp {op:'replace', startSeq, endSeq}` with `sourceEventSeqs` covering
  EVERY shadowed surface node in the range (host validation requires full
  coverage, ordered).
- **Idempotency**: a per-block tombstone keyed by `startSeq..endSeq` +
  contentGeneration; the same range is never replaced twice, and a re-open only
  happens when the surface content actually changed. Every skip is logged to
  `decisions.log` as `surface-replace skipped reason=…` (deduplicated, bounded).
- **Fail-open chain**: surface service or `surfaceOp` unavailable (older host),
  compaction lock open (`compaction/start`..`compaction/end`), version drift on
  surfaceOp semantics — every one of these degrades to the legacy behavior:
  splice-only view, `wire=raw` banner, tally-driven watermark. Never a broken
  request.
- **Flag**: `surfaceFold` (default `true`). OFF keeps exactly the pre-1.10.0
  behavior; with the gate above unchanged, the watermark simply stays on the
  tally for frozen-dispatch sessions.

After a successful surface replace, the meter view and the wire converge
naturally and the banner stops showing `wire=raw` from the next step on; the
`injectView` telemetry remains in the log for observability.

## What the current design supersedes

- **"Mutable dispatch still receives the folded view."** The pre-1.9.1 claim
  that the dispatch producing the model response always carries the fold view
  is false for frozen dispatches; it is replaced by the four-value contract
  above. No documentation or banner may promise fold delivery through the
  splice path alone.
- **Meter duality, old split.** The original porting notes proposed keeping the
  watermark on the STORED tally forever and using view estimates only for trim
  triggers. Superseded: the watermark now reads the outbound view (so folding
  relieves the watermark), with the wire-truth gate as the correctness
  backstop — view reads are allowed only while the view provably reaches the
  wire, otherwise the tally takes over. Stored tallies still bound disk/context
  pressure but no longer drive tiers.
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
