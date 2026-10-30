import type { UiNode } from "./types";

export type NodeCaptureFacts = {
  readonly status: UiNode["layerImageStatus"];
  // Undefined means unmeasured; true means measured fully transparent, even if
  // the bitmap itself was not retained. Neither value proves exportability.
  readonly empty: UiNode["layerImageEmpty"];
  readonly dataUrl: UiNode["layerImageDataUrl"];
  readonly size: UiNode["layerImageSize"];
  // Presence checks only: neither one validates a saved raster image.
  readonly hasImageData: boolean;
  readonly hasNonBlankImageData: boolean;
  // Preserve independent raw metadata, including empty strings. Consumers choose
  // their own fallback semantics; one source must never overwrite another.
  readonly source: string | undefined;
  readonly captureSource: string | undefined;
  readonly inspectionSource: string | undefined;
  readonly error: string | undefined;
  readonly skipDraw: boolean;
};

/** Decode this node's capture metadata without inferring presentation policy. */
export function nodeCaptureFacts(node: UiNode): NodeCaptureFacts {
  return {
    status: node.layerImageStatus,
    empty: node.layerImageEmpty,
    dataUrl: node.layerImageDataUrl,
    size: node.layerImageSize,
    hasImageData: Boolean(node.layerImageDataUrl),
    hasNonBlankImageData: Boolean(node.layerImageDataUrl?.trim()),
    source: node.attributes?.["image-source"],
    captureSource: node.attributes?.["image-capture-source"],
    inspectionSource: node.attributes?.["inspection-source"],
    error: node.attributes?.["image-capture-error"],
    skipDraw: node.attributes?.["skip-draw"] === "true",
  };
}
