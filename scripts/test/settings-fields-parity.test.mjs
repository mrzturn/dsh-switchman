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
