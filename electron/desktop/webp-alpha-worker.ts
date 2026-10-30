import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { MAX_LAYER_IMAGE_PIXELS, rgbaIsEmpty, sameImageSize, webpImageSize, type ImageSize } from "./layer-image-alpha";

// Decode only local bytes. No conversion/resizing of the saved or displayed image.
sharp.cache(false);
sharp.concurrency(1);
parentPort!.on("message", async ({ bytes, size }: { bytes: Uint8Array; size: ImageSize }) => {
  let empty: boolean | undefined;
  try {
    const data = Buffer.from(bytes), actual = webpImageSize(data);
    if (actual && sameImageSize(actual, size)) {
      const image = await sharp(data, { failOn: "warning", limitInputPixels: MAX_LAYER_IMAGE_PIXELS })
        .timeout({ seconds: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (image.info.channels === 4 && sameImageSize(image.info, size)) empty = rgbaIsEmpty(image.data, size);
    }
  } catch { /* Bad/unsupported images remain unknown; a decode failure is not transparency. */ }
  parentPort!.postMessage(empty);
});
