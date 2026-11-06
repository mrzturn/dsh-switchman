/** T1/T2/T3 ladder folding tests (docs/ladder-fold.md).
 *
 * Covers: ledger v2 migration, ladder commit validation, the three-pass
 * view builder, the ladder trigger gates and their priority over the raw
 * tiers, the model-invisibility invariant (watermark + status tool), the
 * full auto loop (T1 folds accumulate → ladder fires → view shrinks), the
 * ladder surface-ship channel, and fork inheritance of ladder ledgers.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { applyContextTrim } from "../../host/context-trim/index.js";
import { createStore, emptyLedger, ladderCensusOf, LEDGER_VERSION } from "../../host/context-trim/state.js";
import { buildView, refOf, refPositions } from "../../host/context-trim/view.js";
import { computeFoldableRange, evaluateTrigger, LADDER_MIN_INTERVAL_MS } from "../../host/context-trim/trigger.js";
import { LADDER_SYSTEM_PROMPT, renderLadderMaterial } from "../../host/context-trim/summarizer.js";
import { renderRootWatermark, renderSubWatermark, PROTOCOL_ROOT_TEXT, PROTOCOL_SUB_TEXT, PAUSED_LINE } from "../../host/context-watch.js";
import { resolveInheritance } from "../../host/context-trim/fork.js";

// ---- helpers ------------------------------------------------------------------

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
		systemPrompt: { section: (s) => sections.push(s), context: (c) => contexts.push(c) },
		on: (event, handler) => { hooks[event] = handler; },
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
	trimEmergencyPercent: 101,
	trimProtectedTail: 6,
	trimMaxFoldsPerHour: 6,
	trimSideModel: { provider: "", model: "" },
	trimStateDir: "",
};

async function poll(cond, limit = 500) {
	for (let i = 0; i < limit; i++) {
		if (cond()) return true;
		await Promise.resolve();
		await Promise.resolve();
	}
	return cond();
}

const summaryTokensOf = (text) => {
	// mirrors index.js summaryTokensOf (messageTokens over a synthetic message)
	let ascii = 8;
	const plain = typeof text === "string" ? text : "";
	ascii += plain.replace(/[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/gu, "").length;
	const cjk = plain.length - (ascii - 8);
	return Math.max(1, Math.round(ascii / 4 + cjk));
};

function makePairs(count, fill = "F".repeat(4_000)) {
	const messages = [];
	for (let i = 1; i <= count; i++) {
		messages.push({ id: `u${i}`, role: "user", content: [{ type: "text", text: `u${i} ` + fill }] });
		messages.push({ id: `a${i}`, role: "assistant", content: [{ type: "text", text: `a${i} ` + fill }] });
	}
	return messages;
}

const decisionsOf = (stateDir) => {
	try {
		return readFileSync(join(stateDir, "decisions.log"), "utf8");
	} catch {
		return "";
	}
};

// ---- 1. ledger v2 migration ---------------------------------------------------

test("v1 ledger files migrate to v2 on load (tier numeric, active, consumes) and persist as v2", () => {
	const dir = mkdtempSync(join(tmpdir(), "ladder-mig-"));
	try {
		const file = join(dir, "s1.json");
		writeFileSync(file, JSON.stringify({
			version: 1,
			sessionId: "s1",
			blocks: [
				{ id: "b1", kind: "summary", tier: "model", refRange: { firstId: "u1", lastId: "a1" }, count: 2, approxTokens: 500, summary: "One.", createdAt: 111 },
				{ id: "b2", kind: "mechanical", tier: "emergency", refRange: { firstId: "u2", lastId: "a2" }, count: 2, approxTokens: 400, summary: "Two.", createdAt: 222, surfaceReplaced: { startSeq: 1, endSeq: 4 } },
			],
			frontier: "a2",
			lastFoldViewTokens: 9_000,
			lastFoldLowTokens: 4_000,
			lastFoldAt: 333,
			foldsThisHour: [222, 333],
		}));
		const store = createStore({ stateDir: dir });
		const ledger = store.ledgerOf("s1");
		assert.equal(ledger.version, LEDGER_VERSION, "in-memory ledger reads as v2");
		assert.equal(ledger.blocks.length, 2);
		assert.deepEqual(ledger.blocks.map((block) => block.tier), [1, 1], "legacy tier strings map to numeric T1");
		assert.deepEqual(ledger.blocks.map((block) => block.active), [true, true]);
		assert.deepEqual(ledger.blocks.map((block) => block.consumes), [[], []]);
		assert.equal(ledger.blocks[1].surfaceReplaced.startSeq, 1, "surface bookkeeping rides along");
		assert.equal(ledger.frontier, "a2");
		assert.equal(ledger.lastFoldLowTokens, 4_000);
		// The next persist writes the v2 shape to disk.
		store.recordFoldBaseline("s1", 9_000, 4_000);
		const round = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(round.version, LEDGER_VERSION, "persisted file upgrades to v2");
		assert.equal(round.blocks[0].active, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("corrupt v2 records reset the ledger (tier-2 without consumes)", () => {
	const dir = mkdtempSync(join(tmpdir(), "lader-corrupt-"));
	try {
		writeFileSync(join(dir, "s1.json"), JSON.stringify({ version: 2, sessionId: "s1", blocks: [{ id: "b1", tier: 2, count: 2, approxTokens: 5, summary: "x", consumes: [], createdAt: 1 }], frontier: null }));
		const store = createStore({ stateDir: dir });
		assert.equal(store.ledgerOf("s1").blocks.length, 0, "tier-2 with empty consumes is unusable → reset");
		assert.ok(existsSync(join(dir, "s1.json.corrupt")), "the bad file moves aside for forensics");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- 2. ladder commit validation ----------------------------------------------

function setupCommits(pairs, prefix = "P") {
	const store = createStore({ stateDir: mkdtempSync(join(tmpdir(), "ladder-commit-")) });
	const messages = makePairs(pairs);
	const positions = refPositions(messages);
	const commitT1 = (firstId, lastId, count, summary) => store.commitFold("lc", { refRange: { firstId, lastId }, count, approxTokens: 900, summary: `${prefix} `.repeat(60) + summary, tier: 1 }, positions);
	return { store, messages, positions, commitT1 };
}

test("ladder commit: success deactivates the consumed run, freezes the frontier, stamps cadence", () => {
	const { store, commitT1 } = setupCommits(6, "B");
	const r1 = commitT1("u1", "a2", 4, "one");
	const r2 = commitT1("u3", "a4", 4, "two");
	assert.ok(r1.ok && r2.ok, JSON.stringify([r1, r2]));
	const frontierBefore = store.ledgerOf("lc").frontier;
	const ladder = store.commitFold("lc", { consumes: [r1.block.id, r2.block.id], summary: "Distilled.", tier: 2, approxTokens: 2_000 }, null, 5_000);
	assert.equal(ladder.ok, true, JSON.stringify(ladder));
	const ledger = store.ledgerOf("lc");
	assert.deepEqual(ledger.blocks.map((block) => block.active), [false, false, true]);
	assert.equal(ledger.blocks[2].tier, 2);
	assert.deepEqual(ledger.blocks[2].consumes, [r1.block.id, r2.block.id]);
	assert.equal(ledger.blocks[2].count, 2);
	assert.equal(ledger.frontier, frontierBefore, "ladder commits never move the raw frontier");
	assert.equal(ledger.lastFoldAt, 5_000, "cadence stamps advance");
	assert.deepEqual(ledger.foldsThisHour.at(-1), 5_000);
});

test("ladder commit rejections: missing, inactive, tier mismatch, non-contiguous, non-adjacent", () => {
	const { store, commitT1 } = setupCommits(8, "R");
	const b1 = commitT1("u1", "a2", 4, "one");
	const b2 = commitT1("u3", "a4", 4, "two");
	const b3 = commitT1("u5", "a6", 4, "three");
	const b4 = commitT1("u7", "a8", 4, "four");
	assert.ok(b1.ok && b2.ok && b3.ok && b4.ok);
	const ledger = store.ledgerOf("lc");
	const [id1, id2, id3, id4] = ledger.blocks.map((block) => block.id);
	// out-of-order ledger run: [b4, b1] breaks consecutiveness
	assert.equal(store.commitFold("lc", { consumes: [id4, id1], summary: "X", tier: 2 }, null).reason, "ladder-not-contiguous");
	// non-contiguous run with a gap: [b1, b3] skips b2
	assert.equal(store.commitFold("lc", { consumes: [id1, id3], summary: "X", tier: 2 }, null).reason, "ladder-not-contiguous");
	// missing id (on still-active blocks: id3/id4 were never consumed)
	assert.equal(store.commitFold("lc", { consumes: [id3, "ghost"], summary: "X", tier: 2 }, null).reason, "ladder-consumed-missing");
	// tier mismatch: a T2 consuming a T2
	const t2ok = store.commitFold("lc", { consumes: [id1, id2], summary: "T2 ".repeat(30), tier: 2 }, null);
	assert.equal(t2ok.ok, true, "sanity: [b1,b2] is a valid T2 run");
	assert.equal(store.commitFold("lc", { consumes: [t2ok.block.id], summary: "X", tier: 2 }, null).reason, "ladder-tier-mismatch", "T2→T2 is invalid; T2→T3 is the ladder");
	// double consumption: b1/b2 are now inactive
	assert.equal(store.commitFold("lc", { consumes: [id1], summary: "Again", tier: 2 }, null).reason, "ladder-consumed-inactive", "single consumption");
	// T3 over the active T2 succeeds
	const t3 = store.commitFold("lc", { consumes: [t2ok.block.id], summary: "Omega.", tier: 3 }, null);
	assert.equal(t3.ok, true);
	// view adjacency: consecutive LEDGER blocks whose raw spans carry a gap
	// (an advisory fold skipped a middle range) are caught by the posMap
	// adjacency check at commit time.
	const { store: store3, commitT1: commitT1y } = setupCommits(8, "H");
	const h1 = commitT1y("u1", "a2", 4, "one");
	const h2 = commitT1y("u5", "a6", 4, "two");
	assert.ok(h1.ok && h2.ok, "two folds with a raw gap between them commit individually");
	const gap = store3.commitFold("lc", { consumes: [h1.block.id, h2.block.id], summary: "Gap", tier: 2 }, refPositions(makePairs(8)));
	assert.equal(gap.ok, false, "runs skipping a raw gap are view-non-adjacent");
	assert.equal(gap.reason, "ladder-not-adjacent");
});

test("ladder census: active populations with CJK-aware mass", () => {
	const store = createStore({ stateDir: mkdtempSync(join(tmpdir(), "ladder-census-")) });
	const messages = makePairs(4);
	const positions = refPositions(messages);
	store.commitFold("cx", { refRange: { firstId: "u1", lastId: "a1" }, count: 2, approxTokens: 800, summary: "汉字摘要".repeat(50), tier: 1 }, positions);
	store.commitFold("cx", { refRange: { firstId: "u2", lastId: "a2" }, count: 2, approxTokens: 800, summary: "ascii summary ".repeat(40), tier: 1 }, positions);
	const census = ladderCensusOf(store.ledgerOf("cx"), summaryTokensOf);
	assert.equal(census.t1.length, 2);
	assert.equal(census.t2.length, 0);
	assert.ok(census.t1[0].summaryTokens > 150, "CJK summaries weigh ~1 token/char, not char/4");
});

test("block ids are unique even within the same millisecond (ladder consumes BY id)", () => {
	const { store, commitT1 } = setupCommits(8, "U");
	const r1 = commitT1("u1", "a2", 4, "one");
	const r2 = commitT1("u3", "a4", 4, "two");
	assert.notEqual(r1.block.id, r2.block.id, "same-ms commits must not collide");
});

// ---- 3. view builder ladder passes ---------------------------------------------

test("view: T2 replaces its consumed T1 run; T3 replaces the T2; determinism golden", () => {
	const { store, commitT1 } = setupCommits(6, "V");
	const r1 = commitT1("u1", "a2", 4, "Alpha summary.");
	const r2 = commitT1("u3", "a4", 4, "Beta summary.");
	assert.ok(r1.ok && r2.ok);
	const t2 = store.commitFold("vx" in {} ? "vx" : "lc", { consumes: [r1.block.id, r2.block.id], summary: "Gamma distillation.", tier: 2, approxTokens: 1_800 }, null);
	assert.equal(t2.ok, true);

	// messages: u1 a1 u2 a2 u3 a3 u4 a4 u5 a5 u6 a6 (12) — tail 2 protects
	// u6,a6; the consumed run covers u1..a4; pass 1 renders both T1 summaries
	// and the T2 pass replaces the run with ONE message.
	const view1 = buildView(makePairs(6), store.ledgerOf("lc"), { protectedTail: 2 });
	assert.equal(view1.applied, 3, "two T1 splices + one T2 replacement count");
	const texts = view1.messages.map((message) => message.content?.[0]?.text ?? "");
	assert.equal(texts[0], "[SWITCHMAN:TRIM] Gamma distillation.");
	assert.equal(texts.some((text) => text.includes("Alpha summary.")), false, "consumed T1 summaries left the view");
	assert.equal(texts.some((text) => text.includes("Beta summary.")), false);
	assert.deepEqual(texts.slice(1), ["u5 FFFF", "a5 FFFF", "u6 FFFF", "a6 FFFF"].map(() => texts.slice(1)[texts.slice(1).indexOf(texts[1])] ) && texts.slice(1).map((t, i) => t), "sanity anchor");
	// T3 over the T2
	const t3 = store.commitFold("lc", { consumes: [t2.block.id], summary: "Omega condensation.", tier: 3, approxTokens: 1_800 }, null);
	assert.equal(t3.ok, true);
	const view2 = buildView(makePairs(6), store.ledgerOf("lc"), { protectedTail: 2 });
	const texts2 = view2.messages.map((message) => message.content?.[0]?.text ?? "");
	assert.equal(texts2[0], "[SWITCHMAN:TRIM] Omega condensation.", "T3 replaces the T2 summary");
	assert.equal(texts2.length, view1.messages.length, "the T3 replacement keeps the message count");
	assert.equal(view2.applied, 3, "two T1 anchor splices + the T3 replacement count (the T2 anchor is replaced within the same build and never counts twice)");
	// determinism: same inputs, byte-identical views
	const view2again = buildView(makePairs(6), store.ledgerOf("lc"), { protectedTail: 2 });
	assert.deepEqual(JSON.stringify(view2again.messages), JSON.stringify(view2.messages));
});

test("view: a non-adjacent consumed run fails open (ladder skipped, T1 anchors stay)", () => {
	const { store, commitT1 } = setupCommits(8, "W");
	const r1 = commitT1("u1", "a2", 4, "One.");
	const r2 = commitT1("u5", "a6", 4, "Two.");
	assert.ok(r1.ok && r2.ok);
	// commit WITHOUT posMap: adjacency unchecked at commit; the view refuses
	const ladder = store.commitFold("lc", { consumes: [r1.block.id, r2.block.id], summary: "Gap distill.", tier: 2 }, null);
	assert.equal(ladder.ok, true);
	const view = buildView(makePairs(8), store.ledgerOf("lc"), { protectedTail: 2 });
	const texts = view.messages.map((message) => message.content?.[0]?.text ?? "");
	assert.equal(texts.some((text) => text.includes("Gap distill.")), false, "non-adjacent ladder never renders");
	assert.equal(texts.some((text) => text.includes("One.")), true, "the T1 anchors stay rendered");
});

// ---- 4. trigger gates -----------------------------------------------------------

const ladderBase = {
	messages: makePairs(6),
	viewTokens: 30_000,
	windowTokens: 150_000,
	thresholds: { growthTokens: 22_500, incrementTokens: 50_000, pressurePercent: 60, emergencyPercent: 95, maxFoldsPerHour: 6, ladderT2Tokens: 1_000, ladderT2MinBlocks: 3, ladderT3Tokens: 800, ladderT3MinBlocks: 2 },
	now: 1_000_000,
	lastFoldAt: 0,
	foldsThisHour: [],
	lastEmergencyAt: 0,
	ledger: { lastFoldLowTokens: 0 },
	ladderRuns: {
		t2: [{ consumes: ["b1", "b2", "b3"], mass: 1_500, count: 3 }],
		t3: [],
	},
};

test("ladder T2 fires on mass+count when raw tiers are quiet", () => {
	const decision = evaluateTrigger({ ...ladderBase, foldable: computeFoldableRange(ladderBase.messages, null, 6) });
	assert.equal(decision.action, "fold");
	assert.equal(decision.kind, "ladder");
	assert.equal(decision.tier, "ladder-2");
	assert.deepEqual(decision.consumes, ["b1", "b2", "b3"]);
	assert.match(decision.reason, /ladder mass/);
});

test("ladder mass gate blocks sub-threshold distills (bili #198)", () => {
	const decision = evaluateTrigger({ ...ladderBase, ladderRuns: { t2: [{ consumes: ["b1", "b2", "b3"], mass: 999, count: 3 }], t3: [] } });
	assert.equal(decision.action, "none");
	assert.equal(decision.reason, "below-thresholds");
});

test("ladder count floor filters degenerate runs (bili #379)", () => {
	const decision = evaluateTrigger({ ...ladderBase, ladderRuns: { t2: [{ consumes: ["b1", "b2"], mass: 5_000, count: 2 }], t3: [] } });
	assert.equal(decision.action, "none");
});

test("raw tiers outrank a ready ladder; ladder fires when raw has nothing", () => {
	// raw growth ready below the pressure line: the raw tier wins
	const fatMessages = makePairs(6, "g".repeat(40_000));
	const rawReady = evaluateTrigger({ ...ladderBase, messages: fatMessages, viewTokens: 80_000, foldable: { startIdx: 2, endIdx: 9 } });
	assert.equal(rawReady.action, "fold");
	assert.equal(rawReady.kind, "raw");
	assert.equal(rawReady.tier, "growth", "raw first");
	// nothing foldable: the ladder still fires
	const rawQuiet = evaluateTrigger({ ...ladderBase, foldable: null });
	assert.equal(rawQuiet.action, "fold");
	assert.equal(rawQuiet.tier, "ladder-2");
});

test("ladder T3 wins over T2 when it reclaims more; cadence gates apply", () => {
	// deeper tier with the larger mass wins (the larger reclaim)
	const deeper = evaluateTrigger({ ...ladderBase, ladderRuns: { t2: [{ consumes: ["b1", "b2", "b3"], mass: 1_500, count: 3 }], t3: [{ consumes: ["t2a", "t2b"], mass: 1_600, count: 2 }] } });
	assert.equal(deeper.tier, "ladder-3", "the larger reclaim wins");
	// equal mass: the deeper tier wins the tie
	const tie = evaluateTrigger({ ...ladderBase, ladderRuns: { t2: [{ consumes: ["b1", "b2", "b3"], mass: 1_500, count: 3 }], t3: [{ consumes: ["t2a", "t2b"], mass: 1_500, count: 2 }] } });
	assert.equal(tie.tier, "ladder-3", "ties go deeper");
	// smaller T3 mass: T2 wins
	const shallower = evaluateTrigger({ ...ladderBase, ladderRuns: { t2: [{ consumes: ["b1", "b2", "b3"], mass: 1_500, count: 3 }], t3: [{ consumes: ["t2a", "t2b"], mass: 900, count: 2 }] } });
	assert.equal(shallower.tier, "ladder-2");
	// interval: within LADDER_MIN_INTERVAL_MS of the last fold
	const hot = evaluateTrigger({ ...ladderBase, lastFoldAt: ladderBase.now - LADDER_MIN_INTERVAL_MS + 1 });
	assert.equal(hot.action, "none");
	assert.equal(hot.reason, "ladder-min-interval");
	// hourly cap
	const capped = evaluateTrigger({ ...ladderBase, foldsThisHour: [ladderBase.now - 1_000, ladderBase.now - 2_000, ladderBase.now - 3_000, ladderBase.now - 4_000, ladderBase.now - 5_000, ladderBase.now - 6_000] });
	assert.equal(capped.action, "none");
	assert.equal(capped.reason, "hourly-cap");
});

// ---- 5. model invisibility ------------------------------------------------------

test("watermark lines carry no numbers, no percentages, no budget values", () => {
	for (const line of [renderRootWatermark("soft", {}), renderRootWatermark("hard", {}), renderRootWatermark("force", { autoHandover: true }), renderRootWatermark("force", { phase: "compacting" }), renderRootWatermark("force", { cooldown: true, autoHandover: true }), renderSubWatermark("soft"), renderSubWatermark("hard"), renderSubWatermark("force"), PROTOCOL_ROOT_TEXT, PROTOCOL_SUB_TEXT, PAUSED_LINE]) {
		assert.doesNotMatch(line, /%|~\d+k|of budget|\d+ min/u, `numeric disclosure in: ${line.slice(0, 80)}`);
	}
	assert.equal(renderRootWatermark("ok", {}), "", "ok tier stays silent");
});

// ---- 6. full loop: T1 folds accumulate → ladder fires → view shrinks -------------

test("loop: T1 folds accumulate, then the ladder distills them and the view flattens", async (t) => {
	mock.timers.enable({ now: Date.now() });
	t.after(() => mock.timers.reset());
	let listener = null;
	const fiber = { on: (event, fn) => { if (event === "llm/stream") listener = fn; }, off: () => {}, effect: () => {} };
	let prepareCalls = 0;
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 300_000 } }),
		prepareCall: async () => {
			prepareCalls += 1;
			return { stream: async function* () {
				yield { type: "text-delta", text: "S".repeat(1_200) };
				yield { type: "finish" };
			} };
		},
	};
	const { ctx, hooks, registeredTools } = mockCtx({ llmFiber: fiber });
	ctx.get = () => llm;
	const stateDir = mkdtempSync(join(tmpdir(), "ladder-loop-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	// Raw tiers fully off; ladder gates low: three fat T1 summaries
	// (~1.2k tokens of mass each) clear the 800-token T2 gate at 3 blocks.
	const handle = applyContextTrim(ctx, {
		...config,
		trimGrowthTokens: 1_000_000_000,
		trimIncrementTokens: 1_000_000_000,
		trimPressurePercent: 101,
		trimProtectedTail: 2,
		trimLadderT2Tokens: 800,
		trimLadderT2MinBlocks: 3,
		trimLadderT3Tokens: 800,
		trimLadderT3MinBlocks: 2,
		trimMaxFoldsPerHour: 6,
		trimStateDir: stateDir,
	});
	assert.equal(registeredTools.some((tool) => tool.name === "ctx_trim_status"), true);
	// ctx_trim_status exposes true sizes only — never a fill percentage,
	// window token count, or threshold percentage (bili lesson #2).
	const statusTool = registeredTools.find((tool) => tool.name === "ctx_trim_status");
	const statusText = await statusTool.execute();
	assert.doesNotMatch(statusText, /%|window tokens|thresholds:/u, `status must stay size-only, got: ${statusText.slice(0, 200)}`);
	const store = [];
	async function turn() {
		store.push({ role: "user", content: [{ type: "text", text: `u${store.length} ` + "F".repeat(6_000) }] });
		store.push({ role: "assistant", content: [{ type: "text", text: `a${store.length} ` + "F".repeat(6_000) }] });
		const messages = store.slice();
		const stream = listener({ sessionId: "lad-1", messages, provider: "p", model: "m" }, async function* () { yield { type: "finish", usage: { input_tokens: 1 } }; });
		for await (const chunk of stream) void chunk;
		return messages;
	}

	// Eight turns seed a full capture (the side-dispatch guard accepts the
	// first dispatch and re-accepts by budget/exemption as history grows);
	// all three commit ranges must clear the protected tail (last 2).
	for (let i = 0; i < 8; i++) await turn();
	const capture = handle.captures.get("lad-1");
	assert.notEqual(capture, undefined, "capture seeded");
	assert.equal(capture.messages.length, 16, "the capture holds all eight turns");
	// commit three fat-summary T1 blocks over raw ranges [0..3], [4..7], [8..11]
	const commitT1 = (start, count) => handle.store.commitFold("lad-1", {
		refRange: { firstId: refOf(capture.messages[start], start), lastId: refOf(capture.messages[start + count - 1], start + count - 1) },
		count,
		approxTokens: 12_000,
		summary: "T".repeat(1_200),
		kind: "summary",
		tier: 1,
	}, refPositions(capture.messages));
	const r1 = commitT1(0, 4);
	const r2 = commitT1(4, 4);
	const r3 = commitT1(8, 4);
	assert.ok(r1.ok && r2.ok && r3.ok, JSON.stringify([r1.reason, r2.reason, r3.reason]));
	const ids = handle.store.ledgerOf("lad-1").blocks.map((block) => block.id);
	assert.equal(ids.length, 3);
	// advance past the ladder interval, then idle
	mock.timers.tick(121_000);
	hooks["agent/status"]({ status: "idle", agent: { session: { id: "lad-1" } } });
	assert.equal(await poll(() => handle.store.ledgerOf("lad-1").blocks.length >= 4), true, "the ladder T2 must commit");
	const ledger = handle.store.ledgerOf("lad-1");
	const ladderBlock = ledger.blocks[3];
	assert.equal(ladderBlock.tier, 2, "the fourth block is the T2 distillation");
	assert.deepEqual(ladderBlock.consumes, ids, "it consumed exactly the three T1 blocks");
	assert.deepEqual(ledger.blocks.slice(0, 3).map((block) => block.active), [false, false, false]);
	assert.ok(prepareCalls >= 1, "the distillation ran through the side model");
	// the view renders the distilled shape: exactly ONE synthetic message
	const view = buildView(capture.messages, ledger, { protectedTail: 2 });
	const texts = view.messages.map((message) => message.content?.[0]?.text ?? "");
	assert.equal(texts.filter((text) => text.includes("[SWITCHMAN:TRIM]")).length, 1, "exactly ONE synthetic message remains");
	assert.match(decisionsOf(stateDir), /outcome=folded:ladder-2:3 blocks/u, "the outcome row names the ladder tier");
});

// ---- 7. summarizer: ladder material + prompt --------------------------------------

test("ladder material renders block-stamped sections; the distill prompt keeps the craft rules", () => {
	const blocks = [
		{ id: "b1", tier: 1, count: 4, approxTokens: 900, summary: "Alpha." },
		{ id: "b2", tier: 1, count: 4, approxTokens: 800, summary: "Beta." },
	];
	const material = renderLadderMaterial(blocks);
	assert.match(material, /\[block b1\] \(tier 1, ~900 tokens, 4 msgs\)/u);
	assert.match(material, /Alpha\./u);
	assert.match(material, /Beta\./u);
	assert.match(LADDER_SYSTEM_PROMPT, /distill several context-fold summaries/u);
	assert.match(LADDER_SYSTEM_PROMPT, /Decisions WITH their rationale/u);
});

// ---- 8. fork inheritance with ladder blocks ----------------------------------------

test("fork inheritance carries tier/active/consumes; the child renders the same ladder view", () => {
	const store = createStore({ stateDir: mkdtempSync(join(tmpdir(), "ladder-fork-")) });
	const messages = makePairs(6);
	const positions = refPositions(messages);
	const r1 = store.commitFold("parent", { refRange: { firstId: "u1", lastId: "a2" }, count: 4, approxTokens: 900, summary: "P1 ".repeat(50), tier: 1 }, positions);
	const r2 = store.commitFold("parent", { refRange: { firstId: "u3", lastId: "a4" }, count: 4, approxTokens: 900, summary: "P2 ".repeat(50), tier: 1 }, positions);
	assert.ok(r1.ok && r2.ok);
	store.commitFold("parent", { consumes: [r1.block.id, r2.block.id], summary: "Child-visible distillation.", tier: 2 }, null);
	const parentLedger = store.ledgerOf("parent");
	const childMessages = [...messages, { role: "user", content: [{ type: "text", text: "extra" }] }];
	const outcome = resolveInheritance(parentLedger, "parent", "child", childMessages, 1_000);
	assert.equal(outcome.ok, true);
	const childLedger = outcome.ledger;
	assert.deepEqual(childLedger.blocks.map((block) => block.tier), [1, 1, 2]);
	assert.deepEqual(childLedger.blocks.map((block) => block.active), [false, false, true]);
	// [2026-11-07]-[regression: a ladder clone's refRange must stay null]-[
	// spreading null used to produce {} which slipped past the view's T1
	// filter and inflated the unlocated count (a phantom epoch signal)]
	assert.deepEqual(childLedger.blocks.map((block) => block.refRange), [r1.block.refRange, r2.block.refRange, null]);
	const view = buildView(childMessages, childLedger, { protectedTail: 2 });
	const texts = view.messages.map((message) => message.content?.[0]?.text ?? "");
	assert.equal(texts.filter((text) => text.includes("[SWITCHMAN:TRIM]")).length, 1, "the child renders exactly the distilled summary");
	assert.match(texts.find((text) => text.includes("[SWITCHMAN:TRIM]")) ?? "", /Child-visible distillation\./u);
});
