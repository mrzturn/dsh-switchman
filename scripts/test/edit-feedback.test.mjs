/** Edit-feedback watcher tests.
 *
 *  Matrix per the design doc §5 (docs/requirements-and-design/
 *  2026-11-21-edit-feedback-watcher-dev-plan.md): parser matrix, lenient
 *  matcher classes, decision correctness, fail-open, loop-guard,
 *  coexistence with the subagent-model listener, config OFF, W3 patch
 *  section presence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLASS_INDENT,
	CLASS_MULTI,
	CLASS_VERBATIM,
	CLASS_WHITESPACE,
	CLASS_ZERO,
	applyEditFeedback,
	boundedEcho,
	classifyMiss,
	composeFeedback,
	excerptAround,
	fallbackCodeOf,
	fenceFor,
	hitLines,
	normalizeLf,
	parseFailure,
} from "../../host/edit-feedback.js";
import { applySubagentModel } from "../../host/subagent-model.js";

const ROOT = join(import.meta.dirname, "..", "..");

// ---------------------------------------------------------------------------
// Fixtures modeled on daily-failure shapes
// ---------------------------------------------------------------------------

const DUP_IMPORTS = [
	'import a from "a";',
	"const x = 1;",
	'import a from "a";',
	"const y = 2;",
	'import a from "a";',
	"",
].join("\n");

const CLOSERS = [
	"function outer() {",
	"  if (a) {",
	"    work();",
	"  }",
	"  if (b) {",
	"    other();",
	"  }",
	"}",
	"",
].join("\n");

const CJK = [
	"// 中文注释：第一处",
	"const 名字 = 1;",
	"// 中文注释：第二处",
	"const 值 = 2;",
	"",
].join("\n");

const CRLF = "alpha\r\nbeta\r\ngamma\r\n";

const MINIFIED = "function a(){return 1};" + "x".repeat(900) + "function b(){return 2};";

// ---------------------------------------------------------------------------
// §5.1 parser matrix
// ---------------------------------------------------------------------------

test("fallbackCodeOf parses both tools' exact wire messages", () => {
	assert.equal(
		fallbackCodeOf("No replacement was performed, old_str `x` did not appear verbatim in a.ts."),
		"FS_EDIT_NOT_FOUND",
	);
	assert.equal(
		fallbackCodeOf("No replacement was performed. Multiple occurrences of old_str `x` in lines [1, 3]. Please ensure it is unique"),
		"FS_AMBIGUOUS_EDIT",
	);
	assert.equal(fallbackCodeOf('old_string was not found in "a.ts"'), "FS_EDIT_NOT_FOUND");
	assert.equal(
		fallbackCodeOf('old_string matched 2 times in "a.ts"; provide a more specific old_string or set replace_all to true'),
		"FS_AMBIGUOUS_EDIT",
	);
});

test("fallbackCodeOf tolerates the Error: envelope and remediation suffix", () => {
	assert.equal(fallbackCodeOf('Error: old_string was not found in "a.ts"'), "FS_EDIT_NOT_FOUND");
	assert.equal(
		fallbackCodeOf('old_string was not found in "a.ts" — re-read the file, then retry'),
		"FS_EDIT_NOT_FOUND",
	);
});

test("fallbackCodeOf excludes arg-level NOT_FOUND lookalikes and foreign messages", () => {
	assert.equal(fallbackCodeOf("old_string must be a non-empty string"), null);
	assert.equal(fallbackCodeOf("cannot modify \"a.ts\": file has not been read — read the file, then retry"), null);
	assert.equal(fallbackCodeOf("EPERM: operation not permitted"), null);
	assert.equal(fallbackCodeOf("No replacement was performed for other reasons"), null);
	assert.equal(fallbackCodeOf(42), null);
});

test("parseFailure prefers result.error.info.code over message shapes", () => {
	const exec = { name: "edit", arguments: { file_path: "f.ts", old_string: "x", new_string: "y" } };
	const result = { isError: true, error: { message: "totally different text", info: { name: "FsError", code: "FS_EDIT_NOT_FOUND" } } };
	assert.deepEqual(parseFailure(exec, result), { code: "FS_EDIT_NOT_FOUND", path: "f.ts" });
});

test("parseFailure falls back to message shapes when info is missing", () => {
	const exec = { name: "str_replace_editor", arguments: { path: "w.txt", old_str: "x", new_str: "y", command: "str_replace" } };
	const result = { isError: true, error: { message: "No replacement was performed. Multiple occurrences of old_str `x` in lines [2, 7]. Please ensure it is unique" } };
	assert.deepEqual(parseFailure(exec, result), { code: "FS_AMBIGUOUS_EDIT", path: "w.txt" });
});

test("parseFailure rejects wrong codes, missing paths, and non-failures", () => {
	const goodExec = { name: "edit", arguments: { file_path: "f.ts", old_string: "x", new_string: "y" } };
	for (const result of [
		{ isError: true, error: { message: "x", info: { name: "FsError", code: "FS_STALE_VERSION" } } },
		{ isError: true, error: { message: "x", info: { name: "FsError", code: "FS_NOT_OBSERVED" } } },
		{ isError: false, error: null },
	]) {
		assert.equal(parseFailure({ name: "edit", arguments: { file_path: "f.ts", old_string: "p", new_string: "q" } }, result), null, JSON.stringify(result));
	}
	assert.equal(parseFailure({ name: "edit", arguments: { old_string: "x", new_string: "y" } }, { isError: true, error: { message: 'old_string was not found in "f.ts"', info: { name: "FsError", code: "FS_EDIT_NOT_FOUND" } } }), null);
	void goodExec;
});

test("parseFailure reads both path arg names and tolerates hostile exec", () => {
	assert.equal(parseFailure({ name: "edit", arguments: { file_path: "a.ts" } }, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "a.ts"'))?.path, "a.ts");
	assert.equal(parseFailure({ name: "str_replace_editor", arguments: { path: "b.ts" } }, err("FS_EDIT_NOT_FOUND", "No replacement was performed, old_str `x` did not appear verbatim in b.ts."))?.path, "b.ts");
	for (const hostile of [null, undefined, {}, { name: "edit", arguments: "string" }, { name: "edit" }]) {
		assert.equal(parseFailure(hostile, err("FS_EDIT_NOT_FOUND", "x")), null);
	}
});

// ---------------------------------------------------------------------------
// §5.2 lenient matcher classes
// ---------------------------------------------------------------------------

test("matcher: CRLF needle vs LF file and vice versa", () => {
	// str_replace_editor matches RAW bytes: an LF needle against a CRLF file
	// is a genuine miss → whitespace-drift diagnosis with the exact text.
	assert.equal(classifyMiss(CRLF, "alpha\nbeta", false).klass, CLASS_WHITESPACE);
	assert.deepEqual(classifyMiss(CRLF, "alpha\nbeta", false).lines, [1]);
	// edit normalizes both sides → the same call is verbatim-unique under
	// tool semantics (contradiction class).
	assert.equal(classifyMiss(CRLF, "alpha\nbeta", true).klass, CLASS_VERBATIM);
	// LF needle + LF file + tool that normalizes → verbatim.
	assert.equal(classifyMiss("a\nb\n", "a\nb", true).klass, CLASS_VERBATIM);
});

test("matcher: trailing-whitespace drift is diagnosed, lines mapped to the original", () => {
	const ws = "foo   \nbar\t\nbaz\n";
	const d = classifyMiss(ws, "foo\nbar", false);
	assert.equal(d.klass, CLASS_WHITESPACE);
	assert.deepEqual(d.lines, [1]);
	// hit line numbers refer to the ORIGINAL content (fold preserves count):
	// the folded (rtruncated) hit maps back to the original line 1.
	const folded = ws.split("\n").map((l) => l.replace(/[ \t]+$/u, "")).join("\n");
	assert.deepEqual(hitLines(folded, "foo\nbar").lines, [1]);
});

test("matcher: indentation drift (aider last rung) is diagnosed", () => {
	const indented = "if (x) {\n\treturn 1;\n}\n";
	const d = classifyMiss(indented, "  return 1;", false);
	assert.equal(d.klass, CLASS_INDENT);
	assert.deepEqual(d.lines, [2]);
});

test("matcher: multi-hit detection with byte-order line numbers", () => {
	const d = classifyMiss(DUP_IMPORTS, 'import a from "a";', false);
	assert.equal(d.klass, CLASS_MULTI);
	assert.deepEqual(d.lines, [1, 3, 5]);
	// repeated closers
	assert.deepEqual(classifyMiss(CLOSERS, "  }", false).lines, [4, 7]);
	// repeated JSON keys in different objects
	assert.deepEqual(classifyMiss('{"a":1}\n{"a":2}\n', '"a":', false).lines, [1, 2]);
	// repeated markdown headings
	assert.deepEqual(classifyMiss("## sec\nx\n## sec\n", "## sec", false).lines, [1, 3]);
});

test("matcher: zero-hit stays zero-hit (no fuzzy scoring)", () => {
	assert.equal(classifyMiss(DUP_IMPORTS, "nothing like this exists", false).klass, CLASS_ZERO);
	// needle longer than the file
	assert.equal(classifyMiss("ab", "abcdef", false).klass, CLASS_ZERO);
	// empty file
	assert.equal(classifyMiss("", "x", false).klass, CLASS_ZERO);
	// whitespace-fold creates a NEW unique match the verbatim search missed
	const sneaky = "keep  \nmatch\t\nend\n";
	const d = classifyMiss(sneaky, "keep \nmatch ", false);
	assert.equal(d.klass, CLASS_WHITESPACE);
});

test("matcher: exotic line separators and mixed indentation", () => {
	// \u2028 stays part of the line (fs layer splits on \n only)
	const exotic = "a\u2028b\nc\n";
	assert.equal(classifyMiss(exotic, "a\u2028b", false).klass, CLASS_VERBATIM);
	// tab/space mixed indentation folds cleanly
	const mixed = "if (x) {\n\t  return 1;\n}\n";
	assert.equal(classifyMiss(mixed, "\treturn 1;", false).klass, CLASS_INDENT);
});

test("matcher: needle at BOF and EOF (window clamps)", () => {
	const content = "first\nmiddle\nlast\n";
	assert.deepEqual(classifyMiss(content, "first", false).lines, [1]);
	assert.deepEqual(classifyMiss(content, "last", false).lines, [3]);
	const d = classifyMiss(content, "middle", false);
	assert.deepEqual(d.lines, [2]);
	const ex = excerptAround(content, d.lines[0]);
	assert.deepEqual(ex.text.split("\n"), content.split("\n")); // clamped to both ends
});

test("matcher: minified 1-line file degenerates to a bounded char window", () => {
	const d = classifyMiss(MINIFIED, "function b(){return 2}", false);
	assert.equal(d.klass, CLASS_VERBATIM);
	const ex = excerptAround(MINIFIED, d.lines[0] ?? 1, 1); // hitOffsets[0] analog: anchor near BOF
	assert.equal(ex.first, null);
	assert.ok(ex.text.length <= 300, `window ${ex.text.length} exceeds cap`);
	// and with the real anchor offset
	const { offsets } = hitLines(MINIFIED, "function b(){return 2}");
	const ex2 = excerptAround(MINIFIED, 1, offsets[0]);
	assert.ok(ex2.text.includes("function b(){return 2}"));
	assert.ok(ex2.text.length <= 300);
});

test("matcher: excerpts are bounded and exact", () => {
	const longLine = `line 20 ${"x".repeat(500)}`;
	const long = Array.from({ length: 40 }, (_, i) => (i === 19 ? longLine : `line ${i} ${"filler".repeat(10)}`)).join("\n");
	const ex = excerptAround(long, 20);
	assert.equal(ex.first, 18);
	assert.equal(ex.last, 22);
	for (const line of ex.text.split("\n")) {
		assert.ok(line.length <= 161, `line ${line.length} exceeds 160+ellipsis`);
	}
	assert.ok(ex.text.split("\n")[2].endsWith("…"), "over-long line is clipped with an ellipsis");
	// CJK content excerpts keep the exact text
	const d = classifyMiss(CJK, "// 中文注释：第一处", false);
	assert.equal(d.klass, CLASS_VERBATIM);
	assert.deepEqual(d.lines, [1]);
});

test("fence: backtick run always exceeds any run inside the excerpt", () => {
	assert.equal(fenceFor("plain"), "```");
	assert.equal(fenceFor("has ``` inside"), "````");
	assert.equal(fenceFor("a````b"), "`````");
	const text = "code with ``` fences\nand ```` more";
	const fence = fenceFor(text);
	assert.ok(!text.includes(fence), "fence must not appear in the text");
});

test("boundedEcho: bounded and lossy-but-informative", () => {
	assert.equal(boundedEcho("short"), "short");
	const long = "a".repeat(700);
	const echo = boundedEcho(long);
	assert.ok(echo.length <= 600);
	assert.ok(echo.startsWith("aaa"));
	assert.ok(echo.endsWith("aaa"));
	assert.ok(echo.includes("…"));
});

// ---------------------------------------------------------------------------
// §5.3 decision correctness
// ---------------------------------------------------------------------------

/** Mount the watcher with a fake fs Service and return the handler. */
function mount(fsImpl, config = {}) {
	const listeners = new Map();
	const warns = [];
	const ctx = {
		on: (name, handler) => listeners.set(name, handler),
		logger: { warn: (m) => warns.push(String(m)), debug: () => {} },
		get: (name) => (name === "fs" ? fsImpl : null),
	};
	applyEditFeedback(ctx, config);
	return { handler: listeners.get("tools/post-execute"), warns, registered: listeners.has("tools/post-execute") };
}

const FS_OK = (content) => ({ resolve: async () => ({}), readText: async () => content });

function err(code, message) {
	return { isError: true, error: { message, info: { name: "FsError", code } } };
}

const SRE_NF = (path) =>
	err("FS_EDIT_NOT_FOUND", `No replacement was performed, old_str \`needle\` did not appear verbatim in ${path}.`);

test("decision: multi-hit block carries ContentBlock feedback + original code, never replace_all for str_replace_editor", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	const exec = {
		name: "str_replace_editor",
		agent: {},
		arguments: { path: "f.js", old_str: 'import a from "a";', new_str: "x", command: "str_replace" },
	};
	const decision = await handler(exec, err("FS_AMBIGUOUS_EDIT", "No replacement was performed. Multiple occurrences of old_str `import a from \"a\";` in lines [1, 3, 5]. Please ensure it is unique"), () => {
		throw new Error("next must not be called when blocking");
	});
	assert.equal(decision.kind, "block");
	assert.ok(Array.isArray(decision.feedback));
	assert.equal(decision.feedback[0].type, "text");
	assert.deepEqual(decision.info, { name: "FsError", code: "FS_AMBIGUOUS_EDIT" });
	const text = decision.feedback[0].text;
	assert.ok(text.includes("L1, L3, L5"));
	assert.ok(text.includes('import a from "a";'));
	assert.match(text, /Around L1:/);
	assert.match(text, /Around L3:/);
	assert.match(text, /Around L5:/);
	assert.match(text, /Extend the old_str/);
	assert.ok(!/replace_all/.test(text), "str_replace_editor must never hear about replace_all");
});

test("decision: edit multi-hit suggests replace_all; excerpts bounded to 5 (+N more)", async () => {
	const many = Array.from({ length: 9 }, (_, i) => `dup(${i});\ndup();`).join("\n");
	const { handler } = mount(FS_OK(many));
	const exec = { name: "edit", agent: {}, arguments: { file_path: "m.js", old_string: "dup();", new_string: "x" } };
	const decision = await handler(exec, err("FS_AMBIGUOUS_EDIT", 'old_string matched 9 times in "m.js"; provide a more specific old_string or set replace_all to true'), () => "unused");
	const text = decision.feedback[0].text;
	assert.ok(/matches 9 locations/.test(text));
	assert.ok(/\(\+4 more\)/.test(text));
	assert.match(text, /replace_all: true/);
});

test("decision: whitespace-drift feedback quotes the exact file text", async () => {
	const { handler } = mount(FS_OK(CRLF));
	const exec = { name: "str_replace_editor", agent: {}, arguments: { path: "w.txt", old_str: "alpha\nbeta", new_str: "x", command: "str_replace" } };
	const decision = await handler(exec, SRE_NF("w.txt"), () => "unused");
	const text = decision.feedback[0].text;
	assert.match(text, /unique match exists at L1 after whitespace normalization/);
	assert.ok(text.includes("alpha"), "excerpt must contain the exact file bytes");
	assert.match(text, /Retry with exactly this text/);
});

test("decision: indent-drift feedback names the class", async () => {
	const { handler } = mount(FS_OK("if (x) {\n\treturn 1;\n}\n"));
	const exec = { name: "edit", agent: {}, arguments: { file_path: "i.js", old_string: "  return 1;", new_string: "x" } };
	const decision = await handler(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "i.js"'), () => "unused");
	assert.match(decision.feedback[0].text, /after indentation normalization/);
});

test("decision: zero-hit says re-read, echoes the searched needle bounded", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	const exec = { name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "z".repeat(700), new_string: "x" } };
	const decision = await handler(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "f.js"'), () => "unused");
	const text = decision.feedback[0].text;
	assert.match(text, /No verbatim or whitespace\/indentation-flexible match/);
	assert.match(text, /Re-read the region/);
	assert.ok(text.includes("…" + "z".repeat(1)), "bounded echo present");
});

test("decision: edit NOT_FOUND diagnosis uses args old_string, not the message echo", async () => {
	const { handler } = mount(FS_OK(CJK));
	const exec = { name: "edit", agent: {}, arguments: { file_path: "c.txt", old_string: "const 名字 = 1;", new_string: "const 名字 = 2;" } };
	// message does NOT echo old_string (edit's real shape)
	const decision = await handler(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "c.txt"'), () => "unused");
	assert.match(decision.feedback[0].text, /const 名字 = 1;/);
});

test("decision: non-edit tools and successful results pass through with zero work", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	let nextCalls = 0;
	const next = () => { nextCalls += 1; return "passthrough"; };
	assert.equal(await handler({ name: "bash", agent: {}, arguments: {} }, err("FS_EDIT_NOT_FOUND", "x"), next), "passthrough");
	assert.equal(await handler({ name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } }, { isError: false, value: "ok" }, next), "passthrough");
	assert.equal(await handler({ name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } }, { isError: true, error: { message: "plain failure" } }, next), "passthrough");
	assert.equal(await handler(null, null, next), "passthrough");
	assert.equal(nextCalls, 4);
});

// ---------------------------------------------------------------------------
// §5.4 fail-open
// ---------------------------------------------------------------------------

test("fail-open: fs service missing → next() unchanged", async () => {
	const { handler } = mount(null);
	const exec = { name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } };
	assert.equal(await handler(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "f.js"'), () => "pt"), "pt");
});

test("fail-open: fs read throws → next() unchanged + warn", async () => {
	const warns = [];
	const listeners = new Map();
	const ctx = {
		on: (n, h) => listeners.set(n, h),
		logger: { warn: (m) => warns.push(String(m)), debug: () => {} },
		get: () => ({ resolve: async () => ({}), readText: async () => { throw new Error("disk boom"); } }),
	};
	applyEditFeedback(ctx, {});
	const exec = { name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } };
	assert.equal(await listeners.get("tools/post-execute")(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "f.js"'), () => "pt"), "pt");
	assert.ok(warns.some((w) => /degraded|failed open/.test(w)));
});

test("fail-open: malformed arguments and hostile exec shapes → next()", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	for (const exec of [
		{ name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "", new_string: "b" } }, // empty needle
		{ name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: 42, new_string: "b" } },
		{ name: "edit" },
		{ name: "edit", agent: {}, arguments: null },
		"not an object",
	]) {
		assert.equal(await handler(exec, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "f.js"'), () => "pt"), "pt", JSON.stringify(exec));
	}
});

test("fail-open: readText returns a non-string → next()", async () => {
	const listeners = new Map();
	const ctx = {
		on: (n, h) => listeners.set(n, h),
		logger: { warn: () => {}, debug: () => {} },
		get: () => ({ resolve: async () => ({}), readText: async () => Buffer.from("bytes") }),
	};
	applyEditFeedback(ctx, {});
	const exec = { name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } };
	assert.equal(await listeners.get("tools/post-execute")(exec, err("FS_EDIT_NOT_FOUND", 'x'), () => "pt"), "pt");
});

test("fail-open: getter itself throws → next() (outer catch)", async () => {
	const listeners = new Map();
	const ctx = {
		on: (n, h) => listeners.set(n, h),
		logger: { warn: () => {}, debug: () => {} },
		get: () => { throw new Error("service bus down"); },
	};
	applyEditFeedback(ctx, {});
	const exec = { name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: "a", new_string: "b" } };
	assert.equal(await listeners.get("tools/post-execute")(exec, err("FS_EDIT_NOT_FOUND", 'x'), () => "pt"), "pt");
});

// ---------------------------------------------------------------------------
// §5.5 loop-guard
// ---------------------------------------------------------------------------

test("loop-guard: 3rd same file+class failure appends the strategy line; others unaffected", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	const agent = {};
	const exec = { name: "edit", agent, arguments: { file_path: "f.js", old_string: "zzz", new_string: "b" } };
	const run = (execArg) => handler(execArg, err("FS_EDIT_NOT_FOUND", 'old_string was not found in "f.js"'), () => "pt");
	const r1 = await run(exec);
	assert.ok(!/failure #/.test(r1.feedback[0].text), "first failure has no loop line");
	await run(exec);
	const r3 = await run(exec);
	assert.match(r3.feedback[0].text, /failure #3 for f\.js/);
	assert.match(r3.feedback[0].text, /switch strategy/);
	// different file does not increment
	const r4 = await run({ name: "edit", agent, arguments: { file_path: "g.js", old_string: "zzz", new_string: "b" } });
	assert.ok(!/failure #/.test(r4.feedback[0].text));
	// same file different class does not continue the count either (class key)
	const r5 = await run({ name: "edit", agent, arguments: { file_path: "f.js", old_string: 'import a from "a";', new_string: "b" } });
	assert.ok(!/failure #/.test(r5.feedback[0].text), "multi-hit class has its own counter");
});

test("loop-guard: unkeyed agents never fabricate counts", async () => {
	const { handler } = mount(FS_OK(DUP_IMPORTS));
	const exec = { name: "edit", arguments: { file_path: "f.js", old_string: "zzz", new_string: "b" } };
	for (let i = 0; i < 5; i += 1) {
		const decision = await handler(exec, err("FS_EDIT_NOT_FOUND", 'x'), () => "pt");
		assert.ok(!/failure #0/.test(decision.feedback[0].text));
	}
});

// ---------------------------------------------------------------------------
// §5.6 coexistence with applySubagentModel
// ---------------------------------------------------------------------------

test("coexistence: both listeners registered; each handles its own lane", async () => {
	const listeners = new Map();
	const ctx = {
		on: (name, handler) => {
			const existing = listeners.get(name);
			listeners.set(name, existing ? (a, b, c) => existing(a, b, () => handler(a, b, c)) : handler);
		},
		logger: { warn: () => {}, debug: () => {} },
		get: () => FS_OK(DUP_IMPORTS),
	};
	applyEditFeedback(ctx, {});
	applySubagentModel(ctx);
	const editHandler = listeners.get("tools/post-execute");
	// edit error → rewritten
	const decision = await editHandler(
		{ name: "edit", agent: {}, arguments: { file_path: "f.js", old_string: 'import a from "a";', new_string: "x" } },
		err("FS_AMBIGUOUS_EDIT", 'old_string matched 3 times in "f.js"; provide a more specific old_string or set replace_all to true'),
		() => "pipeline",
	);
	assert.equal(decision.kind, "block");
	// subagent success → untouched by the edit watcher (accept passthrough)
	const success = { isError: false, value: { sessionId: "session-x" }, content: [{ type: "text", text: "done" }] };
	const out = await editHandler({ name: "subagent", agent: {}, arguments: {} }, success, () => success);
	assert.equal(out, success);
});

// ---------------------------------------------------------------------------
// §5.7 config gate OFF
// ---------------------------------------------------------------------------

test("config OFF: listener never registered; ON (default) registers", () => {
	const off = mount(FS_OK("x"), { editFeedbackEnabled: false });
	assert.equal(off.registered, false);
	const on = mount(FS_OK("x"), {});
	assert.equal(on.registered, true);
	const explicitOn = mount(FS_OK("x"), { editFeedbackEnabled: true });
	assert.equal(explicitOn.registered, true);
});

// ---------------------------------------------------------------------------
// §5.8 W3 patch section + CHANGELOG
// ---------------------------------------------------------------------------

test("W3: patch carries the Native Edit Discipline section between ## 3 and ## 4", () => {
	const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(patch.includes("## Native Edit Discipline (edit / str_replace_editor)"));
	const three = patch.indexOf("## 3. Tiered Verification");
	const native = patch.indexOf("## Native Edit Discipline");
	const four = patch.indexOf("## 4. Boundaries");
	assert.ok(three >= 0 && native > three && native < four, "section must sit between ## 3 and ## 4");
	assert.match(patch, /Copy `old_string` \/ `old_str` verbatim from a fresh read/);
	assert.match(patch, /str_replace_editor` has no `replace_all`/);
	assert.match(patch, /After bash\/git\/formatters touched the file, re-read before editing/);
});

test("CHANGELOG: Unreleased documents the watcher bilingually", () => {
	const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
	const unreleased = changelog.slice(changelog.indexOf("## [Unreleased]"), changelog.indexOf("## [1.11.9]"));
	assert.ok(unreleased.includes("host/edit-feedback.js"));
	assert.ok(unreleased.includes("editFeedbackEnabled"));
	assert.ok(unreleased.includes("编辑回喂 watcher"));
});

test("wiring: index.js registers applyEditFeedback; config schema declares the switch", () => {
	const index = readFileSync(join(ROOT, "index.js"), "utf8");
	assert.match(index, /import \{ applyEditFeedback \} from "\.\/host\/edit-feedback\.js";/);
	assert.match(index, /applyEditFeedback\(ctx, config\);/);
	const config = readFileSync(join(ROOT, "host", "config.js"), "utf8");
	assert.match(config, /editFeedbackEnabled: z\.boolean\(\)\.default\(true\)\.volatile\(\)/);
});
