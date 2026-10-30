import assert from "node:assert/strict";
import { test } from "node:test";
import { preferVerifiedSdkImages } from "../electron/sdk/sdk-capture-route";
import { createCaptureRunContext } from "../electron/capture/run-context";
import { readDebugPropertiesAndImages } from "../electron/capture/debug-image-handoff";
import { makeNode } from "../benchmarks/fixtures";

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

test("actual adoption boundary changes only this capture's route after successful verification", () => {
  for (const mode of ["new", "old", "missing", "failed", "disabled"]) {
    const options = { inspectionMode: "sdk-enhanced" as const, preferVisibleSdk: mode === "disabled" ? false : undefined };
    const context = createCaptureRunContext(options);
    context.plan.acceptVerifiedSdk({ nodeCount: 98, verified: mode !== "missing" && mode !== "failed",
      visibleStream: mode === "old" ? "1" : "2", uiWake: "1", hardwareAccelerated: "true" });
    assert.equal(context.plan.preferVisibleSdk, mode === "new" ? true : options.preferVisibleSdk);
    assert.equal(context.options.preferVisibleSdk, options.preferVisibleSdk);
    assert.equal(options.preferVisibleSdk, mode === "disabled" ? false : undefined, "do not mutate caller or next request policy");
  }
});
test("initial small-tree preparation stays conservative before SDK capabilities are known", () => {
  assert.equal(createCaptureRunContext({ inspectionMode: "sdk-enhanced" }).plan.sdkFirstCandidate(98, true), false);
  assert.equal(createCaptureRunContext({ inspectionMode: "sdk-enhanced", preferVisibleSdk: true }).plan.sdkFirstCandidate(98, true), true);
  assert.equal(createCaptureRunContext({ inspectionMode: "sdk-enhanced", preferVisibleSdk: false }).plan.sdkFirstCandidate(500, true), false);
});

test("actual property handoff skips DDMS images only after this tree callback selects SDK", async () => {
  for (const mode of ["new", "old", "disabled"]) {
    const policy = { preferVisibleSdk: mode === "disabled" ? false : undefined };
    let treeReads = 0, ddmsImages = 0;
    const context = createCaptureRunContext({ inspectionMode: "sdk-enhanced", ...policy, onViewTreeReady: async () => {
      treeReads++;
      context.plan.acceptVerifiedSdk({ nodeCount: 98, verified: true,
        visibleStream: mode === "old" ? "1" : "2", uiWake: "1", hardwareAccelerated: "true" });
    } });
    const root = { ...makeNode("0"), children: [{ ...makeNode("0/0"), attributes: { "view-ref": "Decor@abc" } }] };
    const ports: NonNullable<Parameters<typeof readDebugPropertiesAndImages>[1]> = {
      captureViewLayers: async (_port, options) => {
        assert.equal(typeof options!.skipImages, "function");
        const skipImages = options!.skipImages as () => boolean;
        assert.equal(skipImages(), false, "unknown capability cannot choose SDK before property/tree handoff");
        await options!.onHierarchy!({} as Parameters<NonNullable<NonNullable<typeof options>["onHierarchy"]>>[0], "window");
        if (!skipImages()) ddmsImages++;
        return [];
      },
      applyViewProperties: () => {},
    };
    const result = await readDebugPropertiesAndImages({ port: 1, packageName: "sample.app", root, context,
      stage: () => {}, onBatchTiming: () => {} }, ports);
    assert.equal(treeReads, 1, "do not add a capability-only tree request");
    assert.equal(ddmsImages, mode === "new" ? 0 : 1);
    assert.equal(result.windowName, "window");
  }
});
