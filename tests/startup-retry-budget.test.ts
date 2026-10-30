import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StartupRetryBudgetError, startupRetryBudget } from "../electron/capture/startup-retry-budget";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("retry budget aborts in-flight work with an explicit non-retryable failure", async () => {
  const budget = startupRetryBudget(15);
  try {
    await assert.rejects(delay(1000, null, { signal: budget.signal }), { name: "AbortError" });
    assert.ok(budget.signal.reason instanceof StartupRetryBudgetError);
    assert.ok(!budget.signal.reason.message.startsWith("App 仍在启动"));
  } finally { budget.dispose(); }
});
test("completed retry clears the timer and user cancellation preserves its reason", async () => {
  const done = startupRetryBudget(10); done.dispose(); await delay(20);
  assert.equal(done.signal.aborted, false);
  const parent = new AbortController(), reason = new Error("user cancelled");
  const active = startupRetryBudget(1000, parent.signal);
  try { parent.abort(reason); assert.equal(active.signal.reason, reason); }
  finally { active.dispose(); }
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => startupRetryBudget(value), StartupRetryBudgetError);
});
test("real capture converts only the internal budget into a diagnostic failure, without images", {skip:process.platform === "win32"}, () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-retry-budget-"));
  const sdk = join(import.meta.dirname, "fixtures/startup-adb");
  try {
    for (const cancelled of [false,true]) {
      const calls = join(directory, `${cancelled}.jsonl`);
      const result = spawnSync(process.execPath, [join(import.meta.dirname,"fixtures/startup-budget-entry.ts")], {
        timeout:5000,encoding:"utf8",env:{...process.env,ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk,
          STARTUP_ADB_LOG:calls,BUDGET_USER_CANCEL:cancelled?"1":"0"} });
      assert.equal(result.error,undefined); assert.equal(result.status,0,result.stderr);
      const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
      if (cancelled) {assert.match(value.thrown,/user cancelled/); assert.equal(value.diagnostics,undefined);}
      else {
        assert.match(value.error,/启动重试的总预算已耗尽/); assert.equal(value.root,null); assert.equal(value.nodeCount,0);
        assert.equal(value.diagnostics.totalAttempts,1); assert.match(value.diagnostics.attempts[0].error,/总预算已耗尽/);
        // Cancellation may precede even the first fixture process startup.
        let log=""; try {log=readFileSync(calls,"utf8");} catch {}
        assert.ok(!/forward|screencap|capture-visible/.test(log));
      }
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
