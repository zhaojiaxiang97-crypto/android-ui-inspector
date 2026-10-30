import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { isLayerCopyAction, isLayerMenuAction, isLayerMenuOptions, layerCopyActions, layerMenuCopyValues } from "../shared/layer-context-menu";

const options = { canFocus: true, expandable: false, expanded: false };

test("layer menu only accepts boolean options and four bounded, distinct copy actions", () => {
  assert(isLayerMenuOptions(options));
  assert(isLayerMenuOptions({ ...options, copyActions: [...layerCopyActions] }));
  assert(isLayerMenuOptions({ ...options, copyActions: [] }));
  for (const value of [null, [], {}, { ...options, canFocus: 1 }, { ...options, expanded: "false" },
    { ...options, text: "renderer content must stay out of IPC" }, { ...options, copyActions: "copy-text" },
    { ...options, copyActions: ["copy-text", "copy-text"] }, { ...options, copyActions: ["copy-json"] },
    { ...options, copyActions: [null] }, { ...options, copyActions: [...layerCopyActions, "copy-text"] },
    { ...options, copyActions: Array(1) }, { ...options, copyActions: Object.assign(["copy-text"], { value: "raw content" }) }, Object.create(options),
    { ...options, copyActions: [{ action: "copy-text", value: "raw content" }] }])
    assert.equal(isLayerMenuOptions(value), false, JSON.stringify(value));
});

test("layer menu accepts known actions and cancellation without coercing malformed replies", () => {
  for (const action of [null, "hide", "restore", "focus", "focus-branch", "exit-focus", "expand", "collapse", ...layerCopyActions])
    assert(isLayerMenuAction(action));
  for (const value of [undefined, false, {}, [], "", "copy", "copy-json", { action: "copy-text" }])
    assert.equal(isLayerMenuAction(value), false);
  assert(isLayerCopyAction("copy-text"));
  assert.equal(isLayerCopyAction("hide"), false);
});

test("copy values preserve full text, whitespace, resource IDs and complete class names", () => {
  const root = makeNode("0"), node = makeNode("0/0"); root.children = [node];
  node.text = `  首尾空格\n${"完整内容".repeat(1000)}\n  `;
  node.resourceId = "com.example.long.package:id/some_control";
  node.className = "com.example.widgets.Parent$NestedView";
  const values = layerMenuCopyValues(root, node);
  assert.equal(values["copy-text"], node.text);
  assert.equal(values["copy-resource-id"], node.resourceId);
  assert.equal(values["copy-class-name"], node.className);
  assert(values["copy-hierarchy-path"]?.includes(node.text));
  node.text = "  \n ";
  assert.equal(layerMenuCopyValues(root, node)["copy-text"], node.text);
});

test("copy paths include every real ancestor and preserve names and full types", () => {
  const root = makeNode("0"), parent = makeNode("0/0"), child = makeNode("0/0/0");
  root.text = null; root.attributes = { "debug-name": "  Window Root  " }; root.className = "app.Root";
  parent.text = "页面\n容器"; parent.className = "app.Container";
  child.text = "叶子"; child.className = "app.Child";
  root.children = [parent]; parent.children = [child];
  const original = JSON.stringify(root);
  assert.equal(layerMenuCopyValues(root, child)["copy-hierarchy-path"], "  Window Root   (app.Root) > 页面\n容器 (app.Container) > 叶子 (app.Child)");
  assert.equal(layerMenuCopyValues(root, root)["copy-hierarchy-path"], "  Window Root   (app.Root)");
  assert.equal(JSON.stringify(root), original);
});

test("missing copy fields are omitted and stale or missing nodes never get copy values", () => {
  const root = makeNode("0"), child = makeNode("0/0"); root.children = [child];
  child.text = ""; child.resourceId = null; child.className = null; child.contentDesc = "可访问名称";
  const values = layerMenuCopyValues(root, child);
  assert.deepEqual(Object.keys(values), ["copy-hierarchy-path"]);
  assert(values["copy-hierarchy-path"]?.endsWith(" > 可访问名称"));
  assert.deepEqual(layerMenuCopyValues(root, { ...child }), {});
  assert.deepEqual(layerMenuCopyValues(root, makeNode("0/99")), {});
  assert.deepEqual(layerMenuCopyValues(root, null), {});
});

test("hierarchy copy handles deep trees without recursive traversal", () => {
  const root = makeNode("root"); let leaf = root;
  for (let depth = 1; depth < 3000; depth++) { const child = makeNode(`level-${depth}`); child.text = `层${depth}`; leaf.children = [child]; leaf = child; }
  const path = layerMenuCopyValues(root, leaf)["copy-hierarchy-path"]!;
  assert.equal(path.split(" > ").length, 3000);
  assert(path.endsWith(`层2999 (${leaf.className})`));
});
