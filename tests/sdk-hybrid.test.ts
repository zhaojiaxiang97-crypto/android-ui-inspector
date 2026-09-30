import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSdkTreeAndDebugImages, sdkGroupBranchMatches, verifySdkTreeBeforeImages } from "../electron/sdk-hybrid";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";

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
  assert.equal(joined.root?.attributes?.["sdk-style-version"], "1");
  assert.equal(joinSdkTreeAndDebugImages(snapshot, { ...sdk, styleVersion: undefined }, "sample.app", 42).root?.attributes?.["sdk-style-version"], undefined);
  assert.equal(joined.root?.children[0].children[0].text, "RED CHILD");
  assert.equal(joined.root?.children[0].children[0].attributes?.["debug-name"], "业务调试名称");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-layout-width"], "-1");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-marginRight"], "-10");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-paddingLeft"], "-8");
  assert.equal(joined.root?.children[0].children[0].attributes?.["sdk-layout-gravity"], "85");
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
});
