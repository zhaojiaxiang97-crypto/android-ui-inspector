import { composeSubtreeImage } from "../shared/layer-textures";
import { makeNode } from "./fixtures";
import type { UiNode } from "../shared/types";

/** Real Canvas pixels: an offscreen sibling contains a child translated onscreen. */
export async function verifySubtreeClipping() {
  const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, raw: "" });
  const image = (color: string) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 100;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 100, 100);
    return canvas;
  };
  const white = image("white"), black = image("black");
  const painted = (id: string, rect: ReturnType<typeof bounds>): UiNode => ({ ...makeNode(id), bounds: rect,
    attributes: {}, layerImageDataUrl: "fixture", layerImageSize: { width: 100, height: 100 } });
  const results: string[] = [];
  const check = async (name: string, root: UiNode, expected: (x: number, y: number) => number, hidden?: Set<string>) => {
    const output = await composeSubtreeImage(root, { left: 0, top: 0, width: 100, height: 100 }, async n => n.id === "root" ? white : black, 10_000, hidden);
    try {
      const pixels = output.getContext("2d")!.getImageData(0, 0, 100, 100).data;
      for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
        const offset = (y * 100 + x) * 4, value = expected(x, y);
        if ([0, 1, 2].some(c => Math.abs(pixels[offset + c] - value) > 1) || pixels[offset + 3] !== 255)
          throw new Error(`${name}: unexpected pixel at ${x},${y}: ${Array.from(pixels.slice(offset, offset + 4))}`);
      }
      results.push(name);
    } finally { output.width = output.height = 0; }
  };
  try {
    for (const mode of ["sdk-legacy", "captured-true", "captured-false", "unknown-source", "qml", "translucent-page", "hidden-parent"] as const) {
      const root = painted("root", bounds(0, 0, 100, 100));
      const pager: UiNode = { ...makeNode("pager"), bounds: root.bounds, attributes: { "tree-source": "debug-sdk" } };
      const page: UiNode = { ...makeNode("offscreen-page"), bounds: bounds(-100, 0, 0, 100), attributes: { "clip-children": "false" },
        children: [painted("black-strip", bounds(10, 0, 30, 100))] };
      if (mode === "captured-true") pager.attributes = { "clip-children": "true" };
      if (mode === "captured-false") pager.attributes = { "tree-source": "debug-sdk", "clip-children": "false" };
      if (mode === "unknown-source") pager.attributes = {};
      if (mode === "qml") pager.attributes = { "inspection-source": "debug-qml" };
      if (mode === "translucent-page") page.attributes = { ...page.attributes, alpha: "0.5" };
      root.children = [pager]; pager.children = [page];
      const leaks = ["captured-false", "unknown-source", "qml"].includes(mode);
      await check(mode, root, x => leaks && x >= 10 && x < 30 ? 0 : 255, mode === "hidden-parent" ? new Set(["pager"]) : undefined);
    }
    for (const clipping of [undefined, "true", "false"]) {
      const root = painted("root", bounds(0, 0, 100, 100));
      const parent: UiNode = { ...makeNode("padded"), bounds: bounds(10, 10, 90, 90),
        attributes: { "tree-source": "debug-sdk", "sdk-paddingLeft": "10", "sdk-paddingTop": "20", "sdk-paddingRight": "30", "sdk-paddingBottom": "10",
          ...(clipping === undefined ? {} : { "clip-to-padding": clipping }) },
        children: [painted("overflow", bounds(0, 0, 100, 100))] };
      root.children = [parent];
      await check(`sdk-padding-${clipping ?? "legacy"}`, root, (x, y) => clipping === "false" || x >= 20 && x < 60 && y >= 30 && y < 80 ? 0 : 255);
    }
    return results;
  } finally { white.width = white.height = black.width = black.height = 0; }
}
