# Surface-replace smooth folding

Status: the design below is v1.10.0; behavior changed in v1.10.1/v1.10.2. The
post-1.10.1 fixes and the wire-truth semantics are documented at the end of this
file; the operator-facing summary lives in
[docs/context-trim.md](./context-trim.md).

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

## Post-1.10.1 fix: the incomplete-seqs deadlock (2026-11-05)

A real resumed session folded 61.7k tokens (#2) yet the swap never reached the
wire, and folding then stopped for 35 minutes while the prompt grew to 136k.
Two independent defects combined:

1. **Surface-node seq order is model-visible order, not log order.** A replace
   op splices a NEW event seq into the middle of `surface.nodes`, so a captured
   span that crosses a replacement is legitimately non-monotonic (the real
   capture was `[376, 229, 230, ...]`). `validateStoredSeqs` demanded strictly
   ascending seqs and therefore rejected every capture that
   `captureFoldSeqs` had just produced on the same surface —
   `reason=incomplete-seqs` forever. Fixed: uniqueness + dense span + endpoint
   identity, no ordering assumption (`host/context-trim/surface.js`).
2. **The recency gate froze folding.** `maybeFold` paused whenever
   `inject === "none"` and the last surface ship was older than the 10-minute
   in-memory window. Resumed sessions always dispatch `injected=none`, so after
   ten minutes (or any restart) no fold ran, no fold shipped, and the gate
   stayed shut. Fixed: the gate asks the durable capability probe
   `surfacePass.supported(sessionId)` (enabled + live session with
   `append`/`surface.nodes`); `TRIM_VIEW_MAX_AGE_MS` is display freshness only.
   The banner's `wire=raw` now stands down only on SHIPPED evidence — a
   ledger block carrying `surfaceReplaced`; a commit-time capture
   (`surfaceSeqs`) that may never ship must not silence the warning.

A capture that goes stale is still never blindly re-targeted. Live
re-location is allowed only when the block's refs resolve count-anchored, the
STORED first/last seqs are still live surface nodes AND equal the located
span's endpoints (`refOf` is content-addressed for messages without ids, so an
earlier look-alike span locates just as well), and the located span shares no
seq with a range another block already replaced. Collision checks prefer the
marker's shipped seq set (`surfaceReplaced.seqs`) and fall back to the other
block's capture, then to the numeric interval for legacy markers. Otherwise the
`incomplete-seqs` tombstone stays.

`surfacePass.supported()` also requires that no durable
`compaction/start..compaction/end` lock is open, since `sweep` defers under
one: without it the fold gate kept folding (≤6 summary-model calls/hour) into
a channel that could not ship. Lock state is cached per session `seq`, so the
idle-frequency probe stays O(1).

Known limitation (deliberately not fixed here): the trigger math still fires
*pressure* on any usage at/above the percentage (no hysteresis or increment
floor), and the *growth* anchor mixes units — an MD5-of-tokens view estimate
compared against a stored `lastFoldLowTokens`, so a large fold can leave the
growth gate armed one cycle too long. Both only cause an extra cadence-gated
fold attempt, never a wrong range; a trigger redesign is tracked separately.

Wire truth in the logs: `view-applied` rows carry `wire=<tokens>` when the
provider tally is known, and pressure/emergency tiers run on
`max(view, wire)` — the view estimate omits the system/context sections, so a
136k prompt once read as a 50k view and the tiers stayed silent. `wire` is the
provider's full prompt size: uncached `inputTokens` + `cacheReadTokens` (plus
`cacheWriteTokens` when the provider reports a separate write bucket)
(`host/context-trim/metrics.js:50`).

## Expected steady state

With the fixes in place the loop settles into a sawtooth well below the window
(deepseek-flash, 150k window, current defaults — mirrors docs/context-trim.md "Expected steady state"):

| Point in the cycle | view | wire |
| --- | --- | --- |
| just after a ship | ≈ 22–25k | ≈ 40–44k |
| growth gate re-arms (foldable span ≈ 25k) | ≈ 47–50k | ≈ 64–67k |
| pressure tier (65% of 150k) | ≈ 80.2k | ≈ 97.5k |

`wire − view` stays at the fixed overhead O ≈ 17.3k. The floor creeps +0.5–2k
per cycle (each summary absorbs the previous one, and the 10 protected tail
messages stay raw), so the ceiling — pinned at 97.5k by the pressure tier — is
what actually bounds the prompt, not the window.
