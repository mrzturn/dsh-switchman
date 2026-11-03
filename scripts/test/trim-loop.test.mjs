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
import { applyContextTrim, recentTrimViewTokensOf } from "../../host/context-trim/index.js";
import { measureNow } from "../../host/context-watch.js";

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
	applyContextTrim(ctx, { ...config, trimStateDir: stateDir });

	const meterCtx = { tokenMeter: { measure: () => ({ totalTokens: 150_000 }) } };
	// No trim view yet: the stored tally stands.
	assert.equal(recentTrimViewTokensOf("dual-1"), null);
	assert.equal(measureNow(meterCtx, { session: { id: "dual-1" } }), 150_000);

	// One request refreshes the outbound-view estimate; the watermark now
	// reads it instead of the stale stored measure (the 94.5k->4.5k case).
	const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "V".repeat(2_000) }] }));
	const stream = listener({ sessionId: "dual-1", messages, provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 900 } }; });
	for await (const chunk of stream) void chunk;
	const view = recentTrimViewTokensOf("dual-1");
	assert.ok(Number.isFinite(view) && view > 0);
	assert.ok(view < 150_000);
	assert.equal(measureNow(meterCtx, { session: { id: "dual-1" } }), view);

	// TTL honored: a stale entry falls back to the stored tally.
	assert.equal(recentTrimViewTokensOf("dual-1", -1), null);
	assert.equal(measureNow(meterCtx, { session: { id: "unknown-session" } }), 150_000);
});
