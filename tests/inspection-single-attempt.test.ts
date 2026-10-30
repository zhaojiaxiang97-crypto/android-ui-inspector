import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectionSingleAttempt } from "../shared/inspection-policy";
import { shouldRetryStartupCapture } from "../electron/capture/inspection";

test("single-attempt IPC policy is explicit boolean and omission retains defaults", () => {
  assert.equal(inspectionSingleAttempt(undefined), false);
  assert.equal(inspectionSingleAttempt(false), false);
  assert.equal(inspectionSingleAttempt(true), true);
  for (const bad of [null, 0, 1, "true", "false", {}, [], new Boolean(true)]) assert.throws(() => inspectionSingleAttempt(bad), /必须为布尔值/);
});
test("single attempt suppresses eligible whole-request retries, not default policy", () => {
  const error = "App 仍在启动：first failure";
  assert.equal(shouldRetryStartupCapture(error, 40000), true);
  assert.equal(shouldRetryStartupCapture(error, 40000, false), true);
  assert.equal(shouldRetryStartupCapture(error, 40000, true), false);
});
for (const mode of ["single", "default", "explicit-default", "cancel-single", "cancel-default"]) {
  test(`real preferred-capture entry with isolated adb fixture: ${mode}`, { skip: process.platform === "win32", timeout: 15000 }, () => {
    const project = join(import.meta.dirname, "..");
    const directory = mkdtempSync(join(tmpdir(), "inspector-single-attempt-"));
    const callsPath = join(directory, "calls.jsonl");
    try {
      const sdk = join(project, "tests/fixtures/startup-adb");
      const child = spawnSync(process.execPath, [join(project, "tests/fixtures/startup-single-attempt-entry.ts")], {
        cwd: project, encoding: "utf8", timeout: 12000,
        env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, STARTUP_ADB_LOG: callsPath,
          STARTUP_READY_FIXTURE: "stable", STARTUP_POLICY_FIXTURE: mode },
      });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
      const cancelled = mode.startsWith("cancel-");
      const twice = mode === "default" || mode === "explicit-default";
      assert.equal(result.captureStages, twice ? 2 : 1);
      assert.equal(result.progress.includes("等待 App 页面稳定"), mode !== "single" && mode !== "cancel-single");
      if (cancelled) {
        assert.equal(result.error, "single fixture user cancel");
        assert.equal(result.diagnostics, undefined, "cancellation remains thrown, not a failure snapshot");
      } else {
        assert.equal(result.error, twice ? "single fixture second failure" : "App 仍在启动：single fixture first failure");
        assert.equal(result.root, null);
        assert.equal(result.diagnostics.totalAttempts, twice ? 2 : 1);
        assert.equal(result.diagnostics.attempts[0].error, "App 仍在启动：single fixture first failure");
      }
      const calls: string[][] = readFileSync(callsPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(calls.filter(c => c.join(" ") === "shell dumpsys activity com.example.startup").length, twice ? 2 : 1);
      // The lazy SDK session probe precedes attribute capture; it is not an image request.
      assert.ok(!calls.some(c => c.includes("screencap") || c.includes("capture-visible")
        || c.some(arg => arg.startsWith("jdwp:"))), "first failure never proceeds to images or JDWP capture");
      assert.ok(calls.filter(c => c[0] === "forward" && c[1] !== "--remove")
        .every(c => c.join(" ") === "forward tcp:0 localabstract:com.example.startup.inspector.session"),
        "only the SDK availability probe may open a forward before failure");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
