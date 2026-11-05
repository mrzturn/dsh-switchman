import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { encodeFrames, zstdFrame } from "../session-log-frames.mjs";

const header = '{"id":"s","version":4}';
const plain = Buffer.from([header, '{"type":"user/message","seq":1}', '{"type":"turn/end","seq":2}', ""].join("\n"), "utf8");

function hasZstd() {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("zstd encoding keeps the header alone in the first frame", (t) => {
  if (!hasZstd()) return t.skip("zstd CLI unavailable");
  const encoded = encodeFrames(true, plain);
  const headerFrame = zstdFrame(Buffer.from(header + "\n"));
  // The loader rejects a log whose first frame is not exactly the header line,
  // so a single whole-file frame must never pass this prefix check.
  assert.ok(encoded.subarray(0, headerFrame.length).equals(headerFrame),
    "first frame must be exactly the header line");
  assert.ok(encoded.length > headerFrame.length, "body must live in a subsequent frame");
  assert.deepEqual(execFileSync("zstd", ["-dc"], { input: encoded }), plain, "frames must round-trip");
});

test("plaintext logs pass through unchanged", () => {
  assert.equal(encodeFrames(false, plain), plain);
});
