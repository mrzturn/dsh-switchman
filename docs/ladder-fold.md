# Ladder folding — T1/T2/T3 tiers in the fold engine

> Design for the v1.11 fold-engine upgrade. Status: implemented as of this
> revision. Builds on [context-trim.md](./context-trim.md) (inject contract,
> wire-truth gate, surface ship pass) and follows the borrow verdicts in
> [positioning.md](./positioning.md). Mechanism source: the acp-kernel tier
> model (`ranxianglei/acp-kernel` DESIGN.md §3-§4, `src/compress.ts`
> `resolveTargetTier`/`pendingByTier`/`decideNudge`), re-expressed for an
> in-process, engine-paced folder — no transport attach, no external process.

## What changes

Three things, in priority order:

1. **T1/T2/T3 ladder folding.** Fold blocks gain a tier. T1 folds raw message
   ranges (today's behavior). T2 distills a contiguous run of active T1
   summaries into one block; T3 distills active T2 blocks the same way.
   Consumed blocks deactivate (never deleted) and their coverage is subsumed
   by the consuming block, so the outbound view stops creeping upward in
   long sessions — today the floor rises +0.5–2k per cycle because every
   summary absorbs the previous summary and stays raw forever.
2. **The model never sees the water level.** Every model-visible numeric
   readout is removed: the `[SWITCHMAN:TRIM]` context line (view tokens,
   `% of window`, folds, growth), the watermark's `used ~Nk of budget A/B/C`
   heads, and `ctx_trim_status`'s window/threshold/view lines. bili lesson
   #2 (positioning appendix): a model told "you're at 20%" anchors on
   "looks healthy" and refuses to fold; with numbers hidden, judgment roots
   in the task. Range-level true sizes stay visible (lesson #5 — the
   recommendation list is the interface between bookkeeping and judgment);
   the *fill percentage* and absolute water level never are. Human
   diagnostics move entirely to `decisions.log` + the client badge.
3. **The trim settings card actually persists.** Pre-existing bug found
   during this work: `host/routes.js` `coerceValues`/`snapshotOf` had zero
   trim fields, so the client page's trim card was decorative — edits were
   dropped server-side on every save. All trim fields (old and new) are now
   coerced, snapshotted, and fenced.

Non-goals (explicitly, per positioning): tier-2 re-distillation remains a
rare maintenance path, not a routine one; no decompress/unfold tool this
revision; no transport attach of any kind; the six-pool dispatch, teams,
intent, vision organization core is untouched.

## Tier semantics

```
T1 block: { id, tier: 1, refRange: {firstId, lastId}, count, approxTokens,
            summary, active: true, consumes: [] }
T2 block: { id, tier: 2, refRange: null, count: <consumed count>,
            approxTokens: <sum of consumed>, summary, active: true,
            consumes: [b1, b2, ...] }   // contiguous run of active T1 ids
T3 block: same shape, consumes = contiguous run of active T2 ids
```

- A ladder commit **deactivates** its consumed blocks (bili: `active=false`)
  and keeps them in the ledger forever — coverage is expressible, history is
  never rewritten.
- The raw fold frontier is a T1-only concept and is untouched by ladder
  commits: new raw material still folds into fresh T1 blocks beyond the
  frontier after (or while) ladder folds distill the summary population.
- One consumption each: a block consumed by a ladder block can never be
  consumed again (validated at commit).
- Ladder runs must be contiguous in the LEDGER (creation order) and adjacent
  in the VIEW (their raw spans tile — true for every engine-paced fold since
  each T1 starts at the previous frontier+1; advisory model folds that fold a
  middle range create non-adjacent runs, which the view builder refuses to
  distill — fail-open, and the commit-time adjacency check rejects them
  first when the capture is available).

## Trigger model

Evaluated at the same idle boundary, after the raw tiers, and only in
`trimMode: "auto"` with `trimLadderEnabled`:

```
priority: emergency(T1, mechanical) → pressure(T1) → growth(T1)
          → ladder (best of ready T3/T2 by summary mass, T3 wins ties) → none
```

- **T2 ready** when active-T1 summary mass ≥ `trimLadderT2Tokens` (default
  8000) AND active-T1 count ≥ `trimLadderT2MinBlocks` (default 3). The mass
  gate is the need signal (bili #379: block *count* is not a need signal —
  10:1-condensed summaries can stack many near-empty blocks; the count gate
  only filters degenerate two-block distills).
- **T3 ready** when active-T2 mass ≥ `trimLadderT3Tokens` (default 6000) AND
  count ≥ `trimLadderT3MinBlocks` (default 2).
- Cadence: a ladder fold is a side-model call; it shares the hourly cap
  (`trimMaxFoldsPerHour`) and observes its own minimum interval of 120 s
  after ANY fold (any fold rebuilds the view; interleaving a ladder fold
  between T1 folds would churn the serialized tail twice per minute for
  marginal reclaim). The minimum-benefit idea behind bili #198 is carried by
  the mass gates themselves: sub-threshold distills never fire, so the
  trigger can never enter a zero-yield reset loop.
- Prefix-cache discipline: a T2/T3 fold rewrites the wire from its first
  consumed summary onward (bili #1249). The mass gates keep ladder folds
  rare (a few per session); raw T1 folds stay the primary, cheap cadence —
  exactly bili's default posture (count-trigger distills default OFF, token
  mass is the trigger).

## View construction (view.js)

Deterministic three-pass rebuild — same `(messages, ledger)` in, byte-
identical view out:

1. **T1 pass** (existing logic, one change): locate *every* T1 block — active
   AND consumed — on the raw messages. Consumed T1 summaries must render in
   the intermediate view because they are the ladder's raw material (their
   ranges are identical to when they were active; refs are content-anchored).
   Overlap/tail/system-head/segment guards unchanged.
2. **T2 pass**: for each active T2 block (ledger order), locate the synthetic
   messages of its consumed T1 ids by their `acp_summary_<id>` ids; require
   all present, indices strictly consecutive ascending, span not already
   covered by an applied ladder block; replace the run with the T2 summary
   message.
3. **T3 pass**: identical over active T3 blocks and their consumed T2
   summaries (which exist post-T2-pass).

Fail-open throughout: a ladder block whose consumed run is incomplete,
non-adjacent, or overlapped is skipped for this view (never guessed); the
block stays active and retries next dispatch. `applied` counts every
replacement actually rendered (T1 + ladder); `unlocated` keeps its T1-only
meaning; epoch detection (`ledgerIsStale`) unchanged.

## Commit path (state.js)

- Ledger format **v2**. v1 files migrate on load: every block gains
  `tier: 1` (legacy `tier` strings map: emergency/pressure/growth/model → 1),
  `active: true`, `consumes: []`; the file re-persists as v2. Unknown format
  still resets (existing forensics).
- `commitFold(sessionId, candidate, posMap)` dispatches on
  `candidate.consumes`: non-empty → ladder path; else T1 path (now stamps
  `tier: 1, active: true, consumes: []`).
- Ladder validation (all must hold): every consumed id exists; every
  consumed block is active; every consumed block has `tier === candidate.tier - 1`;
  consumed ids are consecutive in the ledger's block list; no member of the
  run is already consumed (implied by active-check); view-adjacency when a
  posMap is available (each pair `next.firstIdx === prev.lastIdx + 1`).
  Rejections: `ladder-consumed-missing`, `ladder-consumed-inactive`,
  `ladder-tier-mismatch`, `ladder-not-contiguous`, `ladder-not-adjacent`.
- On success: consumed blocks flip `active: false`; the new block appends;
  `lastFoldAt`/`foldsThisHour` advance (shared cadence bookkeeping);
  frontier unchanged.

## Summarizer (summarizer.js)

- `renderLadderMaterial(blocks)`: renders each consumed block as
  `--- [block <id>] (tier N, ~<tokens> tokens, <count> msgs) ---` + its
  summary text, capped by the same 400k material ceiling.
- `LADDER_SYSTEM_PROMPT`: distillation craft — merge the N summaries into
  ONE shorter self-contained summary; keep goals, decisions WITH rationale,
  exact paths/signatures/error strings/values, open objectives with their
  message refs; drop process, repetition, settled details; same language as
  the material; output only the summary. The output replaces its inputs
  permanently — say so.
- Ladder folds never run mechanically: if the side model is unavailable the
  cycle skips and the failure ladder backs off (emergency relief remains a
  raw-material mechanical T1 — mechanical summary-of-summaries reclaims
  little and corrupts craft).

## Surface ship pass (surface.js)

Ladder blocks ride the same `compaction/prune` + `surfaceOp replace` pair:

- A ladder block is pending until `surfaceReplaced` exists, same as T1.
- Resolution (ladder branch inside the sweep loop): every consumed block must
  already carry a `surfaceReplaced` marker (its replacement node IS the
  ladder's surface material). Missing marker → keep pending (T1 ships
  earlier in the same sweep refresh the markers the ladder reads; the loop
  processes the ledger in order). A consumed block hard-skipped
  (`surfaceSkip`) tombstones the ladder as `ladder-consumed-skipped` —
  generation-keyed like every skip, so a surface change re-opens both.
- Each consumed marker's `atSeq` must resolve to a live node; the span
  between first and last must contain EXACTLY the consumed replacement nodes
  (`seqs` set equality, every node an `acp_summary_` message). Nothing can
  legitimately interleave there (engine folds are frontier-ordered), so a
  mismatch tombstones as `ladder-span-mismatch` — never a guessed span.
- `overlapsReplacedRange` runs with the consumed ids exempted (the span's
  seqs ARE the consumed markers' seqs).
- The replacement message is `replacementMessageOf(ladderBlock)` — same
  `acp_summary_` id prefix and `[SWITCHMAN:TRIM]` content prefix downstream
  tooling already recognize; `sourceEventSeqs` covers every shadowed node.
- No tool-pair closure needed (summary user-messages open no calls); the
  system-head clamp stays defensively.

## Model-visible surface after this change

| Channel | Before | After |
| --- | --- | --- |
| `systemPrompt.context` "switchman:trim" | view ~Nk (P% of window W), folds N, growth ~Nk, wire=raw | **removed** (registration gone; diagnostics live in decisions.log `view-applied` rows) |
| `[SWITCHMAN:WATERMARK]` live line | `used ~Nk of budget A/B/C` + tier | tier directive only — **no numbers, no percentages, no budget values**; emitted on tier change |
| watermark protocol head | promises "bucketed used-token reading" | states the number-free disclosure policy |
| `ctx_trim_status` | view estimate, window tokens, threshold percentages | mode, active-block ledger with true sizes, foldable raw range with true size, ladder targets with true sizes — **no window, no fill %, no thresholds percentages** |
| handover phase lines | phase/attempt/cooldown-min | phase only; cooldown drops its minute count |

Byte-stability improves as a side effect: the runtime-context snapshot now
changes only at tier crossings instead of every 5k-token bucket step.

## decisions.log vocabulary additions

- fold decision rows carry `tier=ladder-2|ladder-3` and
  `reason=ladder mass ~<n> >= <threshold> blocks=<n>`.
- outcome rows: `outcome=folded:ladder-2:<n> blocks (~<n> tokens)`.
- ship rows gain `ladder=tier` (`surface-replace startSeq=… ladder=2 …`).
- new ship-skip reasons: `ladder-consumed-skipped`, `ladder-span-mismatch`,
  `ladder-span-gone`, plus commit rejections `ladder-*` surfacing through
  `outcome=commit-rejected:<reason>`.

## Fork inheritance

`resolveInheritance` clones blocks verbatim (tier/active/consumes ride
along; surface bookkeeping stripped as before). A child inheriting a ledger
with ladder blocks renders the same compressed view as the parent. The
frontier guard is unchanged. Guards added: `active`/`consumes` normalized
during migration so pre-v2 parents inherit cleanly.

## Tests (scripts/test/trim-ladder.test.mjs + updates)

- migration v1→v2 (tier/active/consumes defaults; re-persist as v2)
- ladder commit validation matrix (missing/inactive/tier-mismatch/
  non-contiguous/non-adjacent/double-consume; success deactivates consumed,
  frontier frozen, cadence stamps advance)
- view: T2 replaces a consumed T1 run; T3 over T2; fail-open on
  non-adjacency; determinism golden; protected tail; epoch detection intact
- trigger: mass gates, block-count floors, priority over raw tiers, raw-first
  when both ready, hourly cap + 120 s interval, nothing-foldable-raw still
  ladders
- invisibility: watermark root/sub lines contain no digits-attached
  token/% disclosures at any tier; trim layer registers no
  `systemPrompt.context`; `ctx_trim_status` output contains no `%` and no
  window token count
- loop: mock-host full cycle — T1 folds accumulate → ladder fires → view
  shrinks → re-dispatch renders the distilled view
- surface: ladder ship over consumed markers; span-mismatch tombstone;
  pending-until-consumed-shipped ordering; fork inheritance with ladder
  blocks
- routes: `coerceValues`/`snapshotOf` round-trip the trim fields (fixes the
  decorative-card bug)

## Pitfalls carried from bili (positioning appendix mapping)

| bili lesson | Where it lands here |
| --- | --- |
| #2 never disclose fill % to the model | all model-visible numeric readouts removed |
| #5 recommendation list with true sizes | `ctx_trim_status` range/block sizes |
| #198 zero-yield loop | mass gates only; sub-threshold distills never fire/reset baselines |
| #379 count is not a need signal | count floors filter degenerate runs; mass is the trigger |
| #1249 distillation rewrites the wire | rare, mass-gated ladder folds; raw T1 stays the cheap cadence |
| #398 in-place refold | not built (duplicate-range guard unchanged) |
| age-based GC caused memory loss upstream | no deactivation without consumption; blocks never deleted |
| gate must outlive kill-switch (their #3662 bricking) | nothing new gates session creation; the fold gate stays capability-probe based |
