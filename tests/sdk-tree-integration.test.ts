import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["single", "default", "false"]) {
  test(`actual SDK reader inherits capture policy: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "sdk-tree-entry-"));
    try {
      const log = join(directory, "calls.jsonl");
      const sdk = join(import.meta.dirname, "fixtures/startup-adb");
      const child = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures/sdk-tree-entry.ts"), mode], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
          STARTUP_ADB_LOG: log, STARTUP_READY_FIXTURE: "stable", SDK_TREE_FIXTURE: "timeout" },
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
      assert.match(result.error, mode === "single" ? /SDK 控件树超时/ : /SDK 控件树连续超时/);
      const calls: string[][] = readFileSync(log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
      const captures = calls.filter(call => call.includes("capture"));
      assert.equal(captures.length, mode === "single" ? 1 : 2);
      for (const call of captures) assert.match(call[call.indexOf("--arg") + 1], /^[0-9a-f-]{36}$/);
      assert.equal(new Set(captures.map(call => call.at(-1))).size, captures.length);
      assert.ok(!calls.some(call => call.includes("exec-out") || call.includes("capture-visible")), "no stale file read or images after timeout");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
