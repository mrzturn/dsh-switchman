/** Full-loop integration tests for the context-trim layer.
 *
 * Drives a REAL-shaped mock host: the llm/stream waterfall listener is
 * invoked once per turn with a FRESH raw array rebuilt from a session
 * store (host semantics — in-place mutation never persists), idle fires
 * through agent/status with the production OBJECT payload, and the
 * systemPrompt context callback receives an object agent. Also covers
 * the meter-duality bridge (design §8): the watermark prefers the trim
 * layer's fresh outbound-view estimate over the stored token tally.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { applyContextTrim, recentTrimInjectOf, recentTrimPromptTokensOf, recentTrimViewTokensOf } from "../../host/context-trim/index.js";
import { measureNow } from "../../host/context-watch.js";
import { estimateTokensOf, refOf, refPositions } from "../../host/context-trim/view.js";

/** Minimal host-ctx mock (same contract as context-trim.test.mjs). */
function mockCtx({ llmFiber = null } = {}) {
	const sections = [];
	const contexts = [];
	const hooks = {};
	const registeredTools = [];
	const injects = [];
	let currentSessionId = "";
	const ctx = {
		log: { warn: () => {} },
		fiber: { uid: 42 },
		agents: { currentInitiator: () => ({ session: { id: currentSessionId } }) },
		systemPrompt: {
			section: (s) => sections.push(s),
			context: (c) => contexts.push(c),
		},
		on: (event, handler) => {
			hooks[event] = handler;
		},
		tools: { register: (tool) => registeredTools.push(tool) },
		get: () => null,
		inject(deps, body) {
			injects.push({ deps, body });
			if (deps.includes("llm") && llmFiber !== null) body(llmFiber);
		},
	};
	return { ctx, sections, contexts, hooks, registeredTools, injects, setSessionId: (id) => { currentSessionId = id; } };
}

const config = {
	trimEnabled: true,
	trimMode: "auto",
	trimGrowthTokens: 5_000,
	trimIncrementTokens: 1,
	trimPressurePercent: 40,
	trimEmergencyPercent: 101, // off — this loop exercises the pressure tier
	trimProtectedTail: 6,
	trimMaxFoldsPerHour: 6,
	trimSideModel: { provider: "", model: "" },
	trimStateDir: "",
};

/** Drain microtasks until cond() holds (bounded) — no timer APIs so the
 * loop stays safe under node:test mock timers. */
async function poll(cond, limit = 500) {
	for (let i = 0; i < limit; i++) {
		if (cond()) return true;
		await Promise.resolve();
		await Promise.resolve();
	}
	return cond();
}

test("full loop: auto folds commit across raw re-sends; pairs intact; banner renders; fail-open", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	let prepareCalls = 0;
	let prepareBroken = false;
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => {
			if (prepareBroken) throw new Error("model unavailable");
			prepareCalls += 1;
			return { stream: async function* () {
				yield { type: "text-delta", text: "Model fold summary." };
				yield { type: "finish" };
			} };
		},
	};
	const { ctx, contexts, hooks } = mockCtx({ llmFiber: fiber });
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-loop-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	assert.notEqual(listener, null);

	// The session surface the host rebuilds each request from.
	const store = [];
	let turn = 0;
	async function turnStep(withPair = false) {
		turn += 1;
		store.push({ role: "user", content: [{ type: "text", text: `turn ${turn} user ` + "F".repeat(12_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `turn ${turn} assistant ` + "F".repeat(12_000) }] });
		if (withPair) {
			store.push({ role: "assistant", tool_calls: [{ id: `tc${turn}`, type: "function", function: { name: "probe", arguments: "{}" } }], content: [] });
			store.push({ role: "tool", tool_call_id: `tc${turn}`, content: [{ type: "tool_result", content: "probe ok" }] });
		}
		// Host semantics: a FRESH raw array per request (content-equal copies
		// hash to the same refs, exactly like the frozen snapshots).
		const messages = store.slice();
		const stream = listener({ sessionId: "loop-1", messages, provider: "p", model: "m" }, async function* () {
			yield { type: "finish", usage: { input_tokens: 1 } };
		});
		for await (const chunk of stream) void chunk;
		return messages;
	}

	// 8 turns; pairs on turns 3 and 6 (each plain msg ~7.5k tokens).
	for (let i = 1; i <= 8; i++) await turnStep(i === 3 || i === 6);
	assert.ok(handle.metrics.of("loop-1").viewTokens > 40_000, "view must exceed the pressure gate");

	// Idle with the PRODUCTION object payload fires the first auto fold.
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "loop-1" } } });
	assert.equal(await poll(() => handle.store.ledgerOf("loop-1").blocks.length >= 1), true, "first auto fold must commit");
	const ledger1 = handle.store.ledgerOf("loop-1");
	assert.equal(ledger1.blocks[0].kind, "summary");
	assert.equal(ledger1.blocks[0].summary, "Model fold summary.");
	assert.equal(prepareCalls, 1);
	assert.equal(handle.captures.get("loop-1").messages.length, store.length, "capture stays RAW");

	// The committed fold reshapes the very next request view (frontier
	// resolution across raw re-sends). The FIRST USER message (turn 1) is
	// task-intent protected (docs/ladder-fold.md): it stays raw at the head
	// and the summary lands right behind it.
	const after1 = await turnStep();
	assert.ok(after1.length < store.length, "view must replace the folded range");
	assert.match(after1[0].content[0].text, /^turn 1 user /u, "first user message stays raw (task-intent protection)");
	assert.match(after1[1].content[0].text, /\[SWITCHMAN:TRIM\] Model fold summary\./u);

	// Four more turns of growth, then a second auto fold past the 60s
	// min-interval (mock clock advanced — same wall-clock test run).
	for (let i = 0; i < 4; i++) await turnStep();
	mock.timers.tick(61_000);
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "loop-1" } } });
	assert.equal(await poll(() => handle.store.ledgerOf("loop-1").blocks.length >= 2), true, "second auto fold must commit");
	assert.equal(prepareCalls, 2);
	const after2 = await turnStep(true); // pair lands in the protected tail — must stay intact in the view
	assert.ok(after2.length < store.length);

	// Tool pairs are never split: every tool result in the view is still
	// glued to its assistant tool_calls message.
	for (let i = 0; i < after2.length; i++) {
		if (after2[i].role === "tool") {
			assert.ok(i > 0 && after2[i - 1].role === "assistant" && Array.isArray(after2[i - 1].tool_calls), `pair split at ${i}`);
			assert.equal(after2[i - 1].tool_calls[0].id, after2[i].tool_call_id);
		}
	}

	// Model-invisibility invariant (docs/ladder-fold.md): the trim layer
	// registers NO systemPrompt context — view readings, fold counts, and
	// growth numbers never reach the model; the human reads decisions.log.
	assert.equal(contexts.length, 0, "no model-visible trim context is registered");

	// Pressure degrade: with no fallback route configured, a PRESSURE fold
	// whose summary route fails degrades to a mechanical fold — relief beats
	// fidelity near the window edge. Growth folds keep the old fail-open
	// (pinned by the backoff test below).
	prepareBroken = true;
	const before = handle.store.ledgerOf("loop-1").blocks.length;
	for (let i = 0; i < 4; i++) await turnStep();
	mock.timers.tick(61_000);
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "loop-1" } } });
	assert.equal(await poll(() => handle.store.ledgerOf("loop-1").blocks.length === before + 1), true, "pressure fold degrades to mechanical");
	const degraded = handle.store.ledgerOf("loop-1").blocks.at(-1);
	assert.equal(degraded.kind, "mechanical", "the degraded block is mechanical");
	assert.match(degraded.summary, /^Mechanical fold of /u);
	const outcomes = () => readFileSync(join(stateDir, "decisions.log"), "utf8").split("\n").filter((line) => line.includes("outcome="));
	assert.ok(outcomes().some((line) => line.includes("outcome=folded:pressure:") && line.includes("fallback=mechanical")), "the degrade is visible in the outcome row");
	const after3 = await turnStep();
	assert.ok(after3.length < store.length, "the mechanical fold reshapes the view too");
});

test("meter duality: watermark prefers the fresh trim view over the stored tally", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const stateDir = mkdtempSync(join(tmpdir(), "trim-dual-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	// protectedTail 2 so the manual block (first 6 of 8 messages) applies —
	// the bridge only matters once a fold actually reshapes the view.
	const handle = applyContextTrim(ctx, { ...config, trimProtectedTail: 2, trimStateDir: stateDir });

	const meterCtx = { tokenMeter: { measure: () => ({ totalTokens: 150_000 }) } };
	// No trim view yet: the stored tally stands.
	assert.equal(recentTrimViewTokensOf("dual-1"), null);
	assert.equal(measureNow(meterCtx, { session: { id: "dual-1" } }), 150_000);

	// One request refreshes the outbound-view estimate; with an applied fold
	// block the watermark now reads the view instead of the stale stored
	// measure (the 94.5k->4.5k case).
	const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "V".repeat(2_000) }] }));
	const stream = listener({ sessionId: "dual-1", messages, provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 900 } }; });
	for await (const chunk of stream) void chunk;
	const refs = messages.map((message, i) => refOf(message, i));
	const commit = handle.store.commitFold(
		"dual-1",
		{ refRange: { firstId: refs[0], lastId: refs[5] }, count: 6, approxTokens: estimateTokensOf(messages, 0, 5), summary: "Dual anchor fold.", kind: "summary", tier: "model" },
		refPositions(messages),
	);
	assert.equal(commit.ok, true, "manual anchor fold must commit");
	const resend = messages.slice();
	const stream2 = listener({ sessionId: "dual-1", messages: resend, provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 900 } }; });
	for await (const chunk of stream2) void chunk;
	const view = recentTrimViewTokensOf("dual-1");
	assert.ok(Number.isFinite(view) && view > 0);
	assert.ok(view < 150_000);
	assert.equal(measureNow(meterCtx, { session: { id: "dual-1" } }), view);

	// TTL honored: a stale entry falls back to the stored tally.
	assert.equal(recentTrimViewTokensOf("dual-1", -1), null);
	assert.equal(measureNow(meterCtx, { session: { id: "unknown-session" } }), 150_000);
});

test("meter duality, wire domain: the watermark reads max(view, last main wire)", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const stateDir = mkdtempSync(join(tmpdir(), "trim-dual-wire-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const meterCtx = { tokenMeter: { measure: () => ({ totalTokens: 150_000 }) } };

	// A main dispatch whose provider prompt is far larger than the view
	// estimate — the system/tool mass the view never counts. The watermark
	// must read the wire (the trim pressure meter's second operand), not the
	// view and not the stale stored tally (inspection P1-3).
	const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "V".repeat(2_000) }] }));
	const stream = listener({ sessionId: "dualw-1", messages, provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 120_000 } }; });
	for await (const chunk of stream) void chunk;
	const view = recentTrimViewTokensOf("dualw-1");
	assert.ok(Number.isFinite(view) && view > 0 && view < 120_000, "sanity: the view estimate sits below the wire");
	assert.equal(recentTrimPromptTokensOf("dualw-1"), 120_000);
	assert.equal(measureNow(meterCtx, { session: { id: "dualw-1" } }), 120_000);

	// A side dispatch (tiny inherited-id call) samples usage on the same
	// session id but must never LOWER the wire floor: the registry keeps the
	// main dispatch's real prompt and the watermark stays on it.
	const side = listener({ sessionId: "dualw-1", messages: [{ role: "user", content: [{ type: "text", text: "title" }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] }], provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 10 } }; });
	for await (const chunk of side) void chunk;
	assert.equal(recentTrimPromptTokensOf("dualw-1"), 120_000, "side dispatch must not lower the wire floor");
	assert.equal(measureNow(meterCtx, { session: { id: "dualw-1" } }), 120_000);

	// TTL honored on the wire half too: a stale entry falls back to the tally.
	assert.equal(recentTrimPromptTokensOf("dualw-1", -1), null);
	assert.equal(recentTrimViewTokensOf("dualw-1", -1), null);
});

test("side-dispatch guard: tiny inherited-id calls never clobber the meters", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => ({ stream: async function* () {
			yield { type: "text-delta", text: "Model fold summary." };
			yield { type: "finish" };
		} }),
	};
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-side-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	// protectedTail 2 so the manual block (first 6 of 8 messages) clears it.
	const handle = applyContextTrim(ctx, { ...config, trimProtectedTail: 2, trimStateDir: stateDir });

	// A small real history (8 messages — above the 6-message protected tail)
	// plus a manually committed block, so the ledger HAS blocks that locate.
	const store = [];
	for (let i = 1; i <= 4; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] });
	}
	async function send(messages) {
		const stream = listener({ sessionId: "side-1", messages, provider: "p", model: "m" }, async function* () {
			yield { type: "finish", usage: { input_tokens: 1 } };
		});
		for await (const chunk of stream) void chunk;
	}
	await send(store.slice());
	// Drain the async stream-path fold so the ledger deterministically has a
	// locating block (the guard below only fires when blocks exist).
	assert.equal(await poll(() => handle.store.ledgerOf("side-1").blocks.length >= 1), true, "anchor fold must commit");

	const mainView = recentTrimViewTokensOf("side-1");
	const mainCaptureLen = handle.captures.get("side-1").messages.length;
	const baselineBefore = handle.store.ledgerOf("side-1").lastFoldLowTokens;

	// A web-search-shaped side call inherits the session id with a tiny
	// array in which the ledger cannot locate. Without the guard this reset
	// the growth baseline to ~150 tokens and clobbered the view registry
	// that measureNow (the watermark / auto-handover gate) reads.
	await send([
		{ role: "user", content: [{ type: "text", text: "summarize this page" }] },
		{ role: "assistant", content: [{ type: "text", text: "page summary" }] },
	]);
	assert.equal(recentTrimViewTokensOf("side-1"), mainView, "registry must keep the main view");
	assert.equal(handle.captures.get("side-1").messages.length, mainCaptureLen, "capture must keep the main history");
	assert.equal(handle.store.ledgerOf("side-1").lastFoldLowTokens, baselineBefore, "growth baseline must not reset");

	// The next MAIN dispatch is accepted again and carries the fold view.
	const resend = store.slice();
	await send(resend);
	assert.ok(resend.length < store.length, "main dispatch must carry the applied fold view");
	assert.equal(handle.captures.get("side-1").messages.length, store.length, "capture refreshed from the main dispatch");
});

test("wire-truth gate: frozen dispatches switch the watermark to the tally and pause folds", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, contexts } = mockCtx({ llmFiber: fiber });
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => ({ stream: async function* () {
			yield { type: "text-delta", text: "Model fold summary." };
			yield { type: "finish" };
		} }),
	};
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-wire-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimProtectedTail: 2, trimStateDir: stateDir });
	const meterCtx = { tokenMeter: { measure: () => ({ totalTokens: 150_000 }) } };

	const store = [];
	function pushPair(i) {
		store.push({ role: "user", content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] });
	}
	async function send(options) {
		const stream = listener(options, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}
	const dispatch = (messages) => ({ sessionId: "wire-1", messages, provider: "p", model: "m" });

	// Dispatch A (mutable, no blocks yet): the stream-path fold check fires
	// the first auto fold. Drain until it commits.
	for (let i = 1; i <= 4; i++) pushPair(i);
	await send(dispatch(store.slice()));
	assert.equal(await poll(() => handle.store.ledgerOf("wire-1").blocks.length >= 1), true, "first auto fold must commit");

	// Dispatch B: the block applies ("in-place") — the bridge carries the view.
	await send(dispatch(store.slice()));
	assert.equal(recentTrimInjectOf("wire-1"), "in-place");
	const view = recentTrimViewTokensOf("wire-1");
	assert.ok(Number.isFinite(view) && view > 0);
	assert.equal(measureNow(meterCtx, { session: { id: "wire-1" } }), view);

	// Grow past the growth gate so an ungated idle fold WOULD commit.
	for (let i = 5; i <= 7; i++) pushPair(i);
	await send(dispatch(store.slice()));
	assert.equal(recentTrimInjectOf("wire-1"), "in-place");

	// The resumed-host shape: options AND the messages array frozen (the
	// agent loop deep-freezes assembled requests). Both injection paths
	// throw, nothing reaches the wire — the view becomes a meter-only
	// phantom, so the bridge must fall back to the provider tally.
	await send(Object.freeze({ sessionId: "wire-1", messages: Object.freeze(store.slice()), provider: "p", model: "m" }));
	assert.equal(recentTrimInjectOf("wire-1"), "none");
	assert.equal(recentTrimViewTokensOf("wire-1"), null, "bridge must fall back to the tally");
	assert.equal(recentTrimPromptTokensOf("wire-1"), null, "the wire-domain bridge obeys the same gate");
	assert.equal(measureNow(meterCtx, { session: { id: "wire-1" } }), 150_000);

	// The wire-truth state is human diagnostics now (decisions.log), never
	// model-visible: the frozen dispatch logs injected=none, and the trim
	// layer registers no context line the model could read.
	const log = (() => { try { return readFileSync(join(stateDir, "decisions.log"), "utf8"); } catch { return ""; } })();
	assert.match(log, /session=wire-1 view-applied [^\n]*injected=none/u, "the frozen dispatch logs injected=none for the human");
	assert.equal(contexts.length, 0, "no model-visible trim context is registered");

	// Fold cycles pause while the wire cannot carry the view: committing a
	// block would only phantom-shrink the meter while the request stays raw.
	const blocksBefore = handle.store.ledgerOf("wire-1").blocks.length;
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "wire-1" } } });
	await poll(() => false, 200);
	assert.equal(handle.store.ledgerOf("wire-1").blocks.length, blocksBefore, "no fold while injection is unavailable");

	// A mutable dispatch re-arms the fold machinery (inject flips back), but
	// the watermark bridge stays on the tally until no "none" occurred within
	// the TTL window — the sticky gate for mixed frozen/mutable sessions.
	await send(dispatch(store.slice()));
	assert.equal(recentTrimInjectOf("wire-1"), "in-place");
	assert.equal(recentTrimViewTokensOf("wire-1"), null, "bridge stays on the tally right after a none");
	assert.equal(recentTrimPromptTokensOf("wire-1"), null, "the sticky gate binds the wire-domain bridge too");
});

test("side-dispatch budget: a shrunken post-compaction history is re-accepted as main", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => ({ stream: async function* () {
			yield { type: "text-delta", text: "Model fold summary." };
			yield { type: "finish" };
		} }),
	};
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-epoch-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimProtectedTail: 2, trimStateDir: stateDir });

	const store = [];
	for (let i = 1; i <= 4; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] });
	}
	async function send(messages) {
		const stream = listener({ sessionId: "ep-1", messages, provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}

	// Establish a ledger block over the big history.
	await send(store.slice());
	assert.equal(await poll(() => handle.store.ledgerOf("ep-1").blocks.length >= 1), true, "anchor fold must commit");

	// Simulate a host-compaction epoch: the re-send history is now a tiny
	// fresh set whose content cannot locate the stale block. The guard skips
	// it as a side dispatch at first…
	const compacted = [
		{ role: "user", content: [{ type: "text", text: "compaction summary " + "S".repeat(300) }] },
		{ role: "assistant", content: [{ type: "text", text: "continuation " + "S".repeat(300) }] },
	];
	await send(compacted.slice());
	assert.equal(handle.captures.get("ep-1").messages.length, store.length, "capture withheld on the first skip");
	await send(compacted.slice());
	assert.equal(handle.captures.get("ep-1").messages.length, store.length, "capture withheld on the second skip");
	// …but the skip budget exhausts and the dispatch is accepted as main:
	// the capture re-anchors on the compacted history and the epoch baseline
	// resets (ledgerIsStale fires — every block failed to locate).
	await send(compacted.slice());
	assert.equal(handle.captures.get("ep-1").messages.length, compacted.length, "capture re-anchored after the skip budget");
	const ledger = handle.store.ledgerOf("ep-1");
	assert.ok(ledger.lastFoldLowTokens > 0 && ledger.lastFoldLowTokens < 1_000, "growth baseline re-anchored at the post-compaction view");
	// The guard counter reset: further identical dispatches are accepted
	// immediately again.
	await send(compacted.slice());
	assert.equal(handle.captures.get("ep-1").messages.length, compacted.length);
});

test("failure backoff: a failing cycle cools down exponentially instead of re-firing forever", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	let prepareBroken = true;
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => {
			if (prepareBroken) throw new Error("model unavailable");
			return { stream: async function* () { yield { type: "text-delta", text: "Recovered summary." }; yield { type: "finish" }; } };
		},
	};
	const { ctx, hooks } = mockCtx({ llmFiber: fiber });
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-backoff-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir, trimPressurePercent: 201, trimEmergencyPercent: 201 });
	const outcomes = () => readFileSync(join(stateDir, "decisions.log"), "utf8").split("\n").filter((line) => line.includes("outcome="));

	// Grow past the growth gate (pressure/emergency disabled in this test's
	// config): growth is the fail-open tier — a pressure fold would now
	// degrade to mechanical, commit, and clear the ladder this test pins.
	const store = [];
	for (let i = 1; i <= 8; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `t${i}u ` + "F".repeat(12_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `t${i}a ` + "F".repeat(12_000) }] });
	}
	const stream = listener({ sessionId: "back-1", messages: store.slice(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
	for await (const chunk of stream) void chunk;
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "back-1" } } });
	assert.equal(await poll(() => outcomes().some((line) => line.includes("outcome=summary-unavailable"))), true, "first failing attempt logged");

	// Still cooling (60s backoff): repeated idles and the 60s stream check
	// stay silent — the no-backoff loop this test pins used to re-fire here.
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "back-1" } } });
	mock.timers.tick(30_000);
	await poll(() => false, 40);
	assert.equal(outcomes().length, 1, "no retry inside the first backoff window");
	mock.timers.tick(31_000); // past 60s: attempt #2 climbs the ladder
	const stream2 = listener({ sessionId: "back-1", messages: store.slice(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
	for await (const chunk of stream2) void chunk;
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "back-1" } } });
	assert.equal(await poll(() => outcomes().length === 2), true, "second attempt after the first backoff");
	mock.timers.tick(61_000); // 120s backoff after two failures — 61s is NOT enough
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "back-1" } } });
	await poll(() => false, 40);
	assert.equal(outcomes().length, 2, "second backoff window (2x) holds");

	// Recovery: past the 120s window with the model healthy, the cycle folds
	// again — a committed fold resets the failure ladder, so the session
	// paces by its normal cadence gates from here on.
	prepareBroken = false;
	mock.timers.tick(61_000);
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "back-1" } } });
	assert.equal(await poll(() => outcomes().some((line) => line.includes("outcome=folded:"))), true, "recovered cycle folds after the backoff expires");
});

test("zero-fold side-dispatch hole: tiny auxiliary dispatches skip even with no blocks", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "S." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-side0-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	async function send(messages) {
		const stream = listener({ sessionId: "side0-1", messages, provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}
	// A REAL small main dispatch: first dispatch of the session (no trim
	// state yet) stays accepted — it cannot clobber what does not exist.
	const main = [
		{ role: "user", content: [{ type: "text", text: "hello " + "M".repeat(2_000) }] },
		{ role: "assistant", content: [{ type: "text", text: "hi " + "M".repeat(2_000) }] },
	];
	await send(main.slice());
	assert.equal(handle.captures.get("side0-1").messages.length, 2, "first dispatch of a zero-fold session is main");
	// Auxiliary tiny dispatch inheriting the session id: with trim state now
	// present it must skip even though blocksCount === 0.
	const aux = [{ role: "user", content: [{ type: "text", text: "summarize this page" }] }, { role: "assistant", content: [{ type: "text", text: "page summary" }] }];
	await send(aux.slice());
	assert.equal(handle.captures.get("side0-1").messages.length, 2, "aux dispatch with zero blocks must not clobber the capture");
	assert.match(readFileSync(join(stateDir, "decisions.log"), "utf8"), /session=side0-1 side-dispatch skipped/u, "aux dispatch logged as side-dispatch skip");
	// Budget release valve intact: consecutive tiny dispatches exhaust the
	// skip budget and the third is then accepted as main again (logged).
	await send(aux.slice());
	await send(aux.slice());
	assert.match(readFileSync(join(stateDir, "decisions.log"), "utf8"), /side-dispatch budget exhausted/u, "third tiny dispatch accepted via the skip budget");
});

test("reload cut: a real cordis teardown mid-fold logs reload-aborted and never arms the backoff ladder", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	let releaseStream = null;
	let prepareCalls = 0;
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => {
			prepareCalls += 1;
			return { stream: async function* () { await new Promise((resolve) => { releaseStream = resolve; }); } };
		},
	};
	const { ctx, hooks } = mockCtx({ llmFiber: fiber });
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-reload-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const outcomes = () => readFileSync(join(stateDir, "decisions.log"), "utf8").split("\n").filter((line) => line.includes("outcome="));

	// The plugin must subscribe to the REAL cordis teardown event — a guard
	// pinned to a phantom event name passes vacuously and fixes nothing.
	assert.equal(typeof hooks["internal/plugin"], "function", "plugin must subscribe to internal/plugin");

	// Grow past the pressure gate, then idle: the fold starts and blocks
	// inside the never-yielding stream, mid-flight like a real reload.
	const store = [];
	for (let i = 1; i <= 8; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `t${i}u ` + "F".repeat(12_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `t${i}a ` + "F".repeat(12_000) }] });
	}
	const stream = listener({ sessionId: "rel-1", messages: store.slice(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
	for await (const chunk of stream) void chunk;
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "rel-1" } } });
	assert.equal(await poll(() => releaseStream !== null), true, "fold cycle entered the llm stream");

	// HMR disposal, faithful to vendor/cordis fiber.ts:274-275: uid clears,
	// THEN internal/plugin fires with our own fiber.
	ctx.fiber.uid = null;
	hooks["internal/plugin"](ctx.fiber);
	releaseStream(); // the cut stream ends as a clean zero-chunk stream

	assert.equal(await poll(() => outcomes().some((line) => line.includes("outcome=reload-aborted"))), true, "reload cut logged as reload-aborted");
	// No ladder step was armed: the very next idle re-attempts immediately —
	// the second cycle enters the llm call within microtasks, whereas an
	// armed 60s backoff would hold it behind mock.timers until ticked.
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "rel-1" } } });
	assert.equal(await poll(() => prepareCalls === 2), true, "no backoff after a reload cut — retry fires on the next idle");
	assert.ok(outcomes().length === 1 && outcomes()[0].includes("outcome=reload-aborted tier="), "the cut cycle reads reload-aborted with a tier field, never summary-unavailable");
});

test("fold fallback model: a failing side route retries the fallback before any degrade", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const attempts = [];
	const llm = {
		resolveModelInfo: async () => ({
			context: { contextWindow: 100_000 },
			reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }] },
		}),
		prepareCall: async ({ model, reasoningEffort }) => {
			attempts.push({ model, reasoningEffort: reasoningEffort ?? null });
			if (model === "m") throw new Error("pinned upstream rejects the side call");
			return { stream: async function* () { yield { type: "text-delta", text: "Fallback summary." }; yield { type: "finish" }; } };
		},
	};
	const { ctx, hooks } = mockCtx({ llmFiber: fiber });
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-fallback-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, {
		...config, trimStateDir: stateDir,
		trimFoldFallbackModel: { provider: "fb", model: "fallback-m", effort: "high" },
	});

	const store = [];
	for (let i = 1; i <= 8; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `t${i}u ` + "F".repeat(12_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `t${i}a ` + "F".repeat(12_000) }] });
	}
	const stream = listener({ sessionId: "fb-1", messages: store.slice(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
	for await (const chunk of stream) void chunk;
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "fb-1" } } });

	assert.equal(await poll(() => handle.store.ledgerOf("fb-1").blocks.length === 1), true, "the fallback route rescues the fold");
	const block = handle.store.ledgerOf("fb-1").blocks[0];
	assert.equal(block.kind, "summary", "no mechanical degrade when the fallback succeeds");
	assert.equal(block.summary, "Fallback summary.");
	// The session model is inherited as the side route first; the configured
	// fallback route is the second (and only other) stop.
	assert.deepEqual(attempts, [
		{ model: "m", reasoningEffort: "low" },
		{ model: "fallback-m", reasoningEffort: "high" },
	]);
	const fails = readFileSync(join(stateDir, "decisions.log"), "utf8").split("\n").filter((line) => line.includes("summary-fail"));
	assert.equal(fails.length, 1, "exactly one failure row");
	assert.ok(fails[0].includes("route=side"), "the side failure is tagged with its route");
	assert.ok(fails[0].includes("pinned upstream rejects the side call"), "the thrown error message surfaces in the log");
	const outcomes = readFileSync(join(stateDir, "decisions.log"), "utf8").split("\n").filter((line) => line.includes("outcome=folded:pressure:"));
	assert.equal(outcomes.length, 1, "the fold commits on the pressure tier");
	assert.ok(!outcomes[0].includes("fallback=mechanical"), "no degrade marker when the model fallback lands");
});

/** Side-route effort selection (session model → metadata recommendation →
 * summary proposal). The active session's execution pin is not inherited:
 * the resolved model metadata selects the lowest enabled tier, while a stored
 * route pin wins and an unsupported pin retries once at the automatic tier. */
test("side-route effort: session pins are not inherited; model recommendation and explicit pins apply", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const effortsSeen = []; // reasoningEffort of every prepareCall proposal, in order
	const llm = {
		resolveModelInfo: async () => ({
			context: { contextWindow: 100_000 },
			reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }] },
		}),
		prepareCall: async (proposal) => {
			effortsSeen.push(proposal.reasoningEffort ?? null);
			if (proposal.reasoningEffort === "max") {
				const err = new Error("provider \"p\" model \"m\" does not support reasoning effort \"max\"");
				err.code = "UNSUPPORTED_REASONING_EFFORT";
				throw err;
			}
			return { stream: async function* () {
				yield { type: "text-delta", text: "Effort fold summary." };
				yield { type: "finish" };
			} };
		},
	};
	const stateDirs = [];
	t.after(() => { for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true }); });

	async function drive(sessionId, { sessionEffort, sideCfg } = {}) {
		const { ctx, hooks } = mockCtx({ llmFiber: fiber });
		ctx.get = () => llm;
		const stateDir = mkdtempSync(join(tmpdir(), "trim-effort-"));
		stateDirs.push(stateDir);
		const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir, ...sideCfg });
		const store = [];
		for (let i = 1; i <= 6; i++) {
			store.push({ role: "user", content: [{ type: "text", text: `t${i}u ` + "F".repeat(12_000) }] });
			store.push({ role: "assistant", content: [{ type: "text", text: `t${i}a ` + "F".repeat(12_000) }] });
			const options = { sessionId, messages: store.slice(), provider: "p", model: "m" };
			if (sessionEffort !== undefined) options.reasoningEffort = sessionEffort;
			const stream = listener(options, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
			for await (const chunk of stream) void chunk;
		}
		hooks["agent/status"]({ status: "idle", agent: { session: { id: sessionId } } });
		assert.equal(await poll(() => handle.store.ledgerOf(sessionId).blocks.length >= 1), true, `fold must commit for ${sessionId}`);
		mock.timers.tick(61_000); // clear the per-session min-interval for the next scenario
	}

	// A: the session call's explicit high pin does not leak to the summary route.
	await drive("eff-a", { sessionEffort: "high" });
	assert.equal(effortsSeen[0], "low", "use the route model's lowest thinking tier");
	// B: an explicit trimSideModel effort wins over automatic recommendation.
	await drive("eff-b", { sessionEffort: "high", sideCfg: { trimSideModel: { provider: "s", model: "sm", effort: "medium" } } });
	assert.equal(effortsSeen[1], "medium");
	// C: a manually selected model without a pin also gets its lowest tier.
	await drive("eff-c", { sideCfg: { trimSideModel: { provider: "s", model: "sm" } } });
	assert.equal(effortsSeen[2], "low");
	// D: an unsupported explicit pin retries once at the metadata recommendation.
	await drive("eff-d", { sideCfg: { trimSideModel: { provider: "s", model: "sm", effort: "max" } } });
	assert.deepEqual(effortsSeen.slice(3), ["max", "low"]);
});
