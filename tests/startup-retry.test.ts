import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRetryStartupCapture } from "../electron/capture/inspection";

test("exhausted readiness polling, success and unrelated failures never restart the wait", () => {
  for (const error of [null, "前台 App 在 18 秒内未准备好控件树和焦点窗口，请等待页面就绪后重试。",
    "前台 App 在 18 秒内未准备好：详细诊断", "采集期间前台窗口发生变化", "SDK 已发布控件树在绘制前变化：TextView@abc", "SDK 已发布控件树在绘制期间变化：TextView@abc", "仅支持 Debug App：不可调试", "采集被取消"]) {
    assert.equal(shouldRetryStartupCapture(error, 45000), false);
  }
});

test("transient startup retry keeps the existing delay/deadline boundary and fails closed", () => {
  const error = "App 仍在启动，独立画面尚未就绪，请等待页面稳定后重试。";
  assert.equal(shouldRetryStartupCapture(error, 2001), true);
  for (const remaining of [2000, 1999, 0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(shouldRetryStartupCapture(error, remaining), false);
  }
  // The first failure remains a failure; a later success only stops the retry loop.
  const results = [error, null]; let captures = 0;
  for (const result of results) { captures++; if (!shouldRetryStartupCapture(result, 10000)) break; }
  assert.equal(captures, 2);
});

for (const focusMode of ["missing-focus", "focus-null"]) test(`preferred capture stops after one real readiness budget, retains failure and never starts image capture: ${focusMode}`, {
  skip: process.platform === "win32", timeout: 30000,
}, () => {
  const project = join(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "inspector-startup-readiness-"));
  const callsPath = join(directory, "calls.jsonl");
  try {
    const sdk = join(project, "tests/fixtures/startup-adb");
    const child = spawnSync(process.execPath, [join(project, "tests/fixtures/startup-capture-entry.ts")], {
      cwd: project, timeout: 25000, encoding: "utf8",
      env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, STARTUP_ADB_LOG: callsPath,
        ...(focusMode === "focus-null" ? { STARTUP_READY_FIXTURE: focusMode } : {}) },
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    assert.match(result.error, /^前台 App 在 18 秒内未准备好/);
    assert.match(result.error, focusMode === "focus-null" ? /窗口确认：.*系统焦点为空/ : /窗口确认：无法读取前台窗口焦点/);
    assert.match(result.error, /剩余就绪预算不足 1.5 秒，已提前停止/);
    assert.equal(result.root, null); assert.equal(result.nodeCount, 0); assert.equal(result.screenshotDataUrl, null);
    assert.equal(result.diagnostics.totalAttempts, 1); assert.equal(result.diagnostics.attempts.length, 1);
    assert.match(result.diagnostics.attempts[0].error, /^前台 App 在 18 秒内未准备好/);
    assert.equal(result.diagnostics.attempts[0].readiness.firstFocusedWindowMs, null);
    assert.equal(result.diagnostics.attempts[0].readiness.treeReadCount, 0);
    assert.ok(result.durationMs >= 16000 && result.durationMs < 25000);
    assert.ok(!result.progress.includes("等待 App 页面稳定"));
    const calls: string[][] = readFileSync(callsPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    // The one attempt now rechecks authorization while bracketing each ready-tree read.
    // Attempt count above, not the number of cheap focus checks, proves no budget restart.
    assert.equal(calls.filter(c => c.join(" ") === "shell run-as com.example.startup id").length, 1,
      "missing focus never repeats the initial debug eligibility check");
    const foregroundReads = calls.filter(c => c.join(" ") === "shell dumpsys activity activities").length;
    const focusReads = calls.filter(c => c.join(" ") === "shell dumpsys window windows").length;
    assert.ok(foregroundReads === focusReads + 1 || foregroundReads === focusReads + 2,
      "one foreground read per poll; final poll may exhaust the budget before focus observation");
    for (let i = 0; i < calls.length; i++) if (calls[i].join(" ") === "shell dumpsys window windows")
      assert.equal(calls[i - 1]?.join(" "), "shell dumpsys activity activities");
    assert.ok(!calls.some(c => c.join(" ") === "shell dumpsys activity com.example.startup" || c.includes("open-session")), "no App tree or SDK preparation before authorized focus");
    assert.ok(!calls.some(c => c.includes("screencap") || c.includes("forward") || c.includes("capture-visible") || c.includes("capture-refs")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["stable", "window-change", "component-change", "instance-change", "candidate-instance-change", "focus-delay", "tree-delay", "cancel-wait"]) {
  test(`readiness reuses only a focus-bracketed dump: ${mode}`, { skip: process.platform === "win32", timeout: 15000 }, () => {
    const project = join(import.meta.dirname, "..");
    const directory = mkdtempSync(join(tmpdir(), "inspector-startup-ready-"));
    const callsPath = join(directory, "calls.jsonl");
    try {
      const sdk = join(project, "tests/fixtures/startup-adb");
      const child = spawnSync(process.execPath, [join(project, "tests/fixtures/startup-ready-entry.ts")], {
        cwd: project, timeout: 10000, encoding: "utf8",
        env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, STARTUP_ADB_LOG: callsPath, STARTUP_READY_FIXTURE: mode },
      });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
      const changed = mode === "component-change" || mode === "instance-change" || mode === "candidate-instance-change";
      const candidateChanged = mode === "candidate-instance-change";
      assert.match(result.error, mode === "cancel-wait" ? /readiness fixture user cancel/ : changed ? /前台 App 已变化/ : /readiness fixture stop before images/);
      if (changed) { assert.equal(result.root, null); assert.ok(!result.progress.includes("读取完整控件属性")); }
      if (mode === "cancel-wait") assert.equal(result.readiness, undefined, "cancel remains a thrown request, not a snapshot");
      else {
        assert.equal(result.readiness.phase, candidateChanged ? "focus-before" : changed ? "foreground" : "ready");
        assert.equal(result.readiness.treeReadCount, candidateChanged ? 0 : mode === "window-change" || mode === "tree-delay" ? 2 : 1);
        assert.equal(result.readiness.focus?.windowId ?? null, candidateChanged ? null : mode === "window-change" ? "def" : "abc");
        assert.deepEqual(result.diagnostics.attempts[0].readiness, result.readiness);
        const observations = result.readiness.observations;
        assert.ok(observations && observations.droppedCount === 0);
        assert.ok(observations.entries.some((r: { kind: string }) => r.kind === "foreground"));
        if (!changed) {
          assert.ok(observations.entries.some((r: { kind: string; result: string }) => r.kind === "focus-confirm-before" && r.result === "match"));
          assert.ok(observations.entries.some((r: { kind: string; result: string }) => r.kind === "focus-confirm-after" && r.result === "match"));
        }
        if (mode === "focus-delay") {
          assert.equal(observations.entries.filter((r: { kind: string; result: string }) => r.kind === "focus-candidate" && r.result === "unavailable").length, 2);
          assert.ok(observations.entries.filter((r: { result: string }) => r.result === "unavailable")
            .every((r: { focusReason?: string }) => r.focusReason === "null-focus"));
          assert.ok(observations.entries.some((r: { kind: string }) => r.kind === "poll-wait"));
        }
      }
      const calls: string[][] = readFileSync(callsPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
      const dumps = calls.filter(c => c.join(" ") === "shell dumpsys activity com.example.startup");
      const windows = calls.filter(c => c.join(" ") === "shell dumpsys window windows");
      assert.equal(dumps.length, mode === "cancel-wait" || candidateChanged ? 0 : mode === "window-change" || mode === "tree-delay" ? 2 : 1, "one per focus-ready poll; no unguarded initial dump or post-focus duplicate");
      assert.equal(windows.length, mode === "cancel-wait" ? 1 : candidateChanged ? 2 : mode === "window-change" ? 6
        : mode === "focus-delay" || mode === "tree-delay" ? 5 : 3, "candidate observation does not replace either strict check");
      const permissionReads = calls.filter(c => c.join(" ") === "shell run-as com.example.startup id");
      assert.equal(permissionReads.length, mode === "cancel-wait" ? 1 : candidateChanged ? 2
        : mode === "window-change" ? 5 : mode === "tree-delay" ? 4 : 3,
        "only candidate and post-tree confirmations repeat run-as; never absent-focus observations");
      if (mode === "cancel-wait" || changed) assert.ok(!calls.some(c => c.includes("open-session")), "SDK preparation only after valid tree and post-read focus");
      const firstDump = calls.findIndex(c => c.join(" ") === "shell dumpsys activity com.example.startup");
      if (firstDump >= 0) assert.ok(calls.slice(0, firstDump).some(c => c.join(" ") === "shell dumpsys window windows"));
      if (mode === "focus-delay") assert.equal(calls.slice(0, firstDump).filter(c => c.join(" ") === "shell dumpsys window windows").length, 4);
      assert.ok(!calls.some(c => c.includes("screencap") || c.includes("capture-visible")));
      const forwards = calls.filter(c => c.includes("forward"));
      if (mode === "cancel-wait" || changed) assert.equal(forwards.length, 0, "no session probe before authorized stable tree");
      else {
        assert.equal(forwards.length, 1, "ready page may probe the existing SDK service once");
        assert.deepEqual(forwards[0], ["forward", "tcp:0", "localabstract:com.example.startup.inspector.session"]);
        const at = calls.indexOf(forwards[0]);
        assert.equal(calls.slice(0, at).filter(c => c.join(" ") === "shell dumpsys window windows").length, windows.length,
          "socket preparation follows the post-tree focus confirmation, never an unconfirmed candidate");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
