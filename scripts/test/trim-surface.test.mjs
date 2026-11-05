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
	assert.equal(replacement.data.source.kind, "compact-checkpoint");
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

test("validation failure: an incomplete stored capture is skipped and logged", async (t) => {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, agentsById } = mockCtx({ llmFiber: fiber });
	const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }), prepareCall: async () => ({ stream: async function* () { yield { type: "text-delta", text: "Broken capture." }; yield { type: "finish" }; } }) };
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
	// Tamper: drop a middle seq — endpoints stay, dense coverage is gone. The
	// pass must NOT silently re-target a different range via live location.
	block.surfaceSeqs = [block.surfaceSeqs[0], ...block.surfaceSeqs.slice(2)];
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	await poll(() => false, 40);
	assert.equal(block.surfaceReplaced, undefined, "incomplete sourceEventSeqs never ships");
	assert.ok(session.rawEvents.every((event) => event.surfaceOp === undefined || event.surfaceOp === "append"), "no replace events");
	assert.match(decisionsOf(stateDir), /session=surf-v surface-replace skipped reason=incomplete-seqs/u);
	// The tombstone keeps later sweeps quiet (same surface generation).
	const rowsBefore = decisionsOf(stateDir).split("\n").filter((line) => line.includes("incomplete-seqs")).length;
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	await poll(() => false, 20);
	const rowsAfter = decisionsOf(stateDir).split("\n").filter((line) => line.includes("incomplete-seqs")).length;
	assert.equal(rowsAfter, rowsBefore, "tombstoned block does not re-log");
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

test("system head: a block over the first node is tombstoned, later blocks still ship", async (t) => {
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
	// Block 1: stored capture over the system head (the historical first-fold
	// shape). Block 2: a later range without a capture (live-location path).
	const headBlock = { id: "b-head", kind: "summary", tier: "model", refRange: { firstId: "sys-0", lastId: "a1" }, count: 3, approxTokens: 1_000, summary: "Head block." };
	headBlock.surfaceSeqs = session.surface.nodes.slice(0, 3);
	const tailBlock = { id: "b-tail", kind: "summary", tier: "model", refRange: { firstId: "u2", lastId: "a2" }, count: 2, approxTokens: 1_000, summary: "Tail block." };
	handle.store.ledgerOf("surf-sh").blocks.push(headBlock, tailBlock);

	hooks["agent/turn-stopping"]({ agent: { session }, turn: 1, signal: undefined });
	assert.equal(await poll(() => tailBlock.surfaceReplaced !== undefined), true, "the later-range block still ships");
	assert.equal(headBlock.surfaceReplaced, undefined, "the system-head block never ships");
	assert.equal(headBlock.surfaceSkip?.reason, "system-head", "tombstone persisted");
	const replaces = session.rawEvents.filter((event) => event.surfaceOp?.op === "replace");
	assert.equal(replaces.length, 1, "exactly one replace event appended");
	assert.notEqual(replaces[0].surfaceOp.startSeq, 0, "the shipped range never covers node 0");
	const log = decisionsOf(stateDir);
	assert.match(log, /session=surf-sh surface-replace skipped reason=system-head .*block=b-head/u);
	assert.match(log, /session=surf-sh surface-replace startSeq=\d+ endSeq=\d+/u, "the ship row is logged");

	// Second sweep after the content generation moved: the tombstone re-opens
	// but the per-block row stays deduped to one, and nothing new appends.
	hooks["agent/turn-stopping"]({ agent: { session }, turn: 2, signal: undefined });
	await poll(() => false, 20);
	const headRows = decisionsOf(stateDir).split("\n").filter((line) => line.includes("reason=system-head"));
	assert.equal(headRows.length, 1, "exactly one system-head row across sweeps");
	assert.equal(session.rawEvents.filter((event) => event.surfaceOp?.op === "replace").length, 1, "still exactly one replace");
});
