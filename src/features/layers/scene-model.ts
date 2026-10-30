import { isLayerCapturePlacement } from "../../../shared/capture-transform";
import { buildLayerLayout, buildLayerOverview, layerPath, type LayerOverviewResult, type LayerRecord } from "../../../shared/layer-layout";
import { isQuietStructure } from "../../../shared/layer-structure";
import { layerPlaneOpacity } from "../../../shared/layer-textures";
import { clipBounds } from "../../../shared/screen-coordinates";
import type { PixelSize, UiNode } from "../../../shared/types";
import type { LayerAppearance } from "./appearance";
import { layerFraming, type LayerFramingScope } from "./framing";
import { scaledRect, sourceRect } from "./presentation";
import { layerOutlinePolicy } from "./scene-planes";
import type { LayerPlaneRole, LayerPresentation, Rect, ScenePivot, ScenePlane } from "./types";

export type SceneLayoutOptions = {
  root: UiNode;
  size: PixelSize;
  expandedNodeIds: ReadonlySet<string>;
  layoutHiddenIds: ReadonlySet<string>;
  focusedNode: UiNode | null;
  focusKind: "branch" | "layer";
  layerGap: number;
  showInvisible: boolean;
  showOffscreen: boolean;
  structureMode: LayerAppearance["structureMode"];
};

// Selection only enters layout when it must retain a node beyond the cap.
// Ordinary selection and hover consume the same geometry through highlights.
export function buildSceneLayout(options: SceneLayoutOptions, selection: UiNode | null = null): LayerOverviewResult {
  const { root, size, expandedNodeIds, layoutHiddenIds, focusedNode, focusKind, layerGap, showInvisible, showOffscreen, structureMode } = options;
  const overviewOptions = { layerGap, expandedIds: expandedNodeIds, showInvisible, showOffscreen,
    compactStructure: structureMode === "regular", hiddenIds: layoutHiddenIds };
  if (!focusedNode) return buildLayerOverview(root, selection, size, { ...overviewOptions, maxLayers: 512 });
  if (focusKind === "branch") {
    const ancestorInvisible = layerPath(root, focusedNode.id, showOffscreen).entries.get(focusedNode.id)?.isDeviceInvisible;
    const branch = buildLayerOverview(focusedNode, selection, size, { ...overviewOptions, maxLayers: 511, ancestorInvisible });
    // A focused root owns a selectable plane without a separate page backdrop.
    return { ...branch, parent: null, parentId: null, records: [
      ...(branch.parent ? [{ ...branch.parent, hitTestable: true }] : []), ...branch.records,
    ], candidateCount: branch.candidateCount + Number(Boolean(branch.parent)) };
  }
  const single = buildLayerLayout(root, focusedNode, size, { includeParents: false, includeChildren: false,
    maxLayers: 1, showInvisible, showOffscreen });
  return { ...single, parent: null, parentId: null, records: single.records.filter(record => !layoutHiddenIds.has(record.id)).map(record => ({
    ...record, isSelected: false, isCollapsed: record.node.children.length > 0 && !expandedNodeIds.has(record.id),
  })) };
}

export function overflowSceneSelection(layout: LayerOverviewResult, selectedNode: UiNode | null): UiNode | null {
  return layout.truncated && selectedNode && selectedNode.id !== layout.parent?.id
    && !layout.records.some(record => record.id === selectedNode.id) ? selectedNode : null;
}

export function buildSceneFraming(layout: LayerOverviewResult, options: {
  size: PixelSize;
  focusedNode: UiNode | null;
  framingScope: LayerFramingScope;
  origin: Pick<Rect, "left" | "top">;
  renderScale: number;
}) {
  const { size, focusedNode, framingScope, origin, renderScale } = options;
  const records = [layout.parent, ...layout.records].filter((record): record is LayerRecord => Boolean(record));
  const { frames, center } = layerFraming(records, size, !focusedNode && framingScope === "screen");
  return { frames, center,
    renderOrigin: { left: origin.left + (size.width / 2 - center.x) * renderScale,
      top: origin.top + (size.height / 2 - center.y) * renderScale },
    pivot: { x: origin.left + size.width * renderScale / 2, y: origin.top + size.height * renderScale / 2,
      z: center.z * renderScale } };
}

// Texture versions are resolved by the owner of texture demand. Scene building
// only consumes their values and never reads or updates a version cache.
export type ResolvedSceneVisual = Pick<ScenePlane, "source" | "textureSrc" | "textureSize"> & {
  kind: "native" | "composite" | "isolated";
};

export type BaseScenePlaneOptions = {
  parent: LayerRecord | null;
  records: readonly LayerRecord[];
  parentRole: LayerPlaneRole | null;
  roles: ReadonlyMap<string, LayerPlaneRole>;
  visuals: ReadonlyMap<string, ResolvedSceneVisual | null>;
  groupNodeIds: ReadonlySet<string>;
  size: PixelSize;
  renderScale: number;
  renderOrigin: Pick<Rect, "left" | "top">;
  suppressedOutlines: ReadonlySet<string>;
  showOffscreen: boolean;
};

export function buildBaseScenePlanes(options: BaseScenePlaneOptions): ScenePlane[] {
  const { parent, records, parentRole, roles, visuals, groupNodeIds, size, renderScale, renderOrigin, suppressedOutlines, showOffscreen } = options;
  const planes: ScenePlane[] = [];
  const addPlane = (record: LayerRecord, id: string, role: LayerPlaneRole | null, defaultOpacity: number) => {
    const visual = role === "surface" ? visuals.get(record.id) : null;
    const layoutRect = scaledRect(record, renderScale, renderOrigin);
    let rect = layoutRect, source = visual?.source ?? sourceRect(record);
    let opacity = role === "surface" ? layerPlaneOpacity(record.node, record.isCollapsed, groupNodeIds.has(record.id)) : defaultOpacity;
    if (showOffscreen && !record.isCollapsed && !record.isDeviceInvisible && role === "surface" && isLayerCapturePlacement(record.node.layerCapturePlacement)) {
      opacity = record.node.layerCapturePlacement.opacity;
    }
    const placement = record.isCollapsed || showOffscreen ? undefined : record.node.layerCapturePlacement;
    if (!record.isDeviceInvisible && record.node.layerImageDataUrl && isLayerCapturePlacement(placement)) {
      if (placement.hidden) return;
      const p = placement.screen;
      const clipped = clipBounds({ left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height }, size);
      if (!clipped) return;
      const sx = placement.source.width / p.width, sy = placement.source.height / p.height;
      source = { left: placement.source.left + (clipped.left - p.left) * sx, top: placement.source.top + (clipped.top - p.top) * sy,
        width: (clipped.right - clipped.left) * sx, height: (clipped.bottom - clipped.top) * sy };
      rect = { left: renderOrigin.left + clipped.left * renderScale, top: renderOrigin.top + clipped.top * renderScale,
        width: (clipped.right - clipped.left) * renderScale, height: (clipped.bottom - clipped.top) * renderScale };
      if (role === "surface") opacity = placement.opacity;
    }
    planes.push({ id, node: record.hitTestable ? record.node : null, layoutRect, rect, source, textureSrc: visual?.textureSrc ?? null,
      textureSize: visual?.textureSize ?? size, z: record.z * renderScale, kind: record.isDeviceInvisible ? "invisible" : visual?.kind ?? "outline",
      opacity, hitTestable: record.hitTestable, deviceInvisible: record.isDeviceInvisible, quietStructure: isQuietStructure(record), outlineOpacity: 1,
      quickSelect: { collapsed: record.isCollapsed && !record.isDeviceInvisible, screen: sourceRect(record) },
      hitPolicy: role === "surface" ? "content" : "edge",
      outlinePolicy: suppressedOutlines.has(record.id) ? "none" : layerOutlinePolicy(record, role === "surface") });
  };
  if (parent) addPlane(parent, `${parent.id}:parent`, parentRole, 0.65);
  for (const record of records) addPlane(record, record.id, roles.get(record.id) ?? "outline", record.isCompact ? 0.42 : 0.78);
  return planes;
}

export function buildSceneHighlights(baseScenePlanes: readonly ScenePlane[], options: {
  selectedRecord: LayerRecord | null;
  hoveredRecord: LayerRecord | null;
  selectedNodeId: string | null | undefined;
}): ScenePlane[] {
  const { selectedRecord, hoveredRecord, selectedNodeId } = options;
  const planes = [...baseScenePlanes];
  for (const [record, kind] of [[selectedRecord, "selection"], [hoveredRecord?.id === selectedNodeId ? null : hoveredRecord, "hover"]] as const) {
    if (!record) continue;
    const plane = baseScenePlanes.find(plane => plane.id === record.id || plane.id === `${record.id}:parent`);
    if (plane) planes.push({ ...plane, id: `${record.id}:${kind}`, node: null, rect: plane.layoutRect ?? plane.rect,
      textureSrc: null, kind, opacity: 1, hitTestable: false, hitPolicy: "none" });
  }
  return planes;
}

export function buildScenePresentation(scenePlanes: readonly ScenePlane[], options: {
  center: ScenePivot;
  pivot: ScenePivot;
  renderScale: number;
}): LayerPresentation {
  const { center, pivot, renderScale } = options;
  return { depths: new Map(scenePlanes.map(plane => [plane.id.replace(/:(parent|selection|hover)$/, ""), plane.z / renderScale])),
    center, pivot, scale: renderScale };
}
