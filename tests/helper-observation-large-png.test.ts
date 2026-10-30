import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

test("Node accepts large Helper PNGs without regex stack overflow and still rejects malformed Base64", () => {
  const base = resolve(".benchmarks"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "helper-png-node-")), entry = join(directory, "check.cjs");
  try {
    execFileSync("bun", ["build", "tests/fixtures/helper-large-png-check.ts", "--target", "node", "--format", "cjs",
      "--external", "sharp", "--outfile", entry], { timeout: 30_000, stdio: "pipe" });
    const result = JSON.parse(execFileSync("node", [entry], { encoding: "utf8", timeout: 30_000 }));
    assert.deepEqual(result, { acceptedLargePng: true, rejectedMalformedBase64: 7 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
