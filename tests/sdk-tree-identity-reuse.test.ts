import assert from "node:assert/strict";
import { test } from "node:test";
import { isSdkVisibleCaptureInterruption } from "../electron/sdk/capture-protocol";
import { verifySdkTreeIdentity, type SdkTreeVerificationPorts } from "../electron/capture/sdk-tree-verification";
import { acceptSdkMergedTree } from "../electron/capture/sdk-images";
import { createCaptureRunContext } from "../electron/capture/run-context";
import type { UiNode } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";

const root = (): UiNode => ({ ...makeNode("root"), attributes: { "debug-process-id": "42", "debug-component": "sample.app/Settings" } });
const identity = { serial: "fixture", packageName: "sample.app", pid: 42, component: "sample.app/Settings", windowId: "window-1" };
const target = { ...identity, activityName: "Settings", activityRecordId: "abc" };
const unused = () => assert.fail("unexpected device query");
function ports(overrides: Partial<SdkTreeVerificationPorts> = {}): SdkTreeVerificationPorts {
  return { installed: unused, target: unused, pid: unused, read: unused, ...overrides };
}

test("merged adoption reuses fresh identity without another window/PID query", async () => {
  const tree = { version: 1 };
  const result = await verifySdkTreeIdentity({ inspectionMode: "sdk-enhanced", root: root(), serial: "fixture", packageName: "sample.app", prefetched: tree, checkedIdentity: identity }, ports());
  assert.deepEqual(result, { packageName: "sample.app", pid: 42, component: identity.component, windowId: identity.windowId, tree });
});

test("missing identity retains original independent verification", async () => {
  let windows = 0, pids = 0;
  await verifySdkTreeIdentity({ inspectionMode: "sdk-enhanced", root: root(), serial: "fixture", packageName: "sample.app", prefetched: {} }, ports({
    target: async () => { windows++; return identity; }, pid: async () => { pids++; return 42; },
  }));
  assert.equal(windows, 1); assert.equal(pids, 1);
});

test("identity cannot be reused across device, package, process or component; cancellation is preserved", async () => {
  for (const change of [{ serial: "other" }, { packageName: "other.app" }, { pid: 43 }, { component: "sample.app/Other" }, { windowId: "" }])
    await assert.rejects(verifySdkTreeIdentity({ inspectionMode: "sdk-enhanced", root: root(), serial: "fixture", packageName: "sample.app", prefetched: {}, checkedIdentity: { ...identity, ...change } }, ports()), /进程或窗口已变化/);
  const controller = new AbortController(), reason = new Error("cancel before adoption"); controller.abort(reason);
  await assert.rejects(verifySdkTreeIdentity({ inspectionMode: "sdk-enhanced", root: root(), serial: "fixture", packageName: "sample.app", prefetched: {}, checkedIdentity: identity, signal: controller.signal }, ports()), error => error === reason);
});

function acceptance(overrides: Partial<Parameters<typeof acceptSdkMergedTree>[0]> = {}): Parameters<typeof acceptSdkMergedTree>[0] {
  return { value: {}, adbPath: "adb", serial: "fixture", packageName: "sample.app", processId: "42", before: identity,
    root: root(), withTree: { onTree: async () => {} }, notice: () => ({ consumed: false }), callStarted: performance.now(), ...overrides };
}

test("identity proof is created only after fresh matching window/PID checks", async () => {
  for (const mismatch of ["none", "window", "component", "pid"]) {
    let accepted = 0, pidQueries = 0;
    const current = { ...target, ...(mismatch === "window" ? { windowId: "changed" } : mismatch === "component" ? { component: "changed" } : {}) };
    const run = () => acceptSdkMergedTree(acceptance({ withTree: { onTree: async (_value, proof) => { accepted++; assert.deepEqual(proof, identity); } } }),
      createCaptureRunContext({ inspectionMode: "sdk-enhanced" }), {
        checkedTarget: async () => current,
        pid: async (_adb, _serial, _package, checkedTarget) => {
          pidQueries++; assert.equal(checkedTarget, current, "reuse only the target checked by this acceptance call");
          return mismatch === "pid" ? 43 : 42;
        }, now: () => performance.now(),
      });
    if (mismatch === "none") { await run(); assert.equal(accepted, 1); }
    else { await assert.rejects(run(), /窗口或进程已变化/); assert.equal(accepted, 0); }
    assert.equal(pidQueries, mismatch === "window" || mismatch === "component" ? 0 : 1);
  }
});

test("merged tree cancellation during PID verification never adopts or publishes successful timing", async () => {
  const controller = new AbortController(), reason = new Error("cancel during PID check");
  const timings: Record<string, number> = {};
  await assert.rejects(acceptSdkMergedTree(acceptance({ withTree: { timings, onTree: unused } }),
    createCaptureRunContext({ inspectionMode: "sdk-enhanced", signal: controller.signal }), {
      checkedTarget: async () => target,
      pid: async (_adb, _serial, _package, checkedTarget) => { assert.equal(checkedTarget, target); controller.abort(reason); return 42; },
      now: () => performance.now(),
    }), error => error === reason);
  assert.deepEqual(timings, {});
});

test("notification instance must match the tree; mismatch blocks compatibility fallback", async () => {
  let adopted = 0;
  const current = root(), timings: Record<string, number> = {};
  const input = acceptance({ root: current, notice: () => ({ event: { processInstance: "current" }, receivedMs: 42, consumed: true }),
    withTree: { timings, onTree: async () => { adopted++; } } });
  const context = createCaptureRunContext({ inspectionMode: "sdk-enhanced" }), dependencies = { checkedTarget: async () => target, pid: async () => 42, now: () => performance.now() };
  await assert.rejects(acceptSdkMergedTree({ ...input, value: { processInstance: "other" } }, context, dependencies), error => isSdkVisibleCaptureInterruption(error));
  assert.equal(adopted, 0); assert.deepEqual(timings, {});
  await acceptSdkMergedTree({ ...input, value: { processInstance: "current" } }, context, dependencies); assert.equal(adopted, 1);
  assert.equal(current.attributes!["sdk-tree-ready-event"], "true");
  assert.equal(current.attributes!["sdk-tree-ready-received-ms"], "42");
  assert.equal(current.attributes!["sdk-tree-ready-wake"], "true");
  assert.equal(timings["SDK 树通知收到（调用内）"], 42);
  for (const key of ["SDK 合并树身份核对", "SDK 合并树采用回调", "SDK 合并树采用完成（调用内）"])
    assert.ok(Number.isFinite(timings[key]) && timings[key] >= 0);
});

test("standalone tree verification preserves the query order and stops before a second PID on changed window", async () => {
  for (const changed of [false, true]) {
    const trace: string[] = []; let windows = 0;
    const verify = verifySdkTreeIdentity({ inspectionMode: "sdk-enhanced", root: root(), serial: "fixture", packageName: "sample.app" }, {
      installed: async () => { trace.push("provider"); return true; },
      target: async () => { trace.push("window"); return { ...identity, windowId: changed && ++windows > 1 ? "changed" : identity.windowId }; },
      pid: async () => { trace.push("pid"); return 42; },
      read: async () => { trace.push("tree"); return {}; },
    });
    if (changed) await assert.rejects(verify, /进程或窗口已变化/); else await verify;
    assert.deepEqual(trace, changed ? ["provider", "window", "pid", "tree", "window"] : ["provider", "window", "pid", "tree", "window", "pid"]);
  }
});

for (const phase of ["target", "pid", "onTree"] as const)
  test(`merged tree diagnostics retain a notification arriving while ${phase} is pending`, async () => {
    let release!: () => void, entered!: () => void;
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let notice: ReturnType<Parameters<typeof acceptSdkMergedTree>[0]["notice"]> = { consumed: false };
    const current = root(), timings: Record<string, number> = {};
    const pause = async (at: typeof phase) => { if (at === phase) { entered(); await resumed; } };
    const pending = acceptSdkMergedTree(acceptance({ root: current, value: { processInstance: "current" }, notice: () => notice,
      withTree: { timings, onTree: async () => { await pause("onTree"); } } }), createCaptureRunContext({ inspectionMode: "sdk-enhanced" }), {
      checkedTarget: async () => { await pause("target"); return target; },
      pid: async () => { await pause("pid"); return 42; }, now: () => performance.now(),
    });
    await waiting; notice = { event: { processInstance: "current" }, receivedMs: 42, consumed: true }; release();
    await pending;
    assert.equal(current.attributes!["sdk-tree-ready-event"], "true");
    assert.equal(current.attributes!["sdk-tree-ready-received-ms"], "42");
    assert.equal(current.attributes!["sdk-tree-ready-wake"], "true");
    assert.equal(timings["SDK 树通知收到（调用内）"], 42);
    for (const key of ["SDK 合并树身份核对", "SDK 合并树采用回调", "SDK 合并树采用完成（调用内）"])
      assert.ok(Number.isFinite(timings[key]) && timings[key] >= 0);
  });
