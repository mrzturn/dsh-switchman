/** Context-trim layer tests (node:test). Pure modules are exercised
 * directly (view/trigger/state/metrics/summarizer render paths); the
 * assembly is exercised with a mock ctx following the intent-layer test
 * pattern in validate.mjs (ctx.inject(deps, body) => body(fiber)). */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refOf, buildView, injectView, ledgerIsStale, segmentBounds, rangeIsSegmentAligned, estimateTokensOf, replaceInPlace, summaryMessageOf, renderSummaryText, refPositions } from "../../host/context-trim/view.js";
import { createStore, emptyLedger, normalizeBlock } from "../../host/context-trim/state.js";
import { computeFoldableRange, evaluateTrigger, FOLD_MIN_INTERVAL_MS, EMERGENCY_COOLDOWN_MS } from "../../host/context-trim/trigger.js";
import { mechanicalSummary, renderMaterial, summarizeWithModel, SUMMARY_SYSTEM_PROMPT, MAX_MATERIAL_CHARS, TRUNCATED_SUMMARY_MARK } from "../../host/context-trim/summarizer.js";
import { createMetrics, extractUsage, promptTokensOf, wrapStreamForMetrics } from "../../host/context-trim/metrics.js";
import { applyContextTrim, effectiveWindowTokens, TRIM_PROTOCOL_TEXT } from "../../host/context-trim/index.js";

/** Build a deterministic message list (no ids — refs must hash stably). */
function makeMessages(n, seed = 0) {
	const messages = [];
	for (let i = 0; i < n; i++) {
		messages.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `message ${i} seed ${seed} — ${"x".repeat(40)}` }],
		});
	}
	return messages;
}

/** A fold block over messages[startIdx..endIdx] of a list. */
function blockFor(messages, startIdx, endIdx, summary = "folded range") {
	const refs = [];
	for (let i = startIdx; i <= endIdx; i++) refs.push(refOf(messages[i], i));
	return { refRange: { firstId: refs[0], lastId: refs[refs.length - 1] }, count: endIdx - startIdx + 1, approxTokens: estimateTokensOf(messages, startIdx, endIdx), summary, kind: "summary", tier: "growth" };
}

describe("view: refs and canonicalization", () => {
	test("refOf is stable across re-sends (id-less messages)", () => {
		const a = makeMessages(3);
		const b = makeMessages(3);
		for (let i = 0; i < 3; i++) assert.equal(refOf(a[i], i), refOf(b[i], i));
	});

	test("refOf prefers usable explicit ids, rejects whitespace/control ids", () => {
		assert.equal(refOf({ id: "abc-123", role: "user", content: "hi" }, 0), "abc-123");
		const fallback = refOf({ id: "has space", role: "user", content: "hi" }, 0);
		assert.match(fallback, /^h[0-9a-f]{12}$/u);
	});

	test("refOf ignores volatile fields in the hash", () => {
		const a = { role: "user", content: "hi", ts: 1, createdAt: 2 };
		const b = { role: "user", content: "hi", ts: 9, createdAt: 99 };
		assert.equal(refOf(a, 0), refOf(b, 0));
	});
});

describe("view: buildView determinism (golden)", () => {
	test("same (messages, ledger) → byte-identical output", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 9, "first half summary"));
		const one = JSON.stringify(buildView(messages, ledger, { protectedTail: 6 }));
		const two = JSON.stringify(buildView(messages, ledger, { protectedTail: 6 }));
		assert.equal(one, two);
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 1);
		assert.equal(view.messages.length, 11); // 10 folded → 1 synthetic + 10 tail
		assert.equal(view.messages[0].id, "acp_summary_b0_placeholder" === undefined ? "" : view.messages[0].id);
		assert.match(view.messages[0].id, /^acp_summary_/u);
		assert.equal(view.messages[0].role, "user");
		assert.match(renderSummaryText(ledger.blocks[0]), /^\[SWITCHMAN:TRIM\] /u);
		assert.equal(view.messages[0].content[0].text, renderSummaryText(ledger.blocks[0]));
	});

	test("prefix stability: appending tail messages does not move the fold", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 9, "stable prefix"));
		const before = buildView(messages, ledger, { protectedTail: 6 });
		const grown = makeMessages(24);
		const after = buildView(grown, ledger, { protectedTail: 6 });
		// first 11 output messages (synthetic + tail) must be identical
		assert.equal(before.messages.length >= 11, true);
		for (let i = 0; i < 11; i++) assert.deepEqual(after.messages[i], before.messages[i]);
	});

	test("protected tail is never folded", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 19, "everything")); // reaches into tail
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 0);
		assert.equal(view.messages.length, 20);
	});

	test("stale block (refs not in history) is skipped, nothing lost", () => {
		const messages = makeMessages(10);
		const ledger = emptyLedger("s1");
		ledger.blocks.push({ refRange: { firstId: "ghost-first", lastId: "ghost-last" }, count: 5, approxTokens: 10, summary: "ghost", kind: "summary", tier: "growth", createdAt: 0 });
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 0);
		assert.equal(view.messages.length, 10);
		assert.equal(view.unlocated, 1);
		assert.equal(ledgerIsStale(view, ledger), true);
	});

	test("blocks that locate but are skipped (protected tail) are not unlocated", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 19, "everything"));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 0);
		assert.equal(view.unlocated, 0);
		assert.equal(ledgerIsStale(view, ledger), false);
	});

	test("ledgerIsStale requires every block to be unlocated", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 2, 5, "real"));
		ledger.blocks.push({ refRange: { firstId: "ghost-first", lastId: "ghost-last" }, count: 5, approxTokens: 10, summary: "ghost", kind: "summary", tier: "growth", createdAt: 0 });
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 1);
		assert.equal(view.unlocated, 1);
		assert.equal(ledgerIsStale(view, ledger), false);
	});

	test("injectView: in-place on mutable arrays, reference swap on frozen arrays, none on frozen options", () => {
		const messages = makeMessages(12);
		const ledger = emptyLedger("s-inject");
		ledger.blocks.push(blockFor(messages, 0, 5, "head"));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 1);
		// mutable dispatch: splice in place, identity preserved
		const mutableOptions = { messages };
		assert.equal(injectView(mutableOptions, messages, view), "in-place");
		assert.equal(mutableOptions.messages, messages);
		assert.equal(mutableOptions.messages.length, view.messages.length);
		// frozen array (resumed-session re-send): swap the reference
		const frozenMessages = Object.freeze(makeMessages(12));
		const frozenLedger = emptyLedger("s-inject2");
		frozenLedger.blocks.push(blockFor(frozenMessages, 0, 5, "head"));
		const frozenView = buildView(frozenMessages, frozenLedger, { protectedTail: 6 });
		assert.equal(frozenView.applied, 1);
		const swapOptions = { messages: frozenMessages };
		assert.equal(injectView(swapOptions, frozenMessages, frozenView), "swapped");
		assert.notEqual(swapOptions.messages, frozenMessages);
		assert.equal(swapOptions.messages.length, frozenView.messages.length);
		// frozen options on top (fully immutable dispatch): fail open
		const sealedOptions = Object.freeze({ messages: frozenMessages });
		assert.equal(injectView(sealedOptions, frozenMessages, frozenView), "none");
	});

	test("count mismatch guard: located span must equal stored count", () => {
		const messages = makeMessages(20);
		const ledger = emptyLedger("s1");
		const block = blockFor(messages, 0, 9);
		block.count = 99; // lie about the range
		ledger.blocks.push(block);
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 0);
	});

	test("input array is never mutated; replaceInPlace preserves identity", () => {
		const messages = makeMessages(20);
		const snapshot = JSON.stringify(messages);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 9));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(JSON.stringify(messages), snapshot);
		const live = messages.slice();
		const returned = replaceInPlace(live, view.messages);
		assert.equal(returned, live);
		assert.deepEqual(live, view.messages);
	});

	test("two disjoint folds render in positional order", () => {
		const messages = makeMessages(30);
		const ledger = emptyLedger("s1");
		ledger.blocks.push(blockFor(messages, 0, 4, "A"));
		ledger.blocks.push(blockFor(messages, 8, 12, "B"));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 2);
		assert.match(view.messages[0].content[0].text, /A/u);
		const bIdx = view.messages.findIndex((m) => typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("[SWITCHMAN:TRIM] B"));
		assert.ok(bIdx > 0);
		assert.equal(view.messages.length, 30 - 5 - 5 + 2);
	});

	test("system head: a block covering index 0 is skipped, not unlocated", () => {
		const messages = [{ role: "system", content: [{ type: "text", text: "system prompt" }] }, ...makeMessages(19)];
		const ledger = emptyLedger("s-sys");
		ledger.blocks.push(blockFor(messages, 0, 9, "covers the head"));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 0);
		assert.equal(view.unlocated, 0); // epoch semantics untouched
		assert.equal(view.foldedMessages, 0);
		assert.equal(view.messages.length, 20);
		assert.deepEqual(view.messages, messages); // nothing spliced off
		assert.equal(ledgerIsStale(view, ledger), false);
	});

	test("system head: a block over a later range still applies", () => {
		const messages = [{ role: "system", content: [{ type: "text", text: "system prompt" }] }, ...makeMessages(19)];
		const ledger = emptyLedger("s-sys2");
		ledger.blocks.push(blockFor(messages, 2, 9, "later range"));
		const view = buildView(messages, ledger, { protectedTail: 6 });
		assert.equal(view.applied, 1);
		assert.equal(view.messages[0].role, "system"); // the head survives at index 0
		assert.equal(view.messages.length, 20 - 8 + 1);
	});
});

describe("view: tool-pair integrity", () => {
	function pairMessages() {
		return [
			{ role: "user", content: "question" },
			{ id: "assistant-1", role: "assistant", content: "thinking", tool_calls: [{ id: "call-1", function: { name: "read", arguments: "{}" } }] },
			{ id: "tool-1", role: "tool", tool_call_id: "call-1", content: "file body" },
			{ id: "tool-2", role: "tool", tool_call_id: "call-1", content: "file body 2" },
			{ role: "assistant", content: "answer" },
		];
	}
	test("segmentBounds keeps tool pairs atomic", () => {
		const messages = pairMessages();
		assert.deepEqual(segmentBounds(messages), [[0, 0], [1, 3], [4, 4]]);
	});
	test("anthropic-style pairs stay atomic too", () => {
		const messages = [
			{ id: "a1", role: "assistant", content: [{ type: "tool_use", id: "call-1" }] },
			{ id: "u1", role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] },
		];
		assert.deepEqual(segmentBounds(messages), [[0, 1]]);
	});
	test("dsh-native shape: tool-call blocks and role:'tool' results stay atomic", () => {
		// The shape actually captured from the host (c74 session): assistant
		// content block {type:'tool-call', id}, result is a role:'tool' message
		// carrying toolCallId. Pre-fix the call read as a plain message and
		// segmentBounds split it from its result.
		const messages = [
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool-call", id: "c1" }] },
			{ id: "t1", role: "tool", toolCallId: "c1", content: [{ type: "text", text: "result" }] },
			{ id: "u1", role: "user", content: "next" },
		];
		assert.deepEqual(segmentBounds(messages), [[0, 1], [2, 2]]);
		assert.equal(rangeIsSegmentAligned(messages, 0, 0), false, "a range ending on the assistant call cuts the pair");
		assert.equal(rangeIsSegmentAligned(messages, 0, 1), true);
		// A multi-call step with several consecutive results is ONE segment.
		const multi = [
			{ id: "a2", role: "assistant", content: [{ type: "tool-call", id: "c1" }, { type: "tool-call", id: "c2" }] },
			{ id: "t2", role: "tool", toolCallId: "c1", content: [{ type: "text", text: "r1" }] },
			{ id: "t3", role: "tool", toolCallId: "c2", content: [{ type: "text", text: "r2" }] },
		];
		assert.deepEqual(segmentBounds(multi), [[0, 2]]);
	});
	test("a fold range that would split a pair is rejected by alignment check", () => {
		const messages = pairMessages();
		assert.equal(rangeIsSegmentAligned(messages, 0, 2), false); // cuts between assistant and its 2nd tool result
		assert.equal(rangeIsSegmentAligned(messages, 1, 3), true);
	});
	test("summaryMessageOf keeps the synthetic message shape", () => {
		const block = { id: "b7", summary: "hello" };
		assert.deepEqual(summaryMessageOf(block), { id: "acp_summary_b7", role: "user", content: [{ type: "text", text: "[SWITCHMAN:TRIM] hello" }] });
	});
});

describe("state: ledger store", () => {
	test("commit + persistence round-trip", () => {
		const dir = mkdtempSync(join(tmpdir(), "trim-test-"));
		try {
			const store = createStore({ stateDir: join(dir, "trim") });
			const messages = makeMessages(20);
			const first = store.commitFold("sess-1", blockFor(messages, 0, 9, "round trip"), refPositions(messages));
			assert.equal(first.ok, true);
			store.recordFoldBaseline("sess-1", 12345);
			// new store instance = fresh read from disk
			const store2 = createStore({ stateDir: join(dir, "trim") });
			const ledger = store2.ledgerOf("sess-1");
			assert.equal(ledger.blocks.length, 1);
			assert.equal(ledger.blocks[0].summary, "round trip");
			assert.equal(ledger.lastFoldViewTokens, 12345);
			assert.equal(ledger.frontier, blockFor(messages, 0, 9).refRange.lastId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("corrupt file resets the ledger and is moved aside", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trim-test-"));
		try {
			const fsMod = await import("node:fs");
			const file = join(dir, "trim", "sess-2.json");
			fsMod.mkdirSync(join(dir, "trim"), { recursive: true });
			fsMod.writeFileSync(file, "{ this is not json");
			const store = createStore({ stateDir: join(dir, "trim"), warn: () => {} });
			const ledger = store.ledgerOf("sess-2");
			assert.equal(ledger.blocks.length, 0);
			assert.equal(existsSync(file), false); // moved to .corrupt
			assert.equal(existsSync(`${file}.corrupt`), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("monotonic frontier: overlap with an existing fold is rejected", () => {
		const dir = mkdtempSync(join(tmpdir(), "trim-test-"));
		try {
			const store = createStore({ stateDir: join(dir, "trim") });
			const messages = makeMessages(30);
			assert.equal(store.commitFold("s3", blockFor(messages, 0, 9), refPositions(messages)).ok, true);
			const overlap = store.commitFold("s3", blockFor(messages, 5, 14), refPositions(messages));
			assert.equal(overlap.ok, false);
			assert.match(overlap.reason, /overlap|duplicate/u);
			const forward = store.commitFold("s3", blockFor(messages, 10, 19), refPositions(messages));
			assert.equal(forward.ok, true);
			const ledger = store.ledgerOf("s3");
			assert.equal(ledger.blocks.length, 2);
			assert.equal(ledger.frontier, refOf(messages[19], 19));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("duplicate range rejected; count mismatch rejected; invalid block rejected", () => {
		const dir = mkdtempSync(join(tmpdir(), "trim-test-"));
		try {
			const store = createStore({ stateDir: join(dir, "trim") });
			const messages = makeMessages(20);
			const block = blockFor(messages, 0, 9);
			assert.equal(store.commitFold("s4", block, refPositions(messages)).ok, true);
			assert.equal(store.commitFold("s4", blockFor(messages, 0, 9), refPositions(messages)).ok, false);
			const lied = blockFor(messages, 10, 14);
			lied.count = 3;
			const rejected = store.commitFold("s4", lied, refPositions(messages));
			assert.equal(rejected.ok, false);
			assert.equal(rejected.reason, "count-mismatch");
			assert.equal(store.commitFold("s4", { refRange: { firstId: "a", lastId: "b" } }, refPositions(messages)).ok, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("normalizeBlock defaults and validation", () => {
		const now = 1_000;
		assert.equal(normalizeBlock(null, now), null);
		assert.equal(normalizeBlock({ refRange: { firstId: "a", lastId: "b" }, count: 1 }, now), null); // no summary
		const ok = normalizeBlock({ refRange: { firstId: "a", lastId: "b" }, count: 2, summary: " text " }, now);
		assert.equal(ok.summary, "text");
		assert.equal(ok.kind, "summary");
		assert.equal(ok.tier, 1, "legacy tier strings normalize to the T1 numeric tier");
		assert.equal(ok.active, true);
		assert.deepEqual(ok.consumes, []);
		assert.equal(ok.createdAt, now);
		assert.equal(normalizeBlock({ refRange: { firstId: "a", lastId: "b" }, count: 2, summary: "x", tier: "emergency" }, now).tier, 1);
		assert.equal(normalizeBlock({ consumes: ["b1"], summary: "x", tier: 2 }, now), null, "ladder candidates take the commit path, not this normalizer");
	});

	test("emptyLedger shape", () => {
		const ledger = emptyLedger("sx");
		assert.deepEqual(ledger, { version: 2, sessionId: "sx", blocks: [], frontier: null, lastFoldViewTokens: 0, lastFoldLowTokens: 0, lastFoldAt: 0, foldsThisHour: [], inheritedFrom: null, inheritedAt: 0 });
	});
});

describe("trigger: tiers and gates", () => {
	const base = {
		// Fattened so the 50k-token increment gate trips even with the
		// task-intent line excluded: ~33 folded messages x ~1525 tokens
		// each ≈ 50.3k >= 50k.
		messages: makeMessages(40).map((m, i) => ({ ...m, content: [{ type: "text", text: "g".repeat(6100) + "-" + i }] })),
		viewTokens: 100_000,
		windowTokens: 200_000, // 50% usage
		thresholds: { growthTokens: 22_500, incrementTokens: 50_000, pressurePercent: 75, emergencyPercent: 95, maxFoldsPerHour: 6 },
		now: 1_000_000,
		lastFoldAt: 0,
		foldsThisHour: [],
		lastEmergencyAt: 0,
		ledger: { lastFoldViewTokens: 0 },
	};
	function foldable(messages = base.messages) {
		return computeFoldableRange(messages, { frontier: null }, 6);
	}

	test("computeFoldableRange respects frontier, task-intent protection, and protected tail", () => {
		const messages = makeMessages(20);
		// The first user message (task intent) is protected: the range starts
		// after it (docs/ladder-fold.md).
		assert.deepEqual(computeFoldableRange(messages, null, 6), { startIdx: 1, endIdx: 13 });
		const frontierLedger = { frontier: refOf(messages[9], 9) };
		assert.deepEqual(computeFoldableRange(messages, frontierLedger, 6), { startIdx: 10, endIdx: 13 });
		assert.equal(computeFoldableRange(makeMessages(5), null, 6), null); // tail covers all
	});

	test("computeFoldableRange never starts at a leading system message", () => {
		const messages = [{ role: "system", content: [{ type: "text", text: "system prompt" }] }, ...makeMessages(20)];
		// frontier null (the first fold): the system head must stay out
		const nullFrontier = computeFoldableRange(messages, null, 6);
		assert.ok(nullFrontier !== null);
		assert.ok(nullFrontier.startIdx >= 1, `startIdx ${nullFrontier.startIdx} covers the system head`);
		// frontier ON the system head itself: still clamped past it
		const headFrontier = computeFoldableRange(messages, { frontier: refOf(messages[0], 0) }, 6);
		assert.ok(headFrontier === null || headFrontier.startIdx >= 1);
		// a frontier already past the head is untouched by the clamp
		const mid = computeFoldableRange(messages, { frontier: refOf(messages[4], 4) }, 6);
		assert.deepEqual(mid, { startIdx: 5, endIdx: 14 });
		// no leading system message: only the task-intent line protects index 0
		assert.deepEqual(computeFoldableRange(makeMessages(20), null, 6), { startIdx: 1, endIdx: 13 });
	});

	test("growth tier fires only above BOTH gates", () => {
		// growth 100k - 0 > 22.5k; increment of 34 msgs big enough → fold
		const fire = evaluateTrigger({ ...base, foldable: foldable() });
		assert.equal(fire.action, "fold");
		assert.equal(fire.tier, "growth");
		// small growth: below the gate
		const quiet = evaluateTrigger({ ...base, viewTokens: 20_000, foldable: foldable() });
		assert.equal(quiet.action, "none");
		// big growth but tiny increment: gate blocks
		const small = makeMessages(10);
		const tiny = evaluateTrigger({ ...base, messages: small, foldable: computeFoldableRange(small, null, 6) });
		assert.equal(tiny.action, "none");
	});

	test("growth tier stays armed after a high fold (post-fold low anchor)", () => {
		// Emergency-style fold at 140k: the pre-fold baseline is useless, the
		// post-fold low keeps the gate measuring fresh accumulation.
		const ledger = { lastFoldViewTokens: 140_000, lastFoldLowTokens: 40_000 };
		const fire = evaluateTrigger({ ...base, viewTokens: 92_000, ledger, foldable: foldable() });
		assert.equal(fire.action, "fold");
		assert.equal(fire.tier, "growth");
		// Legacy ledger without the low field: falls back to the pre-fold
		// view — the gate stays quiet and pressure picks it up instead.
		const legacy = evaluateTrigger({ ...base, viewTokens: 92_000, ledger: { lastFoldViewTokens: 140_000 }, foldable: foldable() });
		assert.equal(legacy.action, "none");
		assert.equal(legacy.reason, "below-thresholds");
	});

	test("pressure tier fires at 75% and outranks growth", () => {
		const fire = evaluateTrigger({ ...base, viewTokens: 160_000, foldable: foldable() }); // 80%
		assert.equal(fire.action, "fold");
		assert.equal(fire.tier, "pressure");
	});

	test("frontier only advances: an advisory middle-range fold must not drag it backward", () => {
	const store = createStore({ stateDir: mkdtempSync(join(tmpdir(), "frontier-")) });
	const messages = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: "user", content: [{ type: "text", text: `m${i} ` + "x".repeat(40) }] }));
	const positions = refPositions(messages);
	// engine folds the tail range first (frontier = m10)
	const tail = store.commitFold("s", { refRange: { firstId: "m8", lastId: "m10" }, count: 3, approxTokens: 300, summary: "tail fold", tier: 1 }, positions);
	assert.ok(tail.ok);
	assert.equal(store.ledgerOf("s").frontier, "m10");
	// advisory folds a MIDDLE range before the frontier
	const middle = store.commitFold("s", { refRange: { firstId: "m1", lastId: "m3" }, count: 3, approxTokens: 300, summary: "middle fold", tier: 1 }, positions);
	assert.ok(middle.ok, "middle range is disjoint and legal");
	assert.equal(store.ledgerOf("s").frontier, "m10", "frontier must not regress to m3");
	// computeFoldableRange still starts after the frontier (not after m3)
	const foldable = computeFoldableRange(messages, store.ledgerOf("s"), 1);
	assert.ok(foldable === null || foldable.startIdx > 10, "foldable span must stay ahead of the frontier");
});

test("emergency tier fires at 95%, mechanical path, cooldown-gated", () => {
		const fire = evaluateTrigger({ ...base, viewTokens: 195_000, foldable: foldable() }); // 97.5%
		assert.equal(fire.action, "emergency");
		assert.equal(fire.tier, "emergency");
		const cooled = evaluateTrigger({ ...base, viewTokens: 195_000, lastEmergencyAt: base.now - EMERGENCY_COOLDOWN_MS + 1_000, foldable: foldable() });
		assert.equal(cooled.action, "none");
		const recovered = evaluateTrigger({ ...base, viewTokens: 195_000, lastEmergencyAt: base.now - EMERGENCY_COOLDOWN_MS - 1_000, foldable: foldable() });
		assert.equal(recovered.action, "emergency");
	});

	test("cadence: hourly cap and min interval block side-model folds", () => {
		const capped = evaluateTrigger({ ...base, foldsThisHour: [base.now - 1, base.now - 2, base.now - 3, base.now - 4, base.now - 5, base.now - 6], foldable: foldable() });
		assert.equal(capped.action, "none");
		const recent = evaluateTrigger({ ...base, lastFoldAt: base.now - 1_000, foldable: foldable() }); // 1s ago < 60s min
		assert.equal(recent.action, "none");
		assert.equal(FOLD_MIN_INTERVAL_MS >= 60_000, true);
	});

	test("unknown window keeps emergency/pressure off but growth still works", () => {
		const noWindow = evaluateTrigger({ ...base, windowTokens: null, viewTokens: 100_000, foldable: foldable() });
		assert.equal(noWindow.action, "fold");
		assert.equal(noWindow.tier, "growth");
	});

	test("nothing foldable → none", () => {
		assert.equal(evaluateTrigger({ ...base, foldable: null }).action, "none");
	});
});

describe("metrics: stream wrapping and usage extraction", () => {
	test("extractUsage reads common provider shapes", () => {
		assert.deepEqual(extractUsage({ type: "finish", usage: { input_tokens: 100, output_tokens: 5 } }), { inputTokens: 100, cachedTokens: null, cacheWriteTokens: null, outputTokens: 5 });
		assert.deepEqual(extractUsage({ usage: { prompt_tokens: 70, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } } }), { inputTokens: 70, cachedTokens: 40, cacheWriteTokens: null, outputTokens: 3 });
		// Host TokenUsage shape: camelCase buckets, inputTokens = UNCACHED prompt.
		assert.deepEqual(extractUsage({ type: "usage", usage: { inputTokens: 900, cacheReadTokens: 60_000, cacheWriteTokens: 500, outputTokens: 100 } }), { inputTokens: 900, cachedTokens: 60_000, cacheWriteTokens: 500, outputTokens: 100 });
		assert.equal(extractUsage({ type: "text-delta", text: "hi" }), null);
	});

	test("promptTokensOf totals the non-overlapping host buckets", () => {
		const metrics = createMetrics();
		assert.equal(promptTokensOf(null), null);
		assert.equal(promptTokensOf(metrics.of("ghost")), null, "never streamed → no wire signal");
		metrics.recordUsage("s1", { inputTokens: 900, cachedTokens: 60_000, cacheWriteTokens: 500, outputTokens: 100 });
		assert.equal(promptTokensOf(metrics.of("s1")), 61_400);
		// Missing cache buckets count as 0, and a fully cached prompt (0
		// uncached) still reports the cache total.
		metrics.recordUsage("s2", { inputTokens: 0, cachedTokens: 5_000, outputTokens: 1 });
		assert.equal(promptTokensOf(metrics.of("s2")), 5_000);
		metrics.recordUsage("s3", { inputTokens: 1_200, outputTokens: 1 });
		assert.equal(promptTokensOf(metrics.of("s3")), 1_200);
	});

	test("wrapped stream yields every chunk; sampler errors are swallowed", () => {
		async function* inner() {
			yield { type: "text-delta", text: "a" };
			yield { type: "finish", usage: { input_tokens: 9 } };
		}
		let seen = 0;
		async function run() {
			const wrapped = wrapStreamForMetrics(inner(), () => {
				seen += 1;
				if (seen === 1) throw new Error("sampler boom");
			});
			const chunks = [];
			for await (const chunk of wrapped) chunks.push(chunk);
			return chunks;
		}
		return run().then((chunks) => {
			assert.equal(chunks.length, 2);
			assert.equal(seen, 2);
		});
	});

	test("non-iterable results pass through untouched", () => {
		const weird = { hello: true };
		assert.equal(wrapStreamForMetrics(weird, () => {}), weird);
		assert.equal(wrapStreamForMetrics(null, () => {}), null);
	});

	test("per-session record accumulates view + usage", () => {
		const metrics = createMetrics();
		metrics.noteView("s1", 12_345, { provider: "p", model: "m" });
		metrics.recordUsage("s1", { inputTokens: 100, cachedTokens: 50, outputTokens: 7 });
		const record = metrics.of("s1");
		assert.equal(record.viewTokens, 12_345);
		assert.equal(record.lastInputTokens, 100);
		assert.equal(record.cachedTokens, 50);
		assert.equal(record.lastModel.model, "m");
		assert.equal(metrics.of("ghost"), null);
	});
});

describe("summarizer: material render and mechanical fallback", () => {
	test("renderMaterial stamps refs and roles deterministically", () => {
		const messages = makeMessages(6);
		const one = renderMaterial(messages, 0, 5, refOf);
		const two = renderMaterial(messages, 0, 5, refOf);
		assert.equal(one, two);
		assert.match(one, /--- \[m[^\]]+\] \(user\) ---/u);
		assert.match(one, /message 0 seed 0/u);
	});

	test("renderMaterial truncates beyond the cap", () => {
		const messages = [{ role: "user", content: "y".repeat(MAX_MATERIAL_CHARS + 10) }];
		const material = renderMaterial(messages, 0, 0, refOf);
		assert.match(material, /truncated/u);
		assert.ok(material.length < MAX_MATERIAL_CHARS + 200);
	});

	test("mechanicalSummary lists refs with heads", () => {
		const messages = makeMessages(4);
		const summary = mechanicalSummary(messages, 0, 3, refOf);
		assert.match(summary, /Mechanical fold of 4 messages/u);
		assert.match(summary, /\[m/u);
		assert.match(summary, /message 0 seed 0/u);
	});

	test("prompt carries the carry-forward rules", () => {
		assert.match(SUMMARY_SYSTEM_PROMPT, /Open objectives/u);
		assert.match(SUMMARY_SYSTEM_PROMPT, /line numbers/u);
	});
});

describe("model visibility", () => {
	test("the trim layer registers no systemPrompt context (numbers never reach the model)", () => {
		const { ctx, contexts } = mockCtxSimple();
		applyContextTrim(ctx, { trimEnabled: true, trimMode: "auto" });
		assert.equal(contexts.length, 0, "no model-visible trim context is registered");
	});
	test("the protocol head stays digit-free and states the no-numbers policy", () => {
		assert.match(TRIM_PROTOCOL_TEXT, /\[SWITCHMAN:TRIM\]/u);
		assert.doesNotMatch(TRIM_PROTOCOL_TEXT, /\d/u);
		assert.match(TRIM_PROTOCOL_TEXT, /never reports sizes, percentages, or progress/u);
	});
	test("window cap composes as min(resolved, cap)", () => {
		assert.equal(effectiveWindowTokens(512_000, 150_000), 150_000);
		assert.equal(effectiveWindowTokens(128_000, 150_000), 128_000);
		assert.equal(effectiveWindowTokens(null, 150_000), 150_000);
		assert.equal(effectiveWindowTokens(200_000, null), 200_000);
		assert.equal(effectiveWindowTokens(null, null), null);
		assert.equal(effectiveWindowTokens(0, 0), null);
		assert.equal(effectiveWindowTokens(-5, 150_000), 150_000);
	});
});

/** Minimal one-shot ctx for registration-shape tests. */
function mockCtxSimple() {
	const sections = [];
	const contexts = [];
	const ctx = {
		log: { warn: () => {} },
		agents: { currentInitiator: () => null },
		systemPrompt: {
			section: (s) => sections.push(s),
			context: (c) => contexts.push(c),
		},
		on: () => {},
		tools: { register: () => {} },
		get: () => null,
		inject: () => {},
	};
	return { ctx, sections, contexts };
}

describe("assembly: applyContextTrim with a mock ctx", () => {
	/** Minimal mock of the host surface (intent-layer test pattern). */
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
		trimGrowthTokens: 22_500,
		trimIncrementTokens: 50_000,
		trimPressurePercent: 75,
		trimEmergencyPercent: 95,
		trimProtectedTail: 6,
		trimMaxFoldsPerHour: 6,
		trimSideModel: { provider: "", model: "" },
		trimStateDir: mkdtempSync(join(tmpdir(), "trim-live-")),
	};

	test("registers the prompt section, tools, and the llm listener — and NO model-visible context", () => {
		const mounted = [];
		const { ctx, sections, contexts, hooks, registeredTools, injects } = mockCtx({
			llmFiber: { on: (event, fn) => mounted.push([event, fn]), off: () => {}, effect: () => {} },
		});
		applyContextTrim(ctx, config);
		assert.equal(sections.length, 1);
		assert.equal(sections[0].name, "switchman:trim");
		assert.equal(sections[0].text(), TRIM_PROTOCOL_TEXT);
		// Model-invisibility invariant (docs/ladder-fold.md): no context
		// registration — water levels and progress numbers never reach the
		// model; the human reads decisions.log and the client badge.
		assert.equal(contexts.length, 0);
		assert.equal(typeof hooks["agent/status"], "function");
		assert.ok(registeredTools.some((t) => t.name === "ctx_trim_status"));
		assert.ok(registeredTools.some((t) => t.name === "ctx_trim_fold"));
		assert.equal(injects.length, 1);
		assert.deepEqual(injects[0].deps, ["llm"]);
		assert.equal(mounted.length, 1);
		assert.equal(mounted[0][0], "llm/stream");
	});

	test("listener folds the view in place and ALWAYS calls next(); usage sampled", async () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx } = mockCtx({ llmFiber: fiber });
		const handle = applyContextTrim(ctx, config);
		assert.notEqual(listener, null);

		async function* innerStream() {
			yield { type: "finish", usage: { input_tokens: 4321 } };
		}
		let called = false;
		const next = () => {
			called = true;
			return innerStream();
		};

		// First call: prime the capture (fold ledger still empty).
		const messages = makeMessages(20);
		const result = listener({ sessionId: "sess-live", messages, provider: "p", model: "m" }, next);
		assert.equal(called, true, "next must be called on the very first request");
		for await (const chunk of result) void chunk;
		const capture = handle.captures.get("sess-live");
		assert.notEqual(capture, undefined);

		// Commit a fold (as the idle hook would).
		const commit = handle.store.commitFold("sess-live", blockFor(capture.messages, 0, 9, "committed fold"), refPositions(capture.messages));
		assert.equal(commit.ok, true);

		// Second call: the view replaces the folded range IN PLACE.
		const request2 = { sessionId: "sess-live", messages: makeMessages(20), provider: "p", model: "m" };
		called = false;
		const result2 = listener(request2, next);
		assert.equal(called, true);
		assert.equal(request2.messages.length, 11); // 10 folded → 1 synthetic + 10 tail
		assert.match(request2.messages[0].content[0].text, /\[SWITCHMAN:TRIM\] committed fold/u);
		for await (const chunk of result2) void chunk;
		assert.equal(handle.metrics.of("sess-live").lastInputTokens, 4321);
	});

	test("failing view build still calls next() (fail-open)", () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx } = mockCtx({ llmFiber: fiber });
		applyContextTrim(ctx, config);
		const request = { sessionId: "sess-x", messages: "not-an-array", provider: "p", model: "m" };
		let called = false;
		const result = listener(request, () => {
			called = true;
			return "passthrough";
		});
		assert.equal(called, true);
		assert.equal(result, "passthrough");
	});

	test("idle hook runs a full mechanical emergency fold (no model call)", async () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx } = mockCtx({ llmFiber: fiber });
		// llm service: window resolves to 100k; prepareCall explodes — the
		// emergency path must never need it (mechanical), pressure/growth
		// paths just skip their fold on failure.
		ctx.get = () => ({
			resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
			prepareCall: async () => {
				throw new Error("model unavailable");
			},
		});
		const stateDir = mkdtempSync(join(tmpdir(), "trim-asm-"));
		const handle = applyContextTrim(ctx, { ...config, trimEmergencyPercent: 51, trimStateDir: stateDir });

		// Prime the capture at ~60% of the 100k window (60 × ~1000 tokens).
		const heavy = makeMessages(60, 11);
		for (const m of heavy) m.content[0].text = "H".repeat(4_000); // chars/4 ≈ 1000 tokens each
		listener({ sessionId: "sess-heavy", messages: heavy, provider: "p", model: "m" }, () => null);
		// The stream path now fires its own throttled fallback check — drain it.
		await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

		// Fire the idle hook (same entry the agent/status listener uses). The
		// fold already committed on the stream path; this run hits the cooldown.
		await handle.maybeFold("sess-heavy");
		const ledger = handle.store.ledgerOf("sess-heavy");
		assert.equal(ledger.blocks.length, 1);
		assert.equal(ledger.blocks[0].kind, "mechanical");
		assert.match(ledger.blocks[0].summary, /Mechanical fold/u);

		// Second idle run: cooldown blocks an immediate second emergency fold.
		await handle.maybeFold("sess-heavy");
		assert.equal(handle.store.ledgerOf("sess-heavy").blocks.length, 1);

		// And the committed fold actually reshapes the next request view.
		const request = { sessionId: "sess-heavy", messages: makeMessages(60, 11), provider: "p", model: "m" };
		for (const m of request.messages) m.content[0].text = "H".repeat(4_000);
		let called = false;
		async function* empty() {}
		const result = listener(request, () => {
			called = true;
			return empty();
		});
		assert.equal(called, true);
		assert.ok(request.messages.length < 60); // folded view applied in place
		for await (const chunk of result) void chunk;
	});

	test("agent/status with OBJECT payload.agent fires the emergency fold (B2)", async () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx, hooks } = mockCtx({ llmFiber: fiber });
		ctx.get = () => ({
			resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
			prepareCall: async () => {
				throw new Error("model unavailable");
			},
		});
		const stateDir = mkdtempSync(join(tmpdir(), "trim-asm-obj-"));
		const handle = applyContextTrim(ctx, { ...config, trimEmergencyPercent: 51, trimStateDir: stateDir });
		const heavy = makeMessages(60, 12);
		for (const m of heavy) m.content[0].text = "H".repeat(4_000);
		listener({ sessionId: "sess-obj", messages: heavy, provider: "p", model: "m" }, () => null);
		// Production payload shape: payload.agent is the agent OBJECT.
		hooks["agent/status"]({ status: "idle", agent: { session: { id: "sess-obj" } } });
		for (let i = 0; i < 200 && handle.store.ledgerOf("sess-obj").blocks.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(handle.store.ledgerOf("sess-obj").blocks.length, 1, "auto fold must fire from the object payload");
	});

	test("capture stays RAW: a second fold still applies after the first (B1)", async () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx, registeredTools, setSessionId } = mockCtx({ llmFiber: fiber });
		const stateDir = mkdtempSync(join(tmpdir(), "trim-asm-raw-"));
		const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
		setSessionId("sess-raw");
		async function* empty() {}
		const send = () => {
			const messages = [];
			for (let i = 0; i < 30; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `raw ${i} ${"y".repeat(80)}` }] });
			const request = { sessionId: "sess-raw", messages, provider: "p", model: "m" };
			listener(request, () => empty());
			return request;
		};
		send(); // prime the capture
		const foldTool = registeredTools.find((t) => t.name === "ctx_trim_fold");
		const cap1 = handle.captures.get("sess-raw").messages;
		const first = await foldTool.execute({ firstId: refOf(cap1[0], 0), lastId: refOf(cap1[9], 9), count: 10, summary: "first fold" });
		assert.match(first, /Folded 10 messages/u);
		// Host fact: every llm/stream call rebuilds a FRESH raw array.
		const second = send();
		assert.equal(second.messages.length, 21, "fold #1 must apply to the outbound view");
		const cap2 = handle.captures.get("sess-raw").messages;
		assert.equal(cap2.length, 30, "capture must stay RAW (not the folded view)");
		const secondFold = await foldTool.execute({ firstId: refOf(cap2[10], 10), lastId: refOf(cap2[19], 19), count: 10, summary: "second fold" });
		assert.match(secondFold, /Folded 10 messages/u);
		const third = send();
		assert.equal(third.messages.length, 12, "both folds apply: 30 - 20 + 2 synthetics");
	});

	test("ctx_trim_fold rejects a range that splits a tool pair (M2)", async () => {
		let listener = null;
		const fiber = { on: (event, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx, registeredTools, setSessionId } = mockCtx({ llmFiber: fiber });
		const stateDir = mkdtempSync(join(tmpdir(), "trim-asm-pair-"));
		const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
		setSessionId("sess-pair");
		const messages = [
			{ role: "user", content: "q" },
			{ id: "a-1", role: "assistant", content: "t", tool_calls: [{ id: "c-1", function: { name: "read", arguments: "{}" } }] },
			{ id: "t-1", role: "tool", tool_call_id: "c-1", content: "out" },
			{ role: "user", content: "next" },
			{ role: "assistant", content: "a" },
		];
		for (let i = 0; i < 6; i++) messages.push({ role: "user", content: `filler ${i}` });
		listener({ sessionId: "sess-pair", messages, provider: "p", model: "m" }, () => null);
		const foldTool = registeredTools.find((t) => t.name === "ctx_trim_fold");
		const cap = handle.captures.get("sess-pair").messages;
		const rejected = await foldTool.execute({ firstId: refOf(cap[0], 0), lastId: refOf(cap[1], 1), count: 2, summary: "bad split" });
		assert.match(rejected, /splits a tool-call pair/u);
		assert.equal(handle.store.ledgerOf("sess-pair").blocks.length, 0);
		// Defense in depth: buildView also refuses to apply such a block.
		const ledger = emptyLedger("sess-pair-view");
		ledger.blocks.push({ refRange: { firstId: refOf(cap[0], 0), lastId: refOf(cap[1], 1) }, count: 2, approxTokens: 4, summary: "bad", kind: "summary", tier: "model" });
		assert.equal(buildView(cap, ledger, { protectedTail: 0 }).applied, 0);
	});
	test("host-compaction epoch boundary re-anchors the growth baseline once per epoch", async () => {
		let listener = null;
		const fiber = { on: (e, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx } = mockCtx({ llmFiber: fiber });
		const handle = applyContextTrim(ctx, config);
		const finish = async function* () { yield { type: "finish", usage: { input_tokens: 10 } }; };
		const r1 = listener({ sessionId: "sess-epoch", messages: makeMessages(20), provider: "p", model: "m" }, finish);
		for await (const c of r1) void c;
		const capture = handle.captures.get("sess-epoch");
		assert.equal(handle.store.commitFold("sess-epoch", blockFor(capture.messages, 0, 9, "epoch fold"), refPositions(capture.messages)).ok, true);
		handle.store.recordFoldBaseline("sess-epoch", 91_500, 9_136);
		// Host compaction replaced history: every block fails to locate → reset once.
		const r2 = listener({ sessionId: "sess-epoch", messages: makeMessages(20, 7), provider: "p", model: "m" }, finish);
		for await (const c of r2) void c;
		const ledger = handle.store.ledgerOf("sess-epoch");
		assert.notEqual(ledger.lastFoldViewTokens, 91_500);
		assert.equal(ledger.lastFoldLowTokens, ledger.lastFoldViewTokens);
		// Flag consumed: a second stale dispatch in the same epoch does NOT reset again.
		const r3 = listener({ sessionId: "sess-epoch", messages: makeMessages(20, 11), provider: "p", model: "m" }, finish);
		for await (const c of r3) void c;
		assert.equal(handle.store.ledgerOf("sess-epoch").lastFoldViewTokens, ledger.lastFoldViewTokens);
	});

	test("epoch reset is suppressed while a fold cycle is in flight (span self-dispatch)", async () => {
		let listener = null;
		const fiber = { on: (e, fn) => { listener = fn; }, off: () => {}, effect: () => {} };
		const { ctx } = mockCtx({ llmFiber: fiber });
		const handle = applyContextTrim(ctx, config);
		const finish = async function* () { yield { type: "finish", usage: { input_tokens: 10 } }; };
		const r1 = listener({ sessionId: "sess-flight", messages: makeMessages(20), provider: "p", model: "m" }, finish);
		for await (const c of r1) void c;
		const capture = handle.captures.get("sess-flight");
		assert.equal(handle.store.commitFold("sess-flight", blockFor(capture.messages, 0, 9, "flight fold"), refPositions(capture.messages)).ok, true);
		handle.store.recordFoldBaseline("sess-flight", 91_500, 9_136);
		// The cycle's own span dispatch presents a subset array — refs all fail.
		handle.inFlight.add("sess-flight");
		const r2 = listener({ sessionId: "sess-flight", messages: makeMessages(20, 7), provider: "p", model: "m" }, finish);
		for await (const c of r2) void c;
		assert.equal(handle.store.ledgerOf("sess-flight").lastFoldViewTokens, 91_500);
		assert.equal(handle.store.ledgerOf("sess-flight").lastFoldLowTokens, 9_136);
		// Suppression must not consume the epoch flag: a real epoch still resets.
		handle.inFlight.delete("sess-flight");
		const r3 = listener({ sessionId: "sess-flight", messages: makeMessages(20, 7), provider: "p", model: "m" }, finish);
		for await (const c of r3) void c;
		const ledger = handle.store.ledgerOf("sess-flight");
		assert.notEqual(ledger.lastFoldViewTokens, 91_500);
		assert.equal(ledger.lastFoldLowTokens, ledger.lastFoldViewTokens);
	});
});

describe("regression: duplicate refs (identical content)", () => {
	test("commitFold and buildView resolve count-anchored under duplicate refs", () => {
		const dir = mkdtempSync(join(tmpdir(), "trim-dup-"));
		try {
			const store = createStore({ stateDir: join(dir, "trim") });
			// 60 identical-content messages — every same-role ref collides.
			const messages = [];
			for (let i = 0; i < 60; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "H".repeat(4_000) }] });
			const positions = refPositions(messages);
			const block = { refRange: { firstId: refOf(messages[0], 0), lastId: refOf(messages[3], 3) }, count: 4, approxTokens: 4_000, summary: "dup fold", kind: "mechanical", tier: "emergency" };
			const commit = store.commitFold("sess-dup", block, positions);
			assert.equal(commit.ok, true, "count-anchored resolution must accept the dup-ref range");
			const view = buildView(messages, store.ledgerOf("sess-dup"), { protectedTail: 6 });
			assert.equal(view.applied, 1);
			assert.equal(view.messages.length, 60 - 4 + 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test('ledger round-trip preserves lastFoldLowTokens across reload', () => {
	const dir = mkdtempSync(join(tmpdir(), 'trim-test-'));
	const store = createStore({ stateDir: join(dir, 'trim') });
	store.recordFoldBaseline('sess-rt', 91557, 9136);
	const reloaded = createStore({ stateDir: join(dir, 'trim') }).ledgerOf('sess-rt');
	assert.equal(reloaded.lastFoldLowTokens, 9136);
	assert.equal(reloaded.lastFoldViewTokens, 91557);
});

test('summarizer: a length-finished summary is marked truncated, not silently committed (inspection S2)', async () => {
	const route = { provider: 'p', model: 'm' };
	const llmFor = (chunks) => ({
		prepareCall: async () => ({ config: {}, stream: async function* () { yield* chunks; } }),
	});
	const marked = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: 'Partial summary.' },
		{ type: 'finish', kind: 'length' },
	]), route, 'material');
	assert.ok(marked.startsWith(TRUNCATED_SUMMARY_MARK), 'length finish must carry the truncation mark');
	assert.ok(marked.includes('Partial summary.'), 'the partial text survives under the mark');
	const clean = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: 'Full summary.' },
		{ type: 'finish' },
	]), route, 'material');
	assert.equal(clean, 'Full summary.', 'a normal finish must stay unmarked');
	const stillNull = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: '   ' },
		{ type: 'finish', kind: 'length' },
	]), route, 'material');
	assert.equal(stillNull, null, 'empty output stays a failure regardless of finish kind');
});

test('summarizer: DSH-shaped max-tokens finish marks truncation; aborted finish fails closed', async () => {
	const route = { provider: 'p', model: 'm' };
	const llmFor = (chunks) => ({
		prepareCall: async () => ({ config: {}, stream: async function* () { yield* chunks; } }),
	});
	// Real adapters never emit a top-level kind: finish rides as
	// { type:'finish', reason:{kind} } with kind 'max-tokens' for cutoffs.
	const marked = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: 'Cut summary.' },
		{ type: 'finish', reason: { kind: 'max-tokens' } },
	]), route, 'material');
	assert.ok(marked.startsWith(TRUNCATED_SUMMARY_MARK), 'max-tokens finish must carry the truncation mark');
	const clean = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: 'Full summary.' },
		{ type: 'finish', reason: { kind: 'stop' } },
	]), route, 'material');
	assert.equal(clean, 'Full summary.', 'a reason.kind stop must stay unmarked');
	const aborted = await summarizeWithModel(llmFor([
		{ type: 'text-delta', text: 'Died mid-stream.' },
		{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'disposed' } } },
	]), route, 'material');
	assert.equal(aborted, null, 'an aborted finish is a failure, never a summary');
});
