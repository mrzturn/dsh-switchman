#!/usr/bin/env node
/**
 * Validate dsh-switchman's cordis.patch.yml and package.json.
 *
 * Checks:
 * 1. The patch parses as a YAML array of 4 id-targeted loader overrides
 *    plus exactly 1 insert row (this bundle's own UI plugin).
 * 2. Every preset's config matches the shipped preset file verbatim, except
 *    the persona suffix, which must extend the shipped suffix with the
 *    dsh-switchman doctrine.
 * 3. All four persona suffixes resolve to the same string (shared anchor).
 * 4. package.json keeps the client-half discovery surface intact: the
 *    "./client" and "./package.json" exports and the dsh.client declaration
 *    are hard requirements of the Host's client-module scan
 *    (@deepseek-ai/dsh-client-modules); dropping any of them makes the
 *    session-header badge silently vanish (server 404, no console errors).
 */
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_ROOT = process.env.DSH_APP_ROOT ?? "/Applications/DSH Desktop.app/Contents/Resources/app";
const YAML = (await import(`${APP_ROOT}/node_modules/yaml/dist/index.js`)).default;

const MINE = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));
const SHIPPED_DIR = `${APP_ROOT}/node_modules/@deepseek-ai/dsh-web-app/presets`;
const PRESETS = ["standard", "ptc", "minimal", "cordis"];

const load = (path) =>
	YAML.parse(readFileSync(path, "utf8"), {
		customTags: [
			{
				tag: "tag:yaml.org,2002:js",
				resolve(str) {
					return `!!js ${str}`;
				},
			},
		],
	});

const personaSuffix = (plugins) => {
	for (const row of plugins) if (row.id === "persona") return row.config?.suffix;
	return undefined;
};

const stripSuffix = (plugins) =>
	plugins.map((row) =>
		row.id === "persona"
			? { ...row, config: Object.fromEntries(Object.entries(row.config ?? {}).filter(([k]) => k !== "suffix")) }
			: row,
	);

const mine = load(MINE);
assert.ok(Array.isArray(mine), "patch must be a YAML array");

const inserts = mine.filter((entry) => "insert" in entry);
const overrides = mine.filter((entry) => !("insert" in entry));
assert.equal(
	inserts.length,
	1,
	"expected exactly 1 insert entry (the bundle's own UI plugin row)",
);
assert.equal(inserts[0].insert.length, 1);
assert.equal(inserts[0].insert[0].name, "dsh-switchman", "insert row must name this package");
assert.equal(inserts[0].insert[0].id, "dsh-switchman-ui");
assert.equal(overrides.length, 4, "expected 4 id-targeted preset overrides");

const mineById = new Map();
for (const entry of overrides) {
	assert.equal(entry.name, "@deepseek-ai/dsh-agent-preset");
	mineById.set(entry.id, entry.config);
}

const suffixes = [];
for (const pid of PRESETS) {
	const rowId = `preset-${pid}`;
	assert.ok(mineById.has(rowId), `missing override for ${rowId}`);
	const cfg = mineById.get(rowId);
	const shippedRow = load(`${SHIPPED_DIR}/${pid}.patch.yml`)[0]?.insert?.[0]?.config;
	assert.ok(
		shippedRow && Array.isArray(shippedRow.plugins),
		`${pid}: shipped preset file has an unexpected shape (did DSH change its presets?)`,
	);
	const shipped = shippedRow;

	for (const key of new Set([...Object.keys(cfg), ...Object.keys(shipped)])) {
		if (key === "plugins") continue;
		assert.deepEqual(cfg[key], shipped[key], `${pid}: field "${key}" differs from shipped`);
	}

	const suffix = personaSuffix(cfg.plugins);
	const shippedSuffix = personaSuffix(shipped.plugins);
	assert.equal(typeof suffix, "string", `${pid}: persona suffix missing`);
	assert.ok(suffix.includes("dsh-switchman"), `${pid}: doctrine absent from suffix`);
	assert.ok(suffix.startsWith((shippedSuffix ?? "").replace(/\n+$/, "")), `${pid}: shipped suffix prefix lost`);
	suffixes.push(suffix);

	const a = stripSuffix(cfg.plugins);
	const b = stripSuffix(shipped.plugins);
	try {
		assert.deepEqual(a, b, `${pid}: plugins differ from shipped`);
	} catch (err) {
		writeFileSync(`/tmp/mine_${pid}.json`, JSON.stringify(a, null, 1));
		writeFileSync(`/tmp/shipped_${pid}.json`, JSON.stringify(b, null, 1));
		throw new assert.AssertionError({
			message: `${pid}: plugins differ (see /tmp/mine_${pid}.json vs /tmp/shipped_${pid}.json)`,
		});
	}
}

assert.equal(new Set(suffixes).size, 1, "persona suffixes are not identical across presets");

// --- package.json: client-half discovery surface (regression guard) ---
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
assert.equal(pkg.name, "dsh-switchman", "package name changed");
const exportsMap = pkg.exports ?? {};
assert.equal(exportsMap["."], "./index.js", 'exports["."] must stay "./index.js"');
assert.equal(
	exportsMap["./client"],
	"./client.js",
	'exports["./client"] must stay "./client.js" — the client-module scan throws without it',
);
assert.equal(
	exportsMap["./package.json"],
	"./package.json",
	'exports["./package.json"] must stay exposed — the discovery probe resolve("<pkg>/package.json") silently fails otherwise',
);
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", 'dsh.bundle.patch must stay "./cordis.patch.yml"');
const decl = pkg.dsh?.client;
assert.ok(decl && decl.platform === "web", "dsh.client.platform must be web");
assert.ok(
	Array.isArray(decl.inject) &&
		decl.inject.includes("@deepseek-ai/dsh-client-locale") &&
		decl.inject.includes("@deepseek-ai/dsh-client-ui-conversation"),
	"dsh.client.inject must list both the locale and conversation client halves (client.js injects the locale face)",
);
for (const target of ["index.js", "client.js"]) {
	assert.ok(existsSync(fileURLToPath(new URL(`../${target}`, import.meta.url))), `${target} is missing`);
}

console.log("OK: 4 overrides parse, match shipped presets, share one doctrine suffix");
console.log("OK: package.json keeps the client-half discovery surface (exports + dsh.client)");
console.log(`doctrine suffix length: ${suffixes[0].length} chars`);
