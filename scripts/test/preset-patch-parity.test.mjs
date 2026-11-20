// Preset-seed and fail-open parity guards.
//
// Three surfaces must stay in lockstep with the schema defaults in
// host/config.js:
//   1. the factory patch seed (cordis.patch.yml, dsh-switchman-host config
//      block) — a fresh install receives these values verbatim, so any drift
//      means fresh installs silently diverge from the documented defaults;
//   2. the trim loop's readNumber fallbacks (host/context-trim/index.js) —
//      the fail-open values used when a config read fails;
//   3. the trigger tier fallbacks (host/context-trim/trigger.js) — same
//      fail-open class for the growth/pressure/emergency/increment gates.
//
// These mirrors drifted twice during the 2026-11-20 defaults promotion
// (patch seed stayed at 45000, trim fallbacks stayed at 25000/45000/65/95),
// which this test makes impossible to repeat silently.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// Extract top-level schema defaults (exactly one leading tab => top level;
// deeper-indented nested schemas are excluded by the anchor).
function schemaDefaults(configSrc) {
  const map = new Map();
  for (const m of configSrc.matchAll(/^\t(\w+): z\.boolean\(\)[^\n]*?\.default\((true|false)\)/gm)) {
    map.set(m[1], m[2] === "true");
  }
  for (const m of configSrc.matchAll(/^\t(\w+): z\.number\(\)[^\n]*?\.default\((\d[\d_]*(?:\.\d+)?)\)/gm)) {
    map.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  for (const m of configSrc.matchAll(/^\t(\w+): z\.(?:enum|string|union)\([^)]*\)[^\n]*?\.default\("([^"]+)"\)/gm)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

function parsePatchSeed(patchSrc) {
  const lines = patchSrc.split("\n");
  const row = lines.findIndex((l) => l.includes("- id: dsh-switchman-host"));
  assert.ok(row >= 0, "patch seed row (dsh-switchman-host) not found");
  // The config block starts at the 6-space `config:` key under the seed row;
  // its own entries are flat 8-space `key: value` lines.
  const cfg = row + lines.slice(row).findIndex((l) => /^      config:\s*$/.test(l));
  assert.ok(cfg > row, "config block not found under patch seed row");
  const seed = new Map();
  for (let i = cfg + 1; i < lines.length; i++) {
    const m = lines[i].match(/^        ([A-Za-z]\w*): (.+?)\s*$/);
    if (!m) break;
    const raw = m[2];
    if (raw === "true" || raw === "false") seed.set(m[1], raw === "true");
    else if (/^-?\d[\d_]*(\.\d+)?$/.test(raw)) seed.set(m[1], Number(raw));
    else seed.set(m[1], raw.replace(/^"(.*)"$/, "$1"));
  }
  return seed;
}

test("factory patch seed mirrors schema defaults", () => {
  const defaults = schemaDefaults(read("host/config.js"));
  const seed = parsePatchSeed(read("cordis.patch.yml"));
  assert.ok(seed.size >= 25, `patch seed suspiciously small (${seed.size} keys)`);
  for (const [key, value] of seed) {
    assert.ok(defaults.has(key), `patch seed pins unknown key: ${key}`);
    assert.equal(value, defaults.get(key), `patch seed ${key} drifts from schema default`);
  }
  assert.ok(seed.has("trimIncrementTokens"), "patch seed must pin trimIncrementTokens");
});

test("trim readNumber fallbacks mirror schema defaults", () => {
  const defaults = schemaDefaults(read("host/config.js"));
  const src = read("host/context-trim/index.js");
  let checked = 0;
  for (const m of src.matchAll(/readNumber\(config, "(trim\w+)",\s*(\d[\d_]*(?:\.\d+)?)\)/g)) {
    const key = m[1];
    assert.ok(defaults.has(key), `readNumber fallback for unregistered key: ${key}`);
    assert.equal(Number(m[2].replace(/_/g, "")), defaults.get(key), `readNumber fallback ${key} drifts from schema default`);
    checked++;
  }
  assert.ok(checked >= 8, `too few readNumber fallbacks checked (${checked})`);
});

test("trigger tier fallbacks mirror schema defaults", () => {
  const defaults = schemaDefaults(read("host/config.js"));
  // trigger.js local names -> [threshold key, schema key]. incrementGate reads
  // thresholds.incrementTokens (the increment floor), the rest are 1:1.
  const locals = { pressurePercent: ["pressurePercent", "trimPressurePercent"], emergencyPercent: ["emergencyPercent", "trimEmergencyPercent"], incrementGate: ["incrementTokens", "trimIncrementTokens"], growthTokens: ["growthTokens", "trimGrowthTokens"], maxFoldsPerHour: ["maxFoldsPerHour", "trimMaxFoldsPerHour"] };
  const src = read("host/context-trim/trigger.js");
  for (const [local, [tkey, skey]] of Object.entries(locals)) {
    const m = src.match(new RegExp(`thresholds\\.${tkey} > 0 \\? thresholds\\.${tkey} : ([\\d_]+)`));
    assert.ok(m, `trigger fallback for ${local} not found`);
    assert.equal(Number(m[1].replace(/_/g, "")), defaults.get(skey), `trigger fallback ${local} (${skey}) drifts from schema default`);
  }
});
