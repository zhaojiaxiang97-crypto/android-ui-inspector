import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import { flattenNodes, mergeLayerImages } from "../shared/tree-utils";
import type { CaptureGeometry, InspectionPreview, UiSnapshot } from "../shared/types";

// Execute the workspace's actual presentation callback without mounting the desktop UI.
const source = ts.createSourceFile("workspace.ts", readFileSync(new URL("../src/features/inspection/useInspectionWorkspace.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let previewFunction: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "previewCapture") previewFunction = node;
  else ts.forEachChild(node, visit);
}
visit(source); assert.ok(previewFunction);
const compiled = ts.transpileModule(previewFunction.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;

function harness() {
  const root = makeNode("0"), child = makeNode("0/0"); root.children = [child];
  const initial: UiSnapshot = { serial: "fixture", root, nodeCount: 2, rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null };
  const state = { snapshot: initial, selected: child, expanded: new Set<string>(), capturedAt: "tree-time" };
  const scope = {
    currentSnapshotRef: { current: initial }, captureTreeRef: { current: root }, captureTreeTouchedRef: { current: true },
    menuRequestRef: { current: 7 },
    setSnapshot: (next: UiSnapshot) => { state.snapshot = next; },
    setSelectedNodeState: (update: (node: typeof child) => typeof child) => { state.selected = update(state.selected); },
    setTreeExpandedIds: () => assert.fail("screen must not change tree expansion"),
    setTreeCapturedAt: () => assert.fail("screen must not change tree capture time"),
    presentCaptureTree: () => assert.fail("screen must not present another tree"),
    mergeLayerImages, flattenNodes,
  };
  const preview = new Function("scope", `with(scope) { ${compiled}; return previewCapture; }`)(scope) as (event: InspectionPreview) => void;
  return { state, scope, preview };
}

test("workspace merges a late screen into the current tree without replacing interaction or layer state", () => {
  const h = harness(), requestId = "current", expanded = h.state.expanded;
  h.preview({ requestId, phase: "layers", updates: [{ id: "0/0", layerImageDataUrl: "first-layer" }] });
  const root = h.state.snapshot.root, selected = h.state.selected, menuRevision = h.scope.menuRequestRef.current;
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  const captureGeometry: CaptureGeometry = { hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: frame };
  h.preview({ requestId, phase: "screen", screen: { screenshotDataUrl: "preview-screen", captureGeometry } });
  assert.equal(h.state.snapshot.screenshotDataUrl, "preview-screen"); assert.equal(h.state.snapshot.captureGeometry, captureGeometry);
  assert.equal(h.state.snapshot.root, root); assert.equal(h.scope.captureTreeRef.current, root);
  assert.equal(h.state.selected, selected); assert.equal(h.state.expanded, expanded);
  assert.equal(h.scope.menuRequestRef.current, menuRevision); assert.equal(h.state.capturedAt, "tree-time");
  assert.equal(selected.layerImageDataUrl, "first-layer");
  h.preview({ requestId, phase: "layers", updates: [{ id: "0/0", layerImageDataUrl: "next-layer" }] });
  assert.equal(h.state.snapshot.screenshotDataUrl, "preview-screen"); assert.equal(h.state.snapshot.captureGeometry, captureGeometry);
  assert.equal(h.state.selected.layerImageDataUrl, "next-layer"); assert.equal(h.state.expanded, expanded);
});

test("screen update cannot create a workspace document before its tree exists", () => {
  const h = harness(); h.scope.currentSnapshotRef.current = { ...h.state.snapshot, root: null };
  const previous = h.state.snapshot;
  h.preview({ requestId: "current", phase: "screen", screen: { screenshotDataUrl: "early-screen" } });
  assert.equal(h.state.snapshot, previous); assert.equal(h.scope.menuRequestRef.current, 7);
});
