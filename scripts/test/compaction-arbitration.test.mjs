/**
 * Compaction arbitration tests (option A).
 *
 * cordis.patch.yml pins `auto: false` on every compaction-basic row: the
 * engine's AUTOMATIC triggers (agent/pre-step pressure + the overflow retry)
 * never register, while the compaction SERVICE stays mounted so the manual
 * /compact command and the context-watch handover borrow keep working.
 * These tests lock that contract:
 *  - every preset override carries exactly { auto: false } on compaction-basic;
 *  - the compaction group still isolates and mounts the compaction service;
 *  - the /compact command row survives next to it;
 *  - host/context-watch.js still borrows the per-agent compact command;
 *  - when the installed DSH app is readable, the shipped engine still gates
 *    its triggers on config.auto defaulting true (DSH-update drift guard —
 *    validate.mjs enforces the same guard on non-skipped runs).
 */
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// scripts/test/<file>.test.mjs → repo root is three levels up.
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PATCH = join(REPO, "cordis.patch.yml");
const APP_ROOT = process.env.DSH_APP_ROOT ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app";

// Zero runtime deps: borrow the yaml parser from the installed app (same
// resolution strategy as scripts/validate.mjs). Without it the YAML checks
// report as skipped rather than passing vacuously.
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
if (typeof YAML?.parse !== "function") {
	// Same final fallback as scripts/validate.mjs (resolvable from the
	// harness runtime without a repo-local dependency).
	try {
		YAML = (await import("yaml")).default;
	} catch {
		/* stays undefined → the YAML checks report as skipped */
	}
}
const noYaml = typeof YAML?.parse !== "function" ? "yaml runtime unavailable (CI fail-open skip)" : false;

/** Parse the patch with validate.mjs's !!js shim (values unused; tags must not throw). */
const loadPatch = () =>
	YAML.parse(readFileSync(PATCH, "utf8"), {
		customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (str) => `!!js ${str}` }],
	});

/** One compaction-group row of one preset override. */
const compactionRow = (presetId, rowId) => {
	const entry = loadPatch().find((row) => row.id === `preset-${presetId}`);
	assert.ok(entry, `missing override for preset-${presetId}`);
	const group = entry.config.plugins.find((row) => row.id === "compaction" && row.group === true);
	assert.ok(group, `preset-${presetId}: compaction group missing`);
	return { group, row: group.config.find((child) => child.id === rowId) };
};

/** Read one file out of an asar archive (plain header walk, no dependency;
 * mirrors scripts/validate.mjs readAsarFile). */
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

/** The shipped compaction-basic engine source: app tree first, then asar;
 * undefined when the installed app is not readable (CI). */
function shippedEngineSource() {
	const plain = `${APP_ROOT}/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`;
	if (existsSync(plain)) return readFileSync(plain, "utf8");
	if (existsSync(`${APP_ROOT}.asar`)) {
		// The app bundles sources under the dsh/ prefix inside the asar.
		return readAsarFile(`${APP_ROOT}.asar`, "dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js");
	}
	return undefined;
}

const PRESETS = ["standard", "ptc", "minimal", "cordis"];

describe("compaction arbitration (option A)", () => {
	test("every preset silences compaction-basic automatic triggers", { skip: noYaml }, () => {
		for (const pid of PRESETS) {
			const { row } = compactionRow(pid, "compaction-basic");
			assert.ok(row, `${pid}: compaction-basic row missing`);
			assert.deepEqual(
				row.config,
				{ auto: false },
				`${pid}: compaction-basic config must be exactly { auto: false }`,
			);
		}
	});

	test("compaction service and manual /compact stay mounted", { skip: noYaml }, () => {
		for (const pid of PRESETS) {
			const { group, row } = compactionRow(pid, "command-compact");
			assert.equal(group.isolate?.compaction, true, `${pid}: isolate.compaction lost — service would not mount`);
			assert.ok(row, `${pid}: command-compact row missing — manual /compact lost`);
			assert.equal(row.name, "@deepseek-ai/dsh-command-compact");
		}
	});

	test("handover borrow path still targets the borrowed compact command", () => {
		const source = readFileSync(join(REPO, "host", "context-watch.js"), "utf8");
		assert.ok(
			source.includes('ctx.commands.find(agent, "compact")'),
			"handover borrow call missing from host/context-watch.js",
		);
	});

	test("shipped engine still gates automatic triggers on config.auto", {
		skip: shippedEngineSource() === undefined ? "installed DSH app unavailable (CI fail-open skip)" : false,
	}, () => {
		const source = shippedEngineSource();
		assert.ok(
			source.includes("if (this.config.auto)"),
			"shipped engine no longer gates auto triggers on this.config.auto",
		);
		assert.ok(
			source.includes("auto: config.auto ?? true"),
			"shipped engine no longer defaults auto to true",
		);
	});
});
