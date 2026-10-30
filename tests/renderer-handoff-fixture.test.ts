import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./fixtures/debug-handoff-snapshot.json";
import { flattenNodes } from "../shared/tree-utils";
import type { UiSnapshot } from "../shared/types";

test("real handoff fixture keeps 70-node geometry but no business identifiers, screenshots or raw XML", () => {
  const snapshot = fixture as UiSnapshot;
  const nodes = [...flattenNodes(snapshot.root!).values()];
  assert.equal(nodes.length, 70);
  assert.equal(snapshot.nodeCount, nodes.length);
  assert.equal(snapshot.serial, "sanitized-device");
  assert.equal(snapshot.rawXml, null);
  assert.equal(snapshot.screenshotDataUrl, null);
  assert.equal(snapshot.captureMode, "fast");
  assert.ok(nodes.some(node => node.text === "设置"));
  assert.ok(nodes.some(node => node.text === "播放设置"));
  for (const node of nodes) {
    assert.deepEqual(Object.keys(node).sort(), ["id", "index", "text", "className", "resourceId", "package", "contentDesc", "clickable", "enabled",
      "focusable", "focused", "selected", "visibleToUser", "scrollable", "bounds", "attributes", "children"].sort());
    assert.match(node.className!, /^android\.(view|widget)\.[A-Za-z$]+$/);
    assert.match(node.resourceId!, /^com\.example\.sanitized:id\/node_\d+$/);
    assert.equal(node.package, "com.example.sanitized");
    assert.ok(["", "设置", "播放设置"].includes(node.text!));
    assert.equal(node.contentDesc, "");
    assert.deepEqual(node.attributes, {});
    assert.equal(node.layerImageDataUrl, undefined);
    for (const field of ["clickable", "enabled", "focusable", "focused", "scrollable", "selected", "visibleToUser"] as const)
      assert.equal(typeof node[field], "boolean");
    if (node.bounds) assert.equal(node.bounds.raw, `[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`);
  }
});
