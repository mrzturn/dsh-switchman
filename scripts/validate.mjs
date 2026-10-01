#!/usr/bin/env node
/**
 * Validate dsh-switchman's cordis.patch.yml, index.js, and package.json.
 *
 * Checks:
 * 1. The patch parses as a YAML array of 4 id-targeted loader overrides
 *    plus exactly 1 insert row (this bundle's own Host-half plugin row).
 * 2. Every preset's config matches the shipped preset file verbatim, except
 *    the persona suffix, which must extend the shipped suffix with the
 *    dsh-switchman doctrine.
 * 3. All four persona suffixes resolve to the same string (shared anchor).
 * 4. package.json keeps the client-half discovery surface intact: the
 *    "./client" and "./package.json" exports and the dsh.client declaration
 *    are hard requirements of the Host's client-module scan
 *    (@deepseek-ai/dsh-client-modules); dropping any of them makes the
 *    session-header badge silently vanish (server 404, no console errors).
 * 5. Every skills/<name>/ directory carries a parseable SKILL.md whose
 *    frontmatter name matches the directory, and db-query keeps its
 *    scripts/ and references/ intact.
 *
 * Layout note: DSH Desktop ≤0.1.7 shipped a plain `app/node_modules` tree;
 * the renamed DeepSeek Harness app packs the same tree into `app.asar`
 * (with native modules in `app.asar.unpacked`). Shipped presets are read
 * from whichever layout DSH_APP_ROOT points at.
 */
import assert from "node:assert";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = process.env.DSH_APP_ROOT ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app";
const MINE = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));
const PRESETS = ["standard", "ptc", "minimal", "cordis"];

// --- YAML import: legacy app tree → active profile workspace → bare specifier
const YAML_CANDIDATES = [
	`${APP_ROOT}/node_modules/yaml/dist/index.js`,
	`${homedir()}/.dsh/profiles/web/node_modules/yaml/dist/index.js`,
];
let YAML;
for (const candidate of YAML_CANDIDATES) {
	if (existsSync(candidate)) {
		YAML = (await import(candidate)).default;
		break;
	}
}
if (YAML === undefined) YAML = (await import("yaml")).default;

/** Read one file out of an asar archive (plain header walk, no dependency). */
function readAsarFile(asarPath, innerPath) {
	const fd = openSync(asarPath, "r");
	try {
		const head = Buffer.alloc(8);
		readSync(fd, head, 0, 8, 0);
		const headerSize = head.readUInt32LE(4);
		const headerBuffer = Buffer.alloc(headerSize);
		readSync(fd, headerBuffer, 0, headerSize, 8);
		const text = headerBuffer.toString("utf8");
		const header = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
		let node = header;
		for (const segment of innerPath.split("/")) {
			node = node.files[segment];
			if (node === undefined) return undefined;
		}
		if (node.files !== undefined || node.unpacked) return undefined;
		const buffer = Buffer.alloc(node.size);
		readSync(fd, buffer, 0, node.size, 8 + headerSize + Number(node.offset));
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** One shipped preset's patch text: legacy app tree first, then the asar. */
function readShippedPatch(pid) {
	const plain = `${APP_ROOT}/node_modules/@deepseek-ai/dsh-web-app/presets/${pid}.patch.yml`;
	if (existsSync(plain)) return readFileSync(plain, "utf8");
	return readAsarFile(`${APP_ROOT}.asar`, `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/${pid}.patch.yml`);
}

const load = (path) =>
	YAML.parse(path, {
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

const mine = load(readFileSync(MINE, "utf8"));
assert.ok(Array.isArray(mine), "patch must be a YAML array");

const inserts = mine.filter((entry) => "insert" in entry);
const overrides = mine.filter((entry) => !("insert" in entry));
assert.equal(
	inserts.length,
	1,
	"expected exactly 1 insert entry (the bundle's own Host-half plugin row)",
);
assert.equal(inserts[0].insert.length, 1);
assert.equal(inserts[0].insert[0].name, "dsh-switchman", "insert row must name this package");
assert.equal(inserts[0].insert[0].id, "dsh-switchman-host");
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
	const shippedText = readShippedPatch(pid);
	assert.ok(shippedText !== undefined, `${pid}: cannot read the shipped preset (wrong DSH_APP_ROOT?)`);
	const shippedRow = load(shippedText)[0]?.insert?.[0]?.config;
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

// --- bundled skills: same parse subset as index.js, shape + assets intact ---
const INDEX_SOURCE = readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
assert.match(INDEX_SOURCE, /inject\s*=\s*\[\s*"skills"\s*\]/u, "index.js must inject the skills service");
assert.match(
	INDEX_SOURCE,
	/registerProvider/u,
	"index.js must register its skill provider through ctx.skills.registerProvider",
);

const parseFrontmatter = (raw, path) => {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	assert.ok(frontmatter, `${path}: missing YAML frontmatter`);
	const fields = {};
	for (const line of frontmatter[1].split(/\r?\n/u)) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
		if (match === null) continue;
		let value = match[2].trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		fields[match[1]] = value;
	}
	return fields;
};

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
	.map((entry) => entry.name);
assert.ok(skillDirs.length > 0, "skills/ is empty — the bundled skills disappeared");
for (const skillName of skillDirs) {
	const skillMd = join(SKILLS_DIR, skillName, "SKILL.md");
	assert.ok(existsSync(skillMd), `${skillName}: SKILL.md is missing`);
	const fields = parseFrontmatter(readFileSync(skillMd, "utf8"), skillMd);
	assert.equal(fields.name, skillName, `${skillName}: frontmatter name must match the directory name`);
	assert.ok(fields.description?.length > 0, `${skillName}: frontmatter description is empty`);
}
for (const asset of [
	"db-query/scripts/mysql-query.js",
	"db-query/scripts/redis-query.js",
	"db-query/scripts/setup.sh",
	"db-query/scripts/lib/mysql-readonly.js",
	"db-query/scripts/lib/redis-readonly.js",
	"db-query/references/mysql.md",
	"db-query/references/redis.md",
	"db-query/references/security.md",
	"requirement-docs/references/templates.md",
]) {
	assert.ok(existsSync(join(SKILLS_DIR, asset)), `skills/${asset} is missing`);
}

console.log("OK: 4 overrides parse, match shipped presets, share one doctrine suffix");
console.log("OK: package.json keeps the client-half discovery surface (exports + dsh.client)");
console.log(`OK: ${skillDirs.length} bundled skill(s) parse with intact assets: ${skillDirs.join(", ")}`);
console.log(`doctrine suffix length: ${suffixes[0].length} chars`);
