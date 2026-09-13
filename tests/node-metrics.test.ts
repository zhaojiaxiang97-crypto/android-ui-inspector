import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nodeMetrics, rectMetrics } from "../shared/node-metrics";
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
  });
});
