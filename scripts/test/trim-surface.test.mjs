/** Surface-replace pass tests (docs/surface-fold.md, v1.10).
 *
 * Drives the trim loop against a host-shaped mock SESSION: an append-only
 * event log with a real surface projection (nodes list, replace shadowing,
 * deriveMessages-equivalent view) and host-grade validation — surfaceOp
 * markers required on message events, replace ranges must live in the
 * surface, sourceEventSeqs must densely cover every shadowed node. Covers:
 * frozen-dispatch fold ships via turn-stopping, idempotence, the compaction
 * lock, the surfaceFold flag, the missing-service legacy fallback, and the
 * incomplete-seqs validation skip.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyContextTrim, recentTrimInjectOf } from "../../host/context-trim/index.js";

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
	const agentsById = new Map();
	const ctx = {
		log: { warn: () => {} },
		agents: withAgents
			? { currentInitiator: () => ({ session: { id: "" } }), get: (id) => agentsById.get(id) }
			: { currentInitiator: () => ({ session: { id: "" } }) },
		systemPrompt: { section: () => {}, context: () => {} },
		on: (event, handler) => { hooks[event] = handler; },
		tools: { register: (tool) => registered.push(tool) },
		get: () => null,
		inject: (deps, body) => { if (deps.includes("llm") && llmFiber !== null) body(llmFiber); },
	};
	return { ctx, hooks, registered, agentsById };
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
