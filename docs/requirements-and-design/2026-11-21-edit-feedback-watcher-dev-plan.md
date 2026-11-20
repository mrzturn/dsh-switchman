# Edit-tool feedback watcher (W1/W2/W3) — design & handoff

> Version: v1.1　　Date: 2026-11-21　　Related modules: `host/tool-args-sanitize.js`, `host/subagent-model.js`, `host/config.js`, `index.js`, `cordis.patch.yml`
>
> **Confirmed decisions (2026-11-21)**:
> - **Implementation surface**: a `tools/post-execute` waterfall listener — verified to exist in the DSH core pipeline and to receive failed results (see §2.2; precedent: `host/subagent-model.js:144-149`).
> - **Rewrite mechanism**: the `block` decision (`PostToolDecision`, `packages/core/tools/src/contracts.ts:386`) replaces an errored tool result's content with corrective feedback. This is the contract's stated purpose ("block by turning corrective feedback into an error result"), and `accept.value` is forbidden on failed results — so `block` is the only sanctioned content rewrite for errors.
> - **Lenient matching is diagnosis-only**: whitespace/indentation-flexible matching runs in plugin memory to classify the failure and compose feedback; it NEVER writes to disk. Rationale: SWE-agent's recorded lesson — fuzzy matching that applies edits silently corrupts files (https://swe-agent.org/latest/background/edit_formats.html).
> - **Zero runtime dependencies** (repo invariant, AGENTS.md): pure JS string algorithms; no tree-sitter, no ast-grep, no external apply-model API.
> - **Fail-open**: the whole listener body is wrapped in try/catch; any internal error returns `next()` unchanged. Mandatory because the pipeline turns a throwing post-execute listener into `isError` (`pipeline.ts` postExecute docstring).
> - **Scope cut**: W4 (post-success syntax gate) is explicitly deferred to a separate design; the neural apply-model path (Morph/Relace) is rejected (non-deterministic writer, external API, audit problems).

## 1. Goal

Native DSH edit tools fail closed with bare errors when `old_str` misses or matches multiple times. Each failure costs the model 1–2 extra read rounds to re-derive context that the tool already had at failure time. This plan adds a switchman layer that **intercepts native edit-tool failures and re-emits them as self-contained corrective feedback** (verbatim target lines, per-match excerpts, and the correct retry recipe), so the model can fix the retry within the same round. A small doctrine section for native edits (W3) replaces the removed hash-anchor section (commit `14f3046`).

Non-goals: no new tools, no schema changes to native tools (impossible from a plugin), no disk writes by the watcher, no lenient auto-apply.

## 2. Verified current state (evidence)

DSH source checkout: `/Users/mrzturn/Documents/code/my/GitHub/deepseek-harness` (tracking upstream; `git pull --ff-only` allowed per AGENTS.md). Installed-runtime cross-check: `strings -a "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" | grep <keyword>`.

### 2.1 Native editor error matrix (THE parse targets)

| Tool | Code | Message template (verbatim from source) | old_str echoed? | Line numbers? | `replace_all`? | Source |
|---|---|---|---|---|---|---|
| `str_replace_editor` | `FS_EDIT_NOT_FOUND` | `` No replacement was performed, old_str `${oldValue}` did not appear verbatim in ${path}. `` | ✅ full, backtick-delimited | ❌ | ❌ (param does not exist) | `packages/fs/tool-str-replace-editor/src/index.ts:306` |
| `str_replace_editor` | `FS_AMBIGUOUS_EDIT` | `` No replacement was performed. Multiple occurrences of old_str `${oldValue}` in lines [${lines}]. Please ensure it is unique `` | ✅ full | ✅ all hit lines | ❌ | `index.ts:313` (multi-match detection at `:302-315`, `matchOffsets` at `:44-52`) |
| `edit` (tool-fs) | `FS_EDIT_NOT_FOUND` | `old_string was not found in "${displayPath}"` | ❌ path only | ❌ | ✅ | `packages/fs/fs-local/src/fsio.ts:863` |
| `edit` (tool-fs) | `FS_AMBIGUOUS_EDIT` | `` old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true `` | ❌ | ❌ (count only) | ✅ | `fsio.ts` a few lines below `:863` |

Critical asymmetry: `edit`'s NOT_FOUND message does NOT echo `old_string` — but the watcher takes it from the call args (`exec.arguments.old_string`), so diagnosis is still possible. `edit` matches on **LF-normalized content** (`fsio.ts:847` docstring "the edited LF-normalized content"), so CRLF-only drift cannot cause NOT_FOUND for `edit`; `str_replace_editor` matches the **raw** text verbatim (CRLF or trailing-whitespace drift ⇒ genuine NOT_FOUND).

`remediateFsError` (`packages/fs/tool-fs/src/error.ts:29-39`) may append `" — re-read the file, then retry"` to FsError messages and has a dedicated unread-file message (`cannot modify "...": file has not been read — read the file, then retry`). **Parsers must tolerate a trailing remediation suffix**; the exact condition for appending is a [Pending] read (Q3).

Also verified: `edit` schema fields are `file_path` / `old_string` / `new_string` / `replace_all` (`tool-fs/src/edit.ts:94-96`); empty `old_string` and `old_string === new_string` are arg-level errors (`edit.ts:49-50`). `edit` counts occurrences on the LF-normalized content with the LF-normalized needle (`applyLiteralEdit`, `fsio.ts:850-880`); `str_replace_editor` counts with bare `indexOf` on the raw text (`matchOffsets`, `index.ts:44-52`).

### 2.2 Post-execute decision surface (verified)

- Contract, `packages/core/tools/src/contracts.ts:386`:
  ```
  PostToolDecision =
    | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
    | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
    | { kind: 'block'; feedback: ContentBlock[]; info?: ToolErrorInfo; additionalContexts?: UserMessage[] }
  ```
- Pipeline, `packages/core/tools/src/pipeline.ts` (`postExecute`, ~`:498`): waterfall over scope `'tools/post-execute'` with default `{ kind: 'accept' }`; a `block` decision returns `markCanonical` with `isError: true`, `content: feedback`, optional `error.info` from `decision.info`. Docstring confirms: "block turns it into an `isError` whose content is the corrective feedback"; listeners run "inside execute's outer try/catch (a throwing listener → isError)".
- **Failed results flow through the waterfall**: switchman's own precedent fast-paths on them — `host/subagent-model.js:144-149`:
  ```js
  ctx.on("tools/post-execute", (exec, result, next) => {
      if ((exec?.name !== "subagent" && exec?.name !== "subagent_fork") || result?.isError === true) return next();
      return annotate(ctx, exec, result, next, warn);
  });
  ```
- Registration precedent (module shape, fast-path discipline, doc style): `host/subagent-model.js` in full; index.js wiring at `index.js:87-89` + `apply()` chain.
- Pre-execute precedent (conservative whitelist + fail-open philosophy): `host/tool-args-sanitize.js` (shipped, tested by `scripts/test/tool-args-sanitize.test.mjs`).

### 2.3 What already exists / was just done

- `14f3046` (pushed to main) removed the hash-anchor doctrine section from `cordis.patch.yml` and cleaned `tool-args-sanitize.js` comments; 443/443 tests pass; repo version 1.11.9, working tree clean. The persona suffix currently has **no native-edit discipline section** — W3 fills that slot (same unnumbered position between `## 3` and `## 4`).
- `tools/pre-execute` sanitize layer already transparently fixes malformed argument shapes; it does NOT touch error results — no overlap with this plan.

## 3. Gap table

| # | Gap (current) | Required |
|---|---|---|
| D1 | `edit` NOT_FOUND: bare message, no old_str echo, no location hints → model re-reads and re-guesses | Watcher re-derives diagnosis from `exec.args.old_string` + lenient match; feedback carries the verbatim fresh text |
| D2 | AMBIGUOUS errors list line numbers (`str_replace_editor`) or a bare count (`edit`) without excerpts → disambiguation costs an extra read round | Feedback embeds ±2-line excerpt per hit + how to disambiguate (extend old_str; `replace_all` only where the tool supports it) |
| D3 | All edit failures return bare errors; no corrective guidance anywhere | Class-specific structured feedback; loop-guard escalates to "switch strategy" after repeated failures |
| D4 | Persona suffix has no native-edit discipline section | W3: small section (4 bullets) in the slot freed by `14f3046` |
| D5 | Silent mis-edit class (unique-but-wrong hit; model "wins" the match at the wrong place) has no net | **Deferred** — only a post-success syntax gate (W4) would catch it; out of scope this round |

## 4. Technical design

### 4.1 New module `host/edit-feedback.js` (~180–220 lines)

```
model emits edit call
  └─ tools/post-execute waterfall                       // pipeline.ts postExecute
       └─ edit-feedback listener                        // NEW host/edit-feedback.js
            ├─ fast path: name ∉ {edit, str_replace_editor} OR !result.isError → next()
            ├─ parse error message against §2.1 matrix (tolerate remediation suffix)
            ├─ read the file ONCE via the same fs surface the sanitize layer era used
            │    (verify inject surface — Q1; lean: ctx.get("fs") or exec-scoped fs)
            ├─ classify via lenient matcher (pure functions, no I/O):
            │    exact-unique → (tool bug; pass through)  ·  whitespace-drift-unique
            │    indent-drift-unique  ·  multi-hit (lines + excerpts)  ·  zero-hit (stale/hallucinated)
            ├─ compose feedback (bounded: excerpt ≤ ±2 lines, old_str echo ≤ 600 chars)
            ├─ loop-guard: same file+class ≥ 3 → append "switch strategy: re-read the
            │    region and use write, or split the edit"
            └─ return { kind:'block', feedback:[...], info:{ code: <original code> } }
                 (any throw → caught → next())            // fail-open, mandatory
```

Lenient matcher ladder (diagnosis-only, aider-inspired, no disk writes):
1. **verbatim** — the tool already did this; if it reported not-found, verbatim is 0 or ambiguous.
2. **whitespace-flexible** — fold CRLF→LF, strip trailing whitespace per line, then exact search of the folded needle in the folded content; map hit index back to original offsets.
3. **indent-flexible** — additionally strip leading indentation per line (aider ladder's last text step). If this yields a unique hit, report class `indent-drift` — the model re-indented from memory.
4. No similarity/fuzzy scoring in v1 (zero-hit stays zero-hit; feedback says "re-read the region").

Feedback templates (concise, imperative, English; the model-facing tone matches native errors):
- **multi-hit**: `Your old_string matches N locations: L12 / L48 / L120 — excerpts: … Extend old_string with lines unique to the intended occurrence (e.g. the enclosing function signature).` + for `edit` only: `If every occurrence is intended, set replace_all: true.` (never for `str_replace_editor` — param does not exist).
- **whitespace-drift-unique**: `No verbatim match, but a unique match exists at L48 after whitespace normalization. The file's verbatim text is: <fenced exact block>. Retry with exactly this text.`
- **indent-drift-unique**: same shape, class named.
- **zero-hit**: `No verbatim or whitespace-flexible match — the file changed since you read it, or old_string was reconstructed from memory. Re-read the region and retry with fresh content.`
- **loop-guard suffix** after 3 same file+class failures.

### 4.2 W3 — doctrine section in `cordis.patch.yml` (~5 lines)

Unnumbered `## Native Edit Discipline (edit / str_replace_editor)` section in the slot between `## 3` and `## 4` (where the hash section sat). Bullets:
1. Copy `old_string` verbatim from a fresh read — never from memory; when the target text is generic (closers, imports, repeated keys), include an enclosing unique anchor (signature, identifier, distinct neighbor line).
2. On multiple matches: extend context to disambiguate; `str_replace_editor` has no `replace_all` — for rename-everywhere use the `edit` tool's `replace_all`.
3. After bash/git/formatters touched the file, re-read before editing (out-of-band writers leave no trace).
4. Treat `FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` as "diagnose from the feedback excerpts, fix the anchor" — never retry the same arguments unchanged.

Touchpoints: CHANGELOG Unreleased (Added, bilingual); check whether `preset-patch-parity.test.mjs` asserts section presence (it passed after `14f3046`, so likely it pins schema values only — verify before editing the patch); README feature list mention [Pending, small].

### 4.3 Config & registration

- Config switch `editFeedbackEnabled` in `host/config.js` following the existing switch pattern (lean: **default ON** — it is fail-open, fires only on already-failing calls, and rewrites error content the same way sanitize rewrites args; but this is a maintainer call, see Q5).
- Register in `index.js` `apply()` chain next to `applyToolArgsSanitize` (`index.js:132` import; add `applyEditFeedback(ctx, config)` in the same block). Ordering vs `applySubagentModel` is irrelevant (disjoint fast paths), but keep a test asserting both listeners coexist.

### 4.4 W4 (deferred, do NOT build now)

Post-success syntax gate (`node --check` / `python -m py_compile` for edited JS/TS/JSON/PY files) as the only net for D5. Needs its own design: which file types, undo story, performance budget, config gate. Record as future work.

## 5. Test plan (correctness bar: full matrix + adversarial cases)

New `scripts/test/edit-feedback.test.mjs` (harness style: copy `tool-args-sanitize.test.mjs`'s plain-function pattern). Cases:

1. **Parser matrix** (2 tools × 2 codes × variants): with/without `" — re-read the file, then retry"` suffix; old_str containing backticks, newlines, CJK, `${}`; path extraction for both arg names (`path` vs `file_path` — Q2); truncated echo bounds.
2. **Lenient matcher classes**: CRLF needle vs LF file and vice versa; trailing whitespace drift; indentation drift; multi-hit ordering (byte offsets → line numbers); zero-hit; empty file; 1-line (minified) file — excerpt degeneration must stay bounded (char-window fallback, cap ~300 chars); needle longer than file; needle at BOF/EOF (window clamps); file with \u2028/\u2029 line separators; tab/space mixed indentation; content where whitespace-fold creates a NEW unique match the verbatim search missed.
3. **Decision correctness**: block feedback is `ContentBlock[]`; original `info.code` preserved; non-edit tools and successful results pass through with zero work (spy on next); `str_replace_editor` feedback never suggests `replace_all`; `edit` NOT_FOUND feedback does not depend on message-echoed old_str (args-sourced).
4. **Fail-open**: injected fs read throws → `next()` unchanged; malformed/foreign error messages → `next()`; feedback composition throws → `next()`.
5. **Loop-guard**: 3× same file+class appends strategy line; different file/class does not increment; counter bounded.
6. **Coexistence**: `applySubagentModel` + `applyEditFeedback` both registered; subagent success still annotated, edit error still rewritten.
7. **Config gate OFF**: listener not registered (or permanently fast-paths).
8. **W3**: patch section present + parity test still green; CHANGELOG entry exists.

Scenario coverage for daily use (per user goal): include sample fixtures modeled on — duplicate `import` lines, repeated `});` closers, repeated JSON keys in different objects, repeated markdown headings, files with backtick fences, CRLF Windows files, tab-indented Go-style, CJK identifiers/comments, 1-line minified bundle.

## 6. Open questions (verify at implementation start, ~30 min total)

**All six verified 2026-11-21 against the DSH checkout (HEAD `2e39e70496`).**

| Q | Answer (verified) | Evidence |
|---|---|---|
| Q1 | Call args live on **`exec.arguments`** (NOT `exec.args`). `ToolExecutionInput.arguments: unknown`. Failure results carry structured identity: `toolErrorResult` sets `error: { message, info? }` where `info = { name, code }` for any thrown `HarnessError`. Both edit failure codes are `FsError extends HarnessError`, so a failed call exposes **`result.error.info.code`** — classify on it, use message regexes only as a fallback for results missing `info`. Loop-guard key: a `WeakMap` keyed on `exec.agent` (payload-injected object) → inner `Map<"path␟class", count>`; bounded, GC'd with the agent, naturally per-session. Session cwd when needed: `exec.agent?.session?.header?.cwd` (precedent `host/context-watch.js:648`, `host/lang.js:315`). | `packages/core/tools/src/contracts.ts` (`ToolExecutionInput`, `ToolErrorInfo:271-276`); `pipeline.ts:703-709` (`errorInfo`), `:732-739` (`toolErrorResult`); `packages/fs/fs/src/types.ts:218` (`FsError extends HarnessError`) |
| Q2 | `str_replace_editor` args: **`path`** / `old_str` / `new_str` / `command` — only `command === "str_replace"` can produce the two codes. `edit` args: `file_path` / `old_string` / `new_string` / `replace_all`. | `packages/fs/tool-str-replace-editor/src/index.ts` schema block; `packages/fs/tool-fs/src/edit.ts:94-96` |
| Q3 | `remediateFsError` appends `" — re-read the file, then retry"` ONLY to `FS_STALE_VERSION`, and replaces the NOT_FOUND message entirely for unobserved files (`cannot modify "…": file has not been read — read the file, then retry`, code `FS_NOT_OBSERVED`). **NOT_FOUND / AMBIGUOUS messages pass through verbatim** — still tolerate an optional suffix (harmless), but the matrix messages are the exact wire text. | `packages/fs/tool-fs/src/error.ts` (full read) |
| Q4 | **Confirmed supported.** `postExecute` handles `kind:'block'` regardless of the result's prior state: returns `markCanonical` with `content: feedback`, `isError: true`, `error: { message: failureMessageFromContent(feedback), info: decision.info }`. Accept+value on a failed result throws ("cannot replace the value of a failed result"); accept with both value+content throws — `block` is the only sanctioned rewrite. | `packages/core/tools/src/pipeline.ts` `postExecute` (`:507-549`), `failureMessageFromContent` (`:686-692`) |
| Q5 | **Default ON** (`editFeedbackEnabled: z.boolean().default(true).volatile()`), matching every recent switch promotion (constraints, pool feedback, dispatch stats, pool differentiation, trim budget — all ON since 2026-11-20). Fail-open, fires only on already-failing calls. | `host/config.js` switch block; CHANGELOG 1.11.9 |
| Q6 | `ctx.waterfall(carrier, name, ...args, inner)` composes listeners around `inner`: each listener receives the **same fixed `(…args, next)`**; `next()` runs the remaining listeners (second `next()` throws). **The first non-`next()` return value wins** and short-circuits. So the listener contract is `(exec, result, next)` and returning a decision replaces the pipeline default `{kind:'accept'}`. | `vendor/cordis/src/events.ts` `waterfall` (verbatim read); usage `pipeline.ts:509-513` |

**Implementation deltas vs the v1.0 sketch** (adopted because they are strictly better):

1. **Classify on `result.error.info.code` first; message regexes are only a fallback** for results lacking `info` — more robust than parsing message templates.
2. `old_str` / `old_string` is always taken from `exec.arguments` (edit's NOT_FOUND does not echo it anyway) — the message parsers only need the **path**.
3. **Normalization asymmetry (verified)**: `ctx.fs.readText` does NOT normalize line endings (`readWholeText`, `fsio.ts:396`), while `edit` matches on LF-normalized content (`readForEdit` normalizes both sides). So for `str_replace_editor`, verbatim matching on the raw text mirrors the tool exactly (CRLF/尾随空白 drift ⇒ NOT_FOUND 是真实分类，不是误诊); for `edit`, normalize both sides before counting. The watcher reads via `ctx.fs.readText` — same base surface as both tools.
4. `ctx.fs` is the `fs` **Service** (resolved per-call by tools via `ctx.fs.resolve(path, {signal})`). The plugin must not add `fs` to `inject` (new hard dependency): fetch it defensively with `ctx.get?.("fs", false)` (precedent `host/subagent-model.js:74`); missing service → fail-open passthrough. **No `node:fs` fallback** — reading outside the sandboxed fs surface would bypass DSH's sandbox read path.
5. Failure result content shape: `[{ type: 'text', text: "Error: " + message }]` (with the `Error: ` envelope, `pipeline.ts:732-739`) — matcher fallbacks must strip it.
6. `edit`'s empty-`old_string` error also carries `FS_EDIT_NOT_FOUND` (`old_string must be a non-empty string`) — must be excluded by message check so empty args are not misdiagnosed as a miss.

## 7. Research references (verified this session) + follow-up search seeds

Primary engineering references:
- SWE-agent edit-format evolution — fuzzy-match trade-off + lint-gate lesson: https://swe-agent.org/latest/background/edit_formats.html
- Claude Code Edit tool semantics (exact match, uniqueness, replace_all, re-read rules, bash-view satisfies read-requirement): https://code.claude.com/docs/zh-CN/tools-reference#2
- Anthropic text-editor tool error guidance ("Found N matches… provide more context"): https://platform.claude.com/docs/zh-TW/agents-and-tools/tool-use/text-editor-tool#2
- coder/coder ambiguous-edit fix (error text teaching replace_all): https://github.com/coder/coder/commit/32a894d4a78cfe85d954529381c6681d04b5666e
- n8n `MultipleMatchesError` taxonomy page: https://errors.standardbeagle.com/n8n-io/n8n/found-count-matches-please-provide-more-contex
- aider search/replace ladder (DeepWiki): https://deepwiki.com/Aider-AI/aider/3.2-search-and-replace-logic#1 (aider's own docs page: search "aider edit formats" — URL was garbled in this session's search results, do not cite blind)
- Community extraction of fallback ladders: `apply-edit-block` (PyPI + npm twin): https://pypi.org/project/apply-edit-block/#1
- AST-based editing (rejected for zero-dep, keep as future option): https://github.com/microsoft/genaiscript/blob/58c3659578fbd9f3fb332a14dd462ae0412880fb/slides/slides-ast.md ; https://github.com/apmantza/pi-lens/blob/main/README.md
- pi's multi-disjoint-edit contract: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts
- How assistants edit files (survey): https://fabianhertwig.com/blog/coding-assistants-file-edits
- Apply-models (rejected path, recorded why): https://morphllm.com , https://relace.ai/apply-models ; counterpoint "Fast Apply Models are Already Dead" (two-model failure chain)

Follow-up search seeds for the implementing session:
- `"FS_AMBIGUOUS_EDIT"` / `"FS_EDIT_NOT_FOUND"` (may surface DSH-adjacent discussion)
- `str_replace "old_str not found" feedback excerpt disambiguation coding agent 2026`
- `apply-edit-block fallback ladder exact whitespace flexible match`
- `edit tool ambiguous match occurrence hint parameter design`
- OpenHands edit failure taxonomy (issue #4313, cited in earlier session research — re-verify)
- aider benchmark by edit format (weak-model degradation evidence)
- "quiet failure" class (edit applied at wrong place but reported success): dev.to "How Claude Code, Codex and Aider Write to Your Files"

## 8. Implementation order & estimate

1. Verify Q1–Q6 (read `contracts.ts`, both tool sources, `error.ts`, waterfall impl) — ~30 min.
2. `host/edit-feedback.js`: matcher + parser + composer + listener (pure functions exported for tests) — ~180–220 lines.
3. `index.js` registration + `host/config.js` switch (+ settings-page exposure if the existing pattern makes it trivial) — ~20 lines.
4. W3 patch section + CHANGELOG + parity-test check — ~10 lines.
5. Tests per §5 — ~250–350 lines.
6. Full suite (`node --test scripts/test/*.test.mjs`, currently 443 passing) + manual smoke in a live session (trigger an ambiguous edit, observe enriched feedback).
7. Repo quality rules (AGENTS.md / patch §3): change >20 lines → hand to tester (use `subagent_fork` to keep dispatch minimal per user instruction).

Total ≈ 500–700 lines including tests. Commit style: `<type>: <imperative>` (see `git log`); push straight to main per house flow.

## Appendix: file:line quick reference

| Fact | Location |
|---|---|
| `FS_EDIT_NOT_FOUND` message with old_str echo | `packages/fs/tool-str-replace-editor/src/index.ts:306` |
| `FS_AMBIGUOUS_EDIT` message with line list | `tool-str-replace-editor/src/index.ts:313` (detection `:302-315`, `matchOffsets` `:44-52`) |
| `edit` NOT_FOUND (no echo) | `packages/fs/fs-local/src/fsio.ts:863` |
| `edit` AMBIGUOUS (count + replace_all hint) | `fsio.ts` below `:863` |
| `edit` LF-normalized matching | `fsio.ts:847` (docstring) |
| `edit` schema (`file_path`/`old_string`/`new_string`/`replace_all`) | `packages/fs/tool-fs/src/edit.ts:94-96` |
| `edit` arg validation (`old_string === new_string` etc.) | `edit.ts:48-50` |
| remediation suffix / unread-file message | `packages/fs/tool-fs/src/error.ts:29-39` |
| `PostToolDecision` contract | `packages/core/tools/src/contracts.ts:386` |
| postExecute waterfall + block semantics + throwing→isError | `packages/core/tools/src/pipeline.ts` `postExecute` (~`:498`) |
| Listener registration precedent (failed results flow through) | `dsh-switchman/host/subagent-model.js:144-149` |
| Sanitize precedent (fail-open, whitelist) | `dsh-switchman/host/tool-args-sanitize.js` |
| Removed hash section (W3's slot) | commit `14f3046`, `cordis.patch.yml` between `## 3` and `## 4` |
