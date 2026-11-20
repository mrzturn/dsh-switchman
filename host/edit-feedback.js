/** Edit-tool feedback watcher: rewrite native edit-tool failures (the two
 *  recurring miss classes, FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT) into
 *  self-contained corrective feedback — per-match excerpts and the exact
 *  retry recipe — so the model fixes the retry within the same round instead
 *  of spending 1–2 extra reads re-deriving context the tool had at failure
 *  time (design: docs/requirements-and-design/2026-11-21-edit-feedback-watcher-dev-plan.md).
 *
 *  Hard guarantees:
 *  - Diagnosis only. The lenient (whitespace/indentation-flexible) matcher
 *    runs in memory to CLASSIFY the failure; nothing is ever written to disk.
 *  - Fail-open. The whole listener body is wrapped: any internal error falls
 *    through to `next()` unchanged — the pipeline turns a throwing
 *    post-execute listener into an isError result (pipeline.ts postExecute).
 *  - Fires only on already-failing `edit` / `str_replace_editor` results;
 *    everything else is a promise pass-through to `next()`.
 *  - Zero runtime dependencies; no changes to native tools; no new inject.
 */

/** Failure classes the watcher distinguishes. */
const CLASS_VERBATIM = "verbatim";
const CLASS_WHITESPACE = "whitespace-drift";
const CLASS_INDENT = "indent-drift";
const CLASS_MULTI = "multi-hit";
const CLASS_ZERO = "zero-hit";

/** Feedback bounds (chars/lines) — keeps any single rewrite small. */
const ECHO_LIMIT = 600;
const EXCERPT_CONTEXT_LINES = 2;
const EXCERPT_LINE_LIMIT = 160;
const MINIFIED_CHAR_WINDOW = 300;
const MAX_LISTED_HITS = 5;
const LOOP_THRESHOLD = 3;

/** The two codes the watcher handles (FsError codes from the DSH fs layer). */
const HANDLED_CODES = new Set(["FS_EDIT_NOT_FOUND", "FS_AMBIGUOUS_EDIT"]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests; no I/O, no ctx)
// ---------------------------------------------------------------------------

/** Fold CRLF/CR → LF without touching anything else. Line COUNT is
 *  preserved (CRLF→LF never merges lines), so line numbers computed on the
 *  folded text match the original. */
function normalizeLf(text) {
	return text.replace(/\r\n?/gu, "\n");
}

/** True when the string contains at least one line terminator. */
function isMultiline(text) {
	return /[\n\r\u2028\u2029]/u.test(text);
}

/** Split content into lines, accepting LF plus the exotic Unicode separators
 *  (JS regex `.` treats those as non-terminators, but the fs layer treats a
 *  line as a \n unit — we mirror plain \n splitting after folding). */
function contentLines(text) {
	return text.split("\n");
}

/** Strip trailing whitespace of every line (keep leading: indentation is
 *  meaningful until the indent-flexible rung). */
function foldTrailing(text) {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""))
		.join("\n");
}

/** Additionally strip leading indentation per line (aider ladder's last
 *  text rung). Relative indent INSIDE the needle is lost — only used to
 *  LOCATE a candidate window, never to synthesize replacement text. */
function foldIndent(text) {
	return text
		.split("\n")
		.map((line) => line.replace(/^[ \t]+/u, "").replace(/[ \t]+$/u, ""))
		.join("\n");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
	if (needle.length === 0) return 0;
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at >= 0) {
		count += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/** All non-overlapping match start offsets. */
function matchOffsetsOf(haystack, needle) {
	const offsets = [];
	if (needle.length === 0) return offsets;
	let at = haystack.indexOf(needle);
	while (at >= 0) {
		offsets.push(at);
		at = haystack.indexOf(needle, at + needle.length);
	}
	return offsets;
}

/** Byte offset → 1-based line number in the UNFOLDED original content
 *  (safe across CRLF→LF folding because folding preserves line count). */
function lineNumberAt(originalContent, offset) {
	let line = 1;
	for (let i = 0; i < offset && i < originalContent.length; i += 1) {
		if (originalContent.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

/** Locate `needle` (already folded) in `foldedContent`, and map each hit
 *  back to the original content's line numbers via a prefix-sum of line
 *  start offsets computed on the FOLDED text (fold preserves line count, so
 *  the mapping is exact). Returns { lines, offsets } — 1-based line numbers
 *  and the hit byte offsets into the FOLDED content (also valid excerpt
 *  anchors for the original: byte distance from the line start is
 *  preserved by folding). */
function hitLines(foldedContent, foldedNeedle) {
	const starts = [0];
	for (let i = 0; i < foldedContent.length; i += 1) {
		if (foldedContent.charCodeAt(i) === 10) starts.push(i + 1);
	}
	const lines = [];
	const offsets = [];
	for (const offset of matchOffsetsOf(foldedContent, foldedNeedle)) {
		// Binary search: last line start ≤ offset.
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		const line = lo + 1;
		if (lines.at(-1) !== line) lines.push(line);
		offsets.push(offset);
	}
	return { lines, offsets };
}

/** A bounded verbatim excerpt of the lines around `startLine` (1-based,
 *  inclusive ± EXCERPT_CONTEXT_LINES), each line truncated to
 *  EXCERPT_LINE_LIMIT. Returns { first, last, text } — `text` is
 *  newline-joined raw lines (exact file text, the whole point of the
 *  feedback). Degenerates to a char window for line-less content. */
function excerptAround(originalContent, startLine, anchorOffset = null) {
	const lines = contentLines(originalContent);
	if (lines.length <= 1 && !originalContent.includes("\n")) {
		// 1-line / minified file: excerpt degenerates to a bounded character
		// window centered on the hit's byte offset (startLine is a LINE here,
		// so the window anchors on the folded hit line's start offset instead
		// — pass `anchorOffset` when known; the fallback keeps it bounded).
		const center = Math.max(0, anchorOffset ?? 0);
		const offset = Math.max(0, center - Math.floor(MINIFIED_CHAR_WINDOW / 2));
		const text = originalContent.slice(offset, offset + MINIFIED_CHAR_WINDOW);
		return { first: null, last: null, text };
	}
	const first = Math.max(1, startLine - EXCERPT_CONTEXT_LINES);
	const last = Math.min(lines.length, startLine + EXCERPT_CONTEXT_LINES);
	const clipped = [];
	for (let i = first - 1; i < last; i += 1) {
		const line = lines[i];
		clipped.push(line.length > EXCERPT_LINE_LIMIT ? `${line.slice(0, EXCERPT_LINE_LIMIT)}…` : line);
	}
	return { first, last, text: clipped.join("\n") };
}

/** Fence whose backtick run is strictly longer than any run inside `text`
 *  (max(3, longest-run + 1)) so the excerpt can never break out of the
 *  fence. */
function fenceFor(text) {
	let longest = 0;
	for (const m of text.matchAll(/`+/gu)) longest = Math.max(longest, m[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

/** Bounded echo of a long needle: keep head+tail around an ellipsis. */
function boundedEcho(needle, limit = ECHO_LIMIT) {
	if (needle.length <= limit) return needle;
	const head = Math.floor((limit - 1) / 2);
	const tail = limit - 1 - head;
	return `${needle.slice(0, head)}…${needle.slice(needle.length - tail)}`;
}

// ---------------------------------------------------------------------------
// Lenient matcher (diagnosis ladder — never writes, never synthesizes text)
// ---------------------------------------------------------------------------

/** Classify the miss against the live file content.
 *
 *  Ladder (each rung only runs when the previous one is zero-hit):
 *  1. raw verbatim — mirrors `str_replace_editor` exactly; also the
 *     NOT_FOUND baseline (the tool already failed this search).
 *  2. LF-normalized verbatim — for `str_replace_editor` this catches
 *     pure CRLF drift between the model's needle and a CRLF file (the
 *     tool matches raw bytes, the model usually copied from a
 *     LF-normalized view). For `edit` this IS the tool's own match
 *     semantics — a hit here contradicts the tool's own failure report
 *     (race with a concurrent writer); CLASS_VERBATIM feedback tells the
 *     model to re-read and retry.
 *  3. trailing-whitespace-flexible — rtrim every line on both sides.
 *  4. indent-flexible — additionally strip leading indentation per
 *     line; a unique hit here is the classic "re-typed from memory with
 *     different indent".
 *  No similarity scoring: a needle that survives every rung with zero
 *  hits stays zero-hit ("stale or hallucinated").
 *
 *  @returns {{klass: string, lines: number[], hitOffsets: number[]}} —
 *  `lines` are 1-based hit line numbers in the original content;
 *  `hitOffsets` are byte offsets of hits in the folded content (excerpt
 *  anchors for line-less content).
 */
function classifyMiss(rawContent, needle, toolLfNormalizes) {
	const rawNeedle = toolLfNormalizes ? normalizeLf(needle) : needle;
	const rawCount = countOccurrences(rawContent, rawNeedle);
	if (rawCount === 1) {
		const { lines, offsets } = hitLines(rawContent, rawNeedle);
		return { klass: CLASS_VERBATIM, lines, hitOffsets: offsets, hitCount: rawCount };
	}
	if (rawCount > 1) {
		const { lines, offsets } = hitLines(rawContent, rawNeedle);
		return { klass: CLASS_MULTI, lines, hitOffsets: offsets, hitCount: rawCount };
	}

	// Rung 2: LF-normalized both sides.
	const lfContent = normalizeLf(rawContent);
	const lfNeedle = normalizeLf(rawNeedle);
	const lfCount = countOccurrences(lfContent, lfNeedle);
	if (lfCount === 1) {
		const { lines, offsets } = hitLines(lfContent, lfNeedle);
		return {
			klass: toolLfNormalizes ? CLASS_VERBATIM : CLASS_WHITESPACE,
			lines,
			hitOffsets: offsets,
			hitCount: lfCount,
		};
	}
	if (lfCount > 1) {
		const { lines, offsets } = hitLines(lfContent, lfNeedle);
		return { klass: CLASS_MULTI, lines, hitOffsets: offsets, hitCount: lfCount };
	}

	// Rung 3: fold trailing whitespace per line on both sides.
	const foldedContent = foldTrailing(lfContent);
	const foldedNeedle = foldTrailing(lfNeedle);
	const foldedCount = countOccurrences(foldedContent, foldedNeedle);
	if (foldedCount === 1) {
		const { lines, offsets } = hitLines(foldedContent, foldedNeedle);
		return { klass: CLASS_WHITESPACE, lines, hitOffsets: offsets, hitCount: foldedCount };
	}
	if (foldedCount > 1) {
		const { lines, offsets } = hitLines(foldedContent, foldedNeedle);
		return { klass: CLASS_MULTI, lines, hitOffsets: offsets, hitCount: foldedCount };
	}

	// Rung 4: additionally fold leading indentation per line.
	const indentContent = foldIndent(lfContent);
	const indentNeedle = foldIndent(lfNeedle);
	const indentCount = countOccurrences(indentContent, indentNeedle);
	if (indentCount === 1) {
		const { lines, offsets } = hitLines(indentContent, indentNeedle);
		return { klass: CLASS_INDENT, lines, hitOffsets: offsets, hitCount: indentCount };
	}
	if (indentCount > 1) {
		const { lines, offsets } = hitLines(indentContent, indentNeedle);
		return { klass: CLASS_MULTI, lines, hitOffsets: offsets, hitCount: indentCount };
	}
	return { klass: CLASS_ZERO, lines: [], hitOffsets: [], hitCount: 0 };
}

// ---------------------------------------------------------------------------
// Failure parsing (message shapes; info.code is the primary classifier)
// ---------------------------------------------------------------------------

/** Parse a failed edit result into { code, displayPath } — code from
 *  result.error.info.code when present, else from message-shape fallbacks;
 *  displayPath always from the message (both templates quote it). Null when
 *  the result does not match either failure shape (wrong tool args error,
 *  FS_NOT_OBSERVED, FS_STALE_VERSION, anything foreign). */
function parseFailure(exec, result) {
	const message = result?.error?.message ?? "";
	const info = result?.error?.info;
	const code =
		typeof info?.code === "string" ? info.code : fallbackCodeOf(message);
	if (code === null || !HANDLED_CODES.has(code)) return null;
	const path = pathOf(exec);
	if (path === null) return null;
	return { code, path };
}

/** Message-shape fallback for results that lost `info` (defensive: the
 *  pipeline only sets info for HarnessError instances). Ordered most
 *  specific first; the empty-old_string NOT_FOUND message MUST NOT match
 *  the not-found fallback (it is an argument error, not a miss). */
function fallbackCodeOf(message) {
	if (typeof message !== "string") return null;
	const text = message.startsWith("Error: ") ? message.slice(7) : message;
	if (text === "old_string must be a non-empty string") return null;
	if (/^old_string was not found in "/u.test(text)) return "FS_EDIT_NOT_FOUND";
	if (/^old_string matched \d+ times in "/u.test(text)) return "FS_AMBIGUOUS_EDIT";
	if (/^No replacement was performed, old_str `/u.test(text)) return "FS_EDIT_NOT_FOUND";
	if (/^No replacement was performed\. Multiple occurrences of old_str `/u.test(text)) {
		return "FS_AMBIGUOUS_EDIT";
	}
	return null;
}

/** Path argument of either tool (str_replace_editor: `path`; edit:
 *  `file_path`). Non-empty strings only. */
function pathOf(exec) {
	const args = exec?.arguments;
	if (args === null || typeof args !== "object") return null;
	const raw = typeof args.path === "string" && args.path !== "" ? args.path : typeof args.file_path === "string" && args.file_path !== "" ? args.file_path : null;
	return raw;
}

/** The old-text argument of either tool (`old_str` / `old_string`). */
function needleOf(exec) {
	const args = exec?.arguments;
	if (args === null || typeof args !== "object") return null;
	const raw = args.old_str ?? args.old_string;
	return typeof raw === "string" ? raw : null;
}

// ---------------------------------------------------------------------------
// Feedback composition
// ---------------------------------------------------------------------------

/** Compose the corrective feedback text for one classified miss. */
function composeFeedback({ tool, code, path, needle, diagnosis, attempts }) {
	const parts = [];
	const where = path;
	if (diagnosis.klass === CLASS_MULTI) {
		const listed = diagnosis.lines.slice(0, MAX_LISTED_HITS);
		const more = diagnosis.lines.length - listed.length;
		const lineList = listed.map((line) => `L${line}`).join(", ");
		const suffix = more > 0 ? ` (+${more} more)` : "";
		// Line granularity can collapse many adjacent hits (all hits on one
		// line) — report the true occurrence count, not the deduped line count.
		const nLocations = diagnosis.hitCount ?? diagnosis.lines.length;
		parts.push(
			`Your ${needleArgName(tool)} matches ${nLocations} locations in ${where}: ${lineList}${suffix}.`,
		);
		for (const [i, line] of listed.entries()) {
			const excerpt = excerptAround(diagnosis.content, line, diagnosis.hitOffsets[i] ?? null);
			parts.push(`Around L${line}:${formatExcerpt(excerpt)}`);
		}
		parts.push(
			`Extend the ${needleArgName(tool)} with lines unique to the intended occurrence (an enclosing signature, identifier, or distinct neighbor line) and retry.`,
		);
		if (tool === "edit" && code === "FS_AMBIGUOUS_EDIT") {
			parts.push(`If every occurrence should change identically, set replace_all: true instead.`);
		}
	} else if (diagnosis.klass === CLASS_WHITESPACE || diagnosis.klass === CLASS_INDENT) {
		const line = diagnosis.lines[0];
		const kind = diagnosis.klass === CLASS_INDENT ? "indentation" : "whitespace";
		parts.push(
			`No verbatim match in ${where}, but a unique match exists at L${line} after ${kind} normalization — the ${needleArgName(tool)} drifted from the file's exact text.`,
		);
		const excerpt = excerptAround(diagnosis.content, line, diagnosis.hitOffsets[0] ?? null);
		parts.push(`The file's exact text is:${formatExcerpt(excerpt)}`);
		parts.push(`Retry with exactly this text (copy it verbatim from the excerpt).`);
	} else if (diagnosis.klass === CLASS_VERBATIM) {
		// Unique under tool semantics despite a failure — contradiction.
		// Only reachable for `edit` (LF-normalized match succeeded where the
		// tool's own count failed) or a race with a concurrent writer.
		parts.push(
			`The ${needleArgName(tool)} currently matches exactly once in ${where}${diagnosis.lines[0] !== undefined ? ` (L${diagnosis.lines[0]})` : ""}, but the tool reported a miss — the file may have changed between your read and the call, or another writer touched it.`,
		);
		const excerpt = excerptAround(diagnosis.content, diagnosis.lines[0] ?? 1, diagnosis.hitOffsets[0] ?? null);
		parts.push(`Current content around that match:${formatExcerpt(excerpt)}`);
		parts.push(`Re-read the file and retry with the fresh text.`);
	} else {
		parts.push(
			`No verbatim or whitespace/indentation-flexible match in ${where} — the file has changed since you read it, or the ${needleArgName(tool)} was reconstructed from memory.`,
		);
		parts.push(`Re-read the region of ${where} and retry with fresh content copied verbatim from the read.`);
	}
	if (needle !== null && needle.length > 0 && diagnosis.klass !== CLASS_VERBATIM) {
		parts.push(`Searched for: ${boundedEcho(needle)}`);
	}
	if (attempts >= LOOP_THRESHOLD) {
		parts.push(
			`This is failure #${attempts} for ${where} in this session: stop retrying the same shape — switch strategy (re-read the region, then use a full-file write, or split the edit into smaller unique anchors).`,
		);
	}
	return parts.join("\n");
}

function needleArgName(tool) {
	return tool === "edit" ? "old_string" : "old_str";
}

/** Render one excerpt as a fenced block; multi-line excerpts keep their
 *  newlines, single-line/char-window excerpts are one fenced line. The
 *  fence run is always longer than any backtick run inside the text. */
function formatExcerpt({ first, last, text }) {
	if (text.length === 0) return " ```\n(empty)\n``` ";
	const fence = fenceFor(text);
	if (first !== null && last !== null && !(first === last && text.split("\n").length === 1)) {
		const range = first === last ? `L${first}` : `L${first}–L${last}`;
		return ` ${range}: ${fence}\n${text}\n${fence}`;
	}
	return ` ${fence}\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Loop guard (bounded, per-agent, GC'd with the agent)
// ---------------------------------------------------------------------------

function createLoopGuard() {
	/** agent → Map<"path␟class", count> */
	const seen = new WeakMap();
	return {
		/** Record one failure and return the running count (1-based). */
		record(agent, path, klass) {
			if (agent === null || agent === undefined || typeof agent !== "object") return 0;
			let inner = seen.get(agent);
			if (inner === undefined) {
				inner = new Map();
				seen.set(agent, inner);
			}
			const key = `${path}␟${klass}`;
			const next = (inner.get(key) ?? 0) + 1;
			inner.set(key, next);
			// Bounded: a runaway agent cannot grow this map without bound —
			// prune fully-counted keys beyond a generous ceiling.
			if (inner.size > 64) {
				for (const [k, v] of inner) {
					if (v >= LOOP_THRESHOLD) inner.delete(k);
					if (inner.size <= 64) break;
				}
			}
			return next;
		},
	};
}

// ---------------------------------------------------------------------------
// Listener wiring
// ---------------------------------------------------------------------------

/** Resolve the plugin's fs view of `path` through the SAME Service surface
 *  the native tools use (sandboxed resolve + readText). Never node:fs. */
async function readLiveText(ctx, path) {
	const fs = ctx.get?.("fs", false);
	if (fs === null || fs === undefined || typeof fs.resolve !== "function") return null;
	const target = await fs.resolve(path, {});
	const text = await fs.readText(target, undefined);
	return typeof text === "string" ? text : null;
}

/**
 * Mount the edit-feedback watcher (one post-execute listener).
 * @param {import("@deepseek-ai/cordis").Context} ctx - host plugin context.
 * @param {{editFeedbackEnabled?: boolean}} config - plugin config.
 */
function applyEditFeedback(ctx, config) {
	if (config?.editFeedbackEnabled === false) return;
	const warn = (message) => ctx.logger?.warn?.(`dsh-switchman: ${message}`);
	const guard = createLoopGuard();
	ctx.on("tools/post-execute", (exec, result, next) => {
		// Fast path: only failed edit calls enter the watcher.
		const name = exec?.name;
		if ((name !== "edit" && name !== "str_replace_editor") || result?.isError !== true) return next();
		try {
			return rewrite(ctx, exec, result, next, name, guard, warn);
		} catch (error) {
			// Fail-open: the pipeline turns a throwing listener into isError.
			warn(`edit feedback failed open: ${error?.message ?? error}`);
			return next();
		}
	});
}

/** Async body: diagnose + block, or pass through. Never throws (all call
 *  sites of the listener already guard, and every await is wrapped). */
async function rewrite(ctx, exec, result, next, name, guard, warn) {
	try {
		const failure = parseFailure(exec, result);
		if (failure === null) return next();
		const needle = needleOf(exec);
		if (needle === null || needle.length === 0) return next();
		const content = await readLiveText(ctx, failure.path);
		if (content === null) return next();
		// `edit` matches LF-normalized content (applyLiteralEdit); the raw
		// ladder must mirror that or it would "diagnose" CRLF drift the tool
		// itself ignores.
		const toolLfNormalizes = name === "edit";
		const diagnosis = classifyMiss(content, needle, toolLfNormalizes);
		diagnosis.content = content;
		const attempts = guard.record(exec.agent, failure.path, diagnosis.klass);
		const feedback = composeFeedback({
			tool: name,
			code: failure.code,
			path: failure.path,
			needle,
			diagnosis,
			attempts,
		});
		return {
			kind: "block",
			feedback: [{ type: "text", text: feedback }],
			info: { name: "FsError", code: failure.code },
		};
	} catch (error) {
		warn(`edit feedback degraded: ${error?.message ?? error}`);
		return next();
	}
}

// ---------------------------------------------------------------------------
// Exported pure surface (tests + future callers)
// ---------------------------------------------------------------------------

export {
	CLASS_INDENT,
	CLASS_MULTI,
	CLASS_VERBATIM,
	CLASS_WHITESPACE,
	CLASS_ZERO,
	boundedEcho,
	classifyMiss,
	composeFeedback,
	applyEditFeedback,
	contentLines,
	excerptAround,
	fallbackCodeOf,
	fenceFor,
	hitLines,
	isMultiline,
	lineNumberAt,
	matchOffsetsOf,
	normalizeLf,
	parseFailure,
};
