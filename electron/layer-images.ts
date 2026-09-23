import { nativeImage } from "electron";
import { setImmediate } from "node:timers/promises";
import type { UiNode } from "../shared/types";
import { pngSize } from "./capture-display";

// Desktop post-processing: use Electron's decoder, not another PNG library.
export async function measureLayerImages(root: UiNode | null, signal?: AbortSignal) {
  const pending = root ? [root] : [];
  while (pending.length) {
    signal?.throwIfAborted();
    const node = pending.pop()!;
    pending.push(...node.children);
    if (node.layerImageStatus !== "captured" || !node.layerImageDataUrl?.startsWith("data:image/png;base64,")) continue;
    delete node.layerImageEmpty;
    const data = Buffer.from(node.layerImageDataUrl.slice("data:image/png;base64,".length), "base64");
    const size = pngSize(data);
    // Never infer transparency from a failed decode, an oversized image or a thumbnail.
    if (!size || size.width * size.height > 4_000_000) continue;
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) continue;
    const decoded = image.getSize();
    if (decoded.width !== size.width || decoded.height !== size.height) continue;
    const pixels = image.toBitmap();
    if (pixels.length !== size.width * size.height * 4) continue;
    let empty = true;
    // Native N32 pixels on the supported little-endian macOS/Windows/Linux targets.
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 0) { empty = false; break; }
    }
    node.layerImageEmpty = empty;
    await setImmediate(); // Keep cancellation responsive between full-size images.
  }
  signal?.throwIfAborted();
}
