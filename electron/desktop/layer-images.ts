import { app, nativeImage } from "electron";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { UiNode } from "../../shared/types";
import { pngSize } from "../device/capture-display";
import { LAYER_ALPHA_BUDGET_MS, MAX_LAYER_IMAGE_BYTES, rgbaIsEmpty, sameImageSize, validImageSize, webpImageSize } from "./layer-image-alpha";
import { createWebpAlphaDecoder } from "./webp-alpha";

// PNG uses Electron; WebP needs its own decoder (nativeImage supports PNG/JPEG).
export async function measureLayerImages(root: UiNode | null, signal?: AbortSignal,
  workerFile = join(app.getAppPath(), "dist-electron/webp-alpha-worker.cjs")) {
  const pending = root ? [root] : [];
  const deadline = performance.now() + LAYER_ALPHA_BUDGET_MS;
  const webp = createWebpAlphaDecoder({ workerFile });
  try {
    let visited = 0;
    while (pending.length) {
      signal?.throwIfAborted();
      if (++visited % 16 === 0) { await setImmediate(); signal?.throwIfAborted(); }
      const node = pending.pop()!;
      pending.push(...node.children);
      if (node.layerImageStatus !== "captured" || !node.layerImageDataUrl) continue;
      delete node.layerImageEmpty;
      if (performance.now() >= deadline) continue;
      // Bound the encoded input before allocating a buffer or matching a huge data URL.
      if (node.layerImageDataUrl.length > Math.ceil(MAX_LAYER_IMAGE_BYTES / 3) * 4 + 64) continue;
      const match = /^data:image\/(png|webp);base64,([A-Za-z\d+/]+=*)$/.exec(node.layerImageDataUrl);
      if (!match) continue;
      const data = Buffer.from(match[2], "base64");
      if (data.length > MAX_LAYER_IMAGE_BYTES) continue;
      const size = match[1] === "png" ? pngSize(data) : webpImageSize(data);
      // Never infer transparency from a failed decode, an oversized image or a thumbnail.
      if (!validImageSize(size) || (node.layerImageSize && !sameImageSize(size, node.layerImageSize))) continue;
      if (match[1] === "webp") {
        const empty = await webp.measure(data, size, signal);
        if (empty !== undefined) node.layerImageEmpty = empty;
        continue;
      }
      try {
        const image = nativeImage.createFromBuffer(data);
        if (image.isEmpty() || !sameImageSize(image.getSize(), size)) continue;
        // Native N32 alpha on supported little-endian macOS/Windows/Linux targets.
        const empty = rgbaIsEmpty(image.toBitmap(), size);
        if (empty !== undefined) node.layerImageEmpty = empty;
      } catch { /* Native decoder failures leave this node unknown as well. */ }
      await setImmediate();
    }
    signal?.throwIfAborted();
  } finally { await webp.dispose(); }
}
