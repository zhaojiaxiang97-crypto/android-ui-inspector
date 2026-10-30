import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { treeExpansionToContent } from "../shared/tree-collapse";
import type { UiNode } from "../shared/types";

function branch(id: string, properties: Partial<UiNode> = {}, children = [makeNode(`${id}/child`)]): UiNode {
  return { ...makeNode(id), ...properties, children };
}

test("double-click crosses empty and skip-draw wrappers, stopping at each painted branch", () => {
  const painted = branch("painted", { layerImageDataUrl: "data:image/png;base64,pixels", layerImageStatus: "captured", layerImageEmpty: false });
  const styled = branch("styled", { layerImageDataUrl: "data:image/svg+xml,style", layerImageStatus: "style" });
  const second = branch("second", { attributes: { "skip-draw": "true" } }, [painted, styled]);
  const first = branch("first", { layerImageEmpty: true }, [second]);
  const root = branch("root", {}, [first]);
  assert.deepEqual(treeExpansionToContent(root, new Set()), new Set(["root", "first", "second"]));
  assert.deepEqual(treeExpansionToContent(painted, new Set()), new Set(["painted"]));
});

test("unknown, failed, ambiguous and captured pixels are not mistaken for empty containers", () => {
  const boundaries = [
    branch("unknown"),
    branch("missing", { layerImageStatus: "unavailable" }),
    branch("failed", { layerImageStatus: "failed", layerImageEmpty: true, attributes: { "skip-draw": "true" } }),
    branch("ambiguous", { layerImageStatus: "ambiguous", layerImageEmpty: true }),
    branch("painted-skip-draw", { layerImageDataUrl: "data:image/png;base64,pixels", attributes: { "skip-draw": "true" } }),
    branch("transparent-class-name", { className: "android.widget.FrameLayout" }),
  ];
  assert.deepEqual(treeExpansionToContent(branch("root", {}, boundaries), new Set()), new Set(["root"]));
});

test("empty sibling branches open independently without entering device-invisible content", () => {
  const open = branch("open", { layerImageEmpty: true });
  const hidden = branch("hidden", { layerImageEmpty: true, visibleToUser: false });
  const alpha = branch("alpha", { layerImageEmpty: true, attributes: { "effective-alpha": "0", alpha: "1" } });
  const capturedHidden = branch("captured-hidden", { layerImageEmpty: true, layerImageStatus: "hidden" });
  const emptyLeaf = { ...makeNode("empty-leaf"), layerImageEmpty: true };
  assert.deepEqual(treeExpansionToContent(branch("root", {}, [open, hidden, alpha, capturedHidden, emptyLeaf]), new Set()), new Set(["root", "open"]));
});

test("expansion preserves other branches, existing descendant choices and immutable source data", () => {
  const painted = branch("opaque-painted", { layerImageDataUrl: "pixels" });
  const wrapper = branch("opaque-wrapper", { layerImageEmpty: true }, [painted]);
  const root = branch("opaque-root", {}, [wrapper]), before = JSON.stringify(root);
  const expanded = new Set(["elsewhere", painted.id]);
  const next = treeExpansionToContent(root, expanded);
  assert.deepEqual(next, new Set(["elsewhere", painted.id, root.id, wrapper.id]));
  assert.deepEqual(expanded, new Set(["elsewhere", painted.id]));
  assert.equal(JSON.stringify(root), before);
  assert.deepEqual(treeExpansionToContent(root, new Set([root.id])), new Set([root.id]), "repeating expand must not open nested branches");
  assert.deepEqual(treeExpansionToContent(makeNode("leaf"), expanded), expanded);
});

test("deep chains are traversed iteratively and all-empty branches terminate at leaves", () => {
  const root = branch("root", { layerImageEmpty: true }, []);
  let node = root;
  for (let depth = 1; depth <= 12000; depth++) {
    const child = branch(`node-${depth}`, { layerImageEmpty: true }, []);
    node.children.push(child); node = child;
  }
  const expanded = treeExpansionToContent(root, new Set());
  assert.equal(expanded.size, 12000);
  assert(!expanded.has(node.id));
});
