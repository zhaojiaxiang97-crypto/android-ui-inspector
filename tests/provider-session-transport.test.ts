import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("actual provider transport closes cancelled/timed-out sockets, ignores late replies and recovers", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-session-test-"));
  try {
    for (const mode of ["abort", "probe-abort", "timeout", "events", "cold", "probe-timeout", "probe-invalid", "legacy", "timing-new", "timing-old", "timing-invalid", "timing-reject"]) {
      const child = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures/provider-session-entry.ts"), mode], {
        timeout: 8000, encoding: "utf8", env: { ...process.env, PROVIDER_FIXTURE_LOG: join(directory, `${mode}.jsonl`) },
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout.trim()).lateIgnored, true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
