# Surface-replace smooth folding (v1.10.0 design)

## Goal

Make context-trim folds actually reach the wire, smoothly, without relying on the
force-tier handover fallback. Today folds are committed to the ledger but never
ship, because the host deep-freezes every loop-assembled request (splice level is
closed by design). The host's own compaction proves the escape hatch: history is
a DERIVED projection of an append-only event log, and appending an event with
`surfaceOp: {op:'replace', startSeq, endSeq}` shadows a range in the projection.
We clone that mechanism for folds.

## Host mechanism (recon evidence, checkout 22ddee3792)

- `Session.deriveMessages()` — packages/core/session/src/index.ts:999-1020 walks
  `surface.nodes`; replace events remove shadowed nodes from derivation.
- Loop read seam: packages/core/agent-loop/src/agent.ts:721 `buildRequest` calls
  `session.deriveMessages()`; freeze happens AFTER assembly (:720-735) — source
  level is upstream and unaffected.
- Precedent (no LLM): `ToolResultPruner` Service appends metering + one
  replacement event with `surfaceOp` (compaction-tool-result-pruner/src/index.ts:159-172).
- Validation: `sourceEventSeqs` must cover EVERY shadowed surface node
  (packages/core/session/src/surface.ts:329-363); range ordered (:415-428);
  compaction lock = durable `compaction/start`..`compaction/end` pair.
- Installed app.asar verified: 282 `surfaceOp` occurrences (mechanism present).

## Design

New module `host/context-trim/surface.js`, wired from context-watch.js (or a
small Service registration in index.js):

1. Trigger: `ctx.on('agent/turn-stopping')` (serial, no request in flight) plus
   an idle sweep for child/idle sessions. Per session:
   - If the ledger has committed fold blocks that are NOT yet reflected on the
     wire surface (the wire=raw case: blocks folded during freeze windows), and
     the session's live surface still contains the shadowed message range:
   - Compute the fold-block's rendered text (existing view.js block renderer).
   - Append ONE replacement `user/message` (source kind cloned from the host
     compaction checkpoint, compaction/src/checkpoint.ts:19-37) with
     `surfaceOp: {op:'replace', startSeq, endSeq}` and `sourceEventSeqs`
     covering every surface node in the range, preceded by a metering event per
     the shadow-price protocol (synchronously adjacent appends).
   - Record `surface-replace applied` in decisions.log; bump a per-session map
     so the same range is never replaced twice (idempotence guard keyed by
     startSeq..endSeq + contentGeneration).
2. Range selection reuses the existing fold bookkeeping: blocks are
   tool-pair-balanced already; `refPositions` from the ledger map 1:1 to
   surface node seqs captured at fold time (needs a capture-time field: store
   the surface event seqs alongside refPositions in the ledger block).
3. Fallback: if `agents` service / `session.append` / surfaceOp is unavailable
   (older host), keep today's behavior unchanged (wire=raw banner + tally
   watermark). Feature-flag: `surfaceFold` config, default ON.
4. The wire-truth gate stays: after a successful surface replace, the meter
   view and the wire converge naturally; `injected` telemetry remains for
   observability.

## Constraints / risks

- Append-only log: shadowed events stay forever (fine — same as compaction).
- Respect compaction lock: never append a replace while a
  `compaction/start`..`compaction/end` pair is open for the session.
- Metering: follow the pruner's synchronous-adjacent shadow-price protocol or
  the token meter drifts.
- Replay determinism: SurfaceManager replays appends on resume; replacement
  events must be deterministic (no timestamps in content beyond what the
  existing block renderer already emits).
- Version drift: surfaceOp semantics are versioned (format migrations
  v2→v4); runtime feature-detect before use, fail-open to legacy behavior.

## Acceptance

- New test file scripts/test/trim-surface.test.mjs: fold during frozen dispatch
  → surface replace appended on turn-stopping → deriveMessages-equivalent view
  shrinks; idempotence (second turn-stopping appends nothing); lock respected;
  feature-flag off → no appends; fallback when service missing.
- All existing suites green; `node scripts/validate.mjs` OK.
- Live: decisions.log shows surface-replace rows; banner stops showing wire=raw
  after the next step following a fold.
