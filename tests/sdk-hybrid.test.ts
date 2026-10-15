import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptSdkTree, joinSdkRefreshEvidence, joinSdkTreeAndDebugImages, sdkGroupBranchMatches, verifySdkTreeBeforeImages } from "../electron/sdk/sdk-hybrid";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";

test("SDK-only happy path adopts the SDK tree and fails closed on dump mismatches", () => {
  const props = { visible: true, clickable: false, enabled: true, focusable: false, focused: false, selected: false,
    scrollable: false, alpha: 1, elevation: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0 };
  const child = { ...props, ref: "android.widget.TextView@b", className: "android.widget.TextView",
    width: 30, height: 20, screenX: 10, screenY: 20, text: "RED CHILD", layoutParamsClass: "android.widget.FrameLayout$LayoutParams",
    layoutWidth: -1, layoutHeight: 20, children: [] };
  const sdk = { version: 1, styleVersion: 1, packageName: "sample.app", pid: 42,
    processInstance: "11111111-1111-1111-1111-111111111111", capturedAtMillis: 1, nodeCount: 2,
    root: { ...props, ref: "android.widget.FrameLayout@a", className: "android.widget.FrameLayout",
      width: 100, height: 100, screenX: 0, screenY: 0,
      layoutParamsClass: "android.widget.LinearLayout$LayoutParams", layoutWidth: 100, layoutHeight: 100, children: [child] } };
  const donors = () => {
    const text: UiNode = { ...makeNode("0/0/0"), className: "android.widget.TextView", text: null,
      bounds: { left: 19, top: 29, right: 49, bottom: 49, raw: "[19,29][49,49]" },
      attributes: { "view-ref": "android.widget.TextView@b", "inspection-source": "debug-view", "view-flags": "V.E....." } };
    const parent: UiNode = { ...makeNode("0/0"), className: "android.widget.FrameLayout", text: null,
      bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "[0,0][100,100]" },
      attributes: { "view-ref": "android.widget.FrameLayout@a", "inspection-source": "debug-view" }, children: [text] };
    return { ...makeNode("0"), package: "sample.app", children: [parent] } as UiNode;
  };
  const root = donors();
  adoptSdkTree(root, sdk, "sample.app", 42);
  assert.equal(root.children[0].bounds?.left, 0, "adopted geometry comes from the SDK");
  assert.equal(root.children[0].children[0].bounds?.left, 10, "stale dump coordinates do not leak into the tree");
  assert.equal(root.children[0].children[0].text, "RED CHILD", "SDK text is used when the dump has none");
  assert.equal(root.children[0].children[0].attributes?.["tree-source"], "debug-sdk");
  assert.equal(root.children[0].children[0].attributes?.["view-flags"], "V.E.....", "dump extras are kept");
  assert.equal(root.children[0].children[0].attributes?.["alpha"], "1");
  assert.equal(root.children[0].children[0].attributes?.["effective-alpha"], "1");
  assert.equal(root.attributes?.["sdk-process-instance"], sdk.processInstance);
  const wake = donors();
  adoptSdkTree(wake, { ...sdk, uiWakeVersion: 1 }, "sample.app", 42);
  assert.equal(wake.attributes?.["sdk-ui-wake-version"], "1");
  adoptSdkTree(wake, sdk, "sample.app", 42);
  assert.equal(wake.attributes?.["sdk-ui-wake-version"], "", "old SDK cannot inherit a wake capability");
  assert.throws(() => adoptSdkTree(donors(), { ...sdk, uiWakeVersion: 2 }, "sample.app", 42), /唤醒协议/);
  const hardware = donors();
  adoptSdkTree(hardware, { ...sdk, root: { ...sdk.root, children: [{ ...child, hardwareAccelerated: true }] } }, "sample.app", 42);
  assert.equal(hardware.children[0].children[0].attributes?.["sdk-hardwareAccelerated"], "true");
  const unknownHardware = donors();
  unknownHardware.children[0].children[0].attributes!["sdk-hardwareAccelerated"] = "true";
  adoptSdkTree(unknownHardware, sdk, "sample.app", 42);
  assert.equal(unknownHardware.children[0].children[0].attributes?.["sdk-hardwareAccelerated"], undefined, "missing SDK evidence cannot inherit donor evidence");
  assert.throws(() => adoptSdkTree(donors(), { ...sdk, root: { ...sdk.root, children: [{ ...child, hardwareAccelerated: "true" }] } }, "sample.app", 42), /hardwareAccelerated/);
  const clipping = donors();
  const clippingTree = { ...sdk, root: { ...sdk.root, clipChildren: true, clipToPadding: false } };
  adoptSdkTree(clipping, clippingTree, "sample.app", 42);
  assert.equal(clipping.children[0].attributes?.["clip-children"], "true");
  assert.equal(clipping.children[0].attributes?.["clip-to-padding"], "false");
  const changedClipping = joinSdkRefreshEvidence({ serial: "fixture", root: clipping, nodeCount: 3, inspectionSource: "debug-view", error: null } as UiSnapshot,
    { ...sdk, root: { ...sdk.root, clipChildren: false, clipToPadding: true } }, "sample.app", 42, sdk.processInstance);
  assert.equal(changedClipping.root!.children[0].attributes?.["clip-children"], "false", "fresh clipping flags replace old values, including false");
  assert.equal(changedClipping.root!.children[0].attributes?.["clip-to-padding"], "true");
  for (const key of ["clipChildren", "clipToPadding"]) {
    assert.throws(() => adoptSdkTree(donors(), { ...sdk, root: { ...sdk.root, [key]: "false" } }, "sample.app", 42), new RegExp(key));
  }
  const live = { serial: "fixture", root: hardware, nodeCount: 3, inspectionSource: "debug-view", error: null } as UiSnapshot;
  const renewed = joinSdkRefreshEvidence(live, { ...sdk, root: { ...sdk.root, children: [{ ...child, hardwareAccelerated: false }] } }, "sample.app", 42, sdk.processInstance);
  assert.equal(renewed.root!.children[0].children[0].attributes?.["sdk-hardwareAccelerated"], "false", "fresh evidence must replace the old true flag");
  assert.throws(() => joinSdkRefreshEvidence(live, { ...sdk, processInstance: "22222222-2222-2222-2222-222222222222" }, "sample.app", 42, sdk.processInstance), /进程身份/);
  assert.throws(() => joinSdkRefreshEvidence(live, { ...sdk, root: { ...sdk.root, children: [{ ...child, width: 31 }] } }, "sample.app", 42, sdk.processInstance), /尺寸不一致/);
  assert.doesNotThrow(() => verifySdkTreeBeforeImages(root, 3, sdk, "sample.app", 42), "the adopted tree satisfies the normal merger");
  const faded = donors();
  adoptSdkTree(faded, { ...sdk, root: { ...sdk.root, alpha: 0.5, children: [{ ...child, alpha: 0 }] } }, "sample.app", 42);
  assert.equal(faded.children[0].children[0].attributes?.["effective-alpha"], "0");
  assert.equal(faded.children[0].children[0].visibleToUser, false, "a transparent branch is hidden");

  const wrapped = donors();
  const mid = { ...props, ref: "android.widget.FrameLayout@c2", className: "android.widget.FrameLayout",
    width: 100, height: 100, screenX: 0, screenY: 0, layoutParamsClass: "android.widget.LinearLayout$LayoutParams",
    layoutWidth: 100, layoutHeight: 100, children: [{ ...child }] };
  adoptSdkTree(wrapped, { ...sdk, nodeCount: 3, root: { ...sdk.root, children: [mid] } }, "sample.app", 42);
  assert.equal(wrapped.children[0].children[0].attributes?.["view-ref"], "android.widget.FrameLayout@c2", "a wrapper dropped by the dump text is restored from the SDK");
  assert.equal(wrapped.children[0].children[0].children[0].attributes?.["view-ref"], "android.widget.TextView@b");

  const extra = donors();
  extra.children[0].children.push({ ...makeNode("0/0/1"), className: "android.widget.ImageView",
    attributes: { "view-ref": "android.widget.ImageView@e1", "inspection-source": "debug-view" } });
  assert.throws(() => adoptSdkTree(extra, sdk, "sample.app", 42), /不在 SDK 树中/);
  const resized = donors();
  resized.children[0].children[0].bounds = { left: 10, top: 20, right: 41, bottom: 40, raw: "[10,20][41,40]" };
  assert.throws(() => adoptSdkTree(resized, sdk, "sample.app", 42), /尺寸不一致/);
  const misplaced = donors();
  misplaced.children[0].children[0].children.push({ ...makeNode("0/0/0/0"), className: "android.widget.FrameLayout",
    attributes: { "view-ref": "android.widget.FrameLayout@a", "inspection-source": "debug-view" } });
  assert.throws(() => adoptSdkTree(misplaced, sdk, "sample.app", 42), /父子关系/);
  assert.throws(() => adoptSdkTree(donors(), { ...sdk, root: { ...sdk.root, ref: "android.widget.FrameLayout@c" } }, "sample.app", 42), /窗口/);
  assert.throws(() => adoptSdkTree(donors(), sdk, "sample.app", 43), /进程/);

  const replaced = donors();
  replaced.children[0].children[0].attributes!["clip-to-outline"] = "true";
  replaced.children[0].children[0].layerImageDataUrl = "data:image/png;base64,stale";
  const fresh = { ...sdk, root: { ...sdk.root, children: [{ ...child, ref: "android.widget.TextView@f", width: 42, text: "NEW CHILD" }] } };
  assert.throws(() => adoptSdkTree(replaced, fresh, "sample.app", 42), /不在 SDK 树中/);
  adoptSdkTree(replaced, fresh, "sample.app", 42, "merged-capture");
  const newChild = replaced.children[0].children[0];
  assert.equal(newChild.attributes?.["view-ref"], "android.widget.TextView@f");
  assert.equal(newChild.text, "NEW CHILD");
  assert.equal(newChild.bounds!.right - newChild.bounds!.left, 42);
  assert.equal(newChild.layerImageDataUrl, undefined);
  assert.equal(newChild.attributes?.["clip-to-outline"], undefined);
  const unchanged = donors();
  const saved = JSON.stringify(unchanged);
  for (const invalid of [
    { ...fresh, pid: 43 }, { ...fresh, packageName: "other.app" },
    { ...fresh, processInstance: "invalid" },
    { ...fresh, root: { ...fresh.root, ref: "android.widget.FrameLayout@ff" } },
    { ...fresh, root: { ...fresh.root, children: [{ ...child, className: "android.widget.ImageView" }] } },
    { ...fresh, root: { ...fresh.root, children: [{ ...child, paddingLeft: "invalid" }] } },
  ]) {
    assert.throws(() => adoptSdkTree(unchanged, invalid, "sample.app", 42, "merged-capture"));
    assert.equal(JSON.stringify(unchanged), saved, "a rejected tree leaves the original unchanged");
  }
});

test("SDK tree joins only the same process, view identities and geometry", () => {
  const text: UiNode = { ...makeNode("0/0/0"), className: "android.widget.TextView", text: null,
    bounds: { left: 10, top: 20, right: 40, bottom: 40, raw: "[10,20][40,40]" },
    attributes: { "view-ref": "android.widget.TextView@b", "inspection-source": "debug-view" },
    layerImageDataUrl: "data:image/png;base64,child", layerImageSize: { width: 30, height: 20 }, layerImageStatus: "captured" };
  const parent: UiNode = { ...makeNode("0/0"), className: "android.widget.FrameLayout", text: null,
    bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "[0,0][100,100]" },
    attributes: { "view-ref": "android.widget.FrameLayout@a", "inspection-source": "debug-view" },
    layerImageDataUrl: "data:image/png;base64,parent", layerImageSize: { width: 100, height: 100 }, layerImageStatus: "captured", children: [text] };
  const snapshot: UiSnapshot = { serial: "device", root: { ...makeNode("0"), package: "sample.app", children: [parent] },
    nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-view" };
  const props = { visible: true, clickable: false, enabled: true, focusable: false, focused: false, selected: false,
    scrollable: false, alpha: 1, elevation: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0 };
  const child = { ...props, ref: "android.widget.TextView@b", className: "android.widget.TextView",
    width: 30, height: 20, screenX: 10, screenY: 20, text: "RED CHILD", debugName: "业务调试名称", paddingLeft: -8,
    longClickable: true, contextClickable: false, hasOnClickListeners: true, pressed: false, activated: false,
    layoutParamsClass: "android.widget.FrameLayout$LayoutParams", layoutWidth: -1, layoutHeight: 20, layoutGravity: 85,
    marginTop: 0, marginRight: -10, marginBottom: 4, marginLeft: 2, children: [] };
  const sdk = { version: 1, styleVersion: 1, packageName: "sample.app", pid: 42,
    processInstance: "11111111-1111-1111-1111-111111111111", capturedAtMillis: 1, nodeCount: 2,
    classHierarchy: {
      "android.widget.FrameLayout": ["android.widget.FrameLayout", "android.view.ViewGroup", "android.view.View"],
      "android.widget.TextView": ["android.widget.TextView", "android.view.View"],
    },
    root: { ...props, ref: "android.widget.FrameLayout@a", className: "android.widget.FrameLayout",
      width: 100, height: 100, screenX: 0, screenY: 0,
      layoutParamsClass: "android.widget.LinearLayout$LayoutParams", layoutWidth: 100, layoutHeight: 100,
      layoutGravity: -1, layoutWeight: 0.5, children: [child] } };

  const joined = joinSdkTreeAndDebugImages(snapshot, sdk, "sample.app", 42);
  assert.doesNotThrow(() => verifySdkTreeBeforeImages(snapshot.root!, snapshot.nodeCount, sdk, "sample.app", 42));
  assert.throws(() => verifySdkTreeBeforeImages(snapshot.root!, snapshot.nodeCount,
    { ...sdk, root: { ...sdk.root, children: [] } }, "sample.app", 42), /父子关系/,
  "a changing page must not merge stale SDK properties");
  assert.equal(joined.inspectionSource, "debug-hybrid");
  assert.equal(joined.root?.attributes?.["sdk-ref-debug-canvas-version"], undefined);
  assert.equal(joinSdkTreeAndDebugImages(snapshot, { ...sdk, refDebugCanvasVersion: 1 }, "sample.app", 42)
    .root?.attributes?.["sdk-ref-debug-canvas-version"], "1");
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, refDebugCanvasVersion: 2 }, "sample.app", 42));
  assert.equal(joined.root?.attributes?.["sdk-style-version"], "1");
  assert.equal(joinSdkTreeAndDebugImages(snapshot, { ...sdk, styleVersion: undefined }, "sample.app", 42).root?.attributes?.["sdk-style-version"], undefined);
  assert.equal(joined.root?.children[0].children[0].text, "RED CHILD");
  assert.equal(joined.root?.children[0].children[0].attributes?.["debug-name"], "业务调试名称");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-layout-width"], "-1");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-marginRight"], "-10");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-paddingLeft"], "-8");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-layout-gravity"], "85");
  const constraintLayout = joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutParamsClass: "androidx.constraintlayout.widget.ConstraintLayout$LayoutParams", layoutGravity: undefined,
    layoutRules: { type: "ConstraintLayout", rules: { leftToLeft: "parent", topToBottom: "sample.app:id/title", horizontalBias: "0.4", dimensionRatio: "W,16:9" } } }] } }, "sample.app", 42);
  assert.deepEqual(JSON.parse(constraintLayout.root?.children[0].children[0].attributes?.["sdk-layout-rules"] ?? "{}"), {
    type: "ConstraintLayout", rules: { leftToLeft: "parent", topToBottom: "sample.app:id/title", horizontalBias: "0.4", dimensionRatio: "W,16:9" },
  });
  const relative = joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutParamsClass: "android.widget.RelativeLayout$LayoutParams", layoutGravity: undefined,
    layoutRules: { type: "RelativeLayout", rules: { below: "sample.app:id/title", centerHorizontal: true } } }] } }, "sample.app", 42);
  assert.deepEqual(JSON.parse(relative.root?.children[0].children[0].attributes?.["sdk-layout-rules"] ?? "{}"), {
    type: "RelativeLayout", rules: { below: "sample.app:id/title", centerHorizontal: true },
  });
  assert.equal(joined.root?.children[0].attributes?.["sdk-layout-weight"], "0.5");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-longClickable"], "true");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-contextClickable"], "false");
  assert.equal(joined.root?.children[0].attributes?.["sdk-class-hierarchy"], "android.widget.FrameLayout → android.view.ViewGroup → android.view.View");
  assert.equal(joined.root?.children[0].attributes?.["sdk-marginRight"], undefined, "missing SDK margin is not zero");
  assert.equal(joinSdkTreeAndDebugImages(snapshot, { ...sdk, classHierarchy: undefined }, "sample.app", 42).root?.children[0].attributes?.["sdk-class-hierarchy"], undefined, "old SDK snapshots remain readable");
  assert.equal(joined.root?.children[0].layerImageDataUrl, parent.layerImageDataUrl);
  assert.equal(joined.root?.children[0].children[0].layerImageDataUrl, text.layerImageDataUrl);
  const clipped = joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    clipToOutline: true, outlineLeft: 0, outlineTop: 0, outlineRight: 30, outlineBottom: 20, outlineRadius: 5 }] } }, "sample.app", 42);
  assert.equal(clipped.root?.children[0].children[0].attributes?.["sdk-outlineRadius"], "5");
  assert.equal(clipped.root?.children[0].children[0].attributes?.["clip-to-outline"], "true");
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    clipToOutline: true, outlineLeft: 0 }] } }, "sample.app", 42), /轮廓裁剪数据不完整/);
  const matches = (tree: unknown, id = "0/0") => sdkGroupBranchMatches(joined.root!, id, tree, "sample.app", 42, sdk.processInstance);
  assert.equal(matches(sdk), true, "unchanged group can be captured live");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, alpha: 0.5 } }), false, "changed parent opacity cannot reuse the old group geometry/style");
  assert.equal(sdkGroupBranchMatches(clipped.root!, "0/0", { ...sdk, root: { ...sdk.root, children: [{ ...child,
    clipToOutline: true, outlineLeft: 0, outlineTop: 0, outlineRight: 30, outlineBottom: 20, outlineRadius: 8 }] } }, "sample.app", 42, sdk.processInstance), false,
  "changed rounded outline cannot reuse the old branch");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, children: [{ ...child, screenX: 13 }] } }), true, "small motion inside a live group is safe");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, children: [{ ...child, screenX: 19 }] } }), false, "larger child motion still rejects the old branch");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, children: [{ ...child, screenX: undefined }] } }), false, "missing SDK coordinates are not accepted as small motion");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, screenX: 1 } }), false, "the group frame must not move");
  assert.equal(matches({ ...sdk, root: { ...sdk.root, children: [{ ...child, ref: "android.widget.TextView@c" }] } }), false, "replaced child must reject old group");
  assert.equal(matches({ ...sdk, processInstance: "another-process" }), false, "restarted process must reject old group");
  assert.equal(matches(sdk, "0/0/0"), false, "leaf is not a collapsible group");
  const shifted = joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, screenX: 15 }] } }, "sample.app", 42);
  assert.equal(shifted.root?.children[0].children[0].bounds?.left, 10, "small motion must not move the older image");
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, sdk, "sample.app", 43), /进程/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, screenX: 19 }] } }, "sample.app", 42), /位置/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, ref: "android.widget.TextView@c" }] } }, "sample.app", 42), /身份/);
  assert.throws(() => joinSdkTreeAndDebugImages({ ...snapshot, root: { ...snapshot.root!, children: [{ ...parent, children: [{ ...text, text: "BEFORE" }] }] } }, sdk, "sample.app", 42), /文字/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, debugName: " ".repeat(2) }] } }, "sample.app", 42), /调试名称/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, marginLeft: undefined }] } }, "sample.app", 42), /margin/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, layoutWidth: undefined }] } }, "sample.app", 42), /布局宽度/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, paddingLeft: "-8" }] } }, "sample.app", 42), /paddingLeft/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, classHierarchy: { ...sdk.classHierarchy, "android.widget.TextView": ["android.widget.TextView", "fake.View"] } }, "sample.app", 42), /继承链/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, longClickable: "yes" }] } }, "sample.app", 42), /longClickable/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child, layoutGravity: "right" }] } }, "sample.app", 42), /布局重力/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, layoutWeight: Number.NaN } }, "sample.app", 42), /布局权重/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutRules: { type: "ConstraintLayout", rules: { click: "parent" } } }] } }, "sample.app", 42), /不支持/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutParamsClass: undefined, layoutRules: { type: "RelativeLayout", rules: { centerHorizontal: true } } }] } }, "sample.app", 42), /缺少 LayoutParams/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutRules: { type: "RelativeLayout", rules: { below: "unknown target" } } }] } }, "sample.app", 42), /布局目标/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutRules: { type: "ConstraintLayout", rules: { horizontalBias: "1.5" } } }] } }, "sample.app", 42), /布局数值/);
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, root: { ...sdk.root, children: [{ ...child,
    layoutRules: { type: "ConstraintLayout", rules: { dimensionRatio: "not-a-ratio" } } }] } }, "sample.app", 42), /宽高比/);
});
