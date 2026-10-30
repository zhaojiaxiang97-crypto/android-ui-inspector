import type { PixelSize, QmlGroupImage, UiNode } from "../../../shared/types";
import { type LayerRecord } from "../../../shared/layer-layout";
import { subtreeImageNodes } from "../../../shared/layer-textures";
import { type BoundsMeasurement } from "../../../shared/node-metrics";
import { type LayerPlaneRole, type Rect } from "./types";
import { nodePresentationStatus } from "../../../shared/node-presentation-status";

const CONTENT_CLASS_PATTERN = /(TextView|ImageView|ImageButton|Button|EditText|CheckBox|RadioButton|Switch|ToggleButton|ProgressBar|SeekBar|WebView|SurfaceView|TextureView|VideoView)/i;
const STRUCTURAL_CLASS_PATTERN = /(FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|ViewGroup|ViewPager|SlidingPaneLayout|RecyclerView|ScrollView|DrawerLayout|CoordinatorLayout)/i;
const TEXT_ONLY_CLASS_PATTERN = /TextView$/i;

export function subtreeHasHidden(node: UiNode, hiddenNodeIds: ReadonlySet<string>) {
  if (!hiddenNodeIds.size) return false;
  const pending = [node];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (hiddenNodeIds.has(pending[cursor].id)) return true;
    pending.push(...pending[cursor].children);
  }
  return false;
}

// Texture cache keys stay compact: one version per node id and image value. Incremental
// batches and the final capture result replace node objects while unchanged images keep
// the same data URL, so comparing by value keeps their textures cached.
export const textureImageVersions = new Map<string, { image: string | undefined; version: number }>();
let nextTextureImageVersion = 1;
const groupImageVersions = new WeakMap<QmlGroupImage, { image: string; width: number; height: number; version: number }>();
let nextGroupImageVersion = 1;
export const subtreeTextureVersions = new Map<string, { signature: string; version: number }>();
let nextSubtreeTextureVersion = 1;

function textureNodeVersion(node: UiNode) {
  const image = node.layerImageDataUrl;
  const cached = textureImageVersions.get(node.id);
  if (cached && cached.image === image) return cached.version;
  const version = nextTextureImageVersion++;
  textureImageVersions.set(node.id, { image, version });
  return version;
}

export function groupImageFor(record: LayerRecord, groups: ReadonlyMap<string, QmlGroupImage>, hiddenNodeIds: ReadonlySet<string>) {
  if (!record.isCollapsed || !groups.has(record.id) || subtreeHasHidden(record.node, hiddenNodeIds)) return null;
  return groups.get(record.id)!;
}

export function collapsedTextureKey(record: LayerRecord, visibilityKey: string, group: QmlGroupImage | null) {
  if (group) {
    let cached = groupImageVersions.get(group);
    if (!cached || cached.image !== group.dataUrl || cached.width !== group.size.width || cached.height !== group.size.height) {
      cached = { image: group.dataUrl, width: group.size.width, height: group.size.height, version: nextGroupImageVersion++ };
      groupImageVersions.set(group, cached);
    }
    return `live-group:${record.id}:${group.capturedAt}:v${cached.version}`;
  }
  // The same partial-offscreen subtree has different canvas origins/sizes in
  // screen-only and full-layout modes, even when its source pixels are unchanged.
  const signature: unknown[] = [record.renderBounds];
  const pending = [record.node];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const node = pending[cursor];
    signature.push([node.id, textureNodeVersion(node), node.index, node.bounds, node.layerImageSize, node.layerImageEmpty, node.visibleToUser,
      node.children.map(child => child.id), ...["alpha", "effective-alpha", "inspection-source", "tree-source", "z", "qml-clip", "qml-layer-enabled",
        "elevation", "translation-z", "drawing-order", "drawingOrder", "drawing_order",
        "clip-children", "clip-to-padding", "clip-to-outline", "padding-left", "padding-top", "padding-right", "padding-bottom",
        "sdk-paddingLeft", "sdk-paddingTop", "sdk-paddingRight", "sdk-paddingBottom",
        "sdk-outlineLeft", "sdk-outlineTop", "sdk-outlineRight", "sdk-outlineBottom", "sdk-outlineRadius", "image-refreshed-at"]
        .map(key => node.attributes?.[key])]);
    pending.push(...node.children);
  }
  const serialized = JSON.stringify(signature);
  let cached = subtreeTextureVersions.get(record.id);
  if (!cached || cached.signature !== serialized) {
    cached = { signature: serialized, version: nextSubtreeTextureVersion++ };
    subtreeTextureVersions.set(record.id, cached);
  }
  return `subtree:${record.id}:${visibilityKey}:v${cached.version}`;
}

export function indexLayerTree(root: UiNode) {
  const nodes = new Map<string, UiNode>(), parents = new Map<string, string | null>();
  const pending: Array<{ node: UiNode; parentId: string | null }> = [{ node: root, parentId: null }];
  while (pending.length) {
    const { node, parentId } = pending.pop()!;
    nodes.set(node.id, node); parents.set(node.id, parentId);
    for (const child of node.children) pending.push({ node: child, parentId: node.id });
  }
  return { nodes, parents };
}

export function outlineAncestors(record: LayerRecord, tree: ReturnType<typeof indexLayerTree>) {
  const result: UiNode[] = [];
  let id: string | null = record.id;
  while (id) {
    const node = tree.nodes.get(id);
    if (node?.attributes?.["clip-to-outline"] === "true") result.push(node);
    id = tree.parents.get(id) ?? null;
  }
  return result;
}

export function nativeTextureKey(record: LayerRecord, clips: readonly UiNode[]) {
  const version = `v${textureNodeVersion(record.node)}`;
  if (!clips.length) return `${record.id}:${version}`;
  const signature = clips.map(node => [node.id, node.bounds?.left, node.bounds?.top, node.bounds?.right, node.bounds?.bottom,
    ...["Left", "Top", "Right", "Bottom", "Radius"].map(key => node.attributes?.[`sdk-outline${key}`])]);
  const bounds = record.node.bounds;
  return `${record.id}:${version}#outline:${JSON.stringify([[bounds?.left, bounds?.top, bounds?.right, bounds?.bottom], signature])}`;
}

export function hasOwnVisualStyle(record: LayerRecord, size: PixelSize, hiddenNodeIds: ReadonlySet<string>, groups: ReadonlyMap<string, QmlGroupImage>) {
  const node = record.node;
  // Collapsed branches combine independent images; expanded nodes keep their own.
  if (record.isCollapsed) return Boolean(groupImageFor(record, groups, hiddenNodeIds)) || subtreeImageNodes(node, hiddenNodeIds).length > 0;
  const state = nodePresentationStatus(node).ownImage.code;
  if (state === "empty" || state === "structural" || state === "ambiguous") return false;
  if (node.layerImageDataUrl && node.layerImageSize) return true;
  // Without an independent bitmap, keep structural nodes as outlines.
  if (node.children.length > 0 || isNearFullScreen(record, size) || STRUCTURAL_CLASS_PATTERN.test(node.className ?? "")) return false;
  // Missing Debug View / Qt own images stay outlines, never screen crops
  // that would leak pixels from unrelated layers.
  if (state === "failed" || ["debug-view", "debug-qml", "debug-hybrid"].includes(node.attributes?.["inspection-source"] ?? "")) return false;
  // Accessibility-only nodes have no pixels beyond the screenshot to crop.
  const b = record.renderBounds;
  if (b.left < 0 || b.top < 0 || b.right > size.width || b.bottom > size.height) return false;
  // A virtual accessibility leaf has no isolated bitmap. Its bounds crop is
  // the closest representation of the child window, including its background.
  if (record.isVirtual) return Boolean(node.text?.trim() || node.contentDesc?.trim());
  // ponytail: Android debug trees have no isolated view bitmap; texture only leaf views so parent/child pixels are not copied into each other.
  if (node.text?.trim() || node.contentDesc?.trim()) return true;
  if (CONTENT_CLASS_PATTERN.test(node.className ?? "")) return true;
  if (node.clickable || node.focusable || node.selected) return true;
  return Boolean(node.resourceId?.trim() && node.children.length === 0 && !STRUCTURAL_CLASS_PATTERN.test(node.className ?? ""));
}

export function usesTextOnlyTexture(record: LayerRecord) {
  return Boolean(record.node.text?.trim() && TEXT_ONLY_CLASS_PATTERN.test(record.node.className ?? ""));
}

function isNearFullScreen(record: LayerRecord, size: PixelSize) {
  const width = record.renderBounds.right - record.renderBounds.left;
  const height = record.renderBounds.bottom - record.renderBounds.top;
  const widthRatio = width / size.width;
  const heightRatio = height / size.height;
  return (widthRatio >= 0.9 && heightRatio >= 0.75) || (widthRatio >= 0.75 && heightRatio >= 0.9);
}

export function layerPlaneRoles(records: readonly LayerRecord[], size: PixelSize, hiddenNodeIds: ReadonlySet<string>, groups: ReadonlyMap<string, QmlGroupImage>) {
  const roles = new Map<string, LayerPlaneRole>();
  for (const record of records) {
    roles.set(record.id, hasOwnVisualStyle(record, size, hiddenNodeIds, groups) ? "surface" : "outline");
  }
  return roles;
}

export function scaledRect(record: LayerRecord, renderScale: number, origin: Pick<Rect, "left" | "top">): Rect {
  const { left, top, right, bottom } = record.renderBounds;
  return { left: origin.left + left * renderScale, top: origin.top + top * renderScale, width: Math.max(1, (right - left) * renderScale), height: Math.max(1, (bottom - top) * renderScale) };
}

export function sourceRect(record: LayerRecord): Rect {
  const { left, top, right, bottom } = record.renderBounds;
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function visualFor(record: LayerRecord, screenshotSize: PixelSize, visibilityKey: string, group: QmlGroupImage | null, nativeTextureKey = record.node.layerImageDataUrl!) {
  if (record.isCollapsed) {
    const rect = sourceRect(record);
    if (group) {
      const bounds = record.sourceBounds;
      const scaleX = group.size.width / (bounds.right - bounds.left);
      const scaleY = group.size.height / (bounds.bottom - bounds.top);
      return { kind: "composite" as const, textureSrc: collapsedTextureKey(record, visibilityKey, group), textureSize: group.size,
        source: { left: (rect.left - bounds.left) * scaleX, top: (rect.top - bounds.top) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY } };
    }
    const textureSize = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    return { kind: "composite" as const, textureSrc: collapsedTextureKey(record, visibilityKey, null), textureSize, source: { left: 0, top: 0, ...textureSize } };
  }
  if (record.node.layerImageDataUrl && record.node.layerImageSize) {
    const textureSize = record.node.layerImageSize;
    const bounds = record.sourceBounds;
    const scaleX = textureSize.width / (bounds.right - bounds.left);
    const scaleY = textureSize.height / (bounds.bottom - bounds.top);
    const rect = sourceRect(record);
    return { kind: "native" as const, textureSrc: nativeTextureKey, textureSize, source: { left: (rect.left - bounds.left) * scaleX, top: (rect.top - bounds.top) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY } };
  }
  return { kind: "isolated" as const, textureSrc: null, textureSize: screenshotSize, source: sourceRect(record) };
}

export function measurementLabel(measurement: BoundsMeasurement, index: number) {
  if (measurement.relation === "equal") return "边界重合 · 间距 0 px";
  if (measurement.relation === "overlap") return "外框重叠 · 间距 0 px";
  if (measurement.relation === "touching") return "边缘相接 · 间距 0 px";
  return measurement.guides[index].distances.map(({ label, value }) => `${label} ${Number(value.toFixed(2))} px`).join(" · ");
}
