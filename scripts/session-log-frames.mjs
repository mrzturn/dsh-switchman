/**
 * Zstd frame layout for DSH v4 session logs.
 *
 * The installed loader decodes `session.v4.jsonl.zstd` frame by frame and requires
 * the FIRST frame to contain exactly the header line (the session id/meta line):
 * otherwise it fails with "corrupt Zstandard session log: first frame is not
 * exactly one header line". A single frame holding the whole file is therefore
 * NOT loadable even when its events are valid.
 *
 * encodeFrames() writes: frame(header line + "\n") + frame(rest). The rest is one
 * frame because the reader concatenates decoded frames and parses lines, so the
 * exact split after the header is irrelevant.
 *
 * Node builtins + the system `zstd` CLI only (keeps the package dependency-free).
 */
import { execFileSync } from "node:child_process";

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function zstdFrame(buf) {
  return execFileSync("zstd", ["-19", "-c"], { input: buf, maxBuffer: 1 << 30 });
}

/** Encode plaintext JSONL bytes into the loader-compatible frame sequence. */
export function encodeFrames(compressed, plaintext) {
  if (!compressed) return plaintext;
  const nl = plaintext.indexOf(0x0a);
  if (nl < 0) throw new Error("session log has no header line");
  return Buffer.concat([
    zstdFrame(plaintext.subarray(0, nl + 1)),
    zstdFrame(plaintext.subarray(nl + 1)),
  ]);
}

/** Number of zstd frames in a buffer (strict: scans frame magic, not payload). */
export function frameCount(buf) {
  let count = 0;
  let off = 0;
  while (off + ZSTD_MAGIC.length <= buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, off);
    if (at < 0) break;
    count++;
    off = at + ZSTD_MAGIC.length;
  }
  return count;
}
