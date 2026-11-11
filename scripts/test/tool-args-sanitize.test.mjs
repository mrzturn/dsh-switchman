/** Tool-argument sanitation tests.
 *
 *  Regression guard for the recurring failure class in production session
 *  logs (4 days, 5961 calls): models emitting composite arguments as JSON
 *  STRINGS (`view_range: "[100, 145]"` instead of `[100, 145]`; observed
 *  24x, worst run 8 identical retries in a row) and empty-string enum
 *  fields (`encoding: ""` for read; 26x). The pre-execute layer must
 *  coerce exactly these known shapes and nothing else: strict whitelist +
 *  structural assertion, original bytes preserved when the assertion
 *  fails so the tool's own error reaches the model, empty string means
 *  unset, fail-open on internal errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyToolArgsSanitize, sanitizeToolArgs } from "../../host/tool-args-sanitize.js";

test("view_range stringified pair parses to a native array", () => {
	const result = sanitizeToolArgs({ path: "a.txt", view_range: "[100, 145]" });
	assert.ok(result !== null);
	assert.deepEqual(result.args.view_range, [100, 145]);
	assert.equal(result.fixes.length, 1);
});

test("view_range tolerates surrounding whitespace", () => {
	const result = sanitizeToolArgs({ view_range: "  [ 748 , 764 ]  " });
	assert.deepEqual(result.args.view_range, [748, 764]);
});

test("view_range non-array JSON shapes keep the original string", () => {
	for (const bad of ["100", "[100]", "[100, 145, 3]", "[100, -1]", "[1.5, 2]", "[0, 5]", "not json [", "[]", '{"a":1}']) {
		const result = sanitizeToolArgs({ view_range: bad });
		assert.ok(result === null, `expected no fix for ${bad}`);
	}
});

test("read.windows and edit.edits stringified arrays parse", () => {
	const windows = sanitizeToolArgs({ windows: "[{\"offset\":1,\"limit\":5}]" });
	assert.deepEqual(windows.args.windows, [{ offset: 1, limit: 5 }]);
	const edits = sanitizeToolArgs({ edits: "[{\"anchor_from\":\"a\",\"anchor_to\":\"b\",\"replace_with\":\"x\"}]" });
	assert.ok(Array.isArray(edits.args.edits));
});

test("cordis_inspect_query input stringified object parses; arrays rejected", () => {
	const good = sanitizeToolArgs({ platform: "host", input: "{\"method\":\"config\",\"provider\":\"p\"}" });
	assert.deepEqual(good.args.input, { method: "config", provider: "p" });
	assert.equal(sanitizeToolArgs({ input: "[]" }), null);
	assert.equal(sanitizeToolArgs({ input: "null" }), null); // never bracket-open, and null fails the object assertion anyway
});

test("empty-string encoding is dropped; non-empty kept", () => {
	const fixed = sanitizeToolArgs({ path: "a", encoding: "" });
	assert.ok(fixed !== null);
	assert.equal("encoding" in fixed.args, false);
	assert.deepEqual(fixed.fixes, ["encoding: \"\" -> unset"]);
	assert.equal(sanitizeToolArgs({ encoding: "gbk" }), null);
	assert.equal(sanitizeToolArgs({ encoding: "utf-8" }), null);
});

test("content-bearing fields are never parsed (whitelist discipline)", () => {
	assert.equal(sanitizeToolArgs({ command: "[1m foo", include: "*.ts" }), null);
	assert.equal(sanitizeToolArgs({ pattern: "[a-z]+", path: "x" }), null);
});

test("clean or non-object arguments yield null without mutation", () => {
	const clean = { path: "a", view_range: [1, 2] };
	assert.equal(sanitizeToolArgs(clean), null);
	for (const notObject of [null, undefined, "[1,2]", 42, [1, 2]]) {
		assert.equal(sanitizeToolArgs(notObject), null);
	}
	const original = { view_range: "[1, 2]", encoding: "" };
	sanitizeToolArgs(original);
	assert.equal(original.view_range, "[1, 2]"); // input object untouched
	assert.equal(original.encoding, "");
});

test("multiple fixes apply in one pass", () => {
	const result = sanitizeToolArgs({ view_range: "[10, 20]", encoding: "", edits: "[{\"a\":1}]" });
	assert.equal(result.fixes.length, 3);
	assert.deepEqual(result.args.view_range, [10, 20]);
	assert.equal("encoding" in result.args, false);
	assert.deepEqual(result.args.edits, [{ a: 1 }]);
});

/** Mount the sanitation layer on a recording fake ctx. */
function mount() {
	const listeners = new Map();
	const logs = { warn: [], debug: [] };
	const ctx = {
		on: (name, handler) => listeners.set(name, handler),
		logger: {
			warn: (msg) => logs.warn.push(String(msg)),
			debug: (msg) => logs.debug.push(String(msg)),
		},
	};
	applyToolArgsSanitize(ctx, {});
	return { handler: listeners.get("tools/pre-execute"), logs };
}

test("listener coerces exec.arguments wholesale and always calls next()", () => {
	const { handler, logs } = mount();
	const exec = { name: "str_replace_editor", arguments: { path: "a", view_range: "[100, 145]" } };
	const verdict = { passed: true };
	const returned = handler(exec, () => verdict);
	assert.deepEqual(exec.arguments.view_range, [100, 145]);
	assert.equal(exec.arguments.path, "a");
	assert.equal(returned, verdict);
	assert.equal(logs.debug.length, 1);
	assert.match(logs.debug[0], /sanitized str_replace_editor/);
});

test("listener leaves clean arguments untouched (same reference)", () => {
	const { handler, logs } = mount();
	const args = { path: "a", command: "ls" };
	const exec = { name: "bash", arguments: args };
	handler(exec, () => "ok");
	assert.equal(exec.arguments, args);
	assert.equal(logs.debug.length, 0);
});

test("listener fails open when reading arguments throws", () => {
	const { handler, logs } = mount();
	const exec = {};
	Object.defineProperty(exec, "arguments", { get() { throw new Error("boom"); } });
	const returned = handler(exec, () => "ok");
	assert.equal(returned, "ok");
	assert.equal(logs.warn.length, 1);
	assert.match(logs.warn[0], /failed open: boom/);
});
