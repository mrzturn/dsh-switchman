/** Language-layer tail migration tests (T7 of the 2026-11-21 cache-stability
 *  design, docs/requirements-and-design/2026-11-21-cache-safe-injection-design.md).
 *
 *  No lang test existed before this migration; these pin the post-T7 contract:
 *  - the head section NEVER renders the ask guidance (byte-stable doctrine:
 *    the configured [SWITCHMAN:LANG] block, "" while unconfigured);
 *  - the tail payload renders the ask guidance once, then latches to ""
 *    (per process in global scope, per session in project scope);
 *  - subagents never see the ask guidance;
 *  - the configured-language block stays in the head, verbatim;
 *  - the post-execute ask_user_question capture still latches and persists
 *    (unchanged side-effect path);
 *  - registration goes through registerTailContext (context entry named
 *    switchman:lang-ask, order 370, required, interpolate: false).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyLanguage } from "../../host/lang.js";

/** Three-question ask payload the ask_user_question listener parses. */
const MARKER_ANSWERS = {
	answers: [
		{ id: "q-conversation", selected: ["Deutsch"] },
		{ id: "q-comments", selected: ["English"] },
		{ id: "q-docs", selected: [] },
	],
};

/** Fake plugin context for applyLanguage: settings-driven config fields,
 *  root-only agent registry, both systemPrompt channels, recorded listeners.
 *  `project` switches langScope to project mode (prefs then come from
 *  `<cwd>/.switchman/lang.json` files, not the config fields). */
function fakeHost({ project = false, configured = true } = {}) {
	const sections = [];
	const contexts = [];
	const listeners = {};
	/** Mutable root registry: isRoot() is identity-based (roots.includes),
	 *  so tests push the agents that must be allowed to ask. */
	const roots = [ROOT_AGENT];
	const config = {
		langScope: { get: () => (project ? "project" : "global") },
		...(configured
			? {
					langConversation: { get: () => "English" },
					langComments: { get: () => "" },
					langDocs: { get: () => "" },
				}
			: {}),
	};
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		agents: {
			roots: () => roots,
		},
		systemPrompt: {
			section: (section) => sections.push(section),
			context: (entry) => contexts.push(entry),
		},
		on: (event, fn) => {
			(listeners[event] ??= []).push(fn);
		},
	};
	return { ctx, config, sections, contexts, listeners, roots };
}

const ROOT_AGENT = { session: { id: "s-root", header: { cwd: "/nowhere" } } };
const SUB_AGENT = { session: { id: "s-sub", header: { cwd: "/nowhere" } } };

/** Fire the post-execute ask capture with a marker-carrying ask. */
function askOnce(ctx, listeners, agent, value) {
	const exec = {
		name: "ask_user_question",
		agent,
		arguments: {
			questions: [
				{ id: "q-conversation", question: "conversation? (switchman-lang)" },
				{ id: "q-comments", question: "comments? (switchman-lang)" },
				{ id: "q-docs", question: "docs? (switchman-lang)" },
			],
		},
	};
	for (const fn of listeners["tools/post-execute"] ?? []) fn(exec, { value }, () => "next");
}

test("applyLanguage registers the head doctrine plus the lang-ask tail entry", () => {
	const { ctx, config, sections, contexts } = fakeHost({});
	applyLanguage(ctx, config);
	assert.equal(sections.length, 1);
	assert.equal(contexts.length, 1);
	const section = sections[0];
	assert.equal(section.name, "switchman:lang");
	assert.equal(section.order, 10300);
	assert.equal(section.interpolate, false);
	const entry = contexts[0];
	assert.equal(entry.name, "switchman:lang-ask");
	assert.equal(entry.order, 370);
	assert.equal(entry.required, true);
	assert.equal(entry.interpolate, false);
});

test("configured: the [SWITCHMAN:LANG] block renders in the head and the payload stays empty", () => {
	const { ctx, config, sections, contexts } = fakeHost({});
	applyLanguage(ctx, config);
	const agent = ROOT_AGENT;
	const head = sections[0].text({ agent });
	assert.match(head, /^\[SWITCHMAN:LANG\] conversation=English comments=same docs=same\n/);
	assert.match(head, /IRON RULE/);
	assert.ok(!head.includes("ask_user_question"), "head carries no ask guidance");
	assert.equal(contexts[0].text({ agent }), "");
	// Byte-stability: repeated assemblies render identical head bytes.
	assert.equal(sections[0].text({ agent }), head);
});

test("unconfigured global scope: ask guidance rides the tail once, then latches to empty", () => {
	const { ctx, config, sections, contexts, listeners } = fakeHost({ configured: false });
	applyLanguage(ctx, config);
	const agent = ROOT_AGENT;
	// Head renders "" (unconfigured), payload renders the guidance.
	assert.equal(sections[0].text({ agent }), "");
	const first = contexts[0].text({ agent });
	assert.ok(first.startsWith("[SWITCHMAN:LANG] not configured for this project yet."));
	assert.ok(first.includes('include the marker\n"switchman-lang" in each question text'));
	// Second assembly before any ask: same bytes (still unlatched).
	assert.equal(contexts[0].text({ agent }), first);
	// Head still carries no ask guidance bytes at any point.
	assert.equal(sections[0].text({ agent }), "");
	// The ask (any ask_user_question call) latches the payload to "".
	askOnce(ctx, listeners, agent, null);
	assert.equal(contexts[0].text({ agent }), "");
	// Head remains "" — the latch must not disturb head bytes either.
	assert.equal(sections[0].text({ agent }), "");
});

test("unconfigured project scope: the latch is per session, not per process", () => {
	const { ctx, config, sections, contexts, listeners, roots } = fakeHost({ configured: false, project: true });
	applyLanguage(ctx, config);
	const a = { session: { id: "s-a" } };
	const b = { session: { id: "s-b" } };
	roots.push(a, b);
	const guidance = contexts[0].text({ agent: a });
	assert.ok(guidance.startsWith("[SWITCHMAN:LANG] not configured"));
	// Session b is a different session — still unlatched.
	assert.equal(contexts[0].text({ agent: b }), guidance);
	// Asking in session a latches only a.
	askOnce(ctx, listeners, a, null);
	assert.equal(contexts[0].text({ agent: a }), "");
	assert.equal(contexts[0].text({ agent: b }), guidance);
	// A session without an id degrades to the process-wide latch: the ask
	// above latched only session a, so an id-less agent still asks once.
	const anonymous = {};
	roots.push(anonymous);
	assert.ok(contexts[0].text({ agent: anonymous }).startsWith("[SWITCHMAN:LANG]"));
});

test("subagents never see the ask guidance", () => {
	const { ctx, config, sections, contexts } = fakeHost({ configured: false });
	applyLanguage(ctx, config);
	assert.equal(sections[0].text({ agent: SUB_AGENT }), "");
	assert.equal(contexts[0].text({ agent: SUB_AGENT }), "");
	// Unknown registry also counts as root (fail-open) — a usable agent object
	// still asks; a null agent must not throw.
	assert.doesNotThrow(() => contexts[0].text({ agent: null }));
	assert.doesNotThrow(() => sections[0].text({ agent: null }));
});

test("project scope: configured project file renders in the head, missing file asks", () => {
	const dir = mkdtempSync(join(tmpdir(), "switchman-lang-tail-"));
	try {
		// Project A configured on disk; project B empty.
		mkdirSync(join(dir, "a", ".switchman"), { recursive: true });
		writeFileSync(join(dir, "a", ".switchman", "lang.json"), JSON.stringify({ langConversation: "Français", langComments: "", langDocs: "" }), "utf8");
		const agentA = { session: { id: "s-a", header: { cwd: join(dir, "a") } } };
		const agentB = { session: { id: "s-b", header: { cwd: join(dir, "b") } } };
		const { ctx, config, sections, contexts, roots } = fakeHost({ configured: false, project: true });
		applyLanguage(ctx, config);
		roots.push(agentA, agentB);
		const headA = sections[0].text({ agent: agentA });
		assert.match(headA, /^\[SWITCHMAN:LANG\] conversation=Français comments=same docs=same\n/);
		assert.ok(!headA.includes("ask_user_question"));
		assert.equal(contexts[0].text({ agent: agentA }), "", "configured session never asks");
		assert.equal(sections[0].text({ agent: agentB }), "", "unconfigured project asks via the tail");
		assert.ok(contexts[0].text({ agent: agentB }).startsWith("[SWITCHMAN:LANG] not configured"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("capture path unchanged: a captured ask latches, persists the project file, and the head block appears", () => {
	const dir = mkdtempSync(join(tmpdir(), "switchman-lang-capture-"));
	try {
		const agent = { session: { id: "s-persist", header: { cwd: join(dir, "p") } } };
		const { ctx, config, sections, contexts, listeners, roots } = fakeHost({ configured: false, project: true });
		applyLanguage(ctx, config);
		roots.push(agent);
		// Unlatched: guidance in the tail.
		assert.ok(contexts[0].text({ agent }).startsWith("[SWITCHMAN:LANG] not configured"));
		askOnce(ctx, listeners, agent, MARKER_ANSWERS);
		// Latched + persisted: payload empty, head now carries the block.
		assert.equal(contexts[0].text({ agent }), "");
		assert.match(sections[0].text({ agent }), /^\[SWITCHMAN:LANG\] conversation=Deutsch comments=English docs=Deutsch\n/);
		const stored = JSON.parse(readFileSync(join(dir, "p", ".switchman", "lang.json"), "utf8"));
		assert.deepEqual(stored, { langConversation: "Deutsch", langComments: "English", langDocs: "Deutsch" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
