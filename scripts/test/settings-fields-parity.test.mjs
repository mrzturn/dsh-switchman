/** Settings-field parity: every field host/routes.js registers for coercion
 *  MUST be wired into the client page's ALL_FIELDS payload.
 *
 *  Regression guard for the v1.11-class bug: a field added to routes.js (and
 *  host/config.js) but never wired into client.js leaves the client's POST
 *  payload missing it, coerceValues then returns null, and EVERY settings
 *  page save 400s with "invalid values payload". Both files are plain JS, so
 *  this test reads their SOURCE TEXT and extracts the field sets with regexes
 *  (no hard-coded field list): routes.js registry const-arrays + `{ field: "x" }`
 *  entries + ENUM_FIELDS keys versus client.js ALL_FIELDS with its spreads
 *  (`...NAME` and `...NAME.map(({ key }) => key)`) expanded.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const routesSrc = readFileSync(join(ROOT, "host", "routes.js"), "utf8");
const clientSrc = readFileSync(join(ROOT, "client.js"), "utf8");

/** Body of the first `const NAME = [` ... `];` block, or null. */
function constArrayBlock(source, name) {
	const open = source.indexOf(`const ${name} = [`);
	if (open < 0) return null;
	const close = source.indexOf("];", open);
	return close < 0 ? null : source.slice(open, close);
}

/** Body of the first `const NAME = {` ... `};` block, or null. */
function constObjectBlock(source, name) {
	const open = source.indexOf(`const ${name} = {`);
	if (open < 0) return null;
	const close = source.indexOf("};", open);
	return close < 0 ? null : source.slice(open, close);
}

/** routes.js side: every top-level const-array is a field registry
 *  (STRING/POOL/BOOLEAN/EFFORTS/TRIM_STRING/route lists), plus the
 *  `{ field: "x" }` bounded-number entries and the ENUM_FIELDS keys. */
function routesFields(source) {
	const fields = new Set();
	for (const m of source.matchAll(/const (\w+)\s*=\s*\[/g)) {
		const block = constArrayBlock(source, m[1]);
		if (block !== null)
			for (const s of block.matchAll(/"([A-Za-z]\w*)"/g)) fields.add(s[1]);
	}
	for (const m of source.matchAll(/\{\s*field:\s*"([A-Za-z]\w*)"/g))
		fields.add(m[1]);
	const enumBlock = constObjectBlock(source, "ENUM_FIELDS");
	if (enumBlock !== null)
		for (const m of enumBlock.matchAll(/^\s*([A-Za-z]\w*):\s*\[/gm))
			fields.add(m[1]);
	return fields;
}

/** client.js side: ALL_FIELDS with its spreads expanded — plain `...NAME`
 *  (an array of quoted strings) and `...NAME.map(({ key }) => key)` (object
 *  entries keyed by `key`, e.g. POOL_FIELDS field/manualField/effortsField
 *  and the *_NUMBER_FIELDS `field` entries). */
function clientAllFields(source) {
	const block = constArrayBlock(source, "ALL_FIELDS");
	assert.ok(block !== null, "client.js must declare const ALL_FIELDS = [ ... ]");
	const fields = new Set();
	for (const m of block.matchAll(/'([A-Za-z]\w*)'/g)) fields.add(m[1]);
	for (const line of block.split("\n")) {
		const plain = line.match(/\.\.\.(\w+),\s*$/);
		if (plain) {
			const spread = constArrayBlock(source, plain[1]);
			if (spread !== null)
				for (const m of spread.matchAll(/'([A-Za-z]\w*)'/g)) fields.add(m[1]);
			continue;
		}
		const mapped = line.match(
			/\.\.\.(\w+)\.map\(\(\{\s*(\w+)\s*\}\)\s*=>\s*\2\)/,
		);
		if (mapped) {
			const spread = constArrayBlock(source, mapped[1]);
			if (spread !== null) {
				const entry = new RegExp(
					`${mapped[2]}:\\s*'([A-Za-z]\\w*)'`,
					"g",
				);
				for (const m of spread.matchAll(entry)) fields.add(m[1]);
			}
		}
	}
	return fields;
}

test("routes.js registered settings fields are a subset of client.js ALL_FIELDS", () => {
	const host = routesFields(routesSrc);
	const client = clientAllFields(clientSrc);
	// Sanity: extraction found real registries on both sides (guards against
	// the regexes silently matching nothing after a refactor).
	assert.ok(
		host.size >= 40,
		`routes.js field extraction implausibly small: ${host.size}`,
	);
	assert.ok(
		client.size >= 60,
		`client ALL_FIELDS extraction implausibly small: ${client.size}`,
	);
	const missing = [...host].filter((f) => !client.has(f)).sort();
	assert.deepEqual(
		missing,
		[],
		`fields registered in routes.js but missing from client.js ALL_FIELDS ` +
			`(client would omit them from the POST payload → save 400s): ` +
			missing.join(", "),
	);
});

test("dynamic watermark fields are wired on both sides (v1.11 regression guard)", () => {
	const host = routesFields(routesSrc);
	const client = clientAllFields(clientSrc);
	for (const field of [
		"wmDynamicEnabled",
		"wmDynamicTurnsExpected",
		"wmDynamicLookback",
		"wmDynamicOutPerM",
		"wmDynamicAmortization",
	]) {
		assert.ok(host.has(field), `routes.js must register ${field}`);
		assert.ok(client.has(field), `client.js ALL_FIELDS must include ${field}`);
	}
});

test("promoted config-only gray-release fields are wired on both sides", () => {
	const host = routesFields(routesSrc);
	const client = clientAllFields(clientSrc);
	// 2026-11-20 promotion: the three former config-only switches plus the
	// compressBudgetRatio companion must be coercible AND on the client page.
	for (const field of [
		"wmHandoffSplit",
		"costProfileEnabled",
		"trimBudgetEnabled",
		"compressBudgetRatio",
	]) {
		assert.ok(host.has(field), `routes.js must register ${field}`);
		assert.ok(client.has(field), `client.js ALL_FIELDS must include ${field}`);
	}
});

/** Quoted identifier-like matches in a block, repeats included. */
function quotedEntries(block, quote) {
	return [...block.matchAll(new RegExp(`${quote}([A-Za-z]\\w*)${quote}`, "g"))].map(
		(m) => m[1],
	);
}

test("settings field registries contain no duplicate entries", () => {
	// registry-review follow-up: a duplicated name inside one registry list
	// silently double-writes the same setting and hides the shadowed entry
	// from the parity checks above — every registry stays duplicate-free.
	const dup = (list) => list.filter((v, i) => list.indexOf(v) !== i);

	// host/routes.js — a const array whose non-comment content is only quoted
	// strings, commas and whitespace is a field registry; path lists (ROUTES)
	// yield no identifier-like entries and the bounded-number tables carry
	// object rows, so both fall through to the checks below.
	for (const m of routesSrc.matchAll(/const (\w+)\s*=\s*\[/g)) {
		const block = constArrayBlock(routesSrc, m[1]);
		if (block === null) continue;
		const body = block
			.slice(block.indexOf("[") + 1)
			.replace(/\/\/[^\n]*/g, "");
		const bare = body.replace(/"[^"]*"/g, '""');
		if (!/^[\s",\[\]]+$/.test(bare)) continue;
		const repeated = dup(quotedEntries(body, '"'));
		assert.deepEqual(
			repeated,
			[],
			`routes.js ${m[1]} registry has duplicate entries: ${repeated.join(", ")}`,
		);
	}

	// host/routes.js + client.js — bounded-number tables: exactly one row per
	// field (a duplicated row would double-coerce and mask the other bounds).
	for (const [label, src, quote] of [
		["routes.js", routesSrc, '"'],
		["client.js", clientSrc, "'"],
	]) {
		for (const m of src.matchAll(/const (\w+)\s*=\s*\[/g)) {
			const block = constArrayBlock(src, m[1]);
			if (block === null) continue;
			const body = block.replace(/\/\/[^\n]*/g, "");
			if (!new RegExp(`field:\\s*${quote}`).test(body)) continue;
			const fields = [
				...body.matchAll(new RegExp(`field:\\s*${quote}(\\w+)${quote}`, "g")),
			].map((x) => x[1]);
			const repeated = dup(fields);
			assert.deepEqual(
				repeated,
				[],
				`${label} ${m[1]} has duplicate field rows: ${repeated.join(", ")}`,
			);
		}
	}

	// client.js ALL_FIELDS — direct entries plus every expanded spread must
	// form a duplicate-free union.
	const allBlock = constArrayBlock(clientSrc, "ALL_FIELDS");
	assert.ok(allBlock !== null, "client.js must declare const ALL_FIELDS = [ ... ]");
	const union = quotedEntries(allBlock.replace(/\/\/[^\n]*/g, ""), "'");
	for (const line of allBlock.split("\n")) {
		const plain = line.match(/\.\.\.(\w+),\s*$/);
		if (plain) {
			const spread = constArrayBlock(clientSrc, plain[1]);
			if (spread !== null)
				union.push(...quotedEntries(spread.replace(/\/\/[^\n]*/g, ""), "'"));
			continue;
		}
		const mapped = line.match(
			/\.\.\.(\w+)\.map\(\(\{\s*(\w+)\s*\}\)\s*=>\s*\2\)/,
		);
		if (mapped) {
			const spread = constArrayBlock(clientSrc, mapped[1]);
			if (spread !== null) {
				const keyRe = new RegExp(`${mapped[2]}:\\s*'([A-Za-z]\\w*)'`, "g");
				for (const m of spread.replace(/\/\/[^\n]*/g, "").matchAll(keyRe))
					union.push(m[1]);
			}
		}
	}
	const repeated = dup(union);
	assert.deepEqual(
		repeated,
		[],
		`client.js ALL_FIELDS (spreads expanded) has duplicate entries: ${repeated.join(", ")}`,
	);
});
