/** Fork-state inheritance tests (node:test).
 *
 * Covers the copy-on-fork design in host/context-trim/fork.js:
 * - fork-links map: record/load round-trip, bad args, age prune, count cap,
 *   corrupt-file tolerance, atomic writes (no tmp leftovers), unwritable dir.
 * - resolveInheritance: the ok-path ledger shape + block independence, and
 *   every rejection reason (parent-empty / no-history / frontier-not-found).
 * - store.adoptLedger: one-shot semantics, persistence, reload survival.
 * - Full loop: parent folds commit → subagent_fork post-execute records the
 *   link → the child's first stream inherits → the child VIEW applies the
 *   parent's folds and the child ledger carries the inheritedFrom marker;
 *   double-inheritance is refused; non-matching child history starts clean;
 *   the no-link window expires then a LATE fork link re-opens it; the
 *   handover-style cross-instance link (mtime-gated reload) works; a
 *   corrupt links file degrades to a clean start; the marker survives
 *   instance reloads; post-execute passthrough leaves non-fork calls alone.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, describe } from "node:test";
import { applyContextTrim } from "../../host/context-trim/index.js";
import { createStore, emptyLedger } from "../../host/context-trim/state.js";
import { estimateTokensOf, refOf, refPositions } from "../../host/context-trim/view.js";
import { forkLinkOf, loadForkLinks, recordForkLink, resolveInheritance, trimStateDirOf, FORK_LINKS_MAX, FORK_LINKS_VERSION, INHERIT_WINDOW_MS } from "../../host/context-trim/fork.js";

/** Minimal host-ctx mock (same contract as trim-loop.test.mjs). */
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
	trimEmergencyPercent: 101, // off — inheritance tests drive folds explicitly
	trimProtectedTail: 6,
	trimMaxFoldsPerHour: 6,
	trimSideModel: { provider: "", model: "" },
	trimStateDir: "",
};

/** Deterministic id-less message list (refs hash stably across copies). */
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

/** Commit one block through the store (validates against the posMap). */
function commit(store, sessionId, messages, startIdx, endIdx, summary) {
	const result = store.commitFold(sessionId, blockFor(messages, startIdx, endIdx, summary), refPositions(messages));
	assert.equal(result.ok, true, `commitFold ${startIdx}..${endIdx} must succeed`);
	store.recordFoldBaseline(sessionId, 12_345);
	return result.block;
}

/** Attach the llm/stream listener through the mock host. */
function setupTrim(t, stateDir) {
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	const { ctx, hooks, setSessionId } = mockCtx({ llmFiber: fiber });
	const handle = applyContextTrim(ctx, { ...config, trimStateDir: stateDir });
	return { handle, listener, hooks, setSessionId };
}

/** Run one stream call through the listener (drains the stream). */
async function streamOnce(listener, sessionId, messages) {
	const stream = listener({ sessionId, messages, provider: "p", model: "m" }, async function* () {
		yield { type: "finish", usage: { input_tokens: 1 } };
	});
	for await (const chunk of stream) void chunk;
	return messages;
}

describe("fork-links map", () => {
	test("record + load round-trip; re-record overwrites; forkLinkOf reads entries", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-links-"));
		const seen = [];
		assert.equal(recordForkLink("p1", "c1", { stateDir, warn: (m) => seen.push(m), now: 1_000 }), true);
		assert.equal(recordForkLink("p2", "c1", { stateDir, now: 2_000 }), true, "re-recording a child re-parents the link");
		const map = loadForkLinks(stateDir);
		assert.equal(map.version, FORK_LINKS_VERSION);
		assert.deepEqual(forkLinkOf(map, "c1"), { parent: "p2", at: 2_000 });
		assert.equal(forkLinkOf(map, "missing"), null);
		assert.equal(forkLinkOf(null, "c1"), null);
		assert.deepEqual(seen, [], "no warnings on the happy path");
	});

	test("bad args rejected without writing a file", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-bad-"));
		assert.equal(recordForkLink("", "c", { stateDir }), false);
		assert.equal(recordForkLink("p", "", { stateDir }), false);
		assert.equal(recordForkLink("same", "same", { stateDir }), false);
		assert.equal(existsSync(join(stateDir, "fork-links.json")), false, "no file for rejected links");
	});

	test("entries older than the max age are pruned on write", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-prune-"));
		writeFileSync(join(stateDir, "fork-links.json"), JSON.stringify({ version: FORK_LINKS_VERSION, links: { old: { parent: "p", at: 1 }, keep: { parent: "p", at: 11 } } }));
		assert.equal(recordForkLink("p", "fresh", { stateDir, now: 10 + 30 * 24 * 3_600_000 }), true);
		const map = loadForkLinks(stateDir);
		assert.equal(map.links.old, undefined, "over-age entry pruned");
		assert.notEqual(map.links.keep, undefined, "borderline entry kept (age just under max)");
		assert.notEqual(map.links.fresh, undefined);
	});

	test("map is capped at FORK_LINKS_MAX with the oldest entries dropped", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-cap-"));
		for (let i = 0; i < FORK_LINKS_MAX; i++) assert.equal(recordForkLink("p", `c${i}`, { stateDir, now: i + 1 }), true);
		assert.equal(recordForkLink("p", "c-newest", { stateDir, now: FORK_LINKS_MAX + 1 }), true);
		const map = loadForkLinks(stateDir);
		assert.equal(Object.keys(map.links).length, FORK_LINKS_MAX);
		assert.equal(map.links.c0, undefined, "oldest dropped");
		assert.notEqual(map.links.c1, undefined);
		assert.notEqual(map.links["c-newest"], undefined);
	});

	test("corrupt links file is tolerated on load and repaired on record", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-corrupt-"));
		writeFileSync(join(stateDir, "fork-links.json"), "{not json");
		const seen = [];
		const map = loadForkLinks(stateDir, (m) => seen.push(m));
		assert.deepEqual(map.links, {});
		assert.equal(seen.length, 1, "one warning for the corrupt map");
		assert.equal(recordForkLink("p", "c", { stateDir }), true, "recording repairs the file");
		assert.notEqual(loadForkLinks(stateDir).links.c, undefined);
		// Wrong-shape entries are skipped individually.
		writeFileSync(join(stateDir, "fork-links.json"), JSON.stringify({ version: FORK_LINKS_VERSION, links: { bad: { nope: 1 }, good: { parent: "p", at: 5 } } }));
		const partial = loadForkLinks(stateDir);
		assert.equal(partial.links.bad, undefined);
		assert.deepEqual(partial.links.good, { parent: "p", at: 5 });
	});

	test("record is atomic — no tmp leftover, file parses", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-tmp-"));
		recordForkLink("p", "c", { stateDir });
		assert.equal(existsSync(join(stateDir, "fork-links.json.tmp")), false);
		assert.doesNotThrow(() => JSON.parse(readFileSync(join(stateDir, "fork-links.json"), "utf8")));
	});

	test("unwritable state dir degrades to false + warning, never throws", () => {
		const blocker = mkdtempSync(join(tmpdir(), "trim-fork-blocker-"));
		const stateDir = join(blocker, "file-not-dir"); // mkdir will fail: parent path component is a file
		writeFileSync(stateDir, "occupied");
		const seen = [];
		assert.equal(recordForkLink("p", "c", { stateDir, warn: (m) => seen.push(m) }), false);
		assert.equal(seen.length, 1);
	});

	test("trimStateDirOf reads plain strings and {get()} accessors", () => {
		assert.equal(trimStateDirOf({ trimStateDir: "/tmp/x" }), "/tmp/x");
		assert.equal(trimStateDirOf({ trimStateDir: { get: () => "/tmp/y" } }), "/tmp/y");
		assert.equal(trimStateDirOf({ trimStateDir: { get: () => { throw new Error("no"); } } }), null);
		assert.equal(trimStateDirOf({}), null);
		assert.equal(trimStateDirOf(null), null);
	});
});

describe("resolveInheritance", () => {
	function parentLedgerOf() {
		const ledger = emptyLedger("parent-1");
		const messages = makeMessages(20);
		ledger.blocks.push({ ...blockFor(messages, 0, 4, "A"), id: "b1", createdAt: 111 });
		ledger.blocks.push({ ...blockFor(messages, 8, 12, "B"), id: "b2", createdAt: 222 });
		ledger.frontier = ledger.blocks[1].refRange.lastId;
		ledger.lastFoldViewTokens = 9_000;
		ledger.lastFoldLowTokens = 4_000;
		ledger.lastFoldAt = 333;
		ledger.foldsThisHour = [222, 333];
		return { ledger, messages };
	}

	test("ok path: child ledger clones the parent state with the marker set", () => {
		const { ledger: parent, messages } = parentLedgerOf();
		const childMessages = [...structuredClone(messages), { role: "user", content: [{ type: "text", text: "extra one" }] }, { role: "assistant", content: [{ type: "text", text: "extra two" }] }];
		const outcome = resolveInheritance(parent, "parent-1", "child-1", childMessages, 77_000);
		assert.equal(outcome.ok, true);
		const ledger = outcome.ledger;
		assert.equal(ledger.version, 2);
		assert.equal(ledger.sessionId, "child-1");
		assert.equal(ledger.frontier, parent.frontier, "frontier carried verbatim");
		assert.equal(ledger.lastFoldViewTokens, 9_000);
		assert.equal(ledger.lastFoldLowTokens, 4_000, "growth-gate low anchor cloned too");
		assert.equal(ledger.lastFoldAt, 333);
		assert.deepEqual(ledger.foldsThisHour, [222, 333]);
		assert.equal(ledger.inheritedFrom, "parent-1");
		assert.equal(ledger.inheritedAt, 77_000);
		assert.equal(ledger.blocks.length, 2);
		assert.deepEqual(ledger.blocks.map((b) => b.summary), ["A", "B"]);
		// Detached copy: mutating the child ledger must not touch the parent.
		ledger.blocks[0].summary = "MUTATED";
		ledger.blocks[0].refRange.firstId = "MUTATED";
		assert.equal(parent.blocks[0].summary, "A");
		assert.equal(parent.blocks[0].refRange.firstId, blockFor(messages, 0, 0).refRange.firstId);
	});

	test("rejects: parent ledger empty", () => {
		const messages = makeMessages(10);
		assert.deepEqual(resolveInheritance(emptyLedger("p"), "p", "c", messages), { ok: false, reason: "parent-ledger-empty" });
	});

	test("rejects: no child history", () => {
		const { ledger: parent } = parentLedgerOf();
		assert.deepEqual(resolveInheritance(parent, "p", "c", []), { ok: false, reason: "no-child-history" });
		assert.deepEqual(resolveInheritance(parent, "p", "c", "not-an-array"), { ok: false, reason: "no-child-history" });
	});

	test("rejects: child history does not resolve the frontier (stale guard)", () => {
		const { ledger: parent } = parentLedgerOf();
		const unrelated = makeMessages(10, 999);
		assert.deepEqual(resolveInheritance(parent, "p", "c", unrelated), { ok: false, reason: "frontier-not-found" });
	});
});

describe("store.adoptLedger", () => {
	function builtLedgerFor(childId) {
		const messages = makeMessages(20);
		const outcome = resolveInheritance({ ...emptyLedger("p"), blocks: [{ ...blockFor(messages, 0, 4, "A"), id: "b1" }], frontier: blockFor(messages, 4, 4).refRange.lastId }, "p", childId, messages);
		assert.equal(outcome.ok, true);
		return outcome.ledger;
	}

	test("adopts into an empty ledger, persists, and is one-shot", (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-adopt-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const store = createStore({ stateDir });
		const ledger = builtLedgerFor("child-1");
		assert.equal(store.adoptLedger("child-1", ledger), true);
		assert.equal(store.ledgerOf("child-1").inheritedFrom, "p");
		assert.equal(store.adoptLedger("child-1", builtLedgerFor("child-1")), false, "second adoption refused");
		assert.equal(store.adoptLedger("other", ledger), false, "ledger for a different session refused");
		// Persisted on disk.
		const onDisk = JSON.parse(readFileSync(join(stateDir, "child-1.json"), "utf8"));
		assert.equal(onDisk.inheritedFrom, "p");
	});

	test("refused when the session already has its own fold blocks", (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-adopt2-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const store = createStore({ stateDir });
		const messages = makeMessages(20);
		commit(store, "busy-1", messages, 0, 4, "own fold");
		const ledger = builtLedgerFor("busy-1");
		assert.equal(store.adoptLedger("busy-1", ledger), false, "real folds are never overwritten");
		assert.equal(store.ledgerOf("busy-1").blocks.length, 1);
		assert.equal(store.ledgerOf("busy-1").inheritedFrom, null);
	});

	test("marker survives a store reload (idempotent across restarts)", (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-reload-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const first = createStore({ stateDir });
		assert.equal(first.adoptLedger("child-2", builtLedgerFor("child-2")), true);
		const second = createStore({ stateDir });
		assert.equal(second.ledgerOf("child-2").inheritedFrom, "p", "marker reloaded from disk");
		assert.equal(second.adoptLedger("child-2", builtLedgerFor("child-2")), false, "reload refuses re-adoption");
	});
});

describe("fork inheritance loop (mock host)", () => {
	test("parent folds → fork → child inherits: view applies folds, ledger marked, persisted", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-loop-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { handle, listener, hooks, setSessionId } = setupTrim(t, stateDir);
		const parentMessages = makeMessages(20);
		commit(handle.store, "parent-1", parentMessages, 0, 4, "parent fold A");
		commit(handle.store, "parent-1", parentMessages, 8, 12, "parent fold B");

		// Fork observed through the post-execute hook (channel A).
		setSessionId("parent-1");
		const downstream = await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "activation", subagentId: "child-1" } }, async () => ({ kind: "accept", content: [{ type: "text", text: "ok" }] }));
		assert.equal(downstream.kind, "accept", "downstream decision untouched");
		const links = loadForkLinks(stateDir);
		assert.deepEqual(forkLinkOf(links, "child-1"), { parent: "parent-1", at: links.links["child-1"]?.at });

		// The child's first stream carries a content copy of the parent
		// history plus its own extras — inheritance happens INSIDE the view.
		const childMessages = [...structuredClone(parentMessages), { role: "user", content: [{ type: "text", text: "child extra 1" }] }, { role: "assistant", content: [{ type: "text", text: "child extra 2" }] }];
		const view = await streamOnce(listener, "child-1", childMessages);
		assert.equal(view.length, 22 - 5 - 5 + 2, "both parent folds apply to the child view");
		assert.match(view[0].content[0].text, /\[SWITCHMAN:TRIM\] parent fold A/u);
		const bIdx = view.findIndex((m) => typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("[SWITCHMAN:TRIM] parent fold B"));
		assert.ok(bIdx > 0, "fold B synthetic present");
		assert.deepEqual(view[view.length - 2].content[0].text, "child extra 1", "extras stay untouched");

		// Child ledger: inherited marker + parent state, persisted to disk.
		const childLedger = handle.store.ledgerOf("child-1");
		assert.equal(childLedger.blocks.length, 2);
		assert.equal(childLedger.inheritedFrom, "parent-1");
		assert.ok(Number.isFinite(childLedger.inheritedAt) && childLedger.inheritedAt > 0);
		const onDisk = JSON.parse(readFileSync(join(stateDir, "child-1.json"), "utf8"));
		assert.equal(onDisk.inheritedFrom, "parent-1");

		// Double-inheritance: a parent's third fold must NOT flow into the
		// child (one-shot), and the child view stays on two folds.
		commit(handle.store, "parent-1", parentMessages, 13, 16, "parent fold C");
		const inheritedAtBefore = childLedger.inheritedAt;
		const view2 = await streamOnce(listener, "child-1", structuredClone(childMessages));
		assert.equal(view2.length, view.length, "third fold not applied to the child");
		const ledger2 = handle.store.ledgerOf("child-1");
		assert.equal(ledger2.blocks.length, 2);
		assert.equal(ledger2.inheritedAt, inheritedAtBefore, "marker unchanged");
	});

	test("non-matching child history starts clean (frontier guard)", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-clean-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { handle, listener, hooks, setSessionId } = setupTrim(t, stateDir);
		const parentMessages = makeMessages(20);
		commit(handle.store, "parent-1", parentMessages, 0, 4, "parent fold A");
		commit(handle.store, "parent-1", parentMessages, 8, 12, "parent fold B");
		setSessionId("parent-1");
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "activation", subagentId: "child-x" } }, async () => ({ kind: "accept" }));
		const unrelated = makeMessages(24, 4242);
		const view = await streamOnce(listener, "child-x", unrelated);
		assert.equal(view.length, 24, "unrelated history is untouched");
		const ledger = handle.store.ledgerOf("child-x");
		assert.equal(ledger.blocks.length, 0);
		assert.equal(ledger.inheritedFrom, null, "no marker for a rejected inheritance");
		assert.equal(existsSync(join(stateDir, "child-x.json")), false, "nothing persisted for a clean start");
		// Decided: a second stream does not re-attempt.
		await streamOnce(listener, "child-x", unrelated);
		assert.equal(handle.store.ledgerOf("child-x").blocks.length, 0);
	});

	test("no link: window expiry stops checking; a LATE fork link re-opens inheritance", async (t) => {
		mock.timers.enable({ now: Date.now() });
		t.after(() => mock.timers.reset());
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-window-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { handle, listener, hooks, setSessionId } = setupTrim(t, stateDir);
		const parentMessages = makeMessages(20);
		const stray = [...structuredClone(parentMessages), { role: "user", content: [{ type: "text", text: "stray extra" }] }];
		// Stream without any link: pending inside the window...
		const view1 = await streamOnce(listener, "stray-1", stray);
		assert.equal(view1.length, 21, "no folds without a link");
		assert.equal(handle.store.ledgerOf("stray-1").inheritedFrom, null);
		// ...past the window the attempt settles (decided).
		mock.timers.tick(INHERIT_WINDOW_MS + 1_000);
		await streamOnce(listener, "stray-1", structuredClone(stray));
		assert.equal(handle.store.ledgerOf("stray-1").blocks.length, 0);
		assert.equal(existsSync(join(stateDir, "stray-1.json")), false);
		// LATE fork observation re-opens the window: parent folds exist, the
		// child content matches → the next stream inherits.
		commit(handle.store, "parent-1", parentMessages, 0, 4, "late parent fold A");
		commit(handle.store, "parent-1", parentMessages, 8, 12, "late parent fold B");
		setSessionId("parent-1");
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "activation", subagentId: "stray-1" } }, async () => ({ kind: "accept" }));
		const view2 = await streamOnce(listener, "stray-1", structuredClone(stray));
		assert.equal(view2.length, 21 - 5 - 5 + 2, "late inheritance applies both folds");
		assert.equal(handle.store.ledgerOf("stray-1").inheritedFrom, "parent-1");
	});

	test("handover-style link from another call site (mtime-gated reload) is honored", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-cross-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { handle, listener } = setupTrim(t, stateDir);
		const parentMessages = makeMessages(20);
		commit(handle.store, "parent-1", parentMessages, 0, 4, "cross parent fold A");
		commit(handle.store, "parent-1", parentMessages, 8, 12, "cross parent fold B");
		// Warm the instance's links cache with an unrelated session (loads the
		// empty map) — the handover writes the file afterwards.
		await streamOnce(listener, "warm-1", makeMessages(4, 7));
		// Channel B: a general session fork records directly on the shared
		// stateDir (index.js post-execute does exactly this).
		assert.equal(recordForkLink("parent-1", "child-b", { stateDir }), true);
		const childMessages = structuredClone(parentMessages);
		const view = await streamOnce(listener, "child-b", childMessages);
		assert.equal(view.length, 20 - 5 - 5 + 2, "cross-instance link drives inheritance");
		assert.equal(handle.store.ledgerOf("child-b").inheritedFrom, "parent-1");
	});

	test("fail-open: corrupt links file degrades to a clean start", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-failopen-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { handle, listener } = setupTrim(t, stateDir);
		const parentMessages = makeMessages(20);
		commit(handle.store, "parent-1", parentMessages, 0, 4, "failopen fold A");
		commit(handle.store, "parent-1", parentMessages, 8, 12, "failopen fold B");
		writeFileSync(join(stateDir, "fork-links.json"), "]]] broken");
		const childMessages = structuredClone(parentMessages);
		const view = await streamOnce(listener, "child-f", childMessages);
		assert.equal(view.length, 20, "no folds without a readable link");
		assert.equal(handle.store.ledgerOf("child-f").blocks.length, 0);
		assert.equal(handle.store.ledgerOf("child-f").inheritedFrom, null);
	});

	test("inherited marker survives an instance reload (no re-inheritance)", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-restart-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		{
			const { handle, listener, hooks, setSessionId } = setupTrim(t, stateDir);
			const parentMessages = makeMessages(20);
			commit(handle.store, "parent-1", parentMessages, 0, 4, "restart fold A");
			commit(handle.store, "parent-1", parentMessages, 8, 12, "restart fold B");
			setSessionId("parent-1");
			await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "activation", subagentId: "child-r" } }, async () => ({ kind: "accept" }));
			await streamOnce(listener, "child-r", structuredClone(parentMessages));
		}
		const before = JSON.parse(readFileSync(join(stateDir, "child-r.json"), "utf8"));
		{
			// A fresh instance (restart) re-reads the marker from disk.
			const { handle, listener } = setupTrim(t, stateDir);
			await streamOnce(listener, "child-r", structuredClone(makeMessages(20)));
			const ledger = handle.store.ledgerOf("child-r");
			assert.equal(ledger.inheritedAt, before.inheritedAt, "inheritedAt unchanged across restarts");
			assert.equal(ledger.inheritedFrom, before.inheritedFrom);
		}
	});

	test("post-execute passthrough: non-fork tools, failures, and non-accept decisions never link", async (t) => {
		const stateDir = mkdtempSync(join(tmpdir(), "trim-fork-passthru-"));
		t.after(() => rmSync(stateDir, { recursive: true, force: true }));
		const { hooks, setSessionId } = setupTrim(t, stateDir);
		setSessionId("parent-1");
		const next = async () => ({ kind: "accept", content: [] });
		await hooks["tools/post-execute"]({ name: "subagent" }, { value: { kind: "activation", subagentId: "c-plain" } }, next);
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { isError: true, value: { kind: "activation", subagentId: "c-err" } }, next);
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "activation", subagentId: "c-deny" } }, async () => ({ kind: "deny" }));
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "foreground", runId: "c-fg" } }, next);
		// one-shot background job: no session id in the result value → no link
		await hooks["tools/post-execute"]({ name: "subagent_fork" }, { value: { kind: "background", jobId: "j-1" } }, next);
		const map = loadForkLinks(stateDir);
		assert.deepEqual(forkLinkOf(map, "c-fg")?.parent, "parent-1", "foreground runId links (childSessionIdOf semantics)");
		assert.equal(map.links["j-1"], undefined, "jobId-only values carry no link");
	});
});
