import type { LayerRecord } from "../../../shared/layer-layout";
import { nodePresentationStatus } from "../../../shared/node-presentation-status";
import type { LayerDisplayMode } from "./appearance";
import type { TextureAlphaMask } from "./texture-alpha";
import type { HitPolicy, OutlinePolicy, Rect, ScenePlane } from "./types";

export function layerOutlinePolicy(record: LayerRecord, surface: boolean): OutlinePolicy {
  const state = nodePresentationStatus(record.node).ownImage.code;
  if (record.isCollapsed) return surface ? "normal" : "required";
  if (state === "failed" || state === "ambiguous") return "required";
  return surface || state === "empty" || state === "structural" || record.isDeviceInvisible ? "normal" : "required";
}

const textured = (plane: ScenePlane) => plane.kind === "native" || plane.kind === "composite" || plane.kind === "isolated";
const highlighted = (plane: ScenePlane) => plane.kind === "selection" || plane.kind === "hover";

// Trim pixels only. Layout, selection and the original source-to-screen mapping
// are independent of this optimization. Per-texel alpha controls content picking.
export function contentPlane(plane: ScenePlane, contents: ReadonlyMap<string, Rect | null>): ScenePlane | null {
  if (!plane.textureSrc || !contents.has(plane.textureSrc)) return plane;
  const content = contents.get(plane.textureSrc);
  if (!content) return null;
  const source = plane.source;
  const left = Math.max(source.left, content.left * plane.textureSize.width);
  const top = Math.max(source.top, content.top * plane.textureSize.height);
  const right = Math.min(source.left + source.width, (content.left + content.width) * plane.textureSize.width);
  const bottom = Math.min(source.top + source.height, (content.top + content.height) * plane.textureSize.height);
  if (right <= left || bottom <= top) return null;
  if (left === source.left && top === source.top && right === source.left + source.width && bottom === source.top + source.height) return plane;
  const quick = plane.quickSelect;
  return { ...plane, source: { left, top, width: right - left, height: bottom - top },
    ...(quick ? { quickSelect: { ...quick, screen: {
      left: quick.screen.left + (left - source.left) / source.width * quick.screen.width,
      top: quick.screen.top + (top - source.top) / source.height * quick.screen.height,
      width: (right - left) / source.width * quick.screen.width,
      height: (bottom - top) / source.height * quick.screen.height,
    } } } : {}), rect: {
      left: plane.rect.left + (left - source.left) / source.width * plane.rect.width,
      top: plane.rect.top + (top - source.top) / source.height * plane.rect.height,
      width: (right - left) / source.width * plane.rect.width,
      height: (bottom - top) / source.height * plane.rect.height,
    } };
}

// A base plane owns one layout border. Highlight replaces its ordinary stroke
// while the border's edge geometry remains selectable, including alpha margins.
export function prepareScenePlanes(planes: readonly ScenePlane[], contents: ReadonlyMap<string, Rect | null>,
  textures: ReadonlyMap<string, unknown>, mode: LayerDisplayMode = "images", alphaMasks?: ReadonlyMap<string, TextureAlphaMask>): ScenePlane[] {
  const emphasis = new Set(planes.filter(highlighted).map(plane => plane.id.replace(/:(selection|hover)$/, "")));
  return planes.flatMap(plane => {
    const rect = plane.layoutRect ?? plane.rect;
    if (highlighted(plane)) return [{ ...plane, rect, textureSrc: null, hitTestable: false, hitPolicy: "none" as HitPolicy }];
    if (plane.kind === "invisible") return [{ ...plane, rect, hitPolicy: "edge" as HitPolicy }];
    const missing = textured(plane) && Boolean(plane.textureSrc) && !textures.has(plane.textureSrc!);
    const required = missing || plane.outlinePolicy === "required";
    const stroke = mode === "wireframe" || required ? "required" : plane.outlinePolicy ?? "normal";
    const outline: ScenePlane = { ...plane, quietStructure: plane.quietStructure || Boolean(plane.textureSrc && textures.has(plane.textureSrc) && alphaMasks?.has(plane.textureSrc) && contents.has(plane.textureSrc) && contents.get(plane.textureSrc) === null), rect, textureSrc: null, kind: "outline", hitPolicy: "edge",
      // A layout contour describes geometry, independently of its image alpha.
      // Motion still supplies a separate fade for entering/retiring contours.
      outlinePolicy: stroke, opacity: plane.outlineOpacity ?? plane.opacity };
    // The highlight has its own layout stroke. Keep this edge for picking but
    // omit its draw pass so selection never doubles the border's apparent width.
    outline.highlighted = emphasis.has(plane.id.replace(/:parent$/, ""));
    if (mode === "wireframe" || !textured(plane) || missing) return [outline];
    const content = contentPlane({ ...plane, hitPolicy: "content" }, contents);
    return [...(content ? [content] : []), { ...outline, id: `${plane.id}:outline` }];
  });
}

export function outlineIsVisible(plane: ScenePlane, showOutlines: boolean) {
  return plane.outlinePolicy !== "none" && (showOutlines || plane.outlinePolicy === "required");
}
