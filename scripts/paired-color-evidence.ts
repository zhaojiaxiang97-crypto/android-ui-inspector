// Fixed sample provenance validation, not permission to accept business pixels.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function verifyPairedPng(bytes: Buffer, width: number, height: number, sha256: string) {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= 38_400);
  assert(bytes.length >= 24 && bytes.length <= 1_000_000);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, "Paired PNG hash mismatch");
}

export type CaptureEvidence = {
  file: string; backend: string; beganNs: number; endedNs: number; viewIdentity: string;
  left: number; top: number; width: number; height: number; viewAlpha: number; attached: boolean;
  bitmapWidth: number; bitmapHeight: number; bitmapConfig: string; premultiplied: boolean;
  hasAlpha: boolean; density: number; colorSpace: string;
};

export function validatePairedColorEvidence(captures: CaptureEvidence[], index: number, hardware: boolean) {
  assert(Number.isInteger(index) && index >= 0 && index < 8);
  assert(Array.isArray(captures));
  const count = index === 7 ? 2 : 1;
  const prefix = `group-color-${index}-`;
  assert.deepEqual(captures.map(c => c.file), [prefix + "parent.png", prefix + "production.png", prefix + "snapshot.png",
    ...Array.from({ length: count }, (_, i) => prefix + `child-${i}.png`)]);
  let ended = 0;
  for (const [i, capture] of captures.entries()) {
    assert(Number.isSafeInteger(capture.beganNs) && capture.beganNs >= ended);
    assert(Number.isSafeInteger(capture.endedNs) && capture.endedNs >= capture.beganNs);
    ended = capture.endedNs;
    assert.match(capture.viewIdentity, /^[0-9a-f]+$/);
    assert.equal(capture.attached, true);
    assert.equal(capture.backend, !hardware && i >= 3 ? "software-View.draw"
      : `${hardware ? "Hardware" : "Software"}CanvasProvider/createSnapshot`);
    assert.equal(capture.width, i < 3 ? 240 : 61); assert.equal(capture.height, i < 3 ? 160 : 39);
    assert.equal(capture.bitmapWidth, capture.width); assert.equal(capture.bitmapHeight, capture.height);
    assert.equal(capture.bitmapConfig, "ARGB_8888"); assert.equal(capture.premultiplied, true);
    assert.equal(typeof capture.hasAlpha, "boolean");
    assert(Number.isSafeInteger(capture.density) && capture.density >= 0);
    assert(typeof capture.colorSpace === "string" && capture.colorSpace !== "null" && capture.colorSpace.length > 0);
    assert.equal(capture.viewAlpha, i >= 3 && index >= 6 ? 0.5 : 1);
    assert(Number.isSafeInteger(capture.left) && Number.isSafeInteger(capture.top));
    if (i >= 3) {
      assert.equal(capture.left, i === 4 ? 50 : 31); assert.equal(capture.top, i === 4 ? 52 : 43);
      assert.notEqual(capture.viewIdentity, captures[0].viewIdentity);
    } else {
      assert.equal(capture.viewIdentity, captures[0].viewIdentity);
      assert.equal(capture.left, captures[0].left); assert.equal(capture.top, captures[0].top);
    }
  }
  return { captureSpanMs: (ended - captures[0].beganNs) / 1_000_000, ownImages: count + 1 };
}
