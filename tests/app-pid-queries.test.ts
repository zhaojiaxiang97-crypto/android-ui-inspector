import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("multi-PID lookup reuses only its current checked window; absent, wrong or switched targets stay strict", {
  skip: process.platform === "win32",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-pid-queries-"));
  try {
    for (const mode of ["reuse", "fresh", "wrong-package", "switched"]) {
      const callsPath = join(directory, `${mode}.jsonl`);
      const child = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures/app-pid-entry.ts"), mode], {
        encoding: "utf8", timeout: 4000, env: { ...process.env, STARTUP_ADB_LOG: callsPath, STARTUP_PID_FIXTURE: "multi" },
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
      const calls: string[][] = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split(/\r?\n/).map(x => JSON.parse(x)) : [];
      if (mode === "reuse" || mode === "fresh") {
        assert.equal(result.pid, 42, "select the Activity owner, never the first PID");
        assert.equal(calls.length, mode === "reuse" ? 2 : 5);
        assert.ok(calls.some(c => c.join(" ") === "shell dumpsys activity com.example.startup"));
        assert.equal(calls.some(c => c.join(" ") === "shell dumpsys window windows"), mode === "fresh");
      } else {
        assert.ok(result.error); assert.equal(result.pid, undefined);
        if (mode === "wrong-package") assert.equal(calls.length, 0);
        else assert.equal(calls.length, 2, "a switched Activity must reject instead of choosing another PID");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
