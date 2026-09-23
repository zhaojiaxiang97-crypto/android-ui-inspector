import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { measureLayerImages } from "../electron/layer-images";
import { loadSnapshots, saveSnapshot } from "../electron/snapshot-store";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode } from "../shared/types";

// Encoded RGBA PNGs keep expectations independent of native bitmap byte order.
function png(lastAlpha: number, width = 2, height = 2) {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 255, 255, lastAlpha]);
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}

export async function verifyLayerImages() {
  const image = (id: string, url: string): UiNode => ({ ...makeNode(id), layerImageStatus: "captured", layerImageDataUrl: url, layerImageSize: { width: 2, height: 2 } });
  const empty = image("empty", png(0)), faint = image("faint", png(1)), opaque = image("opaque", png(255));
  const broken = image("broken", "data:image/png;base64,AA=="), oversized = image("oversized", png(0, 3000, 3000));
  const truncated = image("truncated", png(0).slice(0, 70));
  const style = image("style", png(0)); style.layerImageStatus = "style";
  broken.layerImageEmpty = true;
  const root = { ...makeNode("root"), children: [empty, faint, opaque, broken, truncated, oversized, style] };
  const original = empty.layerImageDataUrl;
  await measureLayerImages(root);
  assert.equal(empty.layerImageEmpty, true, "transparent RGB pixels must be detected");
  assert.equal(faint.layerImageEmpty, false, "one alpha=1 pixel at the end must survive");
  assert.equal(opaque.layerImageEmpty, false);
  for (const node of [broken, truncated, oversized, style]) assert.equal(node.layerImageEmpty, undefined, `${node.id} must remain unknown`);
  assert.equal(empty.layerImageDataUrl, original, "diagnosis must not modify the image");
  await assert.rejects(measureLayerImages(root, AbortSignal.abort()), { name: "AbortError" });
  const request = { capturedAt: new Date().toISOString(), snapshot: { serial: "alpha-test", root, nodeCount: 8, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null } };
  assert.equal((await saveSnapshot(request)).error, null);
  const loaded = await loadSnapshots();
  assert.equal(loaded.error, null);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[0].layerImageEmpty, true);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[3].layerImageEmpty, undefined);
  assert.ok((await saveSnapshot({ ...request, snapshot: { ...request.snapshot, root: { ...root, layerImageEmpty: "true" } } })).error, "reject malformed transparency metadata");
  return "native PNG alpha: transparent/one faint pixel/opaque/invalid/oversized/QML/cancellation/snapshot roundtrip";
}
