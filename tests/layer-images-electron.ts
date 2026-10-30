import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { measureLayerImages } from "../electron/desktop/layer-images";
import { loadSnapshots, saveSnapshot } from "../electron/desktop/snapshot-store";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode } from "../shared/types";
import { webpImages } from "./fixtures/webp-images";
import sharp from "sharp";
import { createNodeImageClipboardItem } from "../electron/desktop/export";
import { outputNodeImage } from "../electron/desktop/node-image";

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

export async function verifyLayerImages(workerFile: string) {
  const image = (id: string, url: string): UiNode => ({ ...makeNode(id), layerImageStatus: "captured", layerImageDataUrl: url, layerImageSize: { width: 2, height: 2 } });
  const empty = image("empty", png(0)), faint = image("faint", png(1)), opaque = image("opaque", png(255));
  const broken = image("broken", "data:image/png;base64,AA=="), oversized = image("oversized", png(0, 3000, 3000));
  const truncated = image("truncated", png(0).slice(0, 70));
  const style = image("style", png(0)); style.layerImageStatus = "style";
  broken.layerImageEmpty = true;
  const webp = webpImages.map(value => image(value.name, `data:image/webp;base64,${value.data}`));
  const thumbnail = image("thumbnail", webp[0].layerImageDataUrl!); thumbnail.layerImageSize = { width: 4, height: 4 };
  const brokenWebp = image("broken-webp", "data:image/webp;base64,AA=="); brokenWebp.layerImageEmpty = true;
  const pngThumbnail = image("png-thumbnail", png(0)); pngThumbnail.layerImageSize = { width: 4, height: 4 };
  const root = { ...makeNode("root"), children: [empty, faint, opaque, broken, truncated, oversized, style, ...webp, thumbnail, brokenWebp, pngThumbnail] };
  const original = empty.layerImageDataUrl;
  await measureLayerImages(root, undefined, workerFile);
  assert.equal(empty.layerImageEmpty, true, "transparent RGB pixels must be detected");
  assert.equal(faint.layerImageEmpty, false, "one alpha=1 pixel at the end must survive");
  assert.equal(opaque.layerImageEmpty, false);
  for (const node of [broken, truncated, oversized, style, thumbnail, brokenWebp, pngThumbnail]) assert.equal(node.layerImageEmpty, undefined, `${node.id} must remain unknown`);
  for (let index = 0; index < webp.length; index++) assert.equal(webp[index].layerImageEmpty, webpImages[index].alpha === 0, webp[index].id);
  assert.equal(empty.layerImageDataUrl, original, "diagnosis must not modify the image");
  await assert.rejects(measureLayerImages(root, AbortSignal.abort(), workerFile), { name: "AbortError" });
  const request = { capturedAt: new Date().toISOString(), snapshot: { serial: "alpha-test", root, nodeCount: root.children.length + 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null } };
  assert.equal((await saveSnapshot(request)).error, null);
  const loaded = await loadSnapshots();
  assert.equal(loaded.error, null);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[0].layerImageEmpty, true);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[3].layerImageEmpty, undefined);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[7].layerImageEmpty, true);
  assert.equal(loaded.snapshots.at(-1)?.snapshot.root?.children[8].layerImageEmpty, false);
  assert.ok((await saveSnapshot({ ...request, snapshot: { ...request.snapshot, root: { ...root, layerImageEmpty: "true" } } })).error, "reject malformed transparency metadata");
  for (const source of [empty, faint, opaque, ...webp]) {
    let copied = false;
    const result = await outputNodeImage({ action: "copy", dataUrl: source.layerImageDataUrl, size: source.layerImageSize, defaultFileName: `${source.id}.png` }, {
      choosePath: async () => { throw new Error("copy opened a save dialog"); }, write: async () => { throw new Error("copy wrote a file"); },
      copy: async bytes => {
        const item = createNodeImageClipboardItem(bytes);
        assert.deepEqual(item.types, ["image/png"]);
        const payload = await item.getType("image/png"); assert.ok(payload instanceof Blob);
        const png = Buffer.from(await payload.arrayBuffer());
        assert.equal((await sharp(png).metadata()).format, "png");
        const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
        const expected = source === empty ? 0 : source === faint ? 1 : source === opaque ? 255 : webpImages.find(value => value.name === source.id)!.alpha;
        assert.deepEqual([pixels[3], pixels[7], pixels[11], pixels[15]], [0, 0, 0, expected], `${source.id}: clipboard PNG alpha changed`);
        copied = true;
      },
    });
    assert.equal(result.error, null); assert.equal(copied, true);
  }
  return "PNG + lossless/lossy WebP alpha: transparent/alpha=1/visible/invalid/oversized/thumbnail/QML/cancellation/snapshot roundtrip; real Electron ClipboardItem PNG output preserves alpha without modifying system clipboard";
}
