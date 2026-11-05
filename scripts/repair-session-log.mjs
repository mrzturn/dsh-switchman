#!/usr/bin/env node
/**
 * Repair (or diagnose) DSH v4 session logs that the installed loader rejects with:
 *   A) "compaction checkpoint has no matching compaction/start"
 *   B) "compaction cannot shadow the protected system head"
 *
 * Both are produced by pre-1.10.2 context-trim surface folds (m00092): a folded
 * replacement user/message claimed source.kind "compact-checkpoint" without ever
 * emitting a durable compaction/start, and prune events could shadow the session's
 * protected system head seq.
 *
 * Fixes (event count and identity preserved):
 *   A) user/message source { kind: "compact-checkpoint", compactionId: "switchman-trim:*" }
 *      -> { kind: "user" }  (drop the unbacked relationship claim)
 *   B) compaction/prune shadowedSeqs containing the first system/message seq
 *      -> that seq removed (and shadowedRange.start/end advanced off it)
 *
 * Validation is delegated to the REAL installed verifier (the same worker the
 * loader runs). The verifier is a bundled file that resolves ../package.json
 * relative to itself, so it must be staged in a directory that has that
 * sibling — staging is handled here (this was the trap that made hand-rolled
 * repair runs fail their verify step and silently skip the write).
 *
 * Usage:
 *   node scripts/repair-session-log.mjs <log.jsonl[.zstd] | session-dir | workspace-sessions-dir>...
 *        [--scan] [--write] [--verify-with <worker.cjs>] [--app-version <ver>] [--json]
 *
 *   default        dry run: report the planned fixes, verify a repaired temp copy, write nothing
 *   --scan         verify only: report which logs the loader would reject (no repair attempted)
 *   --write        repair in place: sibling .bak-<ts>, then atomic tmp+rename
 *   --verify-with  path to the installed verifier worker (default: discover under
 *                  ~/.dsh/.dsh-switchman/*\/worker.cjs, else fail closed for --write)
 *   --app-version  version to stamp into the staged verifier's package.json
 *                  (default: CFBundleShortVersionString of the installed app)
 *
 * Zstd round-trip uses the system `zstd` CLI (same frame format as the reader).
 * Node builtins only: this file must never add runtime dependencies to the package.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const targets = argv.slice(0, argv.findIndex((a) => a.startsWith("--")) === -1 ? argv.length : argv.findIndex((a) => a.startsWith("--")));
const doWrite = flag("--write");
const doScan = flag("--scan");
const verifyWith = value("--verify-with");
const appVersion = value("--app-version");
const asJson = flag("--json");

if (targets.length === 0 || targets.some((t) => t.startsWith("--"))) {
  console.error("usage: node scripts/repair-session-log.mjs <log|dir>... [--scan] [--write] [--verify-with <worker.cjs>] [--app-version <ver>] [--json]");
  process.exit(2);
}

const LOG_NAME = "session.v4.jsonl.zstd";

function installedAppVersion() {
  try {
    const out = execFileSync("/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", "/Applications/DeepSeek Harness.app/Contents/Info.plist"],
      { encoding: "utf8" }).trim();
    return out || null;
  } catch { return null; }
}

function discoverVerifier() {
  const root = path.join(os.homedir(), ".dsh", ".dsh-switchman");
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "worker.cjs") return p;
    }
  }
  return null;
}

// The bundled verifier does createRequire(__filename)("../package.json").
// Stage it so that lookup resolves, otherwise every verify fails with
// "Cannot find module '../package.json'" and the caller wrongly sees a bad repair.
function stageVerifier(workerPath, version) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repair-verify-"));
  fs.mkdirSync(path.join(stage, "dist"));
  const target = path.join(stage, "dist", "worker.cjs");
  fs.copyFileSync(workerPath, target);
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "dsh-app", version: version || "0.0.0" }) + "\n");
  return target;
}

function decode(file) {
  return file.endsWith(".zstd")
    ? execFileSync("zstd", ["-dc", file], { maxBuffer: 1 << 30 })
    : fs.readFileSync(file);
}

function encode(file, plainPath) {
  return file.endsWith(".zstd")
    ? execFileSync("zstd", ["-19", "-c", plainPath], { maxBuffer: 1 << 30 })
    : fs.readFileSync(plainPath);
}

function collectLogs(targets) {
  const logs = [];
  for (const t of targets) {
    const st = fs.statSync(t);
    if (st.isFile()) { logs.push(t); continue; }
    const direct = path.join(t, LOG_NAME);
    if (fs.existsSync(direct)) { logs.push(direct); continue; }
    for (const e of fs.readdirSync(t, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(t, e.name, LOG_NAME);
      if (fs.existsSync(p)) logs.push(p);
    }
  }
  return logs.sort();
}

function planRepair(file) {
  const lines = decode(file).toString("utf8").split("\n").filter(Boolean);
  if (lines.length < 2) throw new Error("log has no events");
  const header = JSON.parse(lines[0]);
  let headSystemSeq = null;
  for (const l of lines.slice(1)) {
    const e = JSON.parse(l);
    if (e.type === "system/message") { headSystemSeq = e.seq; break; }
  }
  let sourceFixes = 0, pruneFixes = 0, droppedHead = null;
  const out = [lines[0]];
  for (const l of lines.slice(1)) {
    const e = JSON.parse(l);
    // v4 event families differ: user/message carries the message directly in data,
    // system/message and friends wrap it as data.message.
    const msg = e.type === "user/message" ? e.data : e.data?.message;
    if (msg?.source?.kind === "compact-checkpoint"
        && String(msg.source.compactionId ?? "").startsWith("switchman-trim:")) {
      msg.source = { kind: "user" };
      sourceFixes++;
    }
    if (e.type === "compaction/prune" && headSystemSeq !== null) {
      const seqs = e.data?.shadowedSeqs;
      if (Array.isArray(seqs) && seqs.includes(headSystemSeq)) {
        const kept = seqs.filter((s) => s !== headSystemSeq);
        e.data.shadowedSeqs = kept;
        const range = e.data.shadowedRange;
        if (range) {
          if (range.start === headSystemSeq) range.start = kept[0] ?? range.end;
          if (range.end === headSystemSeq) range.end = kept.at(-1) ?? range.start;
        }
        droppedHead = headSystemSeq;
        pruneFixes++;
      }
    }
    out.push(JSON.stringify(e));
  }
  const repaired = Buffer.from(out.join("\n") + "\n", "utf8");
  return { header, eventCount: out.length - 1, sourceFixes, pruneFixes, droppedHead, repaired };
}

function verify(worker, plainPath, expectedId, expectedEventCount) {
  return new Promise((resolve) => {
    const w = new Worker(worker, { workerData: { path: plainPath, compression: "none", expectedId, expectedEventCount } });
    w.on("message", (m) => { resolve(m); w.terminate(); });
    w.on("error", (e) => resolve({ ok: false, message: "WORKER-ERROR: " + e.message }));
  });
}

const verifierSrc = verifyWith || discoverVerifier();
const staged = verifierSrc ? stageVerifier(verifierSrc, appVersion || installedAppVersion()) : null;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repair-"));
const logs = collectLogs(targets);
const report = [];
let failed = 0;

for (const log of logs) {
  const entry = { log, ok: true, action: "none" };
  try {
    const plan = planRepair(log);
    entry.id = plan.header.id;
    if (doScan) {
      entries: {
        const preview = path.join(tmpRoot, "scan-" + path.basename(path.dirname(log)) + ".jsonl");
        fs.writeFileSync(preview, decode(log));
        const r = staged ? await verify(staged, preview, plan.header.id, plan.eventCount) : null;
        entry.action = "scan";
        entry.ok = r ? r.ok : true;
        if (r && !r.ok) entry.error = r.message;
      }
      report.push(entry);
      if (!entry.ok) failed++;
      continue;
    }
    if (plan.sourceFixes === 0 && plan.pruneFixes === 0) {
      entry.action = "clean";
      report.push(entry);
      continue;
    }
    entry.fixes = { source: plan.sourceFixes, prune: plan.pruneFixes, droppedHead: plan.droppedHead };
    const repairedPath = path.join(tmpRoot, "repaired-" + path.basename(path.dirname(log)) + ".jsonl");
    fs.writeFileSync(repairedPath, plan.repaired);
    if (staged) {
      const r = await verify(staged, repairedPath, plan.header.id, plan.eventCount);
      entry.verified = r.ok;
      if (!r.ok) {
        entry.ok = false;
        entry.error = r.message;
        failed++;
        report.push(entry);
        fs.rmSync(repairedPath, { force: true });
        continue;
      }
    } else if (doWrite) {
      entry.ok = false;
      entry.error = "no verifier available (--verify-with <worker.cjs>); refusing to write unverified repair";
      failed++;
      report.push(entry);
      fs.rmSync(repairedPath, { force: true });
      continue;
    }
    if (!doWrite) {
      entry.action = "would-write";
      report.push(entry);
      continue;
    }
    const bak = log + ".bak-" + Date.now();
    fs.copyFileSync(log, bak);
    const finalBytes = encode(log, repairedPath);
    const tmpFinal = log + ".tmp-" + Date.now();
    fs.writeFileSync(tmpFinal, finalBytes);
    fs.renameSync(tmpFinal, log);
    entry.action = "wrote";
    entry.backup = bak;
    report.push(entry);
  } catch (err) {
    entry.ok = false;
    entry.error = String(err?.message ?? err);
    failed++;
    report.push(entry);
  }
}

if (asJson) {
  console.log(JSON.stringify({ verifier: verifierSrc, staged, scanned: logs.length, failed, report }, null, 2));
} else {
  console.log(`logs=${logs.length} verifier=${verifierSrc ?? "(none)"} mode=${doScan ? "scan" : doWrite ? "write" : "dry-run"}`);
  for (const e of report) {
    const fix = e.fixes ? ` fixes=source:${e.fixes.source},prune:${e.fixes.prune}${e.fixes.droppedHead !== null ? `(head ${e.fixes.droppedHead})` : ""}` : "";
    const ver = e.verified === undefined ? "" : ` verified=${e.verified}`;
    console.log(`${e.ok ? "OK  " : "FAIL"} ${e.id ?? "?"} ${e.action}${fix}${ver}${e.error ? " — " + e.error : ""}`);
    if (e.backup) console.log(`     backup: ${e.backup}`);
  }
  if (staged && !doScan) console.log(`staged verifier: ${staged}`);
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
