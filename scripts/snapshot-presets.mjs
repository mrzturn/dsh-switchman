#!/usr/bin/env node
/**
 * Refresh the committed shipped-preset snapshots used by CI.
 *
 * scripts/validate.mjs compares cordis.patch.yml against the installed DSH's
 * factory presets when an app is available, and against these snapshots when
 * DSH_SKIP_HOST_CHECK=1 (CI has no installed app). Run this script on a
 * machine with the target DSH installed whenever the compat floor moves, then
 * commit the refreshed files:
 *
 *   node scripts/snapshot-presets.mjs
 *
 * The snapshots are byte-for-byte copies of the shipped preset files, plus a
 * snapshot.json manifest recording the app version they were taken from.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, loadYaml, readAppVersion, readShippedPatch } from "./dsh-app-source.mjs";

const PRESETS = ["standard", "ptc", "minimal", "cordis"];
const OUT_DIR = fileURLToPath(new URL("./fixtures/dsh-presets/", import.meta.url));

const YAML = await loadYaml();
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

const appVersion = readAppVersion();
if (appVersion === undefined) {
	console.error(`cannot read the installed DSH app version (wrong DSH_APP_ROOT? current: ${APP_ROOT})`);
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
for (const pid of PRESETS) {
	const text = readShippedPatch(pid);
	if (text === undefined) {
		console.error(`${pid}: cannot read the shipped preset (wrong DSH_APP_ROOT?)`);
		process.exit(1);
	}
	// A snapshot of garbage is worse than no snapshot: refuse anything that
	// does not parse into the factory preset shape validate.mjs expects.
	const row = load(text)[0]?.insert?.[0]?.config;
	if (!row || !Array.isArray(row.plugins)) {
		console.error(`${pid}: shipped preset file has an unexpected shape (did DSH change its presets?)`);
		process.exit(1);
	}
	const out = join(OUT_DIR, `${pid}.patch.yml`);
	writeFileSync(out, text);
	console.log(`wrote ${out} (${text.length} bytes)`);
}

const manifest = {
	dsh: appVersion,
	generatedAt: new Date().toISOString(),
	presets: PRESETS,
};
writeFileSync(join(OUT_DIR, "snapshot.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`wrote ${join(OUT_DIR, "snapshot.json")} (dsh ${appVersion})`);
