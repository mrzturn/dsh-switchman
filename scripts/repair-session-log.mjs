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
 * loader runs), and it validates the FINAL artifact (zstd frames included), not a
 * plaintext preview — a whole-file single frame is rejected by the loader even when
 * the events are valid, so the encoded bytes must be the thing under test.
 *
 * The verifier is a bundled file that resolves ../package.json relative to itself,
 * so it is staged in a directory that has that sibling (the staging trap that made
 * hand-rolled repair runs fail their verify step and silently skip the write).
 *
 * Usage:
 *   node scripts/repair-session-log.mjs <log.jsonl[.zstd] | session-dir | workspace-sessions-dir>...
 *        [--scan] [--write] [--verify-with <worker.cjs>] [--app-version <ver>] [--json]
 *
 *   default        dry run: report planned fixes and verify the encoded artifact, write nothing
 *   --scan         verify only: report which logs the loader would reject (no repair attempted)
 *   --write        repair in place: sibling .bak-<ts>, fsync + mode-preserving atomic rename
 *   --verify-with  path to the installed verifier worker (default: discover under
 *                  ~/.dsh/.dsh-switchman/*\/worker.cjs, else fail closed)
 *   --app-version  version to stamp into the staged verifier's package.json
 *                  (default: CFBundleShortVersionString of the installed app)
 *
 * Node builtins only: this file must never add runtime dependencies to the package.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { encodeFrames } from "./session-log-frames.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const firstFlag = argv.findIndex((a) => a.startsWith("--"));
const targets = argv.slice(0, firstFlag === -1 ? argv.length : firstFlag);
const doWrite = flag("--write");
const doScan = flag("--scan");
const verifyWith = value("--verify-with");
const appVersion = value("--app-version");
const asJson = flag("--json");

if (targets.length === 0) {
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
  return { target, stage };
}

function decodeThenCompress(file) {
  // Keep original frame layout untouched; callers only need the plaintext.
  return file.endsWith(".zstd")
    ? execFileSync("zstd", ["-dc", file], { maxBuffer: 1 << 30 })
    : fs.readFileSync(file);
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
  const lines = decodeThenCompress(file).toString("utf8").split("\n").filter(Boolean);
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

function verify(worker, target, compression, expectedId, expectedEventCount) {
  return new Promise((resolve) => {
    const w = new Worker(worker, { workerData: { path: target, compression, expectedId, expectedEventCount } });
    w.on("message", (m) => { resolve(m); w.terminate(); });
    w.on("error", (e) => resolve({ ok: false, message: "WORKER-ERROR: " + e.message }));
  });
}

function writeAtomically(file, bytes) {
  const st = fs.statSync(file);
  const tmp = file + ".tmp-" + Date.now();
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, st.mode & 0o777);
  return tmp;
}

const verifierSrc = verifyWith || discoverVerifier();
const staged = verifierSrc ? stageVerifier(verifierSrc, appVersion || installedAppVersion()) : null;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repair-work-"));
const logs = collectLogs(targets);
const report = [];
let failed = 0;

for (const log of logs) {
  const compressed = log.endsWith(".zstd");
  const entry = { log, ok: true, action: "none" };
  try {
    if (!staged && (doScan || doWrite)) {
      entry.ok = false;
      entry.error = "no verifier available (--verify-with <worker.cjs>); refusing to scan/write unverified";
      report.push(entry);
      failed++;
      continue;
    }
    const plan = planRepair(log);
    entry.id = plan.header.id;
    if (doScan) {
      // Verify the artifact exactly as the loader sees it (zstd frames included).
      const r = staged ? await verify(staged.target, log, compressed ? "zstd" : "none", plan.header.id, plan.eventCount) : null;
      entry.action = "scan";
      entry.ok = r ? r.ok : true;
      if (r && !r.ok) entry.error = r.message;
      report.push(entry);
      if (!entry.ok) failed++;
      continue;
    }
    const compression = compressed ? "zstd" : "none";
    const artifactOk = staged ? await verify(staged.target, log, compression, plan.header.id, plan.eventCount) : null;
    const fixes = plan.sourceFixes + plan.pruneFixes;
    if (fixes === 0 && (!artifactOk || artifactOk.ok)) {
      entry.action = "clean";
      report.push(entry);
      continue;
    }
    if (fixes === 0) entry.reframe = artifactOk.message;
    entry.fixes = { source: plan.sourceFixes, prune: plan.pruneFixes, droppedHead: plan.droppedHead };
    const finalBytes = encodeFrames(compressed, plan.repaired);
    const verified = path.join(tmpRoot, "artifact-" + path.basename(path.dirname(log)) + (compressed ? ".zstd" : ".jsonl"));
    fs.writeFileSync(verified, finalBytes);
    const r = staged ? await verify(staged.target, verified, compressed ? "zstd" : "none", plan.header.id, plan.eventCount) : null;
    entry.verified = r ? r.ok : false;
    if (staged && (!r || !r.ok)) {
      entry.ok = false;
      entry.error = r ? r.message : "verification did not run";
      failed++;
      report.push(entry);
      fs.rmSync(verified, { force: true });
      continue;
    }
    if (!doWrite) {
      entry.action = fixes > 0 ? "would-write" : "would-reframe";
      report.push(entry);
      fs.rmSync(verified, { force: true });
      continue;
    }
    const bak = log + ".bak-" + Date.now();
    fs.copyFileSync(log, bak);
    const tmpFinal = writeAtomically(log, finalBytes);
    fs.renameSync(tmpFinal, log);
    entry.action = fixes > 0 ? "wrote" : "reframed";
    entry.backup = bak;
    report.push(entry);
    fs.rmSync(verified, { force: true });
  } catch (err) {
    entry.ok = false;
    entry.error = String(err?.message ?? err);
    failed++;
    report.push(entry);
  }
}

if (asJson) {
  console.log(JSON.stringify({ verifier: verifierSrc, scanned: logs.length, failed, report }, null, 2));
} else {
  console.log(`logs=${logs.length} verifier=${verifierSrc ?? "(none)"} mode=${doScan ? "scan" : doWrite ? "write" : "dry-run"}`);
  for (const e of report) {
    const fix = e.fixes ? ` fixes=source:${e.fixes.source},prune:${e.fixes.prune}${e.fixes.droppedHead !== null ? `(head ${e.fixes.droppedHead})` : ""}` : "";
    const ver = e.verified === undefined ? "" : ` verified=${e.verified}`;
    console.log(`${e.ok ? "OK  " : "FAIL"} ${e.id ?? "?"} ${e.action}${fix}${ver}${e.error ? " — " + e.error : ""}`);
    if (e.backup) console.log(`     backup: ${e.backup}`);
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (staged) fs.rmSync(staged.stage, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
