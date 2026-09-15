import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLayerLayout, buildLayerOverview, buildLayerRecords } from "../shared/layer-layout";
import type { UiBounds, UiNode } from "../shared/types";

const size = { width: 100, height: 100 };
const bounds = (left: number, top: number, right: number, bottom: number): UiBounds => ({
  left,
  top,
  right,
  bottom,
  raw: `[${left},${top}][${right},${bottom}]`,
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
