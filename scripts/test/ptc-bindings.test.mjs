/** PTC automatic binding ledger tests.
 *
 * Covers the zero-dependency declaration scanner of host/ptc-bindings.js
 * (top-level const/let/var/class/function/enum capture; comments, strings,
 * template literals and regex literals never produce names; IIFE bodies,
 * for-loop heads and nested blocks are excluded; destructuring patterns
 * bind their targets), the session ledger lifecycle (commit on success,
 * rollback + self-heal on the has-already-been-declared rejection, commit
 * on runtime failures, clear on session disposal and on the PTC reset
 * notice), and the ptc-guard section integration ([SWITCHMAN:PTC-LEDGER]
 * appears only for PTC scopes whose session already recorded names).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyPtcBindings,
	clearSessionLedger,
	renderPtcLedgerClause,
	sessionKeyOf,
	stripLiterals,
	topLevelDeclarations,
} from "../../host/ptc-bindings.js";
import { applyPtcGuard } from "../../host/ptc-guard.js";

const PTC_DESCRIBE = () => ({ schemas: [{ name: "run_code" }], knownNames: ["run_code"] });

/** Fake plugin context that records waterfall listeners and session events. */
function fakeCtx() {
	const listeners = {};
	const ctx = {
		on(event, fn) { (listeners[event] ??= []).push(fn); },
		systemPrompt: { section: () => {} },
	};
	return { ctx, listeners };
}

/** Drive one outer run_code call through the mounted pre/post listeners. */
async function runCall(listeners, { agent, code, isError = false, errorText = null }) {
	const exec = { name: "run_code", arguments: { code, description: "d" }, agent };
	for (const fn of listeners["tools/pre-execute"] ?? []) await fn(exec, () => "next");
	const result = isError
		? { isError: true, error: { message: errorText ?? "failed" }, content: [{ type: "text", text: errorText ?? "failed" }] }
		: { value: { logs: [] } };
	for (const fn of listeners["tools/post-execute"] ?? []) await fn(exec, result, () => "next");
}

function agentOf(id) { return { id, session: { id } }; }

test("topLevelDeclarations captures top-level names", () => {
	const prog = [
		"const fs = require('node:fs');",
		"const a = 1, b = 2;",
		"let { x, y: z, ...rest } = obj;",
		"var r;",
		"function helper() {}",
		"class Box {}",
	].join("\n");
	assert.deepEqual(topLevelDeclarations(prog), ["fs", "a", "b", "x", "z", "rest", "r", "helper", "Box"]);
});

test("topLevelDeclarations ignores keywords inside literals", () => {
	const prog = [
		"var r = \"const hidden = 1\";",
		"// const commented = 2;",
		"/* let blocked = 3; */",
		"const s = `tpl const fake = 2 ${a + 1}`;",
		"const re = /const fake2 = 3/;",
	].join("\n");
	assert.deepEqual(topLevelDeclarations(prog), ["r", "s", "re"]);
});

test("topLevelDeclarations excludes IIFE bodies, for-heads and blocks", () => {
	const prog = [
		"await (async () => { const local = 1; })();",
		"for (const i of [1]) { const inner = 2; }",
		"if (true) { const block = 3; }",
		"const top = 4;",
	].join("\n");
	assert.deepEqual(topLevelDeclarations(prog), ["top"]);
});

test("topLevelDeclarations tolerates empty and non-string input", () => {
	assert.deepEqual(topLevelDeclarations(""), []);
	assert.deepEqual(topLevelDeclarations(null), []);
	assert.deepEqual(topLevelDeclarations(42), []);
});

test("sessionKeyOf prefers session.id and falls back to id", () => {
	assert.equal(sessionKeyOf({ id: "a1", session: { id: "s1" } }), "s1");
	assert.equal(sessionKeyOf({ id: "a1" }), "a1");
	assert.equal(sessionKeyOf(null), null);
	assert.equal(sessionKeyOf("s"), null);
	assert.equal(sessionKeyOf({ id: "" }), null);
});

test("applyPtcBindings commits successful top-level names per session", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-commit");
	await runCall(listeners, { agent, code: "const alpha = 1; let beta = 2;" });
	const clause = renderPtcLedgerClause("sess-commit");
	assert.match(clause, /^\[SWITCHMAN:PTC-LEDGER\] /);
	assert.match(clause, /2 top-level bindings already declared/);
	assert.ok(clause.includes("alpha, beta"));
	assert.ok(clause.includes("Never redeclare these names at the top level"));
	clearSessionLedger("sess-commit");
});

test("non-run_code tools never touch the ledger", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-nested");
	await runCall(listeners, { agent, code: "const keep = 1;" });
	const exec = { name: "skill", arguments: { name: "x" }, agent };
	for (const fn of listeners["tools/pre-execute"] ?? []) await fn(exec, () => "next");
	for (const fn of listeners["tools/post-execute"] ?? []) await fn(exec, { value: {} }, () => "next");
	const clause = renderPtcLedgerClause("sess-nested");
	assert.ok(clause.includes("keep"));
	clearSessionLedger("sess-nested");
});

test("redeclare rejection rolls back parked names and self-heals", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-heal");
	await runCall(listeners, { agent, code: "const fs = 1;" });
	await runCall(listeners, {
		agent,
		code: "const fs = 2; const neverRan = 3;",
		isError: true,
		errorText: "Uncaught SyntaxError: Identifier 'fs' has already been declared",
	});
	const clause = renderPtcLedgerClause("sess-heal");
	assert.ok(clause.includes("fs"));
	assert.ok(!clause.includes("neverRan"));
	clearSessionLedger("sess-heal");
});

test("runtime failure commits the parked names", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-runtime");
	await runCall(listeners, {
		agent,
		code: "const part = 1; throw new Error(\"boom\");",
		isError: true,
		errorText: "Error: boom",
	});
	const clause = renderPtcLedgerClause("sess-runtime");
	assert.ok(clause.includes("part"));
	clearSessionLedger("sess-runtime");
});

test("session/disposed clears the ledger", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-dispose");
	await runCall(listeners, { agent, code: "const gone = 1;" });
	assert.ok(renderPtcLedgerClause("sess-dispose") !== "");
	for (const fn of listeners["session/disposed"] ?? []) fn({ id: "sess-dispose" });
	assert.equal(renderPtcLedgerClause("sess-dispose"), "");
});

test("the PTC environment-reset notice clears the ledger", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-reset");
	await runCall(listeners, { agent, code: "const stale = 1;" });
	assert.ok(renderPtcLedgerClause("sess-reset") !== "");
	const event = {
		type: "user/message",
		data: {
			source: { kind: "ptc-mode" },
			content: [{ type: "text", text: "Program environment reset; retained variables cleared. Completed tool effects remain." }],
		},
	};
	for (const fn of listeners["session/event"] ?? []) fn(agent.session, event);
	assert.equal(renderPtcLedgerClause("sess-reset"), "");
});

test("unrelated ptc-mode messages do not clear the ledger", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-keep");
	await runCall(listeners, { agent, code: "const stay = 1;" });
	const event = { type: "user/message", data: { source: { kind: "ptc-mode" }, content: [{ type: "text", text: "unrelated" }] } };
	for (const fn of listeners["session/event"] ?? []) fn(agent.session, event);
	assert.ok(renderPtcLedgerClause("sess-keep") !== "");
	clearSessionLedger("sess-keep");
});

function guardSections(tools) {
	const sections = [];
	applyPtcGuard({ tools, systemPrompt: { section: (s) => sections.push(s) } });
	return sections;
}

test("the guard section appends the ledger clause for a recorded PTC session", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-guard");
	await runCall(listeners, { agent, code: "const ledg = 1; const idx = 2;" });
	const tools = { selectExecutor: () => ({ describe: PTC_DESCRIBE }) };
	const text = guardSections(tools)[0].text;
	const rendered = text({ scope: agent, agent });
	assert.match(rendered, /^\[SWITCHMAN:PTC\] /);
	assert.ok(rendered.includes("[SWITCHMAN:PTC-LEDGER]"));
	assert.ok(rendered.includes("ledg, idx"));
	clearSessionLedger("sess-guard");
	const after = text({ scope: agent, agent });
	assert.match(after, /^\[SWITCHMAN:PTC\] /);
	assert.ok(!after.includes("PTC-LEDGER"));
});

test("the guard section stays ledger-free without an assemble agent", () => {
	const tools = { selectExecutor: () => ({ describe: PTC_DESCRIBE }) };
	const rendered = guardSections(tools)[0].text({ scope: { agent: "anon" } });
	assert.match(rendered, /^\[SWITCHMAN:PTC\] /);
	assert.ok(!rendered.includes("PTC-LEDGER"));
});

test("native scopes never render any ledger text", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-native");
	await runCall(listeners, { agent, code: "const nat = 1;" });
	const tools = { selectExecutor: () => ({ describe: () => ({ schemas: [] }) }) };
	assert.equal(guardSections(tools)[0].text({ scope: agent, agent }), "");
	clearSessionLedger("sess-native");
});

test("listener errors fail open and the call proceeds", async () => {
	const { ctx, listeners } = fakeCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-failopen");
	const exec = { name: "run_code", agent };
	for (const fn of listeners["tools/pre-execute"] ?? []) await fn(exec, () => "next");
	for (const fn of listeners["tools/post-execute"] ?? []) await fn(exec, { value: {} }, () => "next");
	assert.equal(renderPtcLedgerClause("sess-failopen"), "");
});
