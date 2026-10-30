import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";
import { uniqueSnapshotNode } from "../src/features/automation/selector-match-diagnostics";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.FunctionDeclaration | undefined;
const visit = (node: ts.Node) => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "revealTaskMatch") declaration = node;
  ts.forEachChild(node, visit);
};
visit(source); assert.ok(declaration);
const code = ts.transpileModule(`const callback = ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const root = makeNode("root"), target = makeNode("target", 1); root.children = [target];
  const snapshot: UiSnapshot = { serial: "offline-fixture", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast" };
  const calls: Array<{ node: UiNode; root: UiNode }> = [], visibility: string[] = [];
  const scope = { snapshot, uniqueSnapshotNode, navigateToNode: (node: UiNode, sourceRoot: UiNode) => { calls.push({ node, root: sourceRoot }); return true; },
    setDebugTaskEditorVisibility: (value: string) => { visibility.push(value); } };
  const reveal = new Function("scope", `with(scope) { ${code} return callback; }`)(scope);
  return { scope, snapshot, target, root, calls, visibility, reveal };
}

test("candidate navigation uses the current snapshot and actual node object before hiding the editor", () => {
  const h = harness();
  assert.equal(h.reveal("target", h.snapshot), true);
  assert.deepEqual(h.calls, [{ node: h.target, root: h.root }]); assert.deepEqual(h.visibility, ["closed"]);
  assert.equal(h.calls[0].node, h.target); assert.equal(h.calls[0].root, h.root);
});

test("old snapshots, duplicate IDs and missing nodes cannot select a coincidentally named current node", () => {
  const h = harness();
  assert.equal(h.reveal("target", structuredClone(h.snapshot)), false);
  assert.equal(h.reveal("missing", h.snapshot), false);
  h.root.children.push({ ...h.target }); h.snapshot.nodeCount = 3;
  assert.equal(h.reveal("target", h.snapshot), false);
  assert.equal(h.calls.length, 0); assert.equal(h.visibility.length, 0);
});

test("busy or invalid workspace navigation retains the open editor and its draft", () => {
  const h = harness(); h.scope.navigateToNode = () => false;
  assert.equal(h.reveal("target", h.snapshot), false); assert.equal(h.visibility.length, 0);
  h.snapshot.root = null;
  assert.equal(h.reveal("target", h.snapshot), false); assert.equal(h.visibility.length, 0);
});
