import { test } from "node:test";
import assert from "node:assert/strict";
import type { UiSnapshot } from "../shared/types";
import { assertStaticWorkload, staticCaptureSummary } from "../scripts/static-capture-comparison";

function fixture(): UiSnapshot {
  const children = Array.from({ length: 400 }, (_, i) => ({ id: String(i), children: [], className: "TextView",
    attributes: { "view-ref": `TextView@${i}` }, visibleToUser: true,
    bounds: { left: i, top: 0, right: i + 1, bottom: 1 }, layerImageStatus: "captured" as const,
    layerImageDataUrl: "data:image/png;base64,YWJj" }));
  return { root: { id: "root", children, attributes: { "sdk-tree-source": "merged", "debug-process-id": "12",
    "sdk-process-instance": "instance", "debug-window-name": "window" } }, nodeCount: 401, error: null,
    captureRequestDiagnostics: { totalAttempts: 1, attempts: [], totalDurationMs: 100, droppedAttempts: 0 } } as unknown as UiSnapshot;
}

test("static comparison pins geometry, encoded bytes and identity", () => {
  const a = staticCaptureSummary(fixture());
  assertStaticWorkload(a, staticCaptureSummary(fixture()));
  for (const mutate of [
    (s: UiSnapshot) => { s.root!.attributes!["debug-process-id"] = "13"; },
    (s: UiSnapshot) => { s.root!.children[0].bounds!.left++; },
    (s: UiSnapshot) => { s.root!.children[0].layerImageSize = { width: 2, height: 1 }; },
    (s: UiSnapshot) => { s.root!.children[0].layerCapturePlacement = { screen: { left: 1, top: 0, width: 1, height: 1 },
      source: { left: 0, top: 0, width: 1, height: 1 }, opacity: 0.5, hidden: false }; },
    (s: UiSnapshot) => { s.root!.children[0].layerImageDataUrl = "data:image/png;base64,YWJk"; },
  ]) {
    const s = fixture(); mutate(s);
    assert.throws(() => assertStaticWorkload(a, staticCaptureSummary(s)));
  }
});

test("failed, retried, small and fallback captures never qualify", () => {
  for (const mutate of [
    (s: UiSnapshot) => { s.error = "guard rejection"; },
    (s: UiSnapshot) => { s.captureRequestDiagnostics!.totalAttempts = 2; },
    (s: UiSnapshot) => { s.root!.children[0].layerImageStatus = "failed"; },
    (s: UiSnapshot) => { s.root!.attributes!["sdk-tree-source"] = "checked-dump"; },
    (s: UiSnapshot) => { s.root!.attributes!["sdk-visible-fallback"] = "capture interrupted"; },
    (s: UiSnapshot) => { s.root!.children[0].layerImageDataUrl = undefined; },
  ]) { const s = fixture(); mutate(s); assert.throws(() => staticCaptureSummary(s)); }
});
