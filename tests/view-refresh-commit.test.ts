import assert from "node:assert/strict";
import { test } from "node:test";
import { commitViewRefresh } from "../electron/capture/view-refresh-commit";
import type { UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
const fixture = () => {
  const leaf = { id: "0/0/0", children: [] } as unknown as UiNode;
  const node = { id: "0/0", children: [leaf], layerImageDataUrl: "old" } as unknown as UiNode;
  return { requestId: "current", snapshot: { root: { id: "0", children: [node] }, nodeCount: 3 } as unknown as UiSnapshot };
};
const result: ViewRefreshResult = { nodes: [{ id: "0/0", children: [], layerImageDataUrl: "fresh" } as unknown as UiNode], failures: [] };
test("late cancelled refresh cannot mutate the original or replacement snapshot", () => {
  const old = fixture(), next = fixture(), controller = new AbortController();
  const before = JSON.stringify([old, next]);
  controller.abort(new Error("cancelled"));
  assert.throws(() => commitViewRefresh(old, old, "0/0", result, controller.signal), /cancelled/);
  assert.throws(() => commitViewRefresh(old, next, "0/0", result, controller.signal), /cancelled/);
  assert.equal(JSON.stringify([old, next]), before);
});
test("same request ID does not authorize writing into a replacement session", () => {
  const old = fixture(), next = fixture(), before = JSON.stringify([old, next]);
  commitViewRefresh(old, next, "0/0", result, new AbortController().signal);
  commitViewRefresh(old, undefined, "0/0", result, new AbortController().signal);
  assert.equal(JSON.stringify([old, next]), before);
});
test("current refresh recovers, preserves child nodes and updates its own snapshot only", () => {
  const current = fixture(), previousSnapshot = current.snapshot;
  commitViewRefresh(current, current, "0/0", result, new AbortController().signal);
  assert.equal(current.snapshot.root!.children[0].layerImageDataUrl, "fresh");
  assert.equal(current.snapshot.root!.children[0].children.length, 1);
  assert.equal(current.snapshot.nodeCount, 3);
  assert.equal(previousSnapshot.root!.children[0].layerImageDataUrl, "old");
});
