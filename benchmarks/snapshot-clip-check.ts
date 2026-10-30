import { clipLayerImageToOutlines, composeSubtreeImage, textureDimensions } from "../shared/layer-textures";
import type { PixelSize, UiNode } from "../shared/types";
import { rectangularBranchReference } from "./rectangular-branch-reference";
import { makeNode } from "./fixtures";
import { pixelDifferenceSummary } from "./pixel-difference";

export async function checkRectangularReferenceFixtures() {
  const results: object[] = [];
  for (const mode of ["overflow", "parent", "padding", "nested", "empty"] as const) {
    const root = makeNode("0"), parent = makeNode("0/0"), child = makeNode("0/0/0");
    root.bounds = { left: 0, top: 0, right: 20, bottom: 20, raw: "" };
    parent.bounds = { left: 4, top: 3, right: 16, bottom: 17, raw: "" };
    child.bounds = { ...root.bounds }; root.children = [parent]; parent.children = [child];
    root.attributes = {}; parent.attributes = {}; child.attributes = {};
    if (mode === "parent" || mode === "nested") parent.attributes["clip-children"] = "true";
    if (mode === "padding" || mode === "nested" || mode === "empty") parent.attributes = { ...parent.attributes,
      "clip-to-padding": "true", "padding-left": mode === "empty" ? "20" : "2", "padding-top": "1", "padding-right": "3", "padding-bottom": "2" };
    const red = document.createElement("canvas"); red.width = red.height = 20;
    red.getContext("2d")!.fillStyle = "#ff0000"; red.getContext("2d")!.fillRect(0, 0, 20, 20);
    child.layerImageDataUrl = red.toDataURL(); child.layerImageSize = { width: 20, height: 20 };
    const entries = rectangularBranchReference(root), clip = entries[0].clip;
    const reference = document.createElement("canvas"); reference.width = reference.height = 20;
    const context = reference.getContext("2d")!;
    context.beginPath(); context.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top); context.clip(); context.drawImage(red, 0, 0);
    const pixels = context.getImageData(0, 0, 20, 20).data;
    // Manually specified rectangles; expectations do not call the oracle.
    const r = mode === "overflow" ? [0, 0, 20, 20] : mode === "parent" ? [4, 3, 16, 17] : mode === "empty" ? [0, 0, 0, 0] : [6, 4, 13, 15];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4, visible = x >= r[0] && y >= r[1] && x < r[2] && y < r[3];
      if (pixels[i] !== (visible ? 255 : 0) || pixels[i + 1] || pixels[i + 2] || pixels[i + 3] !== (visible ? 255 : 0))
        throw new Error(`Rectangular fixture ${mode}: reference pixel ${x},${y}`);
    }
    results.push({ mode, pixels: 400, manualRgbaVerified: true });
  }
  return results;
}

// Compare production clipping against an independent rounded-rectangle
// equation, using saved business pixels. Boundary antialiasing is excluded.
export async function checkSnapshotClips(root: UiNode) {
  const results: Array<{ id: string; width: number; height: number; inside: number; outside: number; visibleInside: number; removedVisible: number; opaqueColorChecks: number; mismatch: number }> = [];
  const visit = async (node: UiNode, ancestors: UiNode[]) => {
    const clips = [...ancestors, node].filter(n => n.attributes?.["clip-to-outline"] === "true");
    const b = node.bounds;
    if (node.layerImageDataUrl && b && b.right > b.left && b.bottom > b.top
        && clips.some(n => Number(n.attributes?.["sdk-outlineRadius"]) > 0)) {
      const outlines = clips.map(n => ({ b: n.bounds, values: ["Left", "Top", "Right", "Bottom", "Radius"].map(k => Number(n.attributes?.[`sdk-outline${k}`])) }));
      if (outlines.some(o => !o.b || ![o.b.left, o.b.top, o.b.right, o.b.bottom, ...o.values].every(Number.isFinite))) throw new Error(`Unknown outline: ${node.id}`);
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(node.layerImageDataUrl)) throw new Error(`Not an embedded raster image: ${node.id}`);
      const image = await createImageBitmap(await (await fetch(node.layerImageDataUrl)).blob());
      try {
        if (image.width * image.height > 2_000_000) throw new Error(`Pixel budget exceeded: ${node.id}`);
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(image, 0, 0);
        const original = ctx.getImageData(0, 0, image.width, image.height).data;
        const clipped = clipLayerImageToOutlines(node, clips, image) as HTMLCanvasElement;
        const actual = clipped.getContext("2d")!.getImageData(0, 0, image.width, image.height).data;
        const sx = image.width / (b.right - b.left), sy = image.height / (b.bottom - b.top);
        let inside = 0, outside = 0, removedVisible = 0, visibleInside = 0, opaqueColorChecks = 0, mismatch = 0;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          const px = b.left + (x + .5) / sx, py = b.top + (y + .5) / sy;
          let permitted = true, boundary = false;
          for (const outline of outlines) {
            const [l, t, r, bot, radius] = outline.values;
            const left = outline.b!.left + l, top = outline.b!.top + t;
            const right = outline.b!.left + r, bottom = outline.b!.top + bot;
            if (right <= left || bottom <= top || radius < 0 || radius * 2 > Math.min(right - left, bottom - top)) throw new Error(`Unsupported oracle geometry: ${node.id}`);
            const qx = Math.abs(px - (left + right) / 2) - (right - left) / 2 + radius;
            const qy = Math.abs(py - (top + bottom) / 2) - (bottom - top) / 2 + radius;
            const signedDistance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
            if (Math.abs(signedDistance) * Math.min(sx, sy) < 1.25) boundary = true;
            if (signedDistance > 0) permitted = false;
          }
          if (boundary) continue;
          const offset = (y * image.width + x) * 4;
          if (permitted) {
            inside++;
            if (original[offset + 3]) visibleInside++;
            if (actual[offset + 3] !== original[offset + 3]) mismatch++;
            if (original[offset + 3] === 255) {
              opaqueColorChecks++;
              if ([0, 1, 2].some(channel => actual[offset + channel] !== original[offset + channel])) mismatch++;
            }
          } else {
            outside++;
            if (original[offset + 3]) removedVisible++;
            if (actual[offset + 3] !== 0) mismatch++;
          }
        }
        results.push({ id: node.id, width: image.width, height: image.height, inside, outside, visibleInside, removedVisible, opaqueColorChecks, mismatch });
        if (mismatch) throw new Error(`Clip alpha mismatch ${node.id}: ${mismatch}`);
      } finally { image.close(); }
    }
    for (const child of node.children) await visit(child, [...ancestors, node]);
  };
  await visit(root, []);
  if (!results.length) throw new Error("No independently captured image with a known rounded outline");
  if (!results.some(r => r.outside && r.visibleInside)) throw new Error("No clear inside/outside rounded-corner coverage");
  return { results, scope: "saved own-image alpha and opaque RGB against declared outlines; not device composition or live group pixels" };
}

// Flat reference with explicit rectangular ancestral clipping; no group
// opacity, custom outlines, transforms, or child reordering.
// It must differ from the parent's own bitmap to prove child contribution.
export async function checkSnapshotBranch(root: UiNode, id: string, screenSize: PixelSize, groupDataUrl?: string) {
  const nodes: UiNode[] = [];
  const collect = (node: UiNode) => { nodes.push(node); node.children.forEach(collect); };
  collect(root);
  const branch = nodes.find(node => node.id === id);
  if (!branch?.bounds || !screenSize || ![screenSize.width, screenSize.height].every(n => Number.isFinite(n) && n > 0)) throw new Error("Branch bounds or screenshot size missing");
  const entries = rectangularBranchReference(branch);
  const images = entries.map(entry => entry.node);
  if (!images.some(n => n.id !== id)) throw new Error("Branch has no independent child image");
  const b = branch.bounds;
  const left = Math.max(b.left, 0), top = Math.max(b.top, 0);
  const rect = { left, top, width: Math.min(b.right, screenSize.width) - left, height: Math.min(b.bottom, screenSize.height) - top };
  if (rect.width <= 0 || rect.height <= 0) throw new Error("Branch is outside the screen");
  const size = textureDimensions(rect.width, rect.height, 100_000);
  const canvas = () => { const c = document.createElement("canvas"); c.width = size.width; c.height = size.height; return c; };
  const expected = canvas(), parentOnly = canvas();
  // Match the production canvas backend; willReadFrequently opts into a
  // different CPU rasterizer with different downsampling rounding.
  const ctx = expected.getContext("2d")!;
  const sx = size.width / rect.width, sy = size.height / rect.height;
  // Share the browser's coordinate rasterization convention, not production
  // tree traversal/compositing. Pre-multiplied destination coordinates can
  // otherwise shift color interpolation by one 8-bit level.
  ctx.setTransform(sx, 0, 0, sy, -left * sx, -top * sy);
  parentOnly.getContext("2d")!.setTransform(sx, 0, 0, sy, -left * sx, -top * sy);
  const load = async (node: UiNode) => {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(node.layerImageDataUrl!)) throw new Error("Not an embedded raster");
    const image = await createImageBitmap(await (await fetch(node.layerImageDataUrl!)).blob());
    if (image.width * image.height > 4_000_000 || image.width !== node.layerImageSize?.width || image.height !== node.layerImageSize?.height) {
      image.close(); throw new Error(`Image dimensions or decode budget rejected: ${node.id}`);
    }
    return image;
  };
  const paintReference = (context: CanvasRenderingContext2D, entry: typeof entries[number], image: ImageBitmap) => {
    const { node, clip } = entry, bounds = node.bounds!;
    context.save();
    context.beginPath(); context.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top); context.clip();
    context.drawImage(image, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
    context.restore();
  };
  for (const entry of entries) {
    const node = entry.node;
    const image = await load(node);
    try {
      paintReference(ctx, entry, image);
      if (node.id === id) paintReference(parentOnly.getContext("2d")!, entry, image);
    } finally { image.close(); }
  }
  const actual = await composeSubtreeImage(branch, rect, load, 100_000);
  const target = ctx.getImageData(0, 0, size.width, size.height).data;
  const own = parentOnly.getContext("2d")!.getImageData(0, 0, size.width, size.height).data;
  const output = actual.getContext("2d")!.getImageData(0, 0, size.width, size.height).data;
  let mismatchedPixels = 0, childContributionPixels = 0, visiblePixels = 0, maxChannelDelta = 0;
  const mismatchSamples: object[] = [];
  for (let i = 0; i < output.length; i += 4) {
    if (output[i + 3]) visiblePixels++;
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(output[i + channel] - target[i + channel])));
    maxChannelDelta = Math.max(maxChannelDelta, delta);
    if (delta) {
      mismatchedPixels++;
      if (mismatchSamples.length < 8) mismatchSamples.push({ x: (i / 4) % size.width, y: Math.floor(i / 4 / size.width), actual: [...output.slice(i, i + 4)], expected: [...target.slice(i, i + 4)] });
    }
    if ([0, 1, 2, 3].some(channel => target[i + channel] !== own[i + channel])) childContributionPixels++;
  }
  let liveGroup: null | { width: number; height: number; mismatchedPixels: number; maxChannelDelta: number; alphaMismatches: number; samples: object[] } = null;
  let fullResolution: ReturnType<typeof pixelDifferenceSummary> | null = null;
  let groupPng: string | undefined;
  if (groupDataUrl) {
    if (!/^data:image\/png;base64,/.test(groupDataUrl)) throw new Error("Group must be an embedded PNG");
    const image = await createImageBitmap(await (await fetch(groupDataUrl)).blob());
    try {
      if (image.width !== b.right - b.left || image.height !== b.bottom - b.top || image.width * image.height > 4_000_000) throw new Error("Live group dimensions rejected");
      // Keep a no-downsampling comparison so a resized difference cannot be
      // falsely attributed to original capture pixels or dismissed as noise.
      const native = document.createElement("canvas"), reference = document.createElement("canvas"), parent = document.createElement("canvas");
      native.width = reference.width = parent.width = image.width; native.height = reference.height = parent.height = image.height;
      native.getContext("2d")!.drawImage(image, 0, 0);
      const referenceContext = reference.getContext("2d")!;
      referenceContext.setTransform(1, 0, 0, 1, -b.left, -b.top);
      parent.getContext("2d")!.setTransform(1, 0, 0, 1, -b.left, -b.top);
      for (const entry of entries) {
        const node = entry.node;
        const ownImage = await load(node);
        try {
          paintReference(referenceContext, entry, ownImage);
          if (node.id === id) paintReference(parent.getContext("2d")!, entry, ownImage);
        } finally { ownImage.close(); }
      }
      const nativePixels = native.getContext("2d")!.getImageData(0, 0, image.width, image.height).data;
      const referencePixels = referenceContext.getImageData(0, 0, image.width, image.height).data;
      fullResolution = pixelDifferenceSummary(nativePixels, referencePixels, image.width, image.height,
        parent.getContext("2d")!.getImageData(0, 0, image.width, image.height).data);
      const group = canvas(), context = group.getContext("2d")!;
      context.setTransform(sx, 0, 0, sy, -left * sx, -top * sy);
      context.drawImage(image, b.left, b.top, b.right - b.left, b.bottom - b.top);
      const rgba = context.getImageData(0, 0, size.width, size.height).data;
      liveGroup = { width: image.width, height: image.height, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0, samples: [] };
      for (let i = 0; i < rgba.length; i += 4) {
        const delta = Math.max(...[0, 1, 2, 3].map(c => Math.abs(rgba[i + c] - output[i + c])));
        liveGroup.maxChannelDelta = Math.max(liveGroup.maxChannelDelta, delta);
        if (rgba[i + 3] !== output[i + 3]) liveGroup.alphaMismatches++;
        if (delta) {
          liveGroup.mismatchedPixels++;
          if (liveGroup.samples.length < 8) liveGroup.samples.push({ x: (i / 4) % size.width, y: Math.floor(i / 4 / size.width), group: [...rgba.slice(i, i + 4)], local: [...output.slice(i, i + 4)] });
        }
      }
      groupPng = group.toDataURL("image/png");
    } finally { image.close(); }
  }
  const localCompositionVerified = mismatchedPixels === 0 && childContributionPixels > 0 && visiblePixels > 0;
  const nativeGroupVerified = liveGroup && fullResolution ? liveGroup.mismatchedPixels === 0 && fullResolution.mismatchedPixels === 0 : null;
  return { id, rect, size, imageIds: images.map(n => n.id), mismatchedPixels, maxChannelDelta, mismatchSamples, childContributionPixels, visiblePixels, liveGroup, fullResolution,
    localCompositionVerified, nativeGroupVerified,
    verified: mismatchedPixels === 0 && childContributionPixels > 0 && visiblePixels > 0 && (!liveGroup || liveGroup.mismatchedPixels === 0) && (!fullResolution || fullResolution.mismatchedPixels === 0),
    actualPng: actual.toDataURL("image/png"), expectedPng: expected.toDataURL("image/png"),
    ...(groupPng ? { groupPng } : {}),
    scope: groupDataUrl ? "saved own composition versus identity-checked live SDK group at native resolution and 100k output budget; explicit rectangular ancestral clips; captures are not simultaneous; not WebGL sampling or custom clips" : "saved independent own images, local composition versus flat rectangular ancestral-clip reference at 100k pixel budget; not live SDK group or WebGL pixels" };
}
