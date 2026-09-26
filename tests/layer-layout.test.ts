import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLayerLayout, buildLayerOverview, buildLayerRecords } from "../shared/layer-layout";
import type { UiBounds, UiNode } from "../shared/types";
import { subtreeImageNodes } from "../shared/layer-textures";

const size = { width: 100, height: 100 };
const bounds = (left: number, top: number, right: number, bottom: number): UiBounds => ({
  left,
  top,
  right,
  bottom,
  raw: `[${left},${top}][${right},${bottom}]`,
});

test("overview keeps a selected node beyond its cap and excludes hidden descendants", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  root.children = Array.from({ length: 520 }, (_, index) => ({ ...node(`child-${index}`, bounds(0, 0, 10, 10)), index }));
  const selected = root.children[519];
  const hidden = node("hidden", bounds(0, 0, 10, 10)); hidden.visibleToUser = false;
  hidden.children = [node("hidden-child", bounds(0, 0, 10, 10))]; root.children.push(hidden);
  const result = buildLayerOverview(root, selected, size, { maxLayers: 512 });
  assert.equal(result.records.length, 512);
  assert.equal(result.candidateCount, 520);
  assert.equal(result.omittedCount, 8);
  assert.equal(result.records.at(-1)?.id, selected.id);
  assert.equal(result.records.at(-1)?.isSelected, true);
  root.visibleToUser = false;
  const hiddenRoot = buildLayerOverview(root, selected, size);
  assert.equal(hiddenRoot.parent, null);
  assert.equal(hiddenRoot.records.length, 0);
});

test("native measured Z overrides index consistently in expanded and folded branches", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const front = { ...node("front", bounds(0, 0, 10, 10)), index: 0, attributes: { z: "4" }, layerImageDataUrl: "front", layerImageSize: size };
  const back = { ...node("back", bounds(0, 0, 10, 10)), index: 1, attributes: { z: "-2" }, layerImageDataUrl: "back", layerImageSize: size };
  root.children = [front, back];
  assert.deepEqual(buildLayerOverview(root, root, size).records.map((record) => record.id), ["back", "front"]);
  assert.deepEqual(subtreeImageNodes(root).map((node) => node.id), ["back", "front"]);
});

function node(id: string, rect: UiBounds, className = "android.view.ViewGroup"): UiNode {
  return {
    id,
    index: null,
    className,
    package: "com.example",
    text: null,
    resourceId: null,
    contentDesc: null,
    bounds: rect,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    selected: false,
    visibleToUser: true,
    children: [],
  };
}

test("focus layout keeps the selected path and one child depth with deterministic z offsets", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const shell = node("shell", bounds(0, 0, 100, 100));
  const panel = node("panel", bounds(10, 10, 90, 90));
  const selected = node("selected", bounds(20, 20, 80, 80), "android.widget.Button");
  const child = node("child", bounds(30, 30, 70, 70), "android.widget.TextView");
  const grandchild = node("grandchild", bounds(35, 35, 65, 65), "android.widget.TextView");
  selected.children = [child];
  child.children = [grandchild];
  panel.children = [selected];
  shell.children = [panel];
  root.children = [shell];

  const records = buildLayerRecords(root, selected, size, { layerGap: 24 });

  assert.deepEqual(records.map((record) => record.id), ["root", "shell", "panel", "selected", "child"]);
  assert.deepEqual(records.map((record) => record.z), [-72, -48, -24, 0, 24]);
  assert.equal(records.find((record) => record.isSelected)?.id, "selected");
  assert.equal(records.find((record) => record.id === "shell")?.isAncestor, true);
  assert.equal(records.find((record) => record.id === "child")?.isDescendant, true);
  assert.equal(records.find((record) => record.id === "grandchild"), undefined);
});

test("layer layout clips visible bounds and filters hidden, empty, and out-of-frame nodes", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const selected = node("selected", bounds(-20, -10, 60, 50));
  const clipped = node("clipped", bounds(40, 40, 140, 140));
  const hidden = node("hidden", bounds(10, 10, 20, 20));
  hidden.visibleToUser = false;
  const empty = node("empty", bounds(10, 10, 10, 20));
  const outside = node("outside", bounds(120, 10, 140, 20));
  selected.children = [clipped, hidden, empty, outside];
  root.children = [selected];

  const records = buildLayerRecords(root, selected, size, { maxChildDepth: 1 });
  const clippedRecord = records.find((record) => record.id === "selected");

  assert.deepEqual(clippedRecord?.renderBounds, { left: 0, top: 0, right: 60, bottom: 50 });
  assert.equal(clippedRecord?.sourceBounds.raw, "[-20,-10][60,50]");
  assert.equal(records.some((record) => record.id === "clipped"), true);
  assert.equal(records.some((record) => record.id === "hidden"), false);
  assert.equal(records.some((record) => record.id === "empty"), false);
  assert.equal(records.some((record) => record.id === "outside"), false);
});

test("branch and all scopes expand only within their configured depth", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const selected = node("selected", bounds(10, 10, 90, 90));
  const first = node("first", bounds(20, 20, 80, 80));
  const second = node("second", bounds(30, 30, 70, 70));
  const third = node("third", bounds(40, 40, 60, 60));
  second.children = [third];
  first.children = [second];
  selected.children = [first];
  const sibling = node("sibling", bounds(0, 0, 5, 5));
  sibling.index = 1;
  sibling.attributes = { "drawing-order": "2" };
  const earlierSibling = node("earlier-sibling", bounds(0, 0, 5, 5));
  earlierSibling.index = 2;
  earlierSibling.attributes = { "drawing-order": "1" };
  root.children = [selected, sibling, earlierSibling];

  const branch = buildLayerRecords(root, selected, size, { scope: "branch", maxDepth: 2 });
  assert.deepEqual(branch.map((record) => record.id), ["root", "selected", "first", "second"]);

  const all = buildLayerRecords(root, selected, size, { scope: "all", maxDepth: 1 });
  assert.deepEqual(all.map((record) => record.id), ["root", "selected", "earlier-sibling", "sibling"]);
});

test("layer cap never drops the selected node and can disable parent or child collections", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const parent = node("parent", bounds(0, 0, 100, 100));
  const selected = node("selected", bounds(10, 10, 90, 90));
  selected.children = [node("child-1", bounds(20, 20, 40, 40)), node("child-2", bounds(50, 50, 70, 70))];
  parent.children = [selected];
  root.children = [parent];

  const limited = buildLayerLayout(root, selected, size, { maxLayers: 2 });
  assert.equal(limited.records.some((record) => record.isSelected), true);
  assert.equal(limited.truncated, true);
  assert.equal(limited.omittedCount, 3);

  const noParents = buildLayerRecords(root, selected, size, { includeParents: false, includeChildren: false });
  assert.deepEqual(noParents.map((record) => record.id), ["selected"]);
});

test("overlapping siblings receive separate depth slots for direct 3D picking", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const selected = node("selected", bounds(10, 10, 90, 90));
  selected.children = [node("child-1", bounds(20, 20, 80, 80)), node("child-2", bounds(20, 20, 80, 80))];
  root.children = [selected];

  const records = buildLayerRecords(root, selected, size, { layerGap: 20 });

  assert.deepEqual(records.map((record) => record.z), [-20, 0, 20, 40]);
});

test("large exploded branches keep distinct layers inside the camera range", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const selected = node("selected", bounds(10, 10, 90, 90));
  selected.children = Array.from({ length: 24 }, (_, index) => node(`child-${index}`, bounds(20, 20, 80, 80)));
  root.children = [selected];

  const records = buildLayerRecords(root, selected, size, { layerGap: 20 });
  const zValues = records.map((record) => record.z);

  assert.equal(new Set(zValues).size, zValues.length);
  assert.ok(Math.max(...zValues) <= 240);
});

test("overview expands every visible descendant and keeps Z slots stable across selection", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const front = node("front", bounds(15, 15, 85, 85));
  front.attributes = { "drawing-order": "8" };
  const middle = node("middle", bounds(10, 10, 90, 90));
  middle.attributes = { "drawing-order": "4" };
  const nested = node("nested", bounds(20, 20, 80, 80), "android.widget.Button");
  middle.children = [nested];
  const behind = node("behind", bounds(5, 5, 95, 95));
  behind.attributes = { "drawing-order": "1" };
  root.children = [front, middle, behind];

  const overview = buildLayerOverview(root, nested, size, { layerGap: 64 });
  const reselected = buildLayerOverview(root, front, size, { layerGap: 64 });
  const collapsed = buildLayerOverview(root, nested, size, { layerGap: 64, expandedIds: new Set(["root"]) });

  assert.equal(overview.parent?.id, "root");
  assert.deepEqual(overview.records.map((record) => record.id), ["behind", "middle", "nested", "front"]);
  assert.deepEqual(overview.records.map((record) => record.z), [-192, -128, -64, 0]);
  assert.deepEqual(reselected.records.map((record) => record.z), overview.records.map((record) => record.z));
  assert.deepEqual(collapsed.records.map((record) => record.id), ["behind", "middle", "front"]);
  assert.equal(collapsed.records.find((record) => record.id === "middle")?.isCollapsed, true);
  assert.equal(collapsed.records.find((record) => record.id === "behind")?.isCollapsed, false);
  assert.equal(overview.records.find((record) => record.isSelected)?.id, "nested");
  assert.ok((overview.parent?.z ?? 0) < Math.min(...overview.records.map((record) => record.z)));
});

test("collapsed root becomes a clickable composite layer", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  root.children = [node("child", bounds(10, 10, 90, 90))];

  const overview = buildLayerOverview(root, root, size, { expandedIds: new Set() });

  assert.deepEqual(overview.records, []);
  assert.equal(overview.parent?.isCollapsed, true);
  assert.equal(overview.parent?.hitTestable, true);
});

test("overview packs disjoint branches together while preserving overlapping draw order", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const left = node("left", bounds(0, 0, 50, 100));
  const right = node("right", bounds(50, 0, 100, 100));
  left.children = [node("left-label", bounds(5, 10, 45, 30)), node("left-icon", bounds(5, 40, 45, 60))];
  right.children = [node("right-label", bounds(55, 10, 95, 30))];
  const overlay = node("overlay", bounds(20, 20, 80, 80));
  root.children = [left, right, overlay];
  const result = buildLayerOverview(root, left, size);
  const z = Object.fromEntries(result.records.map(record => [record.id, record.z]));
  assert.equal(z.left, z.right);
  assert.equal(z["left-label"], z["left-icon"]);
  assert.equal(z["left-label"], z["right-label"]);
  assert.ok(z["left-label"] > z.left);
  assert.ok(z.overlay > z["right-label"]);
  assert.ok(result.records.every(record => record.hitTestable));
  assert.deepEqual(buildLayerOverview(root, overlay, size).records.map(record => record.z), result.records.map(record => record.z));
});

test("disjoint controls share depth and deep content stacks retain the requested spacing", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  root.children = Array.from({ length: 100 }, (_, i) => node(`cell-${i}`, bounds(i % 10 * 10, Math.floor(i / 10) * 10, i % 10 * 10 + 8, Math.floor(i / 10) * 10 + 8)));
  const grid = buildLayerOverview(root, root, size);
  assert.equal(new Set(grid.records.map(record => record.z)).size, 1);
  assert.equal(grid.parent?.z, -64);
  root.children.forEach(child => { child.bounds = bounds(0, 0, 100, 100); });
  const stack = buildLayerOverview(root, root, size);
  assert.equal(new Set(stack.records.map(record => record.z)).size, 100);
  assert.equal(stack.parent?.z, -64 * 100);
  assert.ok(stack.records.every((record, i) => i === 0 || record.z - stack.records[i - 1].z === 64));
});

test("only repeated confirmed-empty bounds compact; real, unknown and folded layers keep full spacing", () => {
  const root = node("root", bounds(0, 0, 100, 100));
  const empty = { ...node("empty", root.bounds!), layerImageEmpty: true };
  const duplicate = { ...node("duplicate", root.bounds!), attributes: { "skip-draw": "true" } };
  const content = { ...node("content", root.bounds!), layerImageDataUrl: "own-image", layerImageSize: size };
  const unknown = { ...node("unknown", root.bounds!), layerImageStatus: "failed" as const };
  duplicate.children = [node("child", bounds(20, 20, 40, 40))];
  root.children = [empty, duplicate, content, unknown];
  const expandedIds = new Set([root.id, duplicate.id]);
  const result = buildLayerOverview(root, content, size, { layerGap: 100, expandedIds });
  const [a, b, child, c, d] = result.records;
  assert.deepEqual(result.records.map(r => r.isCompact), [false, true, false, false, false]);
  assert.equal(b.z - a.z, 28);
  assert.equal(child.z - b.z, 100);
  assert.equal(c.z - child.z, 100);
  assert.equal(d.z - c.z, 100);
  assert.ok(result.records.every(r => r.hitTestable));
  assert.deepEqual(buildLayerOverview(root, duplicate, size, { layerGap: 100, expandedIds }).records.map(r => r.z), result.records.map(r => r.z));
  const folded = buildLayerOverview(root, duplicate, size, { layerGap: 100, expandedIds: new Set([root.id]) });
  assert.equal(folded.records[1].isCompact, false);
  assert.equal(folded.records[1].z - folded.records[0].z, 100);
  const wider = buildLayerOverview(root, content, size, { layerGap: 240, expandedIds });
  assert.equal(wider.records[3].z - wider.records[2].z, 240);
});
