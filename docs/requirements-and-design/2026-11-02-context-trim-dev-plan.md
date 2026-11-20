# context-trim implementation brief (Round 1 handoff)

GOAL (user, m00092): fully-automatic context trimming inside dsh-switchman, keeping KV-cache hits.
Design doc (read FIRST, in full): docs/requirements-and-design/2026-11-02-context-trim-port-design.md
Repo: /Users/mrzturn/Documents/code/my/GitHub/dsh-switchman (v1.8.1, ZERO runtime deps — keep it that way; devDeps: yaml only)

## CONFIRMED host API facts (verified this session — do NOT re-verify)

1. llm/stream listener (THE view-builder hook), from billion-context/dist/agent/dsh-native.js live code:
   const onEvent = ctx.on.bind(ctx);
   ctx.inject(["llm"], () => {
     onEvent("llm/stream", (options, next) => {
       // waterfall listener: (options, next); outermost-first; NOT calling next() vetoes the chain
       // options.messages is the live request messages array — mutate IN PLACE, then:
       return next();
     });
   });
   - cordis waterfall (cordis/lib/index.js:317): last arg = innermost next; listener runs, calls next().
   - dsh-llm/lib/index.js:2397: return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
   - dsh-agent-loop/lib/index.js:1084: const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request); — every agent-loop model call passes through it.
   - Session attribution: options.sessionId (string) when present; fallback ctx.agents?.currentInitiator?.()?.session?.id (try/catch).
   - bili also validates message ids: string, <=512 chars, no whitespace/control, unique, skip ids starting "acp_summary_".

2. llm service access (intent.js:517-540, 738-757, 902-932):
   - ctx.get("llm", false) -> { prepareCall, stream, resolveModelInfo, registerAdapter } — call methods ON the llm object (receiver-bound).
   - ctx.inject(["llm"], (llmCtx) => llmCtx.llm) defers mount until llm fiber ready.
   - aux side-call: const call = await llm.prepareCall({...}); for await (const chunk of call.stream(options)) {...}

3. Plugin conventions (host/context-watch.js, 1029 lines — READ IT before writing code):
   - ctx.systemPrompt.section({name, order, interpolate:false, text}) = byte-stable head (KV invariant).
   - ctx.systemPrompt.context({name, order:300, required:true, interpolate:false, text:renderFn}) = live tail snapshot.
   - ctx.tokenMeter?.measure?.(agent.session)?.totalTokens = STORED-surface reading.
   - Events: ctx.on("tools/post-execute" | "tools/pre-execute" | "agent/status" | "agent/inbox/claimed", fn).
   - ctx.tools.register({name, description, parameters: FULL object-root JSON Schema, output:{schema,render}, async execute(args, exec), presentCall}) — register-level shape, best-effort try/catch.
   - ctx.commands.register({...}); ctx.commands.find(agent, "compact") = per-agent scoped /compact definition.
   - Fail-open EVERYWHERE: try/catch every host touch, degrade to no-op, never throw into assembly.
   - Layer pattern: applyXxx(ctx, config, logger?) from host/*.js, wired in index.js.

4. Messages at the llm/stream boundary are plain JSON-ish objects: {id?, role, content blocks / text}. Treat as opaque; canonicalize (stable key order, drop volatile fields like timestamps) before hashing. NEVER split an assistant message carrying tool_calls from its tool results (design §4, dsh-compaction/lib/index.js:557 validates pairs).

## BUILD (target files, all NEW except index.js edits)

host/context-trim/
- state.js: per-session (key = agent sessionId) fold ledger. Model: blocks[] {id, kind:"summary", refRange:{firstId,lastId}, summary, tier, createdAt}, frontier = ref of oldest folded item, monotonic (only advances). Persist JSON to <dshHome>/.dsh-switchman/state/trim/<sessionId>.json (host/lib/dsh-home.js for home resolution). Atomic write (tmp+rename). Fail-open: corrupt file -> reset ledger, keep going.
- view.js: pure function buildView(messages, ledger) -> messages'. Fold = replace contiguous folded range with ONE synthetic user message [SWITCHMAN:TRIM] <summary block text>. Deterministic: same ledger + same prefix => byte-identical output prefix (golden test). Never touch messages beyond frontier; never split tool pairs; protected tail (last N messages, default 6) never folded.
- trigger.js: three tiers (port of bili policy, m00068 answer): (a) growth gate PRIMARY: growth-since-last-fold > 22500 AND contiguous-compressible-increment >= 50000 (absolute tokens; count via cheap char/4 estimate); (b) pressure: view usage >= 75% of window -> consider every turn; (c) emergency: >= 95% -> forced fold of largest blocks without side-model (mechanical truncation summaries). Config keys under trim* namespace (see config schema below).
- summarizer.js: L3 side-model folds via llm.prepareCall + call.stream (pattern #2). Prompt: compressive summary rules (open objectives carry-forward with refs, keep paths/line numbers verbatim, decisions+rationale, exact values, drop verbose logs). Timeout guard, best-effort; on failure -> skip this fold cycle (never block the main call). Fold only happens at IDLE boundary (agent/status or tools/post-execute after turn end), NEVER synchronously inside llm/stream.
- metrics.js: wrap next() result; sample usage chunks (finish chunk carries usage) -> per-session {lastInputTokens, cachedTokens?, viewTokens estimate}; growth = lastInputTokens deltas. Logs via logger.
- index.js (module assembly): applyContextTrim(ctx, config, warn) — registers llm/stream listener via pattern #1, agent-status idle hook for fold execution, ctx_trim_fold + ctx_trim_status tools (register-level shape), systemPrompt head section (byte-stable protocol) + live context line (view tokens, fold count, growth) mirroring watermark pattern.

index.js (plugin root): import + applyContextTrim(ctx, config, warn) after applyContextWatch; NO new inject entries needed except none — llm reached via ctx.inject(["llm"]) inside the layer. Wait: ctx.inject is called by the layer itself (pattern #1). Confirm inject list unchanged.

config: add trimEnabled (default true), trimMode ("off"|"advisory"|"auto" = L1/L2/L3, default "auto"), trimGrowthTokens 22500, trimIncrementTokens 50000, trimPressurePercent 75, trimEmergencyPercent 95, trimProtectedTail 6, trimMaxFoldsPerHour 6, trimSideModel (default: inherit session model), trimStateDir (default under dsh home). Add to settings card schema in client-facing config docs IF the repo has a config schema file — check how wmSoftTokens etc. are exposed (host/config.js readNumber pattern) and mirror it.

## TESTS
scripts/test/context-trim.test.mjs using node:test (zero deps): golden determinism (same ledger+messages -> identical view twice, and view prefix stability when tail grows), tool-pair integrity, frontier monotonicity, trigger thresholds, state persistence round-trip + corrupt-file reset. Run: node --test scripts/test/. Add "test": "node --test scripts/test/" to package.json scripts.

## HARD CONSTRAINTS
- ZERO new runtime deps. Node built-ins only (fs, path, crypto for sha256).
- Fail-open: any error inside llm/stream listener -> log + return next() untouched. NEVER veto (always call next()).
- Fold decisions at idle boundary only; llm/stream is pure synchronous view application.
- English comments/docs, tab indentation, match repo style (JSDoc headers per module).
- Do NOT touch context-watch watermark tiers this round (separate todo).
- scripts/validate.mjs must still pass.

## VERIFY
1. node --test scripts/test/ all green. 2. node scripts/validate.mjs green. 3. node -e "require('./index.js')" loads without throwing (syntax check; it may fail on cordis import in bare node — if so use node --check per file).
Report: files created/changed with line counts, test output tail, any deviations from this brief and why.
