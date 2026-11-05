/** Surface-replace pass tests (docs/surface-fold.md, v1.10).
 *
 * Drives the trim loop against a host-shaped mock SESSION: an append-only
 * event log with a real surface projection (nodes list, replace shadowing,
 * deriveMessages-equivalent view) and host-grade validation — surfaceOp
 * markers required on message events, replace ranges must live in the
 * surface, sourceEventSeqs must densely cover every shadowed node. Covers:
 * frozen-dispatch fold ships via turn-stopping, idempotence, the compaction
 * lock, the surfaceFold flag, the missing-service legacy fallback, the
 * incomplete-seqs validation skip, and the system-head skip.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyContextTrim, recentTrimInjectOf } from "../../host/context-trim/index.js";
import { refOf } from "../../host/context-trim/view.js";

/** Mock session: append-only log + surface projection + host validation. */
function mockSession(id) {
	const events = [];
	const surface = { nodes: [], replaceGeneration: 0, contentGeneration: 0 };
	const SURFACE_TYPES = new Set(["user/message", "system/message", "developer/message", "assistant/message", "tool/result"]);
	function derive(event) {
		if (event.type === "user/message") return event.data ?? null;
		if (SURFACE_TYPES.has(event.type)) {
			const message = event.data?.message;
			if (!Array.isArray(message?.content) || message.content.length === 0) return null;
			return message;
		}
		return null;
	}
	function append(type, data, opts) {
		if (SURFACE_TYPES.has(type)) {
			const op = opts?.surfaceOp;
			if (op === undefined) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`);
			if (op !== "append") {
				const startIdx = surface.nodes.indexOf(op.startSeq);
				const endIdx = surface.nodes.indexOf(op.endSeq);
				if (startIdx === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
				if (endIdx === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
				if (startIdx > endIdx) throw new Error("surface replace: reversed range");
				const span = surface.nodes.slice(startIdx, endIdx + 1);
				const sources = opts.sourceEventSeqs;
				if (!Array.isArray(sources)) throw new Error("sourceEventSeqs required");
				for (const seq of span) if (!sources.includes(seq)) throw new Error(`sourceEventSeqs must include every shadowed surface node; missing ${seq}`);
				for (const seq of sources) if (seq >= events.length + 0 && !span.includes(seq)) throw new Error("sourceEventSeqs must reference earlier events");
			}
		} else if (opts?.surfaceOp !== undefined) {
			throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`);
		}
		const event = { seq: events.length, type, data, ...(opts?.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}), ...(opts?.sourceEventSeqs !== undefined ? { sourceEventSeqs: opts.sourceEventSeqs } : {}) };
		events.push(event);
		const op = opts?.surfaceOp;
		if (op !== undefined && op !== "append") {
			const startIdx = surface.nodes.indexOf(op.startSeq);
			const endIdx = surface.nodes.indexOf(op.endSeq);
			surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
			surface.replaceGeneration += 1;
			surface.contentGeneration += 1;
		} else if (op !== undefined) {
			surface.nodes.push(event.seq);
		}
		return event;
	}
	return {
		id,
		get seq() { return events.length; },
		surface,
		eventAt: (seq) => events[seq],
		snapshotEvents: () => events.slice(),
		deriveEventMessage: (event) => derive(event),
		deriveMessages: () => surface.nodes.map((seq) => derive(events[seq])).filter((message) => message !== null),
		append,
		// test hooks
		rawEvents: events,
	};
}

/** Minimal host-ctx mock (trim-loop.test.mjs contract + agents registry). */
function mockCtx({ llmFiber = null, withAgents = true } = {}) {
	const hooks = {};
	const registered = [];
	const contexts = [];
	const agentsById = new Map();
	const ctx = {
		log: { warn: () => {} },
		agents: withAgents
			? { currentInitiator: () => ({ session: { id: "" } }), get: (id) => agentsById.get(id) }
			: { currentInitiator: () => ({ session: { id: "" } }) },
		systemPrompt: { section: () => {}, context: (c) => contexts.push(c) },
		on: (event, handler) => { hooks[event] = handler; },
		tools: { register: (tool) => registered.push(tool) },
		get: () => null,
		inject: (deps, body) => { if (deps.includes("llm") && llmFiber !== null) body(llmFiber); },
	};
	return { ctx, hooks, registered, agentsById, contexts };
}

const config = {
	trimEnabled: true,
	trimMode: "auto",
	trimGrowthTokens: 5_000,
	trimIncrementTokens: 1,
	trimPressurePercent: 40,
	trimEmergencyPercent: 101,
	trimProtectedTail: 2,
	trimMaxFoldsPerHour: 6,
	trimSideModel: { provider: "", model: "" },
	trimStateDir: "",
	surfaceFold: true,
};

async function poll(cond, limit = 500) {
	for (let i = 0; i < limit; i++) {
		if (cond()) return true;
		await Promise.resolve();
		await Promise.resolve();
	}
	return cond();
}

const decisionsOf = (stateDir) => {
	try {
		return readFileSync(join(stateDir, "decisions.log"), "utf8");
	} catch {
		return "";
	}
};

/** Standard fixture: one mock session seeded with 4 user/assistant pairs. */
function seededSession(id) {
	const session = mockSession(id);
	for (let i = 1; i <= 4; i++) {
		session.append("user/message", { id: `u${i}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] }, { surfaceOp: "append" });
		session.append("assistant/message", { message: { id: `a${i}`, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	}
	return session;
}

test("frozen dispatch: fold commits, turn-stopping appends the surface replace pair", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Surface fold summary." }; yield { type: "finish" }; } }),
	};
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-1");
	agentsById.set("surf-1", { session });

	// Mutable dispatch: the stream-path fold check commits the first fold.
	const first = session.deriveMessages();
	await (async () => { const stream = listener({ sessionId: "surf-1", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-1").blocks.length >= 1), true, "auto fold must commit");
	const block = handle.store.ledgerOf("surf-1").blocks[0];
	assert.ok(Array.isArray(block.surfaceSeqs) && block.surfaceSeqs.length === block.count, "commit-time capture stores the node span");
	assert.deepEqual(block.surfaceSeqs, session.surface.nodes.slice(0, block.count), "captured seqs are the leading surface nodes");

	// Frozen re-sends (resumed-host shape): the view cannot ship — wire=raw.
	for (let i = 0; i < 2; i++) {
		await (async () => { const stream = listener(Object.freeze({ sessionId: "surf-1", messages: Object.freeze(session.deriveMessages()), provider: "p", model: "m" }), async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	}
	assert.equal(recentTrimInjectOf("surf-1"), "none", "frozen dispatches cannot carry the view");

	// Turn-stopping (serial boundary): the pass ships the fold to the surface.
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 3, signal: undefined });
	assert.equal(await poll(() => block.surfaceReplaced !== undefined), true, "surface replace must land");
	const events = session.rawEvents;
	const metering = events[events.length - 2];
	const replacement = events[events.length - 1];
	assert.equal(metering.type, "compaction/prune", "metering event precedes the replacement");
	assert.equal(replacement.seq, metering.seq + 1, "synchronously adjacent appends");
	assert.equal(replacement.type, "user/message");
	assert.equal(replacement.surfaceOp.op, "replace");
	assert.equal(replacement.surfaceOp.startSeq, block.surfaceSeqs[0]);
	assert.equal(replacement.surfaceOp.endSeq, block.surfaceSeqs[block.surfaceSeqs.length - 1]);
	assert.deepEqual(replacement.sourceEventSeqs, block.surfaceSeqs, "sourceEventSeqs cover every shadowed node");
	assert.equal(metering.data.shadowedTokenCount, block.approxTokens, "shadow price from the ledger");
	assert.deepEqual(metering.data.shadowedSeqs, block.surfaceSeqs);
	assert.match(replacement.data.content[0].text, /\[SWITCHMAN:TRIM\] Surface fold summary\./u);
	assert.equal(replacement.data.role, "user");
	assert.equal(replacement.data.source.kind, "user", "plain user source (v4 validator rejects checkpoint sources without an open compaction)");
	assert.equal(replacement.data.source.compactionId, undefined, "no compactionId claim");
	// deriveMessages-equivalent view shrinks: summary replaces the folded range.
	const derived = session.deriveMessages();
	assert.equal(derived.length, 9 - block.count, "shadowed range left the projection");
	assert.match(derived[0].content[0].text, /Surface fold summary/u);
	assert.ok(derived.length < first.length);
	assert.match(decisionsOf(stateDir), new RegExp(`session=surf-1 surface-replace startSeq=\\d+ endSeq=\\d+ seqs=${block.count} tokens=\\d+ generation=\\d+ via=turn-stopping`, "u"));
});

test("idempotence: a second pass appends nothing", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Idem summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-i-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-i");
	agentsById.set("surf-i", { session });
	await (async () => { const stream = listener({ sessionId: "surf-i", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-i").blocks.length >= 1), true);
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => handle.store.ledgerOf("surf-i").blocks[0].surfaceReplaced !== undefined), true);
	const afterFirst = session.rawEvents.length;
	// Second turn-stopping AND an idle sweep: nothing more may append.
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "surf-i" } } });
	await poll(() => false, 40);
	assert.equal(session.rawEvents.length, afterFirst, "no duplicate replace");
});

test("compaction lock: an open compaction/start pair defers the replace", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Lock summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-l-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-l");
	agentsById.set("surf-l", { session });
	await (async () => { const stream = listener({ sessionId: "surf-l", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-l").blocks.length >= 1), true);
	// Open lock: a compaction/start without its compaction/end.
	session.append("compaction/start", { compactionId: "c-1", turn: null });
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	await poll(() => false, 40);
	const before = session.rawEvents.length;
	assert.equal(handle.store.ledgerOf("surf-l").blocks[0].surfaceReplaced, undefined, "no replace under the lock");
	assert.ok(session.rawEvents.length === before, "no appends under the lock");
	assert.match(decisionsOf(stateDir), /session=surf-l surface-replace skipped reason=compaction-lock/u);
	// Lock released: the same boundary ships it.
	session.append("compaction/end", { compactionId: "c-1", turn: null });
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	assert.equal(await poll(() => handle.store.ledgerOf("surf-l").blocks[0].surfaceReplaced !== undefined), true, "ships after compaction/end");
});

test("surfaceFold=false: the pass never appends", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Flag summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-f-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, surfaceFold: false, trimStateDir: stateDir });
	const session = seededSession("surf-f");
	agentsById.set("surf-f", { session });
	await (async () => { const stream = listener({ sessionId: "surf-f", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-f").blocks.length >= 1), true);
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	await poll(() => false, 40);
	assert.equal(handle.store.ledgerOf("surf-f").blocks[0].surfaceReplaced, undefined);
	assert.ok(session.rawEvents.every((event) => event.surfaceOp === undefined || event.surfaceOp === "append"), "no replace events");
	assert.match(decisionsOf(stateDir), /session=surf-f surface-replace skipped reason=disabled/u);
});

test("missing service: legacy fallback, no appends, skip row logged", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks } = mockCtx({ llmFiber: fiber, withAgents: false });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Legacy summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-m-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-m");
	await (async () => { const stream = listener({ sessionId: "surf-m", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-m").blocks.length >= 1), true);
	assert.equal(handle.store.ledgerOf("surf-m").blocks[0].surfaceSeqs, undefined, "capture is a no-op without the service");
	hooks["agent/turn-stopping"]({ agent: { session: { id: "surf-m" } }, turn: 1, signal: undefined });
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "surf-m" } } });
	await poll(() => false, 40);
	assert.equal(handle.store.ledgerOf("surf-m").blocks[0].surfaceReplaced, undefined);
	assert.ok(session.rawEvents.every((event) => event.surfaceOp === undefined || event.surfaceOp === "append"), "legacy: nothing appended");
	assert.match(decisionsOf(stateDir), /session=surf-m surface-replace skipped reason=no-service/u);
});

test("stale capture with locating refs: safe re-location ships the same range", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Relocated capture." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-v-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-v");
	agentsById.set("surf-v", { session });
	await (async () => { const stream = listener({ sessionId: "surf-v", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-v").blocks.length >= 1), true);
	const block = handle.store.ledgerOf("surf-v").blocks[0];
	assert.ok(Array.isArray(block.surfaceSeqs) && block.surfaceSeqs.length === block.count);
	const trueSeqs = block.surfaceSeqs.slice();
	// Tamper: drop a middle seq — the dense coverage check fails, but the
	// block's refs still resolve count-anchored on the live surface and no
	// other block replaced that range. The pass re-locates onto the SAME range
	// and ships it (post-1.10.1 safety rule), never a different one.
	block.surfaceSeqs = [block.surfaceSeqs[0], ...block.surfaceSeqs.slice(2)];
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => block.surfaceReplaced !== undefined), true, "safe re-location ships");
	assert.equal(block.surfaceSkip, undefined, "no incomplete-seqs tombstone when re-location is provably the same fold");
	const replace = session.rawEvents.find((event) => event.surfaceOp?.op === "replace");
	assert.notEqual(replace, undefined);
	assert.deepEqual(replace.sourceEventSeqs, trueSeqs, "the shipped range is the refs' true node span, not a re-target");
	assert.match(decisionsOf(stateDir), /session=surf-v surface-replace startSeq=\d+ endSeq=\d+/u);
	// Idempotent afterwards: the durable marker keeps later sweeps quiet.
	const eventsAfterShip = session.rawEvents.length;
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	await poll(() => false, 20);
	assert.equal(session.rawEvents.length, eventsAfterShip, "no second replace append");
});

test("crash window: lost surfaceReplaced marker never re-ships the range", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Crash summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-c-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-c");
	agentsById.set("surf-c", { session });
	await (async () => { const stream = listener({ sessionId: "surf-c", messages: session.deriveMessages(), provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; }); for await (const c of stream) void c; })();
	assert.equal(await poll(() => handle.store.ledgerOf("surf-c").blocks.length >= 1), true);
	const block = handle.store.ledgerOf("surf-c").blocks[0];
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => block.surfaceReplaced !== undefined), true);
	const afterShip = session.rawEvents.length;
	// Simulate the crash window: the marker persist is lost across restart.
	delete block.surfaceReplaced;
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "surf-c" } } });
	await poll(() => false, 40);
	// The shadowed seqs left surface.nodes when the range shipped, so the
	// stored capture no longer validates → incomplete-seqs hard skip, and no
	// second replacement is appended.
	assert.equal(session.rawEvents.length, afterShip, "no second replace append");
	assert.equal(session.rawEvents.filter((event) => event.surfaceOp?.op === "replace").length, 1, "exactly one replace event ever");
	assert.match(decisionsOf(stateDir), /session=surf-c surface-replace skipped reason=incomplete-seqs/u);
});

test("surface channel alive: a recent ship stands down the wire-raw fold pause and banner", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById, contexts } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Relax summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-r-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-r");
	agentsById.set("surf-r", { session });
	async function dispatch(messages) {
		const stream = listener({ sessionId: "surf-r", messages, provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}

	// Fold 1 commits on the first mutable dispatch, then ships (channel alive).
	await dispatch(session.deriveMessages());
	assert.equal(await poll(() => handle.store.ledgerOf("surf-r").blocks.length >= 1), true);
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => handle.store.ledgerOf("surf-r").blocks[0].surfaceReplaced !== undefined), true, "block 1 ships");

	// Grow the history, then commit an UNSHIPPED block whose range still
	// locates (store.commitFold directly — no sweep follows).
	for (let i = 5; i <= 10; i++) {
		session.append("user/message", { id: `u${i}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] }, { surfaceOp: "append" });
		session.append("assistant/message", { message: { id: `a${i}`, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	}
	const derived = session.deriveMessages();
	const first = derived.find((message) => message.id === "u5");
	const last = derived.find((message) => message.id === "a6");
	assert.notEqual(first, undefined);
	assert.notEqual(last, undefined);
	const commit = handle.store.commitFold("surf-r", { refRange: { firstId: first.id, lastId: last.id }, count: 4, approxTokens: 9_000, summary: "Unshipped block.", kind: "summary", tier: "model" }, null);
	assert.equal(commit.ok, true, "unshipped block commits");

	// Frozen dispatch: the unshipped block locates (applied>0) but neither
	// injection path works → inject "none", while the surface channel stays
	// alive through block 1's recent ship.
	const frozenStream = listener(Object.freeze({ sessionId: "surf-r", messages: Object.freeze(session.deriveMessages()), provider: "p", model: "m" }), async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
	for await (const chunk of frozenStream) void chunk;
	assert.equal(recentTrimInjectOf("surf-r"), "none");

	// Idle fold cycle: the injection-unavailable pause must NOT fire — the
	// cycle runs its full evaluation (a third FOLD is cadence-gated to 60s
	// between folds, so the decision ROW is the pass signal here).
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "surf-r" } } });
	assert.equal(await poll(() => /session=surf-r via=idle action=/.test(decisionsOf(stateDir))), true, "idle cycle ran its evaluation");
	const log = decisionsOf(stateDir);
	assert.doesNotMatch(log, /session=surf-r [^\n]*injection-unavailable/u, "no injection-unavailable pause while the channel is alive");
	assert.match(log, /session=surf-r via=idle action=/u, "the idle cycle ran");

	// Banner: wireRaw only when the channel is dead — a fresh ship keeps the
	// wire=raw marker OFF even though the last dispatch logged inject=none.
	const line = contexts[0].text({ agent: { name: "Relax Agent", session: { id: "surf-r" } } });
	assert.doesNotMatch(line, /wire=raw/u);
});

test("count-less legacy block: not-located hard skip, never a guessed range", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-n-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-n");
	agentsById.set("surf-n", { session });
	// Two IDENTICAL id-less messages: both derive one content-hash ref, so a
	// last-occurrence GUESS would fold the pair [dup, dup] — the hardened
	// count-anchored resolution must refuse instead.
	const dup = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "duplicate payload" }] };
	session.append("user/message", { ...dup }, { surfaceOp: "append" });
	session.append("user/message", { ...dup }, { surfaceOp: "append" });
	const nodesBefore = session.surface.nodes.length;
	const dupRef = refOf(dup, 0);
	const block = { id: "b-legacy", kind: "summary", tier: "model", refRange: { firstId: dupRef, lastId: dupRef }, count: 0, approxTokens: 10, summary: "Legacy count-less block." };
	handle.store.ledgerOf("surf-n").blocks.push(block);

	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	await poll(() => false, 40);
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	await poll(() => false, 20);

	// Exactly one per-block row, a durable tombstone, and no shadowing.
	const rows = decisionsOf(stateDir).split("\n").filter((line) => line.includes("session=surf-n") && line.includes("reason=not-located"));
	assert.equal(rows.length, 1, "exactly one not-located row");
	assert.match(rows[0], /block=b-legacy/u);
	assert.equal(block.surfaceSkip?.reason, "not-located", "tombstone written");
	assert.equal(block.surfaceReplaced, undefined, "never shipped");
	assert.equal(session.rawEvents.filter((event) => event.surfaceOp?.op === "replace").length, 0, "no replace events");
	assert.equal(session.surface.nodes.length, nodesBefore, "surface untouched — no guessed range shadowed");
});

test("system head: clamped out of stored and live ranges; head-only blocks tombstone", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-s-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	// Session whose surface node 0 IS the system prompt (the real wire head
	// shape that tripped the host's assertSystemHeadRewrite).
	const session = mockSession("surf-sh");
	session.append("system/message", { message: { id: "sys-0", role: "system", source: { kind: "system" }, content: [{ type: "text", text: "system prompt " + "S".repeat(2_000) }] } }, { surfaceOp: "append" });
	for (let i = 1; i <= 4; i++) {
		session.append("user/message", { id: `u${i}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] }, { surfaceOp: "append" });
		session.append("assistant/message", { message: { id: `a${i}`, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	}
	agentsById.set("surf-sh", { session });
	assert.equal(session.surface.nodes[0], 0, "node 0 is the system head");
	// Block 1: LEGACY stored capture spanning the head (pre-clamp persisted
	// shape — the ship-time clamp must strip the head). Block 2: a head-only
	// range (nothing foldable remains). Block 3: a later range without a
	// capture (live-location path, must locate past the head untouched).
	const headBlock = { id: "b-head", kind: "summary", tier: "model", refRange: { firstId: "sys-0", lastId: "a1" }, count: 3, approxTokens: 1_000, summary: "Head block." };
	headBlock.surfaceSeqs = session.surface.nodes.slice(0, 3);
	const headOnlyBlock = { id: "b-headonly", kind: "summary", tier: "model", refRange: { firstId: "sys-0", lastId: "sys-0" }, count: 1, approxTokens: 500, summary: "Head-only block." };
	headOnlyBlock.surfaceSeqs = [0];
	const tailBlock = { id: "b-tail", kind: "summary", tier: "model", refRange: { firstId: "u2", lastId: "a2" }, count: 2, approxTokens: 1_000, summary: "Tail block." };
	handle.store.ledgerOf("surf-sh").blocks.push(headBlock, headOnlyBlock, tailBlock);

	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => headBlock.surfaceReplaced !== undefined && tailBlock.surfaceReplaced !== undefined), true, "the clamped head block and the tail block ship");
	assert.equal(headBlock.surfaceSkip, undefined, "a head-spanning block clamps instead of tombstoning");
	assert.equal(headBlock.surfaceReplaced.startSeq, 1, "the shipped range starts AFTER the head seq");
	assert.equal(headBlock.surfaceReplaced.endSeq, 2, "the shipped range keeps the foldable tail of the capture");
	assert.equal(headOnlyBlock.surfaceReplaced, undefined, "a head-only block never ships");
	assert.equal(headOnlyBlock.surfaceSkip?.reason, "system-head", "head-only tombstone persisted");
	const replaces = session.rawEvents.filter((event) => event.surfaceOp?.op === "replace");
	assert.equal(replaces.length, 2, "exactly two replace pairs appended");
	for (const event of replaces) {
		assert.notEqual(event.surfaceOp.startSeq, 0, "no shipped range covers node 0");
		assert.equal(event.surfaceOp.startSeq === 0 || event.sourceEventSeqs.includes(0), false, "no shadowed seqs include the system head");
	}
	const log = decisionsOf(stateDir);
	assert.match(log, /session=surf-sh surface-replace skipped reason=system-head .*block=b-headonly/u);
	assert.match(log, /session=surf-sh surface-replace startSeq=\d+ endSeq=\d+/u, "the ship rows are logged");

	// Second sweep after the content generation moved: the head-only
	// tombstone re-opens but the per-block row stays deduped to one, and
	// nothing new appends.
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	await poll(() => false, 20);
	const headRows = decisionsOf(stateDir).split("\n").filter((line) => line.includes("reason=system-head"));
	assert.equal(headRows.length, 1, "exactly one system-head row across sweeps");
	assert.equal(session.rawEvents.filter((event) => event.surfaceOp?.op === "replace").length, 2, "still exactly two replaces");
});

test("capture clamp: a fresh commit over the head stores a clamped capture, marker set", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-cc-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-cc");
	session.append("system/message", { message: { id: "sys-0", role: "system", source: { kind: "system" }, content: [{ type: "text", text: "system prompt " + "S".repeat(2_000) }] } }, { surfaceOp: "append" });
	for (let i = 1; i <= 2; i++) {
		session.append("user/message", { id: `u${i}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] }, { surfaceOp: "append" });
		session.append("assistant/message", { message: { id: `a${i}`, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	}
	agentsById.set("surf-cc", { session });
	const commit = handle.store.commitFold("surf-cc", { refRange: { firstId: "sys-0", lastId: "a1" }, count: 3, approxTokens: 900, summary: "Wide head block.", kind: "summary", tier: "model" }, null);
	assert.equal(commit.ok, true);
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-cc", commit.block), true, "capture resolves");
	assert.equal(commit.block.surfaceHeadClamped, true, "clamp marker recorded");
	assert.deepEqual(commit.block.surfaceSeqs, [1, 2], "the stored capture never contains the head seq 0");

	// The clamped capture ships from the stored path (identity check skips
	// the deliberately dropped first endpoint).
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => commit.block.surfaceReplaced !== undefined), true, "clamped capture ships");
	assert.equal(commit.block.surfaceReplaced.startSeq, 1, "shipped range starts after the head");
	const replace = session.rawEvents.find((event) => event.surfaceOp?.op === "replace");
	assert.equal(replace.surfaceOp.startSeq, 1);
	assert.equal(replace.surfaceOp.endSeq, 2);
	assert.deepEqual(replace.sourceEventSeqs, [1, 2]);
});

/** Append a real-shaped shipped replace pair over [startSeq, endSeq] and
 * return the replacement event. The replacement body carries the
 * acp_summary_ id, exactly like surface.js's own append. */
function shipReplace(session, startSeq, endSeq, blockId) {
	const nodes = session.surface.nodes;
	const span = nodes.slice(nodes.indexOf(startSeq), nodes.indexOf(endSeq) + 1);
	session.append("compaction/prune", { shadowedRange: { start: startSeq, end: endSeq }, shadowedSeqs: span, shadowedTokenCount: 1_000 });
	return session.append("user/message", { id: `acp_summary_${blockId}`, role: "user", content: [{ type: "text", text: `[SWITCHMAN:TRIM] ${blockId} summary` }] }, { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs: span });
}

test("capture roundtrip across a preceding replace pair: non-monotonic node order ships", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-nm-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-nm");
	agentsById.set("surf-nm", { session });
	// A fold that already shipped: replace nodes 2..5 (seqs 2,3,4,5) with a
	// NEW event (seq 9; seq 8 is the log-only metering row), exactly the shape
	// of the real fold #1 whose acp_summary_ message later became fold #2's
	// first message. Surface order becomes [0, 1, 9, 6, 7] — NOT ascending.
	shipReplace(session, 2, 5, "b-first");
	assert.deepEqual(session.surface.nodes, [0, 1, 9, 6, 7], "replacement seq spliced into the middle");
	// Fresh nodes appended after the replacement (turns since the ship).
	session.append("user/message", { id: "u9", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "u9 " + "F".repeat(4_000) }] }, { surfaceOp: "append" });
	session.append("assistant/message", { message: { id: "a9", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "a9 " + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	const block = { id: "b-second", kind: "summary", tier: "model", refRange: { firstId: "acp_summary_b-first", lastId: "a9" }, count: 5, approxTokens: 9_000, summary: "Second fold." };
	handle.store.ledgerOf("surf-nm").blocks.push(block);

	assert.equal(handle.surfacePass.captureFoldSeqs("surf-nm", block), true, "commit-time capture resolves");
	assert.deepEqual(block.surfaceSeqs, [9, 6, 7, 10, 11], "capture keeps MODEL-VISIBLE order");
	assert.equal(block.surfaceSeqs.some((seq, i) => i > 0 && seq < block.surfaceSeqs[i - 1]), true, "the span is legitimately non-monotonic in seq space");

	// THE ROUND TRIP: a capture produced from this surface must validate against
	// the same surface. Pre-fix the ascending check rejected it and the sweep
	// tombstoned with incomplete-seqs forever.
	const shipped = await handle.surfacePass.sweep("surf-nm", "test");
	assert.equal(shipped, 1, "the capture round-trips and ships");
	assert.equal(block.surfaceSkip, undefined, "no incomplete-seqs tombstone");
	assert.equal(block.surfaceReplaced?.startSeq, 9);
	assert.equal(block.surfaceReplaced?.endSeq, 11);
	assert.doesNotMatch(decisionsOf(stateDir), /reason=incomplete-seqs/u);
	const replace = session.rawEvents.find((event) => event.data?.id === "acp_summary_b-second");
	assert.notEqual(replace, undefined);
	assert.deepEqual(replace.sourceEventSeqs, [9, 6, 7, 10, 11], "sourceEventSeqs cover the shadowed nodes in node order");
	assert.deepEqual(session.deriveMessages().map((message) => message.id), ["u1", "a1", "acp_summary_b-second"], "the folded range left the projection");
});

/** Tool-pair fixtures: DSH-native message shapes (assistant content block
 *  {type:'tool-call',id}; role:'tool' message carrying toolCallId) — exactly
 *  what the c74 session logged. */
function appendToolUser(session, id) {
	return session.append("user/message", { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `user ${"F".repeat(400)}` }] }, { surfaceOp: "append" });
}
function appendToolCalls(session, id, callIds) {
	return session.append("assistant/message", { message: { id, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `calling ${"F".repeat(400)}` }, ...callIds.map((callId) => ({ type: "tool-call", id: callId }))] } }, { surfaceOp: "append" });
}
function appendToolResult(session, id, callId) {
	return session.append("tool/result", { message: { id, role: "tool", source: { kind: "tool" }, toolCallId: callId, content: [{ type: "text", text: `result ${"F".repeat(400)}` }] } }, { surfaceOp: "append" });
}
/** Tool-pair integrity of the LIVE surface projection: results whose call id
 *  no longer appears (orphan results) and calls with no result (orphan calls).
 *  The whole point of the closure pass is keeping both counters at zero. */
function pairIntegrityOf(session) {
	const messages = session.deriveMessages();
	const callIds = new Set();
	const resultIds = new Set();
	for (const message of messages) {
		for (const block of Array.isArray(message?.content) ? message.content : []) {
			if (block?.type === "tool-call" && typeof block.id === "string") callIds.add(block.id);
		}
		if (message?.role === "tool" && typeof message.toolCallId === "string") resultIds.add(message.toolCallId);
	}
	let orphanCalls = 0;
	let orphanResults = 0;
	for (const id of callIds) if (!resultIds.has(id)) orphanCalls += 1;
	for (const id of resultIds) if (!callIds.has(id)) orphanResults += 1;
	return { orphanCalls, orphanResults };
}

test("tool-pair closure: a range ending inside a multi-result step extends over every result", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-tpa-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-tpa");
	const u1 = appendToolUser(session, "u1"); // node 0
	const a1 = appendToolCalls(session, "a1", ["c1", "c2"]); // node 1
	const r1 = appendToolResult(session, "r1", "c1"); // node 2
	const r2 = appendToolResult(session, "r2", "c2"); // node 3
	appendToolUser(session, "u2"); // node 4
	agentsById.set("surf-tpa", { session });
	// The fold's ref range ends on the FIRST result of a two-call step, so the
	// second call is inside the range with its result outside. This is the
	// capture→ship roundtrip: the capture must store exactly the located span
	// (a pre-closed capture breaks validateStoredSeqs endpoint identity and
	// makes the block permanently unshippable), and the sweep closes it.
	const block = { id: "b-tpa", kind: "summary", tier: "model", refRange: { firstId: "u1", lastId: "r1" }, count: 3, approxTokens: 900, summary: "Split step." };
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-tpa", block), true, "capture resolves");
	assert.deepEqual(block.surfaceSeqs, [u1.seq, a1.seq, r1.seq], "capture stores the located span, never a pre-closed one");
	handle.store.ledgerOf("surf-tpa").blocks.push(block);

	assert.equal(await handle.surfacePass.sweep("surf-tpa", "test"), 1, "the block ships after closing");
	const prune = session.rawEvents.find((event) => event.type === "compaction/prune");
	const replace = session.rawEvents.find((event) => event.surfaceOp?.op === "replace");
	assert.deepEqual(prune.data.shadowedRange, { start: u1.seq, end: r2.seq }, "shipped range closes forward over the second result");
	assert.deepEqual(prune.data.shadowedSeqs, [u1.seq, a1.seq, r1.seq, r2.seq]);
	assert.equal(replace.surfaceOp.endSeq, r2.seq, "surfaceOp.endSeq is the last result seq");
	assert.deepEqual(replace.sourceEventSeqs, [u1.seq, a1.seq, r1.seq, r2.seq], "sourceEventSeqs densely cover the extended span");
	assert.equal(block.surfaceSkip, undefined, "no tombstone for a closable range");
	assert.deepEqual(pairIntegrityOf(session), { orphanCalls: 0, orphanResults: 0 }, "the wire shape has no split pair");
});

test("tool-pair closure: a leading legacy orphan result is absorbed (healing ship)", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-tpb-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-tpb");
	const u1 = appendToolUser(session, "u1"); // node 0
	const a1 = appendToolCalls(session, "a1", ["c1"]); // node 1
	const r1 = appendToolResult(session, "r1", "c1"); // node 2
	const u2 = appendToolUser(session, "u2"); // node 3
	const a2 = appendToolCalls(session, "a2", []); // node 4 (call-less assistant text)
	agentsById.set("surf-tpb", { session });
	// Pre-fix damage: an earlier fold already replaced the assistant call node
	// on its own, leaving the result as an orphan. Surface order: [u1, r1, u2,
	// a2, replacement].
	shipReplace(session, a1.seq, a1.seq, "b-prev");
	assert.deepEqual(session.surface.nodes, [u1.seq, session.rawEvents[session.rawEvents.length - 1].seq, r1.seq, u2.seq, a2.seq]);
	assert.deepEqual(pairIntegrityOf(session), { orphanCalls: 0, orphanResults: 1 }, "the legacy surface has one orphan result");
	// The next fold's range starts AT the orphan result. Its call is already
	// shadowed (absent from the live surface) → the span is kept as captured:
	// shipping removes the orphan (the healing direction, design §2).
	const block = { id: "b-tpb", kind: "summary", tier: "model", refRange: { firstId: "r1", lastId: "a2" }, count: 3, approxTokens: 900, summary: "Heal orphan." };
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-tpb", block), true, "capture keeps the healing span (consistent with the ship-time rule)");
	assert.deepEqual(block.surfaceSeqs, [r1.seq, u2.seq, a2.seq], "the healing span is stored as located, not extended backwards");
	handle.store.ledgerOf("surf-tpb").blocks.push(block);

	assert.equal(await handle.surfacePass.sweep("surf-tpb", "test"), 1, "the leading orphan result does not block the ship");
	const prune = session.rawEvents.filter((event) => event.type === "compaction/prune").at(-1); // the b-prev ship already logged one
	assert.equal(prune.data.shadowedRange.start, r1.seq, "the shipped range starts at the orphan result seq");
	assert.equal(prune.data.shadowedSeqs.includes(r1.seq), true, "the prune's shadowedSeqs contain the orphan result seq");
	assert.equal(block.surfaceSkip, undefined, "no tool-pair-unclosed tombstone");
	assert.deepEqual(pairIntegrityOf(session), { orphanCalls: 0, orphanResults: 0 }, "shipping the span absorbed the orphan result");
});

test("tool-pair closure: a call with no result on the surface tombstones tool-pair-unclosed", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-tpc-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-tpc");
	const u1 = appendToolUser(session, "u1"); // node 0
	const a1 = appendToolCalls(session, "a1", ["c-lost"]); // node 1: no result anywhere
	const u2 = appendToolUser(session, "u2"); // node 2
	agentsById.set("surf-tpc", { session });
	const block = { id: "b-tpc", kind: "summary", tier: "model", refRange: { firstId: "a1", lastId: "u2" }, count: 2, approxTokens: 900, summary: "Lost result." };
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-tpc", block), true, "capture stores the located span (closure is the sweep's job)");
	assert.deepEqual(block.surfaceSeqs, [a1.seq, u2.seq]);
	handle.store.ledgerOf("surf-tpc").blocks.push(block);
	const eventsBefore = session.rawEvents.length;

	assert.equal(await handle.surfacePass.sweep("surf-tpc", "test"), 0, "an unclosable range never ships");
	assert.equal(session.rawEvents.length, eventsBefore, "nothing appended");
	assert.equal(block.surfaceReplaced, undefined);
	assert.equal(block.surfaceSkip?.reason, "tool-pair-unclosed", "tombstone reason persisted");
	assert.match(decisionsOf(stateDir), /session=surf-tpc surface-replace skipped reason=tool-pair-unclosed .*block=b-tpc/u);
});

test("tool-pair closure: a leading result pulls its live call back into the span", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-tpd-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-tpd");
	const u1 = appendToolUser(session, "u1"); // node 0
	const a1 = appendToolCalls(session, "a1", ["c1"]); // node 1: live call
	const r1 = appendToolResult(session, "r1", "c1"); // node 2
	const u2 = appendToolUser(session, "u2"); // node 3
	agentsById.set("surf-tpd", { session });
	// The fold range starts at the RESULT of a step whose call node is still
	// live just before it. Shipping [r1..u2] as captured would leave the call
	// unclosed (orphan call on the wire); the sweep must move the start back
	// onto the owning assistant node. Pre-fix there is no closure at all, so
	// this assertion is what discriminates the backward pass.
	const block = { id: "b-tpd", kind: "summary", tier: "model", refRange: { firstId: "r1", lastId: "u2" }, count: 2, approxTokens: 900, summary: "Split backwards." };
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-tpd", block), true, "capture resolves the located span");
	assert.deepEqual(block.surfaceSeqs, [r1.seq, u2.seq], "capture stores the located span, not a pre-closed one");
	handle.store.ledgerOf("surf-tpd").blocks.push(block);

	assert.equal(await handle.surfacePass.sweep("surf-tpd", "test"), 1, "the block ships after closing backwards");
	const prune = session.rawEvents.find((event) => event.type === "compaction/prune");
	assert.deepEqual(prune.data.shadowedRange, { start: a1.seq, end: u2.seq }, "shipped range starts on the owning assistant call");
	assert.deepEqual(prune.data.shadowedSeqs, [a1.seq, r1.seq, u2.seq], "the call node is pulled into the shadowed span");
	const replace = session.rawEvents.find((event) => event.surfaceOp?.op === "replace");
	assert.equal(replace.surfaceOp.startSeq, a1.seq, "surfaceOp.startSeq is the owning assistant call seq");
	assert.equal(block.surfaceSkip, undefined, "no tombstone for a closable range");
	assert.deepEqual(pairIntegrityOf(session), { orphanCalls: 0, orphanResults: 0 }, "the wire shape has no split pair");
});

test("stale capture re-locating into an already-replaced range: tombstoned", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-ov-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-ov");
	agentsById.set("surf-ov", { session });
	// Another block already replaced a range that numerically covers the
	// re-located span. Legacy marker shape: surfaceReplaced only, no capture.
	const shippedMarker = { id: "b-shipped", kind: "summary", tier: "model", refRange: { firstId: "u3", lastId: "a3" }, count: 2, approxTokens: 500, summary: "Shipped.", surfaceReplaced: { startSeq: 1, endSeq: 3, atSeq: 9, contentGeneration: 0, at: Date.now() } };
	// Our block: refs u1..a2 (nodes 0..3), capture tampered so it fails the
	// dense check. Re-location WOULD resolve — but it collides with the
	// already-replaced range, so the safety rule keeps the hard skip.
	const block = { id: "b-overlap", kind: "summary", tier: "model", refRange: { firstId: "u1", lastId: "a2" }, count: 4, approxTokens: 800, summary: "Overlap.", surfaceSeqs: [0, 2, 3] };
	handle.store.ledgerOf("surf-ov").blocks.push(shippedMarker, block);
	const eventsBefore = session.rawEvents.length;

	await handle.surfacePass.sweep("surf-ov", "test");

	assert.equal(block.surfaceReplaced, undefined, "overlapping re-location never ships");
	assert.equal(block.surfaceSkip?.reason, "incomplete-seqs", "hard skip kept");
	assert.equal(session.rawEvents.length, eventsBefore, "nothing appended");
	assert.match(decisionsOf(stateDir), /session=surf-ov surface-replace skipped reason=incomplete-seqs .*block=b-overlap overlap/u);
});

test("stale-but-capable surface channel: recency never gates folding or lies in the banner", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById, contexts } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Stale channel summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-stale-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-stale");
	agentsById.set("surf-stale", { session });
	async function dispatch(frozen) {
		const options = frozen
			? Object.freeze({ sessionId: "surf-stale", messages: Object.freeze(session.deriveMessages()), provider: "p", model: "m" })
			: { sessionId: "surf-stale", messages: session.deriveMessages(), provider: "p", model: "m" };
		const stream = listener(options, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}

	// Fold 1 commits and ships.
	await dispatch(false);
	assert.equal(await poll(() => handle.store.ledgerOf("surf-stale").blocks.length >= 1), true);
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => handle.store.ledgerOf("surf-stale").blocks[0].surfaceReplaced !== undefined), true, "block 1 ships");
	const block = handle.store.ledgerOf("surf-stale").blocks[0];
	// Age the ship past the old 10-minute in-memory recency window: a proven
	// channel is still capable, the fold gate must not care HOW LONG ago it
	// shipped.
	block.surfaceReplaced.at = Date.now() - 11 * 60_000;

	// Grow the history so a fold cycle has something to evaluate.
	for (let i = 5; i <= 8; i++) {
		session.append("user/message", { id: `u${i}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `u${i} ` + "F".repeat(4_000) }] }, { surfaceOp: "append" });
		session.append("assistant/message", { message: { id: `a${i}`, role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `a${i} ` + "F".repeat(4_000) }] } }, { surfaceOp: "append" });
	}
	// An unshipped block whose refs still locate in the raw re-send: this is
	// what makes the frozen dispatch resolve a view it cannot carry
	// (injected=none), exactly the resumed-session shape from the incident.
	const derived = session.deriveMessages();
	const firstU5 = derived.find((message) => message.id === "u5");
	const lastA6 = derived.find((message) => message.id === "a6");
	assert.notEqual(firstU5, undefined);
	assert.notEqual(lastA6, undefined);
	const pending = handle.store.commitFold("surf-stale", { refRange: { firstId: firstU5.id, lastId: lastA6.id }, count: 4, approxTokens: 9_000, summary: "Pending block.", kind: "summary", tier: "model" }, null);
	assert.equal(pending.ok, true, "unshipped block commits");
	// Frozen dispatch: inject=none, as on every resumed-session main wire.
	await dispatch(true);
	assert.equal(recentTrimInjectOf("surf-stale"), "none");
	assert.equal(handle.surfacePass.supported("surf-stale"), true, "the durable capability probe still says yes");

	// Idle fold cycle: the cycle must run its full evaluation — NOT the
	// injection-unavailable pause the recency gate used to force.
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "surf-stale" } } });
	assert.equal(await poll(() => /session=surf-stale via=idle action=/.test(decisionsOf(stateDir))), true, "idle cycle ran");
	const log = decisionsOf(stateDir);
	assert.doesNotMatch(log, /session=surf-stale [^\n]*injection-unavailable/u, "a stale-but-capable channel never pauses folding");
	// The banner must not claim wire=raw while the ledger proves a shipped
	// replacement, even though the ship is 11 minutes old.
	const line = contexts[0].text({ agent: { name: "Stale Agent", session: { id: "surf-stale" } } });
	assert.doesNotMatch(line, /wire=raw/u);
});

test("wire truth: view-applied logs the tally; pressure tiers use max(view, wire)", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Wire truth summary." }; yield { type: "finish" }; } }) };
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-wire-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir, trimGrowthTokens: 1_000_000_000, trimPressurePercent: 40, trimEmergencyPercent: 101, trimProtectedTail: 2 });
	const store = [];
	for (let i = 1; i <= 7; i++) {
		store.push({ role: "user", content: [{ type: "text", text: `u${i} ` + "F".repeat(300) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `a${i} ` + "F".repeat(300) }] });
	}
	async function send(usage = null) {
		const stream = listener({ sessionId: "wire-2", messages: store.slice(), provider: "p", model: "m" }, async function* () {
			if (usage !== null) yield { type: "usage", usage };
			yield { type: "finish" };
		});
		for await (const chunk of stream) void chunk;
	}

	// First dispatch: no tally known yet, so the row carries no wire= field
	// (fail-open: unknown must behave exactly like before).
	await send();
	assert.equal(handle.captures.has("wire-2"), true);
	assert.equal(handle.metrics.of("wire-2").lastInputTokens, null, "tally unknown until a usage sample");
	assert.doesNotMatch(decisionsOf(stateDir), /session=wire-2 view-applied [^\n]*wire=/u);

	// The provider reports a heavily cached 61.4k prompt as a HOST-shaped
	// TokenUsage chunk: inputTokens covers UNCACHED prompt tokens only, the
	// rest rides the cache buckets. Reading inputTokens alone would log
	// wire=900 and keep max(view, wire) silent — the incident's 130k-of-136k
	// cached shape. The sampler must fold all three buckets into the total.
	await send({ inputTokens: 900, cacheReadTokens: 60_000, cacheWriteTokens: 500, outputTokens: 100 });
	assert.equal(handle.metrics.of("wire-2").lastInputTokens, 900, "inputTokens stays the uncached bucket");
	assert.equal(handle.metrics.of("wire-2").cachedTokens, 60_000, "camelCase cacheReadTokens is mapped");
	assert.equal(handle.metrics.of("wire-2").cacheWriteTokens, 500, "camelCase cacheWriteTokens is mapped");
	await send();
	assert.match(decisionsOf(stateDir), /session=wire-2 view-applied [^\n]* wire=61400/u, "the row carries the FULL prompt size");
	assert.equal(handle.store.ledgerOf("wire-2").blocks.length, 0, "no fold before the tally-driven cycle");

	await handle.maybeFold("wire-2", "test");
	const log = decisionsOf(stateDir);
	assert.match(log, /session=wire-2 via=test action=fold tier=pressure/u, "pressure fires on max(view, wire)");
	assert.match(log, /session=wire-2 via=test [^\n]* view=\d+ wire=61400 window=100000/u, "the decision row shows both meters");
	assert.equal(handle.store.ledgerOf("wire-2").blocks.length, 1, "pressure tier committed a fold");
});

test("stale capture with vanished refs: incomplete-seqs tombstone, no guessed range", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-gone-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-gone");
	agentsById.set("surf-gone", { session });
	// Authoritative capture from commit time (refs u1..a2 → nodes 0..3).
	const commit = handle.store.commitFold("surf-gone", { refRange: { firstId: "u1", lastId: "a2" }, count: 4, approxTokens: 9_000, summary: "Vanished block.", kind: "summary", tier: "model" }, null);
	assert.equal(commit.ok, true);
	const block = commit.block;
	assert.equal(handle.surfacePass.captureFoldSeqs("surf-gone", block), true);
	assert.deepEqual(block.surfaceSeqs, [0, 1, 2, 3]);
	// Another fold already shadowed that EXACT range: the capture endpoints
	// left the surface AND the refs no longer resolve. Neither resolution path
	// can produce an honest range, so the block must tombstone as
	// incomplete-seqs (the hard-skip branch) instead of guessing.
	shipReplace(session, 0, 3, "other");
	const eventsBefore = session.rawEvents.length;
	await handle.surfacePass.sweep("surf-gone", "test");
	assert.equal(block.surfaceReplaced, undefined, "never shipped");
	assert.equal(block.surfaceSkip?.reason, "incomplete-seqs", "hard skip kept");
	assert.equal(session.rawEvents.length, eventsBefore, "nothing appended");
	// The tombstone is keyed on the surface generation: a stable surface stays
	// quiet on later sweeps.
	await handle.surfacePass.sweep("surf-gone", "test");
	const rows = decisionsOf(stateDir).split("\n").filter((line) => line.includes("session=surf-gone") && line.includes("reason=incomplete-seqs"));
	assert.equal(rows.length, 1, "the tombstoned block logs once per surface generation");
	assert.match(rows[0], /block=.*/u);
});

test("stale capture whose refs locate an earlier look-alike span: tombstoned, never re-targeted", async (t) => {
	const { ctx, agentsById } = mockCtx({ withAgents: true });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-look-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = mockSession("surf-look");
	const text = (who) => [{ type: "text", text: `${who} ` + "L".repeat(500) }];
	// Two IDENTICAL id-less pairs: refOf is content-addressed, so the pair
	// repeats one ref twice — a count-anchored locate takes the FIRST match.
	const dupP = () => ({ role: "user", source: { kind: "user" }, content: text("dup-p") });
	const dupQ = () => ({ role: "assistant", source: { kind: "model" }, content: text("dup-q") });
	session.append("user/message", { id: "u1", role: "user", source: { kind: "user" }, content: text("u1") }, { surfaceOp: "append" });
	session.append("assistant/message", { message: { id: "a1", role: "assistant", source: { kind: "model" }, content: text("a1") } }, { surfaceOp: "append" });
	session.append("user/message", dupP(), { surfaceOp: "append" });
	session.append("assistant/message", { message: dupQ() }, { surfaceOp: "append" });
	session.append("user/message", { id: "u2", role: "user", source: { kind: "user" }, content: text("u2") }, { surfaceOp: "append" });
	session.append("assistant/message", { message: { id: "a2", role: "assistant", source: { kind: "model" }, content: text("a2") } }, { surfaceOp: "append" });
	session.append("user/message", dupP(), { surfaceOp: "append" });
	session.append("assistant/message", { message: dupQ() }, { surfaceOp: "append" });
	agentsById.set("surf-look", { session });
	assert.deepEqual(session.surface.nodes, [0, 1, 2, 3, 4, 5, 6, 7]);
	// The block's authoritative capture is the LATER pair (nodes 6,7).
	const block = { id: "b-look", kind: "summary", tier: "model", refRange: { firstId: refOf(dupP(), 0), lastId: refOf(dupQ(), 0) }, count: 2, approxTokens: 500, summary: "Look-alike block.", surfaceSeqs: [6, 7] };
	handle.store.ledgerOf("surf-look").blocks.push(block);
	// Another fold shadowed the block's TRUE span, so its refs now resolve to
	// the earlier look-alike pair (nodes 2,3). The stored endpoints prove the
	// located span is a DIFFERENT range: re-targeting it would shadow messages
	// the fold never covered.
	shipReplace(session, 6, 7, "other");
	const nodesBefore = session.surface.nodes.slice();
	await handle.surfacePass.sweep("surf-look", "test");
	assert.equal(block.surfaceReplaced, undefined, "never re-targets the earlier look-alike span");
	assert.equal(block.surfaceSkip?.reason, "incomplete-seqs", "hard skip kept");
	assert.deepEqual(session.surface.nodes, nodesBefore, "surface untouched — no look-alike range shadowed");
	assert.match(decisionsOf(stateDir), /session=surf-look surface-replace skipped reason=incomplete-seqs .*block=b-look relocated-range/u);
});

test("open compaction lock: supported() false and maybeFold burns no summary call", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, agentsById } = mockCtx({ llmFiber: fiber });
	let prepareCalls = 0;
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
		prepareCall: async () => {
			prepareCalls += 1;
			return { stream: async function* () { yield { type: "text-delta", text: "Locked summary." }; yield { type: "finish" }; } };
		},
	};
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-lk-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	const session = seededSession("surf-lk");
	agentsById.set("surf-lk", { session });
	async function dispatch(frozen) {
		const options = frozen
			? Object.freeze({ sessionId: "surf-lk", messages: Object.freeze(session.deriveMessages()), provider: "p", model: "m" })
			: { sessionId: "surf-lk", messages: session.deriveMessages(), provider: "p", model: "m" };
		const stream = listener(options, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
	}
	// Fold 1 commits on the mutable dispatch (one summary-model call), then a
	// frozen re-send puts the dispatch on inject=none — the resumed shape.
	await dispatch(false);
	assert.equal(await poll(() => handle.store.ledgerOf("surf-lk").blocks.length >= 1), true, "fold 1 committed");
	await dispatch(true);
	assert.equal(recentTrimInjectOf("surf-lk"), "none");
	const blocksAfterFold = handle.store.ledgerOf("surf-lk").blocks.length;
	const callsAfterFold = prepareCalls;

	// Open (orphaned) compaction lock: sweep defers, so the fold gate must say
	// "not capable" instead of letting maybeFold burn summary calls for folds
	// that can never reach the wire (≤6/hour with zero relief).
	session.append("compaction/start", { compactionId: "c-open", turn: null });
	assert.equal(handle.surfacePass.supported("surf-lk"), false, "an open lock makes the channel incapable");
	await handle.maybeFold("surf-lk", "locktest");
	assert.equal(prepareCalls, callsAfterFold, "no summary-model call under the lock");
	assert.equal(handle.store.ledgerOf("surf-lk").blocks.length, blocksAfterFold, "no fold committed under the lock");
	const lockedLog = decisionsOf(stateDir);
	assert.match(lockedLog, /session=surf-lk via=locktest action=none reason=injection-unavailable/u, "the fold cycle is gated before evaluation");
	assert.doesNotMatch(lockedLog, /session=surf-lk via=locktest action=fold/u);

	// Lock released: the cached probe invalidates on the new session seq and
	// the decision cycle runs again (cadence-gated, but evaluated).
	session.append("compaction/end", { compactionId: "c-open", turn: null });
	assert.equal(handle.surfacePass.supported("surf-lk"), true, "lock released → capable again");
	await handle.maybeFold("surf-lk", "unlocked");
	const log = decisionsOf(stateDir);
	assert.match(log, /session=surf-lk via=unlocked action=/u, "the cycle evaluates after the lock clears");
	assert.doesNotMatch(log, /session=surf-lk via=unlocked [^\n]*injection-unavailable/u);
});

test("banner: a capture alone never hides wire=raw; a shipped replacement does", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, contexts } = mockCtx({ llmFiber: fiber, withAgents: false });
	ctx.get = () => null;
	const stateDir = mkdtempSync(join(tmpdir(), "trim-surface-cap-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	// Persisted capture from an earlier process, no live registry (so the
	// capability probe says no) and no ship: the capture must NOT suppress
	// the honest warning.
	const messages = [];
	for (let i = 1; i <= 3; i++) {
		messages.push({ id: `u${i}`, role: "user", content: [{ type: "text", text: `u${i} ` + "C".repeat(400) }] });
		messages.push({ id: `a${i}`, role: "assistant", content: [{ type: "text", text: `a${i} ` + "C".repeat(400) }] });
	}
	const block = { id: "b-cap", kind: "summary", tier: "model", refRange: { firstId: "u1", lastId: "a1" }, count: 2, approxTokens: 500, summary: "Capture only.", surfaceSeqs: [0, 1] };
	handle.store.ledgerOf("surf-cap").blocks.push(block);
	const stream = listener(Object.freeze({ sessionId: "surf-cap", messages: Object.freeze(messages), provider: "p", model: "m" }), async function* () { yield { type: "finish" }; });
	for await (const chunk of stream) void chunk;
	assert.equal(recentTrimInjectOf("surf-cap"), "none");
	const captured = contexts[0].text({ agent: { name: "Cap Agent", session: { id: "surf-cap" } } });
	assert.match(captured, /wire=raw/u, "a capture alone must not silence the warning");
	// Shipped evidence stands the marker down.
	block.surfaceReplaced = { startSeq: 0, endSeq: 1, seqs: [0, 1], contentGeneration: 0, atSeq: null, via: "test", at: Date.now() };
	const shipped = contexts[0].text({ agent: { name: "Cap Agent", session: { id: "surf-cap" } } });
	assert.doesNotMatch(shipped, /wire=raw/u, "a shipped replacement suppresses wire=raw");
});
