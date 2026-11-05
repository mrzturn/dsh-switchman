/** Unit tests for the CJK-aware token estimator (host/context-trim/view.js).
 *
 * The flat char/4 heuristic undercounts CJK text ~4x (CJK tokenizes at
 * ~1 token per hanzi in the glm/deepseek vocabularies). CJK chars now weigh
 * TOKENS_PER_CJK_CHAR = 1. Note: this is a general accuracy fix — the
 * 2026-11-04 incident (view ~80k vs a 176k wire) was caused by frozen
 * dispatches blocking view injection, not by the estimator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { messageTokens, estimateTokensOf, TOKENS_PER_CHAR, TOKENS_PER_CJK_CHAR } from "../../host/context-trim/view.js";

test("ascii text keeps the flat char/4 estimate", () => {
	const message = { role: "user", content: [{ type: "text", text: "abcdefgh" }] };
	// framing (8) + 8 ascii chars, all at char/4
	assert.equal(messageTokens(message), Math.round((8 + 8) * TOKENS_PER_CHAR));
});

test("cjk text weighs ~1 token per char instead of char/4", () => {
	const hanzi = "你好世界你好世界再见晚安"; // 12 CJK chars
	const message = { role: "user", content: [{ type: "text", text: hanzi }] };
	const expected = Math.round(8 * TOKENS_PER_CHAR + 12 * TOKENS_PER_CJK_CHAR);
	assert.equal(messageTokens(message), expected);
	assert.ok(messageTokens(message) > hanzi.length, "cjk must weigh more than char/4");
});

test("cjk punctuation, fullwidth and kana count as cjk", () => {
	const text = "、。「」：；アイウエオ";
	const message = { role: "user", content: [{ type: "text", text }] };
	// every char above falls in the cjk ranges → counted at the cjk weight
	assert.equal(messageTokens(message), Math.round(8 * TOKENS_PER_CHAR + [...text].length * TOKENS_PER_CJK_CHAR));
});

test("mixed text splits ascii and cjk pools", () => {
	const message = { role: "user", content: [{ type: "text", text: "abc你好" }] };
	assert.equal(messageTokens(message), Math.round((8 + 3) * TOKENS_PER_CHAR + 2 * TOKENS_PER_CJK_CHAR));
});

test("tool_calls payloads are measured with the same weights", () => {
	const message = {
		role: "assistant",
		content: [],
		tool_calls: [{ id: "t1", type: "function", function: { name: "probe", arguments: '{"q":"你好"}' } }],
	};
	// arguments text: `{"q":"你好"}` → 7 ascii (incl. quotes/braces) + 2 cjk, plus the wrapper JSON around it
	const tokens = messageTokens(message);
	const flat = (() => {
		const chars = 8 + JSON.stringify(message.tool_calls).length;
		return Math.round(chars * TOKENS_PER_CHAR);
	})();
	assert.ok(tokens > flat, "cjk inside tool_calls must lift the estimate");
});

test("regression: a 40%-cjk history estimates ~2.2x the flat char/4 figure", () => {
	// Mirrors the measured incident session (~40% cjk chars).
	let text = "";
	for (let i = 0; i < 100; i++) text += "abcd".repeat(3) + "你好世界你好世界"; // 12 ascii + 8 cjk per unit
	const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] }));
	const calibrated = estimateTokensOf(messages);
	const flat = Math.round(((8 + text.length) * TOKENS_PER_CHAR) * 8);
	assert.ok(calibrated > flat * 1.9 && calibrated < flat * 2.6, `calibrated=${calibrated} flat=${flat}`);
});

test("estimateTokensOf range bounds and empty input still behave", () => {
	assert.equal(estimateTokensOf([], 0, 10), 0);
	const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	assert.equal(estimateTokensOf(messages, 5, 9), 0, "out-of-range slice is zero");
	assert.ok(estimateTokensOf(messages) > 0);
});
