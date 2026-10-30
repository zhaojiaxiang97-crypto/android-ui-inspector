import assert from "node:assert/strict";
import { test } from "node:test";
import { captureScreenQuad, rectangularCapturePlacement, type RectCaptureEvidence } from "../shared/capture-transform";

function rectEvidence(): RectCaptureEvidence {
  return { rootReached: true, bitmapSpace: "view-local", localToScreen: [0.8, 0, 80, 0, 0.8, 20, 0, 0, 1],
    chain: [
      ["android.view.View@1", "android.widget.FrameLayout@2", 80, 20, 100, 40, 0, 0, 0.5, 0, [1,0,0,0,1,0,0,0,1], false, false, false],
      ["android.widget.FrameLayout@2", "", 0, 0, 120, 100, 0, 0, 0.5, 0, [1,0,0,0,1,0,0,0,1], true, true, false],
    ], clipContext: [
      { ref: "android.view.View@1", clipBounds: null, padding: [0,0,0,0], localToScreen: [0.8,0,80,0,0.8,20,0,0,1] },
      { ref: "android.widget.FrameLayout@2", clipBounds: null, padding: [0,0,10,0], localToScreen: [1,0,0,0,1,0,0,0,1] },
    ] };
}

test("rectangular capture clips local pixels and shares screen extent with picking and border", () => {
  assert.equal(rectangularCapturePlacement({ ...rectEvidence(), diagnosticOnly: true }, 100, 40), null);
  assert.deepEqual(rectangularCapturePlacement(rectEvidence(), 100, 40), {
    screen: { left: 80, top: 20, width: 30, height: 32 },
    source: { left: 0, top: 0, width: 37.5, height: 40 }, opacity: 0.25, hidden: false,
  });
  const e = rectEvidence();
  e.clipContext![0].clipBounds = [10, 5, 90, 35];
  assert.deepEqual(rectangularCapturePlacement(e, 100, 40)?.screen, { left: 88, top: 24, width: 22, height: 24 });
});

test("incomplete, outline, rotated and custom ancestor contexts retain explicit legacy fallback", () => {
  for (const change of [
    (e: RectCaptureEvidence) => { e.rootReached = false; },
    (e: RectCaptureEvidence) => { e.chain[1][13] = true; },
    (e: RectCaptureEvidence) => { e.chain[1][0] = "example.CustomParent@2"; e.clipContext![1].ref = String(e.chain[1][0]); },
    (e: RectCaptureEvidence) => { e.localToScreen = [0,-1,100,1,0,20,0,0,1]; },
  ]) {
    const e = rectEvidence(); change(e);
    assert.equal(rectangularCapturePlacement(e, 100, 40), null);
  }
});

test("fully clipped or transparent layers do not get visible or clickable geometry", () => {
  const e = rectEvidence(); e.clipContext![1].clipBounds = [0,0,10,10];
  assert.equal(rectangularCapturePlacement(e, 100, 40)?.hidden, true);
  const transparent = rectEvidence(); transparent.chain[1][8] = 0;
  assert.equal(rectangularCapturePlacement(transparent, 100, 40)?.hidden, true);
});

test("capture quad preserves fractional pivot scale and ancestor translation", () => {
  // Scale 0.9 around (50,20), then ancestor translation (100.25,200.5).
  assert.deepEqual(captureScreenQuad([0.9, 0, 105.25, 0, 0.9, 202.5, 0, 0, 1], 100, 40), [
    { x: 105.25, y: 202.5 }, { x: 195.25, y: 202.5 },
    { x: 195.25, y: 238.5 }, { x: 105.25, y: 238.5 },
  ]);
});

test("rotated and mirrored pixels retain corner order rather than becoming bounding rectangles", () => {
  assert.deepEqual(captureScreenQuad([0, -1, 100, 1, 0, 20, 0, 0, 1], 40, 10), [
    { x: 100, y: 20 }, { x: 100, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 20 },
  ]);
  assert.deepEqual(captureScreenQuad([-1, 0, 40, 0, 1, 0, 0, 0, 1], 40, 10)?.[1], { x: 0, y: 0 });
});

test("degenerate, invalid and horizon-crossing captures have no usable quad", () => {
  for (const matrix of [[], [1,0,NaN,0,1,0,0,0,1], [0,0,0,0,0,0,0,0,1], [1,0,0,0,1,0,-0.1,0,1]])
    assert.equal(captureScreenQuad(matrix, 20, 10), null);
  assert.equal(captureScreenQuad([1,0,0,0,1,0,0,0,1], 0, 10), null);
});
