import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { isSdkVisibleCaptureInterruption, SdkMergedTreeFailure } from "../electron/sdk/capture-protocol";

const source = readFileSync(new URL("../electron/capture/inspection.ts", import.meta.url), "utf8");
const compile = (parameters: string[], body: string) => new Function(...parameters,
  ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const start = source.indexOf("          const expectedPid = Number(root.attributes", source.indexOf("export function inspectPreferredDevice"));
const end = source.indexOf("        } else {\n          const installed", start);
assert.ok(start > 0 && end > start);
const adopt = compile(["root", "serial", "packageName", "prefetched", "checkedIdentity", "inspectionContext", "checkedDebugTarget", "singleAppPid", "adbPath"],
  `return (async () => {let pid,component,windowId,tree;${source.slice(start, end)} return {pid,component,windowId,tree};})();`);
const root = { attributes: { "debug-process-id": "42", "debug-component": "sample.app/Settings" } };
const identity = { serial: "fixture", packageName: "sample.app", pid: 42, component: "sample.app/Settings", windowId: "window-1" };

test("merged adoption reuses fresh identity without another window/PID query", async () => {
  const tree = { version: 1 };
  const result = await adopt(root, "fixture", "sample.app", tree, identity, { getStore: () => ({}) },
    () => assert.fail("duplicate window query"), () => assert.fail("duplicate PID query"), "adb");
  assert.deepEqual(result, { pid: 42, component: identity.component, windowId: identity.windowId, tree });
});

test("missing identity retains original independent verification", async () => {
  let windows = 0, pids = 0;
  await adopt(root, "fixture", "sample.app", {}, undefined, { getStore: () => ({}) },
    async () => { windows++; return identity; }, async () => { pids++; return 42; }, "adb");
  assert.equal(windows, 1); assert.equal(pids, 1);
});

test("identity cannot be reused across device, package, process or component; cancellation is preserved", async () => {
  for (const change of [{ serial: "other" }, { packageName: "other.app" }, { pid: 43 }, { component: "sample.app/Other" }, { windowId: "" }])
    await assert.rejects(adopt(root, "fixture", "sample.app", {}, { ...identity, ...change }, { getStore: () => ({}) },
      () => assert.fail("bad evidence must not query"), () => assert.fail("bad evidence must not query"), "adb"), /进程或窗口已变化/);
  const controller = new AbortController(), reason = new Error("cancel before adoption"); controller.abort(reason);
  await assert.rejects(adopt(root, "fixture", "sample.app", {}, identity, { getStore: () => ({ signal: controller.signal }) },
    () => assert.fail("cancelled"), () => assert.fail("cancelled"), "adb"), error => error === reason);
});

const imageSource = readFileSync(new URL("../electron/capture/sdk-images.ts", import.meta.url), "utf8");
const acceptStart = imageSource.indexOf("    const acceptMergedTree = async");
const acceptEnd = imageSource.indexOf("    const readMergedTree = async", acceptStart);
assert.ok(acceptStart > 0 && acceptEnd > acceptStart);
const accept = compile(["checkedDebugTarget", "singleAppPid", "inspectionContext", "withTree", "before", "processId", "adbPath", "serial", "packageName", "treeEvent", "root", "SdkMergedTreeFailure", "treeNoticeMs", "noticeConsumed", "callStarted"],
  `${imageSource.slice(acceptStart, acceptEnd)} return acceptMergedTree;`);

test("identity proof is created only after fresh matching window/PID checks", async () => {
  for (const mismatch of ["none", "window", "component", "pid"]) {
    let accepted = 0, pidQueries = 0;
    const current = { ...identity, ...(mismatch === "window" ? { windowId: "changed" } : mismatch === "component" ? { component: "changed" } : {}) };
    const callback = accept(async () => current, async (_adb: string, _serial: string, _package: string, checkedTarget: unknown) => {
      pidQueries++;
      assert.equal(checkedTarget, current, "reuse only the target checked by this acceptance call");
      return mismatch === "pid" ? 43 : 42;
    }, { getStore: () => ({}) },
      { onTree: async (_value: unknown, proof: unknown) => { accepted++; assert.deepEqual(proof, identity); } }, identity, "42", "adb", "fixture", "sample.app");
    if (mismatch === "none") { await callback({}); assert.equal(accepted, 1); }
    else { await assert.rejects(callback({}), /窗口或进程已变化/); assert.equal(accepted, 0); }
    assert.equal(pidQueries, mismatch === "window" || mismatch === "component" ? 0 : 1);
  }
});

test("merged tree cancellation during PID verification never adopts or publishes successful timing", async () => {
  const controller = new AbortController(), reason = new Error("cancel during PID check");
  const timings: Record<string, number> = {};
  const callback = accept(async () => identity, async (_adb: string, _serial: string, _package: string, target: unknown) => {
    assert.equal(target, identity); controller.abort(reason); return 42;
  }, { getStore: () => ({ signal: controller.signal }) },
  { timings, onTree: () => assert.fail("cancelled tree cannot be adopted") }, identity, "42", "adb", "fixture", "sample.app");
  await assert.rejects(callback({}), error => error === reason);
  assert.deepEqual(timings, {});
});

test("notification instance must match the tree; mismatch blocks compatibility fallback", async () => {
  let adopted = 0;
  const current = { attributes: {} };
  const timings: Record<string, number> = {};
  const callback = accept(async () => identity, async () => 42, { getStore: () => ({}) },
    { timings, onTree: async () => { adopted++; } }, identity, "42", "adb", "fixture", "sample.app",
    { processInstance: "current" }, current, SdkMergedTreeFailure, 42, true, performance.now());
  await assert.rejects(callback({ processInstance: "other" }), error => isSdkVisibleCaptureInterruption(error));
  assert.equal(adopted, 0);
  assert.deepEqual(timings, {});
  await callback({ processInstance: "current" }); assert.equal(adopted, 1);
  assert.equal((current.attributes as Record<string, string>)["sdk-tree-ready-event"], "true");
  assert.equal((current.attributes as Record<string, string>)["sdk-tree-ready-received-ms"], "42");
  assert.equal((current.attributes as Record<string, string>)["sdk-tree-ready-wake"], "true");
  assert.equal(timings["SDK 树通知收到（调用内）"], 42);
  for (const key of ["SDK 合并树身份核对", "SDK 合并树采用回调", "SDK 合并树采用完成（调用内）"])
    assert.ok(Number.isFinite(timings[key]) && timings[key] >= 0);
});
