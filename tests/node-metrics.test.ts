import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { measureBounds, nodeMetrics, rectMetrics } from "../shared/node-metrics";
import type { UiNode } from "../shared/types";

function node(id: string, left: number, top: number, right: number, bottom: number): UiNode {
  return {
    id,
    index: 0,
    className: "android.view.View",
    package: "com.example",
    text: null,
    resourceId: null,
    contentDesc: null,
    bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` },
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

describe("node metrics", () => {
  test("calculates pixel dimensions and parent-relative offsets", () => {
    const root = node("root", 0, 0, 1080, 2400);
    const panel = node("panel", 100, 200, 900, 1200);
    const button = node("button", 140, 260, 500, 420);
    panel.children = [button];
    root.children = [panel];

    const metrics = nodeMetrics(root, button, { width: 1080, height: 2400 });
    assert.equal(metrics.depth, 2);
    assert.equal(metrics.childCount, 0);
    assert.equal(metrics.parent, panel);
    assert.equal(nodeMetrics(root, root).parent, null);
    assert.deepEqual(metrics.rect, { left: 140, top: 260, right: 500, bottom: 420, width: 360, height: 160, centerX: 320, centerY: 340, area: 57600 });
    assert.deepEqual(metrics.parentOffset, { x: 40, y: 60, right: 400, bottom: 780 });
    assert.deepEqual(metrics.screenshotSize, { width: 1080, height: 2400 });
  });

  test("rejects missing and non-positive bounds instead of inventing dimensions", () => {
    assert.equal(rectMetrics(null), null);
    assert.equal(rectMetrics({ left: 10, top: 10, right: 10, bottom: 20, raw: "bad" }), null);
    assert.equal(rectMetrics({ left: 10, top: 10, right: 20, bottom: 10, raw: "bad" }), null);
  });

  test("keeps a missing target safe", () => {
    const root = node("root", 0, 0, 100, 100);
    const missing = node("missing", 5, 5, 20, 20);
    const metrics = nodeMetrics(root, missing);
    assert.equal(metrics.depth, 0);
    assert.equal(metrics.rect?.width, 15);
    assert.equal(metrics.parentOffset, null);
    assert.equal(metrics.parent, null);
  });

  test("measures original bounds: separation, insets, overlap and invalid input", () => {
    const a = node("a", 10, 20, 110, 120).bounds!;
    const b = node("b", 134, 156, 180, 200).bounds!;
    const gap = measureBounds(a, b)!;
    assert.equal(gap.relation, "gap");
    assert.deepEqual(gap.guides[0], { from: { x: 110, y: 120 }, to: { x: 134, y: 156 }, distances: [{ label: "水平", value: 24 }, { label: "垂直", value: 36 }] });
    const reverse = measureBounds(b, a)!;
    assert.deepEqual(reverse.guides[0].distances, gap.guides[0].distances);
    assert.deepEqual(reverse.guides[0].from, gap.guides[0].to);
    const inner = node("inner", 20, 35, 80, 90).bounds!;
    const contained = measureBounds(a, inner)!;
    assert.equal(contained.relation, "contains");
    assert.deepEqual(contained.guides.map(g => g.distances[0].value), [10, 30, 15, 30]);
    const inside = measureBounds(inner, a)!;
    assert.equal(inside.relation, "inside");
    assert.deepEqual(inside.guides.map(g => g.from), contained.guides.map(g => g.to));
    assert.equal(measureBounds(a, a)!.relation, "equal");
    assert.equal(measureBounds(a, node("overlap", 80, 80, 140, 160).bounds)!.relation, "overlap");
    assert.equal(measureBounds(a, node("touch", 110, 40, 160, 80).bounds)!.relation, "touching");
    const horizontal = measureBounds(a, node("right", 135, 40, 170, 80).bounds)!;
    assert.deepEqual(horizontal.guides[0].distances.map(d => d.value), [25, 0]);
    const outsideScreen = measureBounds(node("offscreen", -100, -50, -10, 10).bounds, a)!;
    assert.deepEqual(outsideScreen.guides[0].distances.map(d => d.value), [20, 10]);
    assert.equal(measureBounds(null, b), null);
    assert.equal(measureBounds({ ...a, right: a.left }, b), null);
    assert.equal(measureBounds({ ...a, left: NaN }, b), null);
    assert.equal(measureBounds(a, { ...b, bottom: Infinity }), null);
  });
});
