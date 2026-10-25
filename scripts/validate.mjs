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
 * 6. Bundle isolation: package.json declares NO ordinary runtime
 *    dependencies — @deepseek-ai/schemastery stays a peerDependency, so an
 *    install can never hoist a second copy into the profile root and shadow
 *    the host's (the mechanism that crashed dshmarket while 1.7.0 shipped
 *    schemastery as a dependency).
 * 7. KV-cache stability: the watermark protocol texts stay digit-free and
 *    deterministic, ok tier renders "", and the live numbers go only through
 *    the systemPrompt.context tail channel (see host/context-watch.js).
 * 8. Intent layer: the OFF-resident adapter (listModels hides the group,
 *    the null route throws the documented error), the effectiveContextWindow
 *    0.8 handover floor, the intent-state overflow-risk probe (normal /
 *    null / throwing resolveModelInfo), and the 11-dictionary surface.
 *
 * Layout note: DSH Desktop ≤0.1.7 shipped a plain `app/node_modules` tree;
 * the renamed DeepSeek Harness app packs the same tree into `app.asar`
 * (with native modules in `app.asar.unpacked`). Shipped presets are read
 * from whichever layout DSH_APP_ROOT points at.
 */
import assert from "node:assert";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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
// The shipped-preset comparison needs the local DSH Desktop install; allow
// skipping it on CI (no /Applications/DeepSeek Harness.app there).
const SKIP_HOST_CHECK = process.env.DSH_SKIP_HOST_CHECK === "1";
if (SKIP_HOST_CHECK) {
	console.log("SKIP: shipped-preset comparison (DSH_SKIP_HOST_CHECK=1)");
} else {
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
}

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

// --- npm publish / marketplace readiness --------------------------------
// The market display path reads <package>/locale/en.json (+ <lang>.json
// siblings) and package.json's `icon` (dsh-app-boot readPluginMeta); the
// client-module scan additionally needs the ./locale/*.json export exposed.
assert.equal(pkg.private, undefined, "package.json must not stay private for npm publishing");
assert.equal(pkg.dsh?.manifestVersion, 1, "dsh.manifestVersion must be 1");
assert.equal(typeof pkg.engines?.dsh, "string", "engines.dsh must be declared as a SemVer range");
// --- bundle isolation invariant (the dshmarket conflict, 2026-10) ----------
// dsh-switchman must ship ZERO ordinary runtime dependencies. Host-plane
// packages (@deepseek-ai/schemastery, cordis, dsh-*) are provided by the
// running DSH and must be declared as peerDependencies only: the runtime
// resolver answers a peer import from the host's own copy, while an ordinary
// dependency is physically installed into the profile workspace
// (<profile>/node_modules/@deepseek-ai/schemastery) where it SHADOWS the
// host copy for every other profile-resident package — dshmarket included.
// That dual-instance split is what crashed the plugin market while 1.7.0
// carried schemastery as a dependency. A future `dependencies` entry (or a
// bundled transitive one) reintroduces the conflict class.
assert.deepEqual(
	pkg.dependencies ?? {},
	{},
	"dsh-switchman must declare NO runtime dependencies — host-plane packages go to peerDependencies (profile-root hoisting shadows the host's copy and crashes dshmarket)",
);
assert.equal(
	pkg.peerDependencies?.["@deepseek-ai/schemastery"],
	"^3.18.1",
	"@deepseek-ai/schemastery must stay a peerDependency with the ecosystem range ^3.18.1 (same range dshmarket declares)",
);
assert.equal(
	exportsMap["./locale/*.json"],
	"./locale/*.json",
	'exports["./locale/*.json"] must stay exposed for the plugin-meta locale scan',
);
const ICON = fileURLToPath(new URL("../icon.svg", import.meta.url));
assert.ok(existsSync(ICON), "icon.svg is missing");
assert.ok(statSync(ICON).size <= 256 * 1024, "icon.svg exceeds the 256 KiB plugin-meta limit");
for (const published of [
	"index.js",
	"client.js",
	"host/",
	"skills/db-query/SKILL.md",
	"skills/db-query/scripts",
	"skills/git-commit-message/SKILL.md",
	"skills/requirement-docs/SKILL.md",
	"locale/",
	"icon.svg",
	"cordis.patch.yml",
]) {
	assert.ok(pkg.files?.includes(published), `package.json files must include "${published}"`);
}
for (const lang of ["en", "zh"]) {
	const metaPath = fileURLToPath(new URL(`../locale/${lang}.json`, import.meta.url));
	assert.ok(existsSync(metaPath), `locale/${lang}.json is missing (plugin display meta)`);
	const meta = JSON.parse(readFileSync(metaPath, "utf8")).meta;
	assert.equal(typeof meta?.title, "string", `locale/${lang}.json: meta.title must be a string`);
	assert.ok(meta.title.length > 0, `locale/${lang}.json: meta.title is empty`);
	assert.equal(typeof meta?.description, "string", `locale/${lang}.json: meta.description must be a string`);
	assert.ok(meta.description.length > 0, `locale/${lang}.json: meta.description is empty`);
}
const HOST_CONFIG = fileURLToPath(new URL("../host/config.js", import.meta.url));
assert.ok(existsSync(HOST_CONFIG), "host/config.js is missing");
const CONFIG_SOURCE = readFileSync(HOST_CONFIG, "utf8");
assert.match(CONFIG_SOURCE, /export const Config = z\.object/u, "host/config.js must export the Config schema");
assert.match(
	CONFIG_SOURCE,
	/import z from "@deepseek-ai\/schemastery"/u,
	"host/config.js must build its schema on @deepseek-ai/schemastery",
);
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");
assert.match(CLIENT_SOURCE, /ctx\.locale\.register\(/u, "client.js must register its locale namespace");
assert.match(CLIENT_SOURCE, /ctx\.locale\.bind\(/u, "client.js must bind its locale namespace");

// --- bundled skills: same parse subset as index.js, shape + assets intact ---
const INDEX_SOURCE = readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
assert.match(INDEX_SOURCE, /inject\s*=\s*\[[^\]]*"skills"/u, "index.js must inject the skills service");
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

// ---- KV-cache stability guard (watermark head/tail split) -------------------
// The watermark's static protocol lives in systemPrompt.section (byte-stable
// request head); the live tier + bucketed used reading lives ONLY in the
// systemPrompt.context tail channel (append-only runtime-context snapshot).
// Any digit leaking into the protocol texts would churn the head per step and
// kill the prompt-cache prefix again — these assertions pin the invariant.

const cw = await import(new URL("../host/context-watch.js", import.meta.url));
for (const [name, text] of [
	["PROTOCOL_ROOT_TEXT", cw.PROTOCOL_ROOT_TEXT],
	["PROTOCOL_SUB_TEXT", cw.PROTOCOL_SUB_TEXT],
	["PAUSED_LINE", cw.PAUSED_LINE],
]) {
	assert.ok(text.length > 0, `${name} is empty`);
	assert.doesNotMatch(text, /\d/u, `${name} must stay digit-free (byte-stable head invariant)`);
}
const WM_TH = { soft: 50000, hard: 90000, force: 130000 };
assert.equal(cw.renderRootWatermark("ok", 12345, WM_TH, {}), "", "root watermark must be silent at ok tier");
assert.equal(cw.renderSubWatermark(12345, WM_TH), "", "sub watermark must be silent at ok tier");
for (const [level, used] of [
	["soft", 62000],
	["hard", 95000],
	["force", 131000],
]) {
	for (const status of [{}, { autoHandover: true, cooldownMin: 10 }, { phase: "compacting", attempt: 2 }]) {
		const a = cw.renderRootWatermark(level, used, WM_TH, status);
		const b = cw.renderRootWatermark(level, used, WM_TH, status);
		assert.equal(a, b, `renderRootWatermark(${level}) must be deterministic`);
		assert.ok(a.length > 0, `${level} tier must render a live root line`);
	}
	const s1 = cw.renderSubWatermark(used, WM_TH);
	const s2 = cw.renderSubWatermark(used, WM_TH);
	assert.equal(s1, s2, `renderSubWatermark(${level}) must be deterministic`);
	assert.ok(s1.length > 0, `${level} tier must render a live sub line`);
}
assert.match(cw.renderRootWatermark("soft", 62000, WM_TH, {}), /~60k/u, "used reading must be 5k-bucketed");
assert.equal(cw.bucketKilo(0), "0k", "bucketKilo(0) must be 0k");
assert.equal(cw.bucketKilo(52000), "50k", "bucketKilo(52000) must bucket down to 50k");
const cwSource = readFileSync(fileURLToPath(new URL("../host/context-watch.js", import.meta.url)), "utf8");
assert.match(cwSource, /ctx\.systemPrompt\.context\(\s*\{/u, "watermark must register the tail runtime-context channel");
assert.match(cwSource, /order:\s*300,/u, "tail context must sit after the core runtime-context placements");
assert.match(cwSource, /required:\s*true,\s*\n\s*interpolate:\s*false,/u, "tail context must survive suppressRuntimeContext and skip interpolation");
console.log("OK: watermark head protocol byte-stable; live numbers confined to the tail context line");

console.log(
	SKIP_HOST_CHECK
		? "OK: 4 overrides parse (shipped-preset comparison skipped)"
		: "OK: 4 overrides parse, match shipped presets, share one doctrine suffix",
);
console.log("OK: package.json keeps the client-half discovery surface (exports + dsh.client)");
console.log("OK: npm/market surface (icon, locale meta, files, peer-only schemastery, manifestVersion)");
console.log("OK: bundle isolation (zero runtime dependencies — host packages are peers, no profile-root shadowing)");
console.log(`OK: ${skillDirs.length} bundled skill(s) parse with intact assets: ${skillDirs.join(", ")}`);
if (!SKIP_HOST_CHECK) console.log(`doctrine suffix length: ${suffixes[0].length} chars`);

// ---- intent layer: OFF-resident adapter, window floor, state enrichment ----
const intent = await import(new URL("../host/intent.js", import.meta.url));

// effectiveContextWindow: the 0.8 handover floor, its opt-out, defaults, clamp.
assert.equal(intent.effectiveContextWindow({}), 200000, "empty config keeps the 200000 default window");
assert.equal(
	intent.effectiveContextWindow({ wmAutoHandover: true, intentContextWindow: 100000 }),
	187500,
	"default wmForceTokens path: floor = ceil(150000 / 0.8) must lift a small window",
);
// Boundary equality: with the default wmForceTokens the floor is the SMALLEST
// window whose 0.8 auto-compaction line still reaches the force watermark —
// 0.8 x 187500 = 150000 lands exactly on force (ceil exactness, not overshoot).
const defaultForceFloor = Math.ceil(150000 / 0.8);
assert.equal(defaultForceFloor, 187500, "default force floor is exactly ceil(150000 / 0.8)");
assert.ok(0.8 * defaultForceFloor >= 150000, "0.8 x floor reaches force (equality holds at the boundary)");
assert.ok(0.8 * (defaultForceFloor - 1) < 150000, "one token less would drop the 0.8 line below force — floor is minimal");
assert.equal(
	intent.effectiveContextWindow({ wmAutoHandover: true, intentContextWindow: 100000, wmForceTokens: 200000 }),
	250000,
	"explicit wmForceTokens drives the floor",
);
assert.equal(
	intent.effectiveContextWindow({ wmAutoHandover: true, intentContextWindow: 400000 }),
	400000,
	"a larger user window wins over the floor",
);
assert.equal(
	intent.effectiveContextWindow({ wmAutoHandover: false, intentContextWindow: 100000, wmForceTokens: 200000 }),
	100000,
	"wmAutoHandover=false must not lift the window",
);
assert.equal(intent.effectiveContextWindow({ intentContextWindow: 500 }), 1024, "window clamps up to 1024");

// Minimal cordis-flavored mock: ctx.inject(["llm"], cb) runs cb at once with
// a fake llm fiber; the registered adapter is captured for direct probing.
function mountAutoAdapter(config) {
	const mounted = [];
	const llmFiber = {
		llm: {
			registerAdapter: (_providers, adapter) => {
				mounted.push(adapter);
				return () => {};
			},
			prepareCall: () => {},
			stream: () => {},
		},
		effect: () => {},
		on: () => {},
	};
	const ctx = {
		logger: { warn: () => {} },
		inject: (_deps, body) => body(llmFiber),
		get: () => null,
	};
	intent.applyIntent(ctx, config);
	assert.equal(mounted.length, 1, "applyIntent must register the adapter");
	return mounted[0];
}

// P1: OFF keeps the adapter mounted but hides the catalog group; the flag is
// read at CALL time (a mount-time snapshot regression must turn this red).
let intentOn = false;
const liveAdapter = mountAutoAdapter({ intentEnabled: { get: () => intentOn } });
assert.deepEqual(await liveAdapter.listModels("dsh-switchman-auto"), [], "OFF listModels must hide the Auto group");
intentOn = true;
assert.equal(
	(await liveAdapter.listModels("dsh-switchman-auto")).length,
	1,
	"the SAME adapter must expose the Auto entry the moment the flag flips ON",
);
assert.equal(
	(await liveAdapter.resolveModel("dsh-switchman-auto", "auto")).context.contextWindow,
	200000,
	"resolveModel declares the effective window",
);
const offAdapter = liveAdapter;

// P1: nothing routable → explicit error, not the old TypeError on route.provider.
await assert.rejects(
	() => offAdapter.stream({ sessionId: "validate-off-route" }).next(),
	/no route available.*pick a concrete model/u,
	"the null-route stream must throw the documented error",
);

// P3: intentStateOf enrichment — resolveModelInfo normal / null / throwing tri-state.
const probeCalls = [];
const llmMock = {
	// Method shorthand on purpose: a detached call (const fn = llm.resolveModelInfo)
	// loses `this`, the assert below throws inside intentStateOf's per-candidate
	// catch, every window reads as null, and the outer minCandidateWindow
	// assertion fails — pinning the receiver-bound contract from vision.js.
	resolveModelInfo: async function probe(provider, model) {
		assert.equal(this, llmMock, "resolveModelInfo must stay receiver-bound");
		probeCalls.push(`${provider}/${model}`);
		if (provider === "boom") throw new Error("resolve failed");
		if (model === "opaque") return { name: model }; // no context → don't know
		return { context: { contextWindow: model === "wide" ? 400000 : 64000 } };
	},
};
const stateCtx = { get: (name) => (name === "llm" ? llmMock : null) };
const state = await intent.intentStateOf(
	stateCtx,
	{
		intentEnabled: true,
		wmAutoHandover: true,
		wmForceTokens: 130000,
		intentCandidates: [
			{ provider: "ok", model: "wide" },
			{ provider: "boom", model: "x" },
			{ provider: "ok", model: "opaque" },
			{ provider: "ok", model: "small" },
		],
	},
	null,
);
assert.equal(state.context.contextWindow, 200000, "intent-state reports the effective window");
assert.equal(state.context.minCandidateWindow, 64000, "probe keeps the smallest KNOWN window (null probes skipped)");
assert.equal(state.context.minCandidateModel, "small", "probe names the narrowest candidate");
assert.equal(state.context.overflowRisk, true, "64000 < 130000 flags overflow risk");
assert.deepEqual(
	probeCalls,
	["ok/wide", "boom/x", "ok/opaque", "ok/small"],
	"probes run sequentially over every candidate",
);

// Above the watermark → no risk; missing llm service → don't know, never throws.
const safeState = await intent.intentStateOf(
	stateCtx,
	{ intentCandidates: [{ provider: "ok", model: "wide" }] },
	null,
);
assert.equal(safeState.context.minCandidateWindow, 400000, "a known wide window is reported");
assert.equal(safeState.context.overflowRisk, false, "default wmForceTokens path: 400000 >= 150000 is not risky");
const noLlmState = await intent.intentStateOf(
	{ get: () => null },
	{ intentCandidates: [{ provider: "ok", model: "wide" }] },
	null,
);
assert.equal(noLlmState.context.minCandidateWindow, null, "missing llm service reads as don't know");
assert.equal(noLlmState.context.minCandidateModel, null, "no window → no model named");
assert.equal(noLlmState.context.overflowRisk, false, "don't know never flags risk");

// P2/P3 client surface: every inline dictionary carries the new key and the
// amended help text (11 dictionaries: zh/en DICTS + 9 EXTRA_UI_DICTS).
const overflowRiskKeys = CLIENT_SOURCE.match(/intentDockOverflowRisk:/gu) ?? [];
assert.equal(overflowRiskKeys.length, 11, "all 11 dictionaries must define intentDockOverflowRisk");
const windowHelps = CLIENT_SOURCE.match(/intentContextWindowHelp:/gu) ?? [];
assert.equal(windowHelps.length, 11, "all 11 dictionaries must define intentContextWindowHelp");
assert.match(
	CLIENT_SOURCE,
	/当 0\.8×窗口低于 force 水位时生效值会自动抬升/u,
	"zh intentContextWindowHelp must explain the floor",
);
// Heuristic floor for the other 10 locales: every amended help mentions the
// 0.8 ratio (decimal-comma variants included). ≥11 keeps a dropped locale red;
// pre-existing mentions elsewhere only inflate, never mask a full miss.
const ratioMentions = CLIENT_SOURCE.match(/0[.,]8/gu) ?? [];
assert.ok(ratioMentions.length >= 11, "every intentContextWindowHelp should mention the 0.8 ratio");
assert.match(
	CLIENT_SOURCE,
	/minCandidateWindow|overflowRisk/u,
	"the dock mapping must pass the overflow-risk fields through",
);
console.log("OK: intent layer (OFF-resident adapter, 0.8 window floor, overflow-risk probe, 11-dict surface)");
