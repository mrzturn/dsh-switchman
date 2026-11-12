/** PTC direct-call guard tests.
 *
 * Covers the detection discriminator and the section contract of
 * host/ptc-guard.js against fake ToolsService/systemPrompt shapes:
 * the PTC executor is recognized purely behaviorally (describe() declaring
 * exactly knownNames ["run_code"]), the native executor (no knownNames) and
 * every unusable probe shape render an empty section (fail-open, status quo),
 * and the clause text carries the anchor plus the `await tools.name(args)`
 * SDK call shape quoted from the run_code tool's own description. It also
 * pins the sandbox_permissions never-set rule added after session 22ced69f.
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

/** Fake plugin context capturing systemPrompt.section registrations. */
function fakeCtx(tools) {
	const sections = [];
	const ctx = { tools, systemPrompt: { section: (section) => sections.push(section) } };
	return { ctx, sections };
}

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

test("applyPtcGuard registers exactly one final-say section", () => {
	const { ctx, sections } = fakeCtx(fakeTools({ describe: PTC_DESCRIBE }).tools);
	applyPtcGuard(ctx);
	assert.equal(sections.length, 1);
	const section = sections[0];
	assert.equal(section.name, "switchman:ptc-guard");
	assert.equal(section.order, 10510);
	assert.equal(section.interpolate, false);
	assert.equal(typeof section.text, "function");
});

test('section text renders the clause for a PTC scope and "" otherwise', () => {
	const { ctx, sections } = fakeCtx(fakeTools({ describe: PTC_DESCRIBE }).tools);
	applyPtcGuard(ctx);
	const text = sections[0].text;
	const scope = { agent: "agent-3" };

	const rendered = text({ scope });
	assert.match(rendered, /^\[SWITCHMAN:PTC\] /);
	assert.match(rendered, /`run_code` is the ONLY tool callable directly/);
	assert.match(rendered, /await tools\.name\(args\)/);
	assert.match(rendered, /await tools\.skill\(\{ name: "git-commit-message" \}\)/);
	assert.match(rendered, /await tools\.spawn_teammate\(\{ \.\.\. \}\)/);
	assert.match(rendered, /unknown tool "x"/);
	assert.match(rendered, /Never set `sandbox_permissions` on any call, direct or SDK/);
	assert.match(rendered, /not strictly wider than this call's current \.\.\. mode/);
	assert.match(rendered, /retry without the field/);
});

test("section text is empty for a native scope and every fail-open shape", () => {
	for (const tools of [
		fakeTools({ describe: NATIVE_DESCRIBE }).tools,
		fakeTools({}).tools,
		fakeTools({}, { missingMethod: true }).tools,
		fakeTools({}, { throwing: true }).tools,
	]) {
		const { ctx, sections } = fakeCtx(tools);
		applyPtcGuard(ctx);
		assert.equal(sections[0].text({ scope: { agent: "x" } }), "");
	}
	// No tools service at all: the closure must not throw.
	const { ctx, sections } = fakeCtx(undefined);
	applyPtcGuard(ctx);
	assert.equal(sections[0].text({}), "");
	assert.equal(sections[0].text(undefined), "");
});

test("renderPtcGuard is byte-stable and interpolation-safe", () => {
	assert.equal(renderPtcGuard(), renderPtcGuard());
	assert.equal(renderPtcGuard().split("\n").length, 5);
	assert.ok(renderPtcGuard().includes("{ name:"));
});

test("the section text forwards the assemble context's scope to the probe", () => {
	const seen = [];
	const executor = { describe: PTC_DESCRIBE };
	const tools = {
		selectExecutor(scope) {
			seen.push(scope);
			return executor;
		},
	};
	const { ctx, sections } = fakeCtx(tools);
	applyPtcGuard(ctx);
	const scope = { agent: "agent-4", step: 7 };
	assert.notEqual(sections[0].text({ scope }), "");
	assert.deepEqual(seen, [scope]);
});
