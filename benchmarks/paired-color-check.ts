import { composeSubtreeImage } from "../shared/layer-textures";
import { makeNode } from "./fixtures";
import { pixelDifferenceSummary } from "./pixel-difference";
import type { CaptureEvidence } from "../scripts/paired-color-evidence";

export type PairedColorInput = { case: string; captures: CaptureEvidence[]; images: Record<string, string>;
  phoneMetric: { pixels: number; mismatchedPixels: number; maxChannelDelta: number; alphaMismatches: number } };

// Flat, fixed sample reference. Does not call production traversal, opacity or compositing.
export async function checkPairedColor(input: PairedColorInput) {
  const images = new Map<string, ImageBitmap>();
  const canvas = () => { const c = document.createElement("canvas"); c.width = 240; c.height = 160; return c; };
  const pixels = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, 240, 160).data;
  try {
    for (const [file, data] of Object.entries(input.images))
      images.set(file, await createImageBitmap(await (await fetch(data)).blob()));
    const root = makeNode("0"), parent = input.captures[0];
    root.bounds = { left: 0, top: 0, right: 240, bottom: 160, raw: "" };
    root.attributes = { alpha: String(parent.viewAlpha), "clip-children": "true" };
    root.layerImageDataUrl = input.images[parent.file]; root.layerImageSize = { width: 240, height: 160 };
    root.children = input.captures.slice(3).map((capture, i) => {
      const child = makeNode(`0/${i}`, i);
      child.bounds = { left: capture.left, top: capture.top, right: capture.left + capture.width,
        bottom: capture.top + capture.height, raw: "" };
      child.attributes = { alpha: String(capture.viewAlpha) };
      child.layerImageDataUrl = input.images[capture.file];
      child.layerImageSize = { width: capture.width, height: capture.height };
      return child;
    });
    const actual = await composeSubtreeImage(root, { left: 0, top: 0, width: 240, height: 160 },
      async node => createImageBitmap(await (await fetch(node.layerImageDataUrl!)).blob()), 38_400);
    const flat = (truncateAlpha: boolean) => {
      const c = canvas(), context = c.getContext("2d")!;
      context.drawImage(images.get(parent.file)!, 0, 0);
      for (const capture of input.captures.slice(3)) {
        context.globalAlpha = truncateAlpha ? Math.trunc(capture.viewAlpha * 255) / 255 : capture.viewAlpha;
        context.drawImage(images.get(capture.file)!, capture.left, capture.top);
      }
      return c;
    };
    const imageCanvas = (file: string) => {
      const c = canvas(); c.getContext("2d")!.drawImage(images.get(file)!, 0, 0); return c;
    };
    const prefix = parent.file.replace(/parent\.png$/, "");
    const phone = pixels(imageCanvas(prefix + "composed.png"));
    const group = pixels(imageCanvas(prefix + "production.png"));
    const own = pixels(imageCanvas(parent.file));
    const compare = (a: Uint8ClampedArray, b: Uint8ClampedArray) => pixelDifferenceSummary(a, b, 240, 160, own);
    const desktop = pixels(actual), raw = pixels(flat(false)), quantized = pixels(flat(true));
    const phoneVsNativeGroup = compare(phone, group);
    for (const key of ["pixels", "mismatchedPixels", "maxChannelDelta", "alphaMismatches"] as const)
      if (phoneVsNativeGroup[key] !== input.phoneMetric[key]) throw new Error(`PNG comparison disagrees with saved Android metric: ${key}`);
    return { case: input.case,
      desktopVsPhone: compare(desktop, phone), desktopVsNativeGroup: compare(desktop, group),
      desktopVsFlatRaw: compare(desktop, raw), truncatedAlphaControlVsPhone: compare(quantized, phone),
      truncatedAlphaControlVsNativeGroup: compare(quantized, group),
      phoneVsNativeGroup,
      nativeVsSnapshot: compare(group, pixels(imageCanvas(prefix + "snapshot.png"))),
      desktopPng: actual.toDataURL("image/png"), truncatedAlphaControlPng: flat(true).toDataURL("image/png") };
  } finally { for (const image of images.values()) image.close(); }
}
