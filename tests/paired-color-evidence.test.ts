import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { validatePairedColorEvidence, verifyPairedPng, type CaptureEvidence } from "../scripts/paired-color-evidence";

function fixture(index = 5, hardware = true): CaptureEvidence[] {
  return ["parent", "production", "snapshot", "child-0", ...(index === 7 ? ["child-1"] : [])].map((name, i) => ({
    file: `group-color-${index}-${name}.png`, backend: !hardware && i >= 3 ? "software-View.draw"
      : `${hardware ? "Hardware" : "Software"}CanvasProvider/createSnapshot`, beganNs: (i + 1) * 1_000_000,
    endedNs: (i + 1) * 1_000_000 + 500_000, viewIdentity: i < 3 ? "abc" : i === 3 ? "def" : "fed",
    left: i < 3 ? 0 : i === 4 ? 50 : 31, top: i < 3 ? 0 : i === 4 ? 52 : 43,
    width: i < 3 ? 240 : 61, height: i < 3 ? 160 : 39, viewAlpha: i >= 3 && index >= 6 ? 0.5 : 1,
    attached: true, bitmapWidth: i < 3 ? 240 : 61, bitmapHeight: i < 3 ? 160 : 39,
    bitmapConfig: "ARGB_8888", premultiplied: true, hasAlpha: true, density: 160, colorSpace: "sRGB"
  }));
}

test("paired evidence validates exact geometry, backend and bounded capture interval", () => {
  assert.deepEqual(validatePairedColorEvidence(fixture(), 5, true), { captureSpanMs: 3.5, ownImages: 2 });
  assert.equal(validatePairedColorEvidence(fixture(7, false), 7, false).ownImages, 3);
});

test("paired evidence rejects missing provenance, changed identity and wrong route", () => {
  for (const mutate of [
    (rows: CaptureEvidence[]) => { rows.pop(); },
    (rows: CaptureEvidence[]) => { rows[1].viewIdentity = "123"; },
    (rows: CaptureEvidence[]) => { rows[1].beganNs = 1; },
    (rows: CaptureEvidence[]) => { rows[0].backend = "unknown"; },
    (rows: CaptureEvidence[]) => { rows[3].bitmapWidth = 60; },
    (rows: CaptureEvidence[]) => { rows[3].left = 32; },
    (rows: CaptureEvidence[]) => { rows[3].viewAlpha = 1 / 3; },
    (rows: CaptureEvidence[]) => { rows[3].file = "../other.png"; },
    (rows: CaptureEvidence[]) => { rows[0].colorSpace = "null"; },
  ]) {
    const rows = fixture(); mutate(rows); assert.throws(() => validatePairedColorEvidence(rows, 5, true));
  }
});

test("paired PNG admission verifies signature, dimensions and exact digest without mutation", () => {
  // Header only: this tests admission, not a successful browser PNG decode.
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(61, 16); bytes.writeUInt32BE(39, 20);
  const original = Buffer.from(bytes), digest = createHash("sha256").update(bytes).digest("hex");
  verifyPairedPng(bytes, 61, 39, digest);
  assert.deepEqual(bytes, original);
  assert.throws(() => verifyPairedPng(bytes, 60, 39, digest));
  assert.throws(() => verifyPairedPng(bytes, 61, 39, "0".repeat(64)), /hash mismatch/);
  assert.throws(() => verifyPairedPng(bytes, 61, 39, "unknown"));
  const changed = Buffer.from(bytes); changed[8] = 1;
  assert.throws(() => verifyPairedPng(changed, 61, 39, digest), /hash mismatch/);
  assert.throws(() => verifyPairedPng(Buffer.alloc(23), 61, 39, digest));
  assert.throws(() => verifyPairedPng(Buffer.alloc(1_000_001), 61, 39, digest));
  assert.throws(() => verifyPairedPng(Buffer.alloc(24), 61, 39, digest));
});
