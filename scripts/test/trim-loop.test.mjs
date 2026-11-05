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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { applyContextTrim, recentTrimInjectOf, recentTrimViewTokensOf } from "../../host/context-trim/index.js";
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
	// resolution across raw re-sends).
	const after1 = await turnStep();
	assert.ok(after1.length < store.length, "view must replace the folded range");
	assert.match(after1[0].content[0].text, /\[SWITCHMAN:TRIM\] Model fold summary\./u);

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

	// Banner: the context line renders for an OBJECT agent with a name and
	// carries the live view-reading.
	const line = contexts[0].text({ agent: { name: "Loop Agent", session: { id: "loop-1" } } });
	assert.match(line, /^\[SWITCHMAN:TRIM\] agent Loop Agent: view ~\d+k tokens/u);

	// Fail-open: a summarizer that rejects must skip the fold silently.
	prepareBroken = true;
	const before = handle.store.ledgerOf("loop-1").blocks.length;
	for (let i = 0; i < 4; i++) await turnStep();
	mock.timers.tick(61_000);
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "loop-1" } } });
	await poll(() => false, 20);
	assert.equal(handle.store.ledgerOf("loop-1").blocks.length, before, "no fold on summary failure");
	const after3 = await turnStep();
	assert.ok(Array.isArray(after3));
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
	assert.equal(measureNow(meterCtx, { session: { id: "wire-1" } }), 150_000);

	// The trim banner marks the meter-only state so the divergence is visible.
	const line = contexts[0].text({ agent: { name: "Wire Agent", session: { id: "wire-1" } } });
	assert.match(line, /wire=raw/u);

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
