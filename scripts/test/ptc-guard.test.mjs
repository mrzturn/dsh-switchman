/** PTC direct-call guard tests.
 *
 * Covers the detection discriminator and the dual-channel registration
 * contract of host/ptc-guard.js (mounted through host/tail-context.js)
 * against fake ToolsService/systemPrompt shapes: the PTC executor is
 * recognized purely behaviorally (describe() declaring exactly knownNames
 * ["run_code"]), the native executor (no knownNames) and every unusable
 * probe shape render an empty section AND an empty context entry (fail-open,
 * status quo). The head channel carries the byte-stable guard rules; the
 * growing ledger clause travels in the tail `systemPrompt.context` entry and
 * the head bytes never change while it grows (cache-stability core). Hosts
 * without the context API fall back to the legacy head embedding with a
 * warning. It also pins routine run_code argument handling,
 * invalid-justification retry behavior, grep regex escape/recovery, and the
 * sandbox_permissions never-set rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyPtcGuard,
	isPtcDescription,
	isPtcScope,
	renderPtcGuard,
	selectedExecutor,
} from "../../host/ptc-guard.js";
import { applyPtcBindings, clearSessionLedger } from "../../host/ptc-bindings.js";

/** PTC executor shape: describe() declares exactly the reserved run_code transport. */
const PTC_DESCRIBE = () => ({ schemas: [{ name: "run_code" }], knownNames: ["run_code"] });
/** Native executor shape: describe() projects schemas only, no knownNames field. */
const NATIVE_DESCRIBE = () => ({ schemas: [] });

/** Fake ToolsService recording selectExecutor calls. */
function fakeTools(executor, { missingMethod = false, throwing = false } = {}) {
	const calls = [];
	const tools = missingMethod
		? {}
		: {
				selectExecutor(scope) {
					calls.push(scope);
					if (throwing) throw new Error("The selected tool executor is unavailable.");
					return executor;
				},
			};
	return { tools, calls };
}

/** Fake plugin context capturing systemPrompt.section AND systemPrompt.context
 *  registrations (the tail ledger slot added by the cache-safe migration). */
function fakeCtx(tools) {
	const sections = [];
	const contexts = [];
	const warnings = [];
	const ctx = {
		logger: { warn: (message) => warnings.push(message) },
		tools,
		systemPrompt: {
			section: (section) => sections.push(section),
			context: (entry) => contexts.push(entry),
		},
	};
	return { ctx, sections, contexts, warnings };
}

/** Fake context for host/ptc-bindings.js: records waterfall listeners only. */
function fakeBindingsCtx() {
	const listeners = {};
	const ctx = {
		on(event, fn) { (listeners[event] ??= []).push(fn); },
		systemPrompt: { section: () => {}, context: () => {} },
		logger: { info() {}, warn() {} },
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

test("isPtcDescription matches exactly the single run_code knownName", () => {
	assert.equal(isPtcDescription({ schemas: [], knownNames: ["run_code"] }), true);
	assert.equal(isPtcDescription({ schemas: [] }), false); // native shape
	assert.equal(isPtcDescription({ schemas: [], knownNames: [] }), false);
	assert.equal(isPtcDescription({ schemas: [], knownNames: ["run_code", "other"] }), false);
	assert.equal(isPtcDescription({ schemas: [], knownNames: ["spawn_teammate"] }), false);
	assert.equal(isPtcDescription(null), false);
	assert.equal(isPtcDescription("run_code"), false);
	assert.equal(isPtcDescription({ knownNames: "run_code" }), false);
});

test("selectedExecutor passes the scope through and fails open", () => {
	const executor = { describe: PTC_DESCRIBE };
	const { tools, calls } = fakeTools(executor);
	const scope = { agent: "agent-1" };
	assert.equal(selectedExecutor({ tools }, scope), executor);
	assert.deepEqual(calls, [scope]);

	// Unusable probe shapes all resolve to null, never throw.
	assert.equal(selectedExecutor({}, scope), null); // no tools service
	assert.equal(selectedExecutor(null, scope), null);
	assert.equal(selectedExecutor({ tools: fakeTools(executor, { missingMethod: true }).tools }, scope), null);
	assert.equal(selectedExecutor({ tools: fakeTools(executor, { throwing: true }).tools }, scope), null);
	assert.equal(selectedExecutor({ tools: { selectExecutor: () => 42 } }, scope), null);
});

test("isPtcScope discriminates behaviorally and tolerates a throwing describe", () => {
	const scope = { agent: "agent-2" };
	assert.equal(isPtcScope({ tools: fakeTools({ describe: PTC_DESCRIBE }).tools }, scope), true);
	assert.equal(isPtcScope({ tools: fakeTools({ describe: NATIVE_DESCRIBE }).tools }, scope), false);
	assert.equal(isPtcScope({ tools: fakeTools({ describe: () => { throw new Error("boom"); } }).tools }, scope), false);
	assert.equal(isPtcScope({ tools: fakeTools({}).tools }, scope), false); // executor without describe
});

test("applyPtcGuard registers the head rules section and the tail ledger entry", () => {
	const { ctx, sections, contexts } = fakeCtx(fakeTools({ describe: PTC_DESCRIBE }).tools);
	applyPtcGuard(ctx);
	assert.equal(sections.length, 1);
	assert.equal(contexts.length, 1);
	const section = sections[0];
	assert.equal(section.name, "switchman:ptc-guard");
	assert.equal(section.order, 10510);
	assert.equal(section.interpolate, false);
	assert.equal(typeof section.text, "function");
	const entry = contexts[0];
	assert.equal(entry.name, "switchman:ptc-ledger");
	assert.equal(entry.order, 310);
	assert.equal(entry.required, true);
	assert.equal(entry.interpolate, false);
	assert.equal(typeof entry.text, "function");
});

test('head rules render for a PTC scope and "" otherwise; ledger clause rides the tail entry', () => {
	const { ctx, sections, contexts } = fakeCtx(fakeTools({ describe: PTC_DESCRIBE }).tools);
	applyPtcGuard(ctx);
	const head = sections[0].text;
	const tail = contexts[0].text;
	const scope = { agent: "agent-3" };

	const rendered = head({ scope });
	assert.match(rendered, /^\[SWITCHMAN:PTC\] /);
	assert.match(rendered, /`run_code` is the ONLY tool callable directly/);
	assert.match(rendered, /await tools\.name\(args\)/);
	assert.match(rendered, /await tools\.skill\(\{ name: "git-commit-message" \}\)/);
	assert.match(rendered, /await tools\.spawn_teammate\(\{ \.\.\. \}\)/);
	assert.match(rendered, /unknown tool "x"/);
	assert.match(rendered, /Never set `sandbox_permissions` on any call, direct or SDK/);
	assert.ok(rendered.includes('For routine `run_code` calls'));
	assert.match(rendered, /pass only `code`, `description`, and `timeoutMs`; omit both `sandbox_permissions` and `justification`/);
	assert.match(rendered, /invalid justification, never repeat it unchanged; retry without those fields/);
	assert.match(rendered, /parser error such as "Expected ident"/);
	assert.match(rendered, /long prompt text/);
	assert.match(rendered, /double-quoted JavaScript string/);
	assert.match(rendered, /JSON\.stringify\(text\)/);
	assert.ok(rendered.includes('getResource(".")'));
	assert.ok(rendered.includes('System.getProperty("user.dir")'));
	assert.ok(rendered.includes('when present, the appended "File sandbox: ..." reports execution context, not the cause'));
	assert.match(rendered, /not strictly wider than this call's current \.\.\. mode/);
	assert.match(rendered, /retry without the field/);
	assert.match(rendered, /`grep\.pattern` is a regular expression/);
	assert.ok(rendered.includes('write `"\\\\("` to pass `\\(`'));
	assert.match(rendered, /String\.raw/);
	assert.match(rendered, /unclosed group/);
	assert.match(rendered, /never repeat it unchanged/);
	assert.ok(rendered.includes("MUST wrap the entire run_code program body in an async IIFE"));
	assert.ok(rendered.includes("await (async () => { ... })();"));
	assert.ok(rendered.includes("this makes reusing local names such as `res` safe"));
	assert.match(rendered, /Top-level bindings persist for this Agent/);
	assert.ok(rendered.includes("never redeclare existing top-level `const`/`let`/`class`"));
	assert.ok(rendered.includes("Identifier ... has already been declared"));
	assert.match(rendered, /rewrite the program in the IIFE rather than merely rerunning it/);
	assert.ok(rendered.includes("globalThis.__dshSwitchmanPtcBindings"));
	assert.ok(rendered.includes("This ledger is manually maintained, not automatic introspection"));
	// The migrated clause no longer rides in the head channel.
	assert.ok(!rendered.includes("PTC-LEDGER"));
});

test("head bytes stay constant while the ledger grows (cache-stability core)", async () => {
	const { ctx, listeners } = fakeBindingsCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-grow");
	const tools = { selectExecutor: () => ({ describe: PTC_DESCRIBE }) };
	const { ctx: guardCtx, sections, contexts } = fakeCtx(tools);
	applyPtcGuard(guardCtx);
	const head = sections[0].text;
	const tail = contexts[0].text;
	const assemble = { scope: agent, agent };

	// Empty ledger: head renders the rules, tail renders zero bytes.
	const headBefore = head(assemble);
	assert.match(headBefore, /^\[SWITCHMAN:PTC\] /);
	assert.equal(tail(assemble), "");

	// Grow the ledger in steps; head bytes NEVER change while the tail grows.
	await runCall(listeners, { agent, code: "const alpha = 1;" });
	assert.match(tail(assemble), /^\[SWITCHMAN:PTC-LEDGER\] 1 top-level binding already declared/);
	assert.ok(tail(assemble).includes("alpha"));
	assert.equal(head(assemble), headBefore);
	await runCall(listeners, { agent, code: "const beta = 2;\nlet gamma = 3;" });
	const grown = tail(assemble);
	assert.match(grown, /3 top-level bindings already declared/);
	assert.ok(grown.includes("alpha, beta, gamma"));
	assert.equal(head(assemble), headBefore);

	// Legacy fallback equivalence: with the payload non-empty, today's
	// pre-refactor shape (guard + blank line + clause) is reproduced exactly.
	assert.equal(`${head(assemble)}\n\n${grown}`, renderPtcGuard() + "\n\n" + grown);
	// Tail collapses to "" when the agent has no recorded ledger.
	assert.equal(tail({ scope: agent }), "");
	assert.equal(tail({}), "");
	assert.equal(tail(undefined), "");

	clearSessionLedger("sess-grow");
});

test("tail ledger entry is gated by isPtcScope exactly like the head rules", async () => {
	const { ctx, listeners } = fakeBindingsCtx();
	applyPtcBindings(ctx);
	const agent = agentOf("sess-gate");
	await runCall(listeners, { agent, code: "const gated = 1;" });
	// Native executor: both channels render "" despite a recorded ledger.
	const native = fakeCtx({ selectExecutor: () => ({ describe: NATIVE_DESCRIBE }) });
	applyPtcGuard(native.ctx);
	const assemble = { scope: agent, agent };
	assert.equal(native.sections[0].text(assemble), "");
	assert.equal(native.contexts[0].text(assemble), "");
	// Missing tools service entirely: fail-open "" on both channels, and the
	// closures must not throw for any assemble-context shape.
	const bare = fakeCtx(undefined);
	applyPtcGuard(bare.ctx);
	assert.equal(bare.sections[0].text({}), "");
	assert.equal(bare.contexts[0].text({}), "");
	assert.equal(bare.sections[0].text(undefined), "");
	assert.equal(bare.contexts[0].text(undefined), "");
	clearSessionLedger("sess-gate");
});

test("legacy fallback: no context API embeds the payload after a blank line and warns", async () => {
	const { ctx: bindingsCtx, listeners } = fakeBindingsCtx();
	applyPtcBindings(bindingsCtx);
	const warnings = [];
	const sections = [];
	const ctx = {
		logger: { warn: (message) => warnings.push(message) },
		tools: fakeTools({ describe: PTC_DESCRIBE }).tools,
		// No systemPrompt.context at all — pre-migration host shape.
		systemPrompt: { section: (section) => sections.push(section) },
	};
	applyPtcGuard(ctx);
	assert.equal(sections.length, 1);
	const text = sections[0].text;
	const agent = agentOf("sess-legacy");
	const assemble = { scope: agent, agent };
	// Empty payload -> head rules only (same bytes as the dual-channel head).
	assert.equal(text(assemble), renderPtcGuard());
	// Non-empty payload -> guard rules, blank line, ledger clause (today's
	// exact pre-refactor shape).
	await runCall(listeners, { agent, code: "const legacy = 1;" });
	const combined = text(assemble);
	assert.ok(combined.startsWith(renderPtcGuard() + "\n\n"));
	assert.ok(combined.includes("[SWITCHMAN:PTC-LEDGER]"));
	// Exactly one degradation warning per registration.
	assert.equal(warnings.filter((message) => message.includes("legacy mode")).length, 1);
	clearSessionLedger("sess-legacy");
});

test('section text and context entry are empty for a native scope and every fail-open shape', () => {
	for (const tools of [
		fakeTools({ describe: NATIVE_DESCRIBE }).tools,
		fakeTools({}).tools,
		fakeTools({}, { missingMethod: true }).tools,
		fakeTools({}, { throwing: true }).tools,
	]) {
		const { ctx, sections, contexts } = fakeCtx(tools);
		applyPtcGuard(ctx);
		assert.equal(sections[0].text({ scope: { agent: "x" } }), "");
		assert.equal(contexts[0].text({ scope: { agent: "x" } }), "");
	}
	// No tools service at all: the closures must not throw.
	const { ctx, sections, contexts } = fakeCtx(undefined);
	applyPtcGuard(ctx);
	assert.equal(sections[0].text({}), "");
	assert.equal(sections[0].text(undefined), "");
	assert.equal(contexts[0].text({}), "");
	assert.equal(contexts[0].text(undefined), "");
});

test("renderPtcGuard is byte-stable and interpolation-safe", () => {
	assert.equal(renderPtcGuard(), renderPtcGuard());
	assert.equal(renderPtcGuard().split("\n").length, 11);
	assert.ok(renderPtcGuard().includes("{ name:"));
});

test("the section and context closures forward the assemble context's scope to the probe", () => {
	const seen = [];
	const executor = { describe: PTC_DESCRIBE };
	const tools = {
		selectExecutor(scope) {
			seen.push(scope);
			return executor;
		},
	};
	const { ctx, sections, contexts } = fakeCtx(tools);
	applyPtcGuard(ctx);
	const scope = { agent: "agent-4", step: 7 };
	assert.notEqual(sections[0].text({ scope }), "");
	// The tail probes too, but renders "" without an agent/recorded ledger.
	assert.equal(contexts[0].text({ scope }), "");
	assert.deepEqual(seen, [scope, scope]);
});
