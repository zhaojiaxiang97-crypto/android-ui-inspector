import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { FocusUnavailableError } from "../electron/device/target";
import { waitForSessionProbeRestoration } from "../scripts/session-probe-restoration";

// Execute the actual probe's finalization, not another implementation of its gates.
const source = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-session-connection-probe.ts", import.meta.url), "utf8");
const start = source.indexOf("} finally {"), end = source.indexOf("\n}\nsave({", start);
assert.ok(start > 0 && end > start);
const finalizeBody = new Function("verified", "failure", "forwardsBefore", "sampleOpened", "previous", "disposeProvider", "adb", "getDebugTarget", "save", "assert", "output", "waitForSessionProbeRestoration",
  ts.transpileModule(`return (async () => {const serial = "fixture", provider = { dispose: disposeProvider };${source.slice(start + "} finally {".length, end)}${source.slice(end + 2)}})();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const finalize = (...args: any[]) => finalizeBody(...args, waitForSessionProbeRestoration);

const previousTarget = { packageName: "sample.previous", component: "sample.previous/Settings", windowId: "window-1" } as Awaited<ReturnType<typeof import("../electron/device/target").getDebugTarget>>;

test("restoration waits only for transient null focus and keeps one overall deadline", async () => {
  let reads = 0;
  const signal = AbortSignal.timeout(1000);
  const restored = await waitForSessionProbeRestoration(previousTarget, async received => {
    assert.equal(received, signal);
    if (++reads === 1) throw new FocusUnavailableError("null-focus", "not ready");
    return previousTarget;
  }, signal);
  assert.equal(restored, previousTarget); assert.equal(reads, 2);
});

test("restoration rejects wrong target and non-transient errors without retry", async () => {
  for (const change of [{ packageName: "other" }, { component: "other/Activity" }, { windowId: "other" }]) {
    let reads = 0;
    await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
      reads++; return { ...previousTarget, ...change };
    }));
    assert.equal(reads, 1);
  }
  const failure = new Error("device disconnected");
  let reads = 0;
  await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
    reads++; throw failure;
  }), error => error === failure);
  assert.equal(reads, 1);
  const otherFocus = new FocusUnavailableError("non-primary-display", "wrong display");
  reads = 0;
  await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
    reads++; throw otherFocus;
  }), error => error === otherFocus);
  assert.equal(reads, 1);
});

test("restoration cancellation and deadline reject even late successful reads", async () => {
  const controller = new AbortController(), reason = new Error("cancelled");
  controller.abort(reason);
  let reads = 0;
  await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
    reads++; return previousTarget;
  }, controller.signal), error => error === reason);
  assert.equal(reads, 0);
  const deadline = AbortSignal.timeout(20);
  await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
    reads++; throw new FocusUnavailableError("null-focus", "not ready");
  }, deadline));
  assert.equal(reads, 1);
  const late = new AbortController();
  await assert.rejects(waitForSessionProbeRestoration(previousTarget, async () => {
    late.abort(reason); return previousTarget;
  }, late.signal), error => error === reason);
});

const phaseStart = source.indexOf("    // Historical connection phases"), phaseEnd = source.indexOf('    if (name === "cold-service")', phaseStart);
assert.ok(phaseStart > 0 && phaseEnd > phaseStart);
const validatePhases = new Function("name", "timings", "rows", "assert", ts.transpileModule(source.slice(phaseStart, phaseEnd),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

test("sample phase gate rejects missing, inconsistent or changed historical timings", () => {
  const warm = { "SDK 当前连接首次探测": 20, "SDK 当前连接兼容启动": 0,
    "SDK 当前连接启动后核验": 0, "SDK 当前连接建立耗时": 20 };
  const cold = { ...warm, "SDK 当前连接兼容启动": 800, "SDK 当前连接启动后核验": 30,
    "SDK 当前连接建立耗时": 850 };
  validatePhases("cold-service", cold, [], assert);
  validatePhases("warm-reconnect", warm, [], assert);
  validatePhases("same-connection", warm, [null, { timings: warm }], assert);
  for (const invalid of [{ ...cold, "SDK 当前连接首次探测": NaN },
    { ...cold, "SDK 当前连接建立耗时": 200 }, { ...cold, "SDK 当前连接启动后核验": -1 }])
    assert.throws(() => validatePhases("cold-service", invalid, [], assert));
  assert.throws(() => validatePhases("warm-reconnect", cold, [], assert));
  assert.throws(() => validatePhases("same-connection", { ...warm, "SDK 当前连接首次探测": 21 },
    [null, { timings: warm }], assert));
});

test("sample probe passes only after connection disposal, forward check and foreground restoration", async () => {
  const order: string[] = [], reports: any[] = [];
  const previous = { component: "sample.previous/Settings", packageName: "sample.previous", windowId: "window-1" };
  await finalize(true, undefined, "original-forward", true, previous, async () => { order.push("dispose"); },
    (...args: string[]) => { order.push(args[0] === "forward" ? "forwards" : "restore"); return "original-forward"; },
    async () => { order.push("verify-restoration"); return previous; },
    (report: any) => { order.push("save"); reports.push(report); }, assert, "fixture");
  assert.deepEqual(order, ["dispose", "forwards", "restore", "verify-restoration", "save"]);
  assert.equal(reports[0].passed, true);
});

test("transient restoration focus does not replay navigation or save before recovery", async () => {
  let navigations = 0, reads = 0;
  const reports: any[] = [];
  await finalize(true, undefined, "", true, previousTarget, async () => {},
    (...args: string[]) => { if (args[0] !== "forward") navigations++; return ""; },
    async () => {
      assert.equal(reports.length, 0);
      if (++reads === 1) throw new FocusUnavailableError("null-focus", "transition");
      return previousTarget;
    }, (report: any) => reports.push(report), assert, "fixture");
  assert.equal(navigations, 1); assert.equal(reads, 2); assert.equal(reports[0].passed, true);
});

test("cleanup, forward or restoration failure cannot leave a passed report; original failure survives", async () => {
  for (const mode of ["dispose", "forward", "restore", "original"]) {
    const reports: any[] = [], primary = new Error("original capture failed");
    const previous = { component: "sample.previous/Settings", packageName: "sample.previous", windowId: "window-1" };
    await assert.rejects(finalize(true, mode === "original" ? primary : undefined, "baseline", true, previous,
      async () => { if (mode === "dispose" || mode === "original") throw new Error("dispose failed"); },
      () => mode === "forward" ? "leaked-forward" : "baseline",
      async () => ({ ...previous, windowId: "changed" }),
      (report: any) => reports.push(report), assert, "fixture"),
    error => mode === "original" ? error === primary : error instanceof Error);
    assert.equal(reports[0].passed, false);
    assert.ok(reports[0].error);
  }
});
