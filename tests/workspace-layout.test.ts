import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKSPACE_LAYOUT, clampFloatingInspectorRect, parseWorkspaceLayout, readWorkspaceLayout, treePaneWidthBounds } from "../shared/workspace-layout";

const remembered = { version: 1 as const, treeWidth: 520, inspector: { floating: true, rect: { left: 850, top: 40, width: 360, height: 600 } } };
test("workspace layout keeps the existing default and round-trips only local tool geometry", () => {
  assert.deepEqual(DEFAULT_WORKSPACE_LAYOUT, { version: 1, treeWidth: 306, inspector: { floating: false, rect: null } });
  assert.deepEqual(readWorkspaceLayout(null), { layout: DEFAULT_WORKSPACE_LAYOUT, error: null });
  assert.deepEqual(readWorkspaceLayout(JSON.stringify(remembered)), { layout: remembered, error: null });
  assert.deepEqual(parseWorkspaceLayout({ ...remembered, snapshot: "never retain", selectedNodeId: "0/1" }), remembered);
});

test("invalid versions, corrupt storage and unsafe dimensions fail to a visible default", () => {
  const invalid = [undefined, null, [], "value", {}, { ...remembered, version: 2 }, { ...remembered, treeWidth: 119 },
    { ...remembered, treeWidth: 721 }, { ...remembered, treeWidth: NaN }, { ...remembered, treeWidth: Infinity },
    { ...remembered, inspector: { floating: "true", rect: null } }, { ...remembered, inspector: { floating: true } }];
  for (const key of ["left", "top", "width", "height"]) {
    for (const bad of [NaN, Infinity, -1, "320", 100001]) invalid.push({ ...remembered, inspector: { floating: true, rect: { ...remembered.inspector.rect, [key]: bad } } });
  }
  for (const value of invalid) assert.equal(parseWorkspaceLayout(value), null);
  for (const raw of ["", "broken{", "{}", JSON.stringify({ ...remembered, version: 2 }), " ".repeat(2049)]) {
    const result = readWorkspaceLayout(raw);
    assert.equal(result.layout, DEFAULT_WORKSPACE_LAYOUT);
    assert.match(result.error!, /默认布局/);
  }
});

test("visible inspector clamping keeps the preferred large-window rectangle unchanged", () => {
  const preferred = { left: 850, top: 680, width: 360, height: 600 };
  const original = { ...preferred };
  for (const viewport of [{ width: 1000, height: 740, minTop: 24 }, { width: 480, height: 400, minTop: 24 },
    { width: 250, height: 140, minTop: 24 }, { width: 1, height: 1, minTop: 100 }]) {
    const visible = clampFloatingInspectorRect(preferred, viewport);
    assert.ok(visible.width > 0 && visible.height > 0);
    assert.ok(visible.left >= 0 && visible.top >= 0);
    assert.ok(visible.left + visible.width <= viewport.width);
    assert.ok(visible.top + visible.height <= viewport.height);
    assert.deepEqual(preferred, original);
  }
  const visible = clampFloatingInspectorRect(original, { width: 1440, height: 900 });
  assert.equal(visible.width, original.width);
  assert.equal(visible.height, original.height);
  const invalid = clampFloatingInspectorRect({ left: NaN, top: Infinity, width: NaN, height: Infinity }, { width: NaN, height: Infinity, minTop: Infinity });
  assert.ok(Object.values(invalid).every(Number.isFinite));
});

test("tree width limits retain the current tree/canvas allocation", () => {
  assert.deepEqual(treePaneWidthBounds(1440), { min: 240, max: 720 });
  assert.deepEqual(treePaneWidthBounds(960), { min: 240, max: 595 });
  assert.deepEqual(treePaneWidthBounds(480), { min: 192, max: 211 });
});
