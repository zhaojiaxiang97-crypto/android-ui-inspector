import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { preferVerifiedSdkImages } from "../electron/sdk/sdk-capture-route";

const small = { nodeCount: 98, verified: true, visibleStream: "2", uiWake: "1", hardwareAccelerated: "true" };
test("verified modern small pages choose SDK images without another tree request", () => {
  assert.equal(preferVerifiedSdkImages(small), true);
  assert.equal(preferVerifiedSdkImages({ ...small, hardwareAccelerated: "false" }), true);
  for (const change of [{ verified: false }, { visibleStream: "1" }, { visibleStream: undefined },
    { uiWake: undefined }, { uiWake: "2" }, { hardwareAccelerated: undefined }, { hardwareAccelerated: true }])
    assert.equal(preferVerifiedSdkImages({ ...small, ...change }), false);
});
test("explicit preference and existing large-tree boundary are preserved after validation", () => {
  for (const nodeCount of [1, 98, 199, 200, 5000]) {
    assert.equal(preferVerifiedSdkImages({ ...small, nodeCount, preference: false }), false);
    assert.equal(preferVerifiedSdkImages({ ...small, nodeCount, preference: true, verified: false }), false);
    assert.equal(preferVerifiedSdkImages({ ...small, nodeCount, preference: true, visibleStream: undefined }), true);
    assert.equal(preferVerifiedSdkImages({ ...small, nodeCount, visibleStream: undefined }), nodeCount >= 200);
  }
});

const source = readFileSync(new URL("../electron/capture/inspection.ts", import.meta.url), "utf8");
const imageSource = readFileSync(new URL("../electron/capture/debug-images.ts", import.meta.url), "utf8");
const start = source.indexOf("        // Small pages reuse the tree already validated above;");
const end = source.indexOf("      } catch (error) {", start);
assert.ok(start > 0 && end > start);
const activate = new Function("options", "root", "sdkState", "captureOptions", "inspectionContext", "countNodes", "windowAcceleration", "preferVerifiedSdkImages",
  ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
test("actual adoption boundary changes only this capture's route after successful verification", () => {
  for (const mode of ["new", "old", "missing", "failed", "disabled"]) {
    const options = { preferVisibleSdk: mode === "disabled" ? false : undefined };
    const captureOptions = { ...options }, active = { ...options };
    const root = { attributes: { "sdk-visible-stream": mode === "old" ? "1" : "2", "sdk-ui-wake-version": "1" } };
    activate(options, root, { capture: mode === "missing" ? null : {}, error: mode === "failed" ? new Error("identity mismatch") : null },
      captureOptions, { getStore: () => active }, () => 98, () => "true", preferVerifiedSdkImages);
    assert.equal(captureOptions.preferVisibleSdk, mode === "new" ? true : options.preferVisibleSdk);
    assert.equal(active.preferVisibleSdk, captureOptions.preferVisibleSdk);
    assert.equal(options.preferVisibleSdk, mode === "disabled" ? false : undefined, "do not mutate caller or next request policy");
  }
});
test("initial small-tree preparation stays conservative before SDK capabilities are known", () => {
  const start = imageSource.indexOf("    const sdkFirstCandidate ="), end = imageSource.indexOf("    let sdkFirst =", start);
  assert.ok(start > 0 && end > start);
  const candidate = new Function("store", "root", "countNodes", ts.transpileModule(`${imageSource.slice(start, end)}return sdkFirstCandidate;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  assert.equal(candidate({ onViewTreeReady: () => {} }, {}, () => 98), false);
  assert.equal(candidate({ onViewTreeReady: () => {}, preferVisibleSdk: true }, {}, () => 98), true);
  assert.equal(candidate({ onViewTreeReady: () => {}, preferVisibleSdk: false }, {}, () => 500), false);
});

test("actual property handoff skips DDMS images only after this tree callback selects SDK", async () => {
  const start = imageSource.indexOf("    if (sdkFirst) {", imageSource.indexOf("async function captureDebugViewImages"));
  const end = imageSource.indexOf("    let sdkVisible =", start);
  assert.ok(start > 0 && end > start);
  const handoff = new Function("captureViewLayers", "inspectionContext", "useVisibleSdk", "stage", "root", "applyViewProperties",
    ts.transpileModule(`return (async () => {const packageName="sample.app",sdkFirst=false,mergedVisible=null,port=1,rootRefs=()=>["Decor@abc"],batchTiming=()=>{};
      let layers=[],windowName="";const preview=undefined;${imageSource.slice(start, end)}return {layers,windowName};})();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  for (const mode of ["new", "old", "disabled"]) {
    const policy = { preferVisibleSdk: mode === "disabled" ? false : undefined };
    const active: any = { ...policy };
    let treeReads = 0, ddmsImages = 0;
    const root = { attributes: { "sdk-visible-stream": mode === "old" ? "1" : "2", "sdk-ui-wake-version": "1" } };
    active.onViewTreeReady = async () => {
      treeReads++;
      activate(policy, root, { capture: {}, error: null }, active, { getStore: () => active }, () => 98, () => "true", preferVerifiedSdkImages);
    };
    const result = await handoff(async (_port: number, options: any) => {
      assert.equal(options.skipImages(), false, "unknown capability cannot choose SDK before property/tree handoff");
      await options.onHierarchy({}, "window");
      if (!options.skipImages()) ddmsImages++;
      return [];
    }, { getStore: () => active }, () => active.preferVisibleSdk === true, () => {}, root, () => {});
    assert.equal(treeReads, 1, "do not add a capability-only tree request");
    assert.equal(ddmsImages, mode === "new" ? 0 : 1);
    assert.equal(result.windowName, "window");
  }
});
