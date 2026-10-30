import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PixelSize, QmlGroupImage, SnapshotGroupImage, UiNode } from "../../../shared/types";
import { buildLayerLayout, buildLayerOverview, layerPath, type LayerRecord } from "../../../shared/layer-layout";
import { clipLayerImageToOutlines, composeSubtreeImage, layerPlaneOpacity } from "../../../shared/layer-textures";
import { nodeDisplayLabel, nodeShortClass } from "../../../shared/tree-utils";
import { isLayerCapturePlacement } from "../../../shared/capture-transform";
import { clipBounds } from "../../../shared/screen-coordinates";
import { layerImageProvenance, layerImagePresentation, type GroupRequestState } from "../../../shared/layer-image-provenance";
import { nodePresentationStatus } from "../../../shared/node-presentation-status";
import { LayerDemandQueue } from "../../../shared/layer-demand";
import { type Rect, type LayerCamera, type LayerSceneHandle, type LayerMeasurementState, type Renderer, type ScenePlane, type ScenePivot, type LayerPresentation, type ProjectedPlane, type Point, type RendererStatus } from "./types";
import { layerDemandOrder } from "./demand";
import { indexLayerTree, subtreeHasHidden, groupImageFor, hasOwnVisualStyle, outlineAncestors, nativeTextureKey, textureImageVersions, subtreeTextureVersions, collapsedTextureKey, layerPlaneRoles, usesTextOnlyTexture, visualFor, scaledRect, sourceRect } from "./presentation";
import { cameraRotation, rotatePoint, pointInQuad, pointNearQuadEdge } from "./projection";
import { drawScene, createRenderer, disposeRenderer, uploadTexture, loadLayerImage, uploadLayerTexture } from "./webgl-renderer";
import { DEFAULT_LAYER_APPEARANCE, type LayerAppearance } from "./appearance";
import { useLayerMeasurement } from "./useLayerMeasurement";
import { LAYER_MOTION_FALLBACK_LIMIT, layerPlaneNodeId, motionProgress, sampleLayerMotion, type LayerMotion, type LayerMotionFrame } from "./motion";
import { resolveVisibleHoverId } from "../../../shared/node-hover";
import { useNodeHover } from "../inspection/NodeHoverContext";
import { candidateOnPaintedPlane, findQuickSelectCandidates, pointOnPaintedPlane, quickSelectMessage, type QuickSelectCandidate, type QuickSelectResult } from "./quick-select";


type Props = {
  sessionKey?: string | number;
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  hiddenNodeIds?: ReadonlySet<string>;
  focusedNode?: UiNode | null;
  focusKind?: "branch" | "layer";
  size: PixelSize;
  renderScale: number;
  origin: Pick<Rect, "left" | "top">;
  viewport?: Rect;
  camera: LayerCamera;
  appearance?: LayerAppearance;
  onSelect: (node: UiNode) => void;
  onCaptureGroup?: (node: UiNode) => Promise<QmlGroupImage | null>;
  savedGroupImages?: readonly SnapshotGroupImage[];
  onFitScale?: (scale: number) => void;
  onMeasurementStateChange?: (state: LayerMeasurementState) => void;
};
const NO_HIDDEN_NODES: ReadonlySet<string> = new Set();
const NO_SAVED_GROUPS: readonly SnapshotGroupImage[] = [];
const MAX_LAYER_TEXTURE_PIXELS = 16_000_000;
type TextureDemand = { key: string; record: LayerRecord; group: QmlGroupImage | null; clips: readonly UiNode[]; hidden: ReadonlySet<string>; maxPixels: number };

export const Layer3DPreview = forwardRef<LayerSceneHandle, Props>(function Layer3DPreview({ sessionKey, src, root, selectedNode, expandedNodeIds, hiddenNodeIds = NO_HIDDEN_NODES, focusedNode = null, focusKind = "layer", size, renderScale, origin, viewport, camera, appearance = DEFAULT_LAYER_APPEARANCE, onSelect, onCaptureGroup, savedGroupImages = NO_SAVED_GROUPS, onFitScale, onMeasurementStateChange }, ref) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const planesRef = useRef<ScenePlane[]>([]);
  const presentationRef = useRef<LayerPresentation | null>(null);
  const paintedFrameRef = useRef<LayerMotionFrame | null>(null);
  const transitionRef = useRef<LayerMotion | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousTreeRef = useRef<{ root: UiNode; src: string; session: string | number | undefined; visibility: string; showInvisible: boolean; expanded: ReadonlySet<string>; gap: number; focusedId: string | null; focusKind: "branch" | "layer" } | null>(null);
  const projectedRef = useRef<ProjectedPlane[]>([]);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const quickOutlineRef = useRef<SVGSVGElement>(null);
  const quickPreviewRef = useRef<{ result: QuickSelectResult; candidate: QuickSelectCandidate } | null>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<(planes: readonly ScenePlane[], pivot: ScenePivot, camera: LayerCamera) => void>(() => {});
  const groupQueueRef = useRef<LayerDemandQueue<UiNode> | null>(null);
  const textureQueueRef = useRef<LayerDemandQueue<TextureDemand> | null>(null);
  const groupQueueContextRef = useRef<{ root: UiNode; src: string } | null>(null);
  const textureQueueContextRef = useRef<{ root: UiNode; src: string } | null>(null);
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>("loading");
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { hover: sharedHover, publishHover, clearHover } = useNodeHover();
  const [textureWarning, setTextureWarning] = useState<string | null>(null);
  const savedGroups = useMemo(() => new Map(savedGroupImages.map(group => [group.nodeId, group.image])), [savedGroupImages]);
  const [groupData, setGroupData] = useState(() => ({ root, src, images: savedGroups, requests: new Map<string, GroupRequestState>() }));
  const groupImages = groupData.root === root && groupData.src === src ? groupData.images : savedGroups;
  const groupRequestStates = groupData.root === root && groupData.src === src ? groupData.requests : new Map<string, GroupRequestState>();
  const savedGroupIds = useMemo(() => new Set(savedGroupImages.map(group => group.nodeId)), [savedGroupImages]);
  const savedImages = useMemo(() => new Set(savedGroupImages.map(group => group.image)), [savedGroupImages]);
  const treeIndex = useMemo(() => indexLayerTree(root), [root]);
  const layout = useMemo(() => {
    if (!focusedNode) return buildLayerOverview(root, selectedNode, size, { maxLayers: 512, layerGap: camera.layerGap, expandedIds: expandedNodeIds, showInvisible: appearance.showInvisible });
    if (focusKind === "branch") {
      const ancestorInvisible = layerPath(root, focusedNode.id).entries.get(focusedNode.id)?.isDeviceInvisible;
      const branch = buildLayerOverview(focusedNode, selectedNode, size, { maxLayers: 511, layerGap: camera.layerGap, expandedIds: expandedNodeIds, showInvisible: appearance.showInvisible, ancestorInvisible });
      // The focused root is a normal, selectable own/group plane, without a page backdrop.
      return { ...branch, parent: null, parentId: null, records: [
        ...(branch.parent ? [{ ...branch.parent, hitTestable: true }] : []), ...branch.records,
      ], candidateCount: branch.candidateCount + Number(Boolean(branch.parent)) };
    }
    // Isolation is independent of selection, tree folding and manually hidden
    // planes. Reuse the single-node layout without changing the captured tree.
    const single = buildLayerLayout(root, focusedNode, size, { includeParents: false, includeChildren: false, maxLayers: 1, showInvisible: appearance.showInvisible });
    return { ...single, parent: null, parentId: null, records: single.records.map(record => ({
      ...record, isSelected: record.id === selectedNode?.id,
      isCollapsed: record.node.children.length > 0 && !expandedNodeIds.has(record.id),
    })) };
  }, [camera.layerGap, expandedNodeIds, focusedNode, focusKind, root, selectedNode, size, appearance.showInvisible]);
  // Hide presentation only: retain the original Z slots and camera pivot.
  const records = useMemo(() => layout.records.filter((record) => !hiddenNodeIds.has(record.id)), [layout.records, hiddenNodeIds]);
  const parent = layout.parent && !hiddenNodeIds.has(layout.parent.id) ? layout.parent : null;
  const visibilityKey = useMemo(() => JSON.stringify([...hiddenNodeIds].sort()), [hiddenNodeIds]);
  const quickContext = useMemo(() => ({}), [root, src, sessionKey, visibilityKey, expandedNodeIds, focusedNode, focusKind, appearance.showInvisible]);
  const collapsedRecords = [parent, ...records].filter((record): record is LayerRecord => Boolean(record?.isCollapsed && !record.isDeviceInvisible && !subtreeHasHidden(record.node, hiddenNodeIds)
    && (record.node.attributes?.["inspection-source"] === "debug-qml" || root.attributes?.["tree-source"] === "debug-sdk")));
  const shownGroupImages = collapsedRecords.map(record => groupImageFor(record, groupImages, hiddenNodeIds)).filter((image): image is QmlGroupImage => Boolean(image));
  const textureRecords = useMemo(() => [parent, ...records].filter((record): record is LayerRecord => Boolean(record && !record.isDeviceInvisible && hasOwnVisualStyle(record, size, hiddenNodeIds, groupImages) && (record.isCollapsed || record.node.layerImageDataUrl))), [groupImages, hiddenNodeIds, parent, records, size]);
  const nativeLayerClips = useMemo(() => new Map(textureRecords.filter(record => !record.isCollapsed).map(record => [record.id, outlineAncestors(record, treeIndex)])), [textureRecords, treeIndex]);
  const nativeTextureKeys = useMemo(() => new Map(textureRecords.filter(record => !record.isCollapsed).map(record => [record.id, nativeTextureKey(record, nativeLayerClips.get(record.id) ?? [])])), [textureRecords, nativeLayerClips]);
  // Drop version entries for nodes that left the tree so stale images are not retained.
  useEffect(() => {
    for (const id of textureImageVersions.keys()) if (!treeIndex.nodes.has(id)) textureImageVersions.delete(id);
    for (const id of subtreeTextureVersions.keys()) if (!treeIndex.nodes.has(id)) subtreeTextureVersions.delete(id);
  }, [treeIndex]);
  const localCompositeCount = textureRecords.filter(record => record.isCollapsed && !groupImageFor(record, groupImages, hiddenNodeIds)).length;
  // Camera/hover preserve texture identity; the live queue updates demand.
  const textureKey = `${visibilityKey}|${textureRecords.map((record) => `${record.id}:${record.isCollapsed ? collapsedTextureKey(record, visibilityKey, groupImageFor(record, groupImages, hiddenNodeIds)) : nativeTextureKeys.get(record.id)}`).join("|")}`;
  const roles = useMemo(() => {
    const result = layerPlaneRoles(records, size, hiddenNodeIds, groupImages);
    for (const record of records) if (record.isDeviceInvisible) result.set(record.id, "outline");
    return result;
  }, [records, size, hiddenNodeIds, groupImages]);
  const selectedRecord = records.find((record) => record.isSelected) ?? (parent?.isSelected ? parent : null);
  const pointerHoveredRecord = records.find((record) => record.id === hoveredId) ?? (parent?.id === hoveredId ? parent : null);
  const visibleHoverIds = useMemo(() => new Set([...records.map(record => record.id), ...(parent ? [parent.id] : [])]), [records, parent]);
  const visualHoveredId = sharedHover?.source === "tree"
    ? resolveVisibleHoverId(sharedHover.nodeId, visibleHoverIds, treeIndex.parents, hiddenNodeIds) : hoveredId;
  const hoveredRecord = records.find(record => record.id === visualHoveredId) ?? (parent?.id === visualHoveredId ? parent : null);
  const treeMeasureHover = sharedHover?.source === "tree" ? records.find(record => record.id === sharedHover.nodeId) ?? (parent?.id === sharedHover.nodeId ? parent : null) : pointerHoveredRecord;
  const { anchor: measureAnchor, target: measureTarget, measurement, isPinned, summary, toggleMeasurementPin, clearPinnedMeasurement, beginMeasurement, useSelectedMeasurementNode, startMeasurementMode, setTemporaryMeasurement } = useLayerMeasurement({
    context: sessionKey ?? root, src, records: (parent ? [parent, ...records] : records).filter(record => !record.isDeviceInvisible),
    selected: selectedRecord && selectedRecord.id === selectedNode?.id && !selectedRecord.isDeviceInvisible ? selectedRecord : null,
    hovered: treeMeasureHover?.isDeviceInvisible ? null : treeMeasureHover, rendererStatus, onChange: onMeasurementStateChange,
  });
  const parentRole = parent ? (!parent.isDeviceInvisible && hasOwnVisualStyle(parent, size, hiddenNodeIds, groupImages) ? "surface" : "outline") : null;
  const provenanceFor = (record: LayerRecord) => {
    const provenance = layerImageProvenance({ collapsed: record.isCollapsed,
      hasGroup: Boolean(groupImageFor(record, groupImages, hiddenNodeIds)), hiddenDescendants: subtreeHasHidden(record.node, hiddenNodeIds),
      canRequestGroup: Boolean(onCaptureGroup && collapsedRecords.some(item => item.id === record.id)),
      requestState: groupRequestStates.get(record.id), ownSource: record.node.attributes?.["image-capture-source"] });
    const role = record === parent ? parentRole : roles.get(record.id);
    return { ...provenance, source: role === "surface" ? provenance.source : "none" };
  };
  const imagePresentationFor = (record: LayerRecord | null | undefined) => {
    if (!record) return null;
    if (record.isDeviceInvisible) return { label: "设备不可见", detail: "控件或祖先不可见，仅显示已采集的布局边界。" };
    const provenance = provenanceFor(record);
    if (record.isCollapsed) return layerImagePresentation(provenance);
    // Use captured facts to explain an own-layer outline; group pixels retain
    // the separate provenance above even when this node's own image is empty.
    return provenance.source === "none" ? nodePresentationStatus(record.node, { presentation: provenance }) : null;
  };
  const selectedImagePresentation = imagePresentationFor(selectedRecord);
  const hoveredImagePresentation = imagePresentationFor(hoveredRecord);
  const textureCount = records.filter((record) => roles.get(record.id) === "surface").length + Number(parentRole === "surface");
  const compositeCount = records.filter((record) => record.isCollapsed && !record.isDeviceInvisible).length + Number(Boolean(parent?.isCollapsed && !parent.isDeviceInvisible));
  const nativeTextureCount = records.filter((record) => roles.get(record.id) === "surface" && Boolean(record.node.layerImageDataUrl)).length;
  const textOnlyCount = records.filter((record) => roles.get(record.id) === "surface" && usesTextOnlyTexture(record)).length;
  const outlineCount = records.filter((record) => roles.get(record.id) === "outline").length;
  const invisibleCount = records.filter(record => record.isDeviceInvisible).length + Number(Boolean(parent?.isDeviceInvisible));
  const sceneRecords = [layout.parent, ...layout.records].filter((record): record is LayerRecord => Boolean(record));
  const center = {
    x: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.renderBounds.left)) + Math.max(...sceneRecords.map(r => r.renderBounds.right))) / 2 : size.width / 2,
    y: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.renderBounds.top)) + Math.max(...sceneRecords.map(r => r.renderBounds.bottom))) / 2 : size.height / 2,
    z: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.z)) + Math.max(...sceneRecords.map(r => r.z))) / 2 : 0,
  };
  const renderOrigin = { left: origin.left + (size.width / 2 - center.x) * renderScale, top: origin.top + (size.height / 2 - center.y) * renderScale };
  const pivot = useMemo(() => ({
    x: origin.left + size.width * renderScale / 2,
    y: origin.top + size.height * renderScale / 2,
    z: center.z * renderScale,
  }), [origin.left, origin.top, size.width, size.height, center.z, renderScale]);

  const textureDemands = new Map(textureRecords.map(record => {
    const group = groupImageFor(record, groupImages, hiddenNodeIds);
    const key = record.isCollapsed ? collapsedTextureKey(record, visibilityKey, group) : nativeTextureKeys.get(record.id)!;
    return [record.id, { key, record, group, clips: nativeLayerClips.get(record.id) ?? [], hidden: hiddenNodeIds,
      maxPixels: Math.min(2_000_000, Math.floor(MAX_LAYER_TEXTURE_PIXELS / Math.max(1, textureRecords.length))) }];
  }));
  const textureDemandsRef = useRef(textureDemands);
  textureDemandsRef.current = textureDemands;
  scheduleRef.current = (planes, paintPivot, currentCamera) => {
    const renderer = rendererRef.current;
    const available = viewportRef.current ?? { left: 0, top: 0,
      width: canvasRef.current?.clientWidth || size.width * renderScale, height: canvasRef.current?.clientHeight || size.height * renderScale };
    const ids = layerDemandOrder(planes, currentCamera, paintPivot, available, selectedNode?.id);
    const groups = new Map(collapsedRecords.map(record => [record.id, record.node]));
    if (groupQueueContextRef.current?.root === root && groupQueueContextRef.current.src === src) {
      groupQueueRef.current?.update(ids.filter(id => groups.has(id) && !groupImages.has(id) && !savedGroupIds.has(id))
        .map(id => ({ key: id, value: groups.get(id)! })));
    }
    if (!renderer?.textureReady) return;
    const queue = textureQueueContextRef.current?.root === root && textureQueueContextRef.current.src === src ? textureQueueRef.current : null;
    queue?.update(ids.flatMap(id => {
      const demand = textureDemands.get(id);
      return demand && !renderer.layerTextures.has(demand.key) ? [{ key: `${demand.key}@${demand.maxPixels}`, value: demand }] : [];
    }));
    renderer.canvas.dataset.layerTextureBytes = String([...renderer.layerTextureBytes.values()].reduce((sum, bytes) => sum + bytes, 0));
    renderer.canvas.dataset.layerTextureCount = String(renderer.layerTextures.size);
    renderer.canvas.dataset.layerTexturePendingCount = String(queue?.pendingCount ?? 0);
    if ((queue?.pendingCount ?? 0) === 0) renderer.canvas.dataset.layerTextureVisibility = visibilityKey;
    else delete renderer.canvas.dataset.layerTextureVisibility;
  };

  fitRef.current = () => {
    const canvas = canvasRef.current;
    if (!onFitScale || !canvas?.clientWidth || !canvas.clientHeight) return;
    const currentCamera = cameraRef.current;
    const rotation = cameraRotation(currentCamera);
    const halfWidth = Math.max(1, viewport?.width ?? canvas.clientWidth) * 0.43, halfHeight = Math.max(1, viewport?.height ?? canvas.clientHeight) * 0.43;
    const distance = currentCamera.distance;
    let scale = 1;
    // Fit every actual corner, including Z, with a 7% margin on each side.
    // Solve the perspective inequality directly; no trial renders or zoom loop.
    for (const record of sceneRecords) {
      const b = record.renderBounds;
      for (const x of [b.left, b.right]) for (const y of [b.top, b.bottom]) {
        const p = rotatePoint(x, y, record.z, center, rotation);
        for (const [extent, half] of [[Math.abs(p.x), halfWidth], [Math.abs(p.y), halfHeight]]) {
          const denominator = distance * extent + half * p.depth;
          if (denominator > 0) scale = Math.min(scale, half * distance / denominator);
        }
        if (p.depth > 0) scale = Math.min(scale, (distance - 32) / p.depth);
      }
    }
    onFitScale(scale);
  };

  useEffect(() => {
    if (hoveredId && !pointerHoveredRecord) { setHoveredId(null); clearHover("canvas"); }
  }, [hoveredId, pointerHoveredRecord, clearHover]);

  useLayoutEffect(() => {
    hoverPointRef.current = null;
    setHoveredId(null);
    clearHover("canvas");
    return () => clearHover("canvas");
  }, [root, src, sessionKey, clearHover]);

  useEffect(() => {
    setGroupData({ root, src, images: new Map(savedGroups), requests: new Map() });
    if (!onCaptureGroup) return;
    const queue = new LayerDemandQueue<UiNode>(async (node, key, isActive) => {
      setGroupData(previous => previous.root === root && previous.src === src
        ? { ...previous, requests: new Map(previous.requests).set(key, "pending") } : previous);
      const image = await onCaptureGroup(node).catch(() => null);
      if (!isActive()) return;
      setGroupData(previous => {
        if (previous.root !== root || previous.src !== src) return previous;
        const requests = new Map(previous.requests), images = new Map(previous.images);
        if (image) { requests.delete(key); images.set(key, image); }
        else requests.set(key, "unavailable");
        return { ...previous, requests, images };
      });
    }, (_error, key) => setGroupData(previous => previous.root === root && previous.src === src
      ? { ...previous, requests: new Map(previous.requests).set(key, "unavailable") } : previous));
    groupQueueRef.current = queue;
    groupQueueContextRef.current = { root, src };
    drawRef.current();
    return () => { queue.dispose(); if (groupQueueRef.current === queue) { groupQueueRef.current = null; groupQueueContextRef.current = null; } };
  }, [root, src, onCaptureGroup, savedGroups]);

  const scenePlanes = useMemo(() => {
    // Each visible plane owns its pixels. A full-screen screenshot behind the
    // stack duplicates child content and reads like a reflected surface.
    const planes: ScenePlane[] = [];
    const addPlane = (record: LayerRecord, id: string, role: string | null, defaultOpacity: number) => {
      const group = groupImageFor(record, groupImages, hiddenNodeIds);
      const visual = role === "surface" ? visualFor(record, size, visibilityKey, group, nativeTextureKeys.get(record.id)) : null;
      let rect = scaledRect(record, renderScale, renderOrigin), source = visual?.source ?? sourceRect(record);
      let opacity = role === "surface" ? layerPlaneOpacity(record.node, record.isCollapsed, Boolean(group)) : defaultOpacity;
      const placement = record.isCollapsed ? undefined : record.node.layerCapturePlacement;
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
      planes.push({ id, node: record.hitTestable ? record.node : null, rect, source, textureSrc: visual?.textureSrc ?? null,
        textureSize: visual?.textureSize ?? size, z: record.z * renderScale, kind: record.isDeviceInvisible ? "invisible" : visual?.kind ?? "outline", opacity, hitTestable: record.hitTestable,
        deviceInvisible: record.isDeviceInvisible,
        quickSelect: { collapsed: record.isCollapsed && !record.isDeviceInvisible, screen: sourceRect(record) },
        // A node's empty own image does not prove its folded descendants have images.
        outlineRequired: role === "outline" && (record.isCollapsed || !record.node.layerImageEmpty) });
    };
    if (parent) {
      addPlane(parent, `${parent.id}:parent`, parentRole, 0.65);
    }
    for (const record of records) {
      const role = roles.get(record.id) ?? "outline";
      addPlane(record, record.id, role, record.isCompact ? 0.42 : 0.78);
    }
    for (const [record, kind] of [[selectedRecord, "selection"], [hoveredRecord?.isSelected ? null : hoveredRecord, "hover"]] as const) {
      if (!record) continue;
      const plane = planes.find(plane => plane.id === record.id || plane.id === `${record.id}:parent`)!;
      if (!plane) continue;
      planes.push({ ...plane, id: `${record.id}:${kind}`, node: null, kind, opacity: 1, hitTestable: false });
    }
    return planes;
  }, [hoveredRecord, parent, renderOrigin.left, renderOrigin.top, parentRole, records, renderScale, roles, selectedRecord, size, visibilityKey, groupImages, hiddenNodeIds, nativeTextureKeys]);

  const targetPresentation = useMemo(() => ({
    depths: new Map(scenePlanes.map(plane => [plane.id.replace(/:(parent|selection|hover)$/, ""), plane.z / renderScale])),
    center, pivot, scale: renderScale,
  }), [scenePlanes, center.x, center.y, center.z, pivot, renderScale]);

  function deleteLayerTexture(renderer: Renderer, key: string) {
    renderer.gl.deleteTexture(renderer.layerTextures.get(key) ?? null);
    renderer.layerTextures.delete(key);
    renderer.layerTextureBytes.delete(key);
    renderer.layerContentRects.delete(key);
    renderer.layerAlphaScans.delete(key);
    renderer.sourcePlanes = null;
  }

  function pruneTextures() {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const wanted = new Map([...textureDemandsRef.current.values()].map(demand => [demand.key, demand.maxPixels]));
    const retained = new Set(transitionRef.current ? paintedFrameRef.current?.planes.flatMap(plane => plane.textureSrc ? [plane.textureSrc] : []) : []);
    for (const [key, bytes] of renderer.layerTextureBytes) {
      const budget = wanted.get(key);
      if (budget !== undefined ? bytes <= budget * 4 : retained.has(key)) continue;
      deleteLayerTexture(renderer, key);
    }
  }

  function finishLayerMotion() {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    animationFrameRef.current = null; fallbackTimerRef.current = null;
    transitionRef.current = null;
  }

  function retiringReady(plane: ScenePlane) {
    const renderer = rendererRef.current;
    const id = layerPlaneNodeId(plane.id), targets = planesRef.current.filter(item => item.kind !== "selection" && item.kind !== "hover");
    let parentId: string | null | undefined = id;
    let parentPlane: ScenePlane | undefined;
    while (parentId && !parentPlane) {
      parentPlane = targets.find(item => layerPlaneNodeId(item.id) === parentId);
      if (!parentPlane) parentId = treeIndex.parents.get(parentId);
    }
    if (!parentPlane) return true;
    const loaded = (item: ScenePlane) => (item.kind !== "native" && item.kind !== "composite") || !item.textureSrc || Boolean(renderer?.layerTextures.has(item.textureSrc));
    if (parentId !== id || plane.kind !== "composite") return loaded(parentPlane);
    // The outgoing folded image covers children until their own images arrive.
    return targets.filter(item => {
      let ancestor: string | null | undefined = layerPlaneNodeId(item.id);
      while (ancestor && ancestor !== id) ancestor = treeIndex.parents.get(ancestor);
      return ancestor === id;
    }).every(loaded);
  }

  drawRef.current = () => {
    positionHoverLabel();
    const renderer = rendererRef.current;
    const currentCamera = cameraRef.current;
    if (!renderer) { scheduleRef.current(planesRef.current, pivot, currentCamera); return; }
    let transition = transitionRef.current;
    const progress = transition ? motionProgress(transition.started, performance.now()) : 1;
    if (transition && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishLayerMotion(); transition = null;
    }
    const target = { planes: planesRef.current, presentation: targetPresentation };
    let frame = transition ? sampleLayerMotion(transition, target, treeIndex.parents, progress, retiringReady) : target;
    if (transition && progress === 1 && !frame.planes.some(plane => plane.id.endsWith(":motion"))) {
      finishLayerMotion(); transition = null; frame = target;
    }
    const { planes: paintPlanes, presentation: { pivot: paintPivot, depths } } = frame;
    paintedFrameRef.current = frame;
    presentationRef.current = frame.presentation;
    renderer.canvas.dataset.layerAnimationProgress = transition ? progress.toFixed(3) : "1";
    renderer.canvas.dataset.layerRetiringCount = String(paintPlanes.filter(plane => plane.id.endsWith(":motion")).length);
    renderer.canvas.dataset.layerPaintedDepths = JSON.stringify([...depths]);
    drawScene(renderer, paintPlanes, currentCamera, paintPivot, projectedRef, appearance);
    positionQuickOutline();
    pruneTextures();
    scheduleRef.current(paintPlanes, paintPivot, currentCamera);
  };

  useLayoutEffect(() => {
    const previous = previousTreeRef.current;
    const sameTree = previous?.root === root && previous.src === src && previous.session === sessionKey && previous.visibility === visibilityKey && previous.showInvisible === appearance.showInvisible
      && previous.gap === camera.layerGap && previous.focusedId === (focusedNode?.id ?? null) && previous.focusKind === focusKind;
    const added = sameTree && [...expandedNodeIds].some(id => !previous.expanded.has(id));
    const removed = sameTree && [...previous.expanded].some(id => !expandedNodeIds.has(id));
    if (!sameTree || removed || added) {
      finishLayerMotion();
      if (sameTree && paintedFrameRef.current && (added || removed) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        transitionRef.current = { from: paintedFrameRef.current, started: performance.now() };
        fallbackTimerRef.current = setTimeout(() => { finishLayerMotion(); drawRef.current(); }, LAYER_MOTION_FALLBACK_LIMIT);
      }
    }
    previousTreeRef.current = { root, src, session: sessionKey, visibility: visibilityKey, showInvisible: appearance.showInvisible, expanded: expandedNodeIds, gap: camera.layerGap, focusedId: focusedNode?.id ?? null, focusKind };
    planesRef.current = scenePlanes;
    drawRef.current();
    // One short GPU repaint loop. No per-frame React state or texture decoding.
    const animate = () => {
      animationFrameRef.current = null;
      drawRef.current();
      if (transitionRef.current && rendererRef.current && Number(rendererRef.current.canvas.dataset.layerAnimationProgress) < 1) animationFrameRef.current = requestAnimationFrame(animate);
    };
    if (transitionRef.current && animationFrameRef.current === null) animationFrameRef.current = requestAnimationFrame(animate);
  }, [scenePlanes, root, src, sessionKey, visibilityKey, expandedNodeIds, camera.layerGap, focusedNode, focusKind, appearance]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => { if (preference.matches) { finishLayerMotion(); drawRef.current(); } };
    preference.addEventListener?.("change", changed);
    return () => { preference.removeEventListener?.("change", changed); finishLayerMotion(); };
  }, []);

  useEffect(() => {
    cameraRef.current = camera;
    sceneRef.current?.style.setProperty("transform", `translate3d(${camera.panX}px, ${camera.panY}px, 0)`);
    drawRef.current();
  }, [camera, viewport?.left, viewport?.top, viewport?.width, viewport?.height]);

  // Fit after updating the camera. Selection, hover, hiding and free rotation
  // do not change framing; isolation, a changed tree, spacing or viewport do.
  useEffect(() => { fitRef.current(); }, [expandedNodeIds, camera.layerGap, camera.distance, focusedNode, layout.candidateCount, size.width, size.height, center.x, center.y, center.z, viewport?.left, viewport?.top, viewport?.width, viewport?.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer(canvas);
    if (!renderer) {
      setRendererStatus("fallback");
      return;
    }
    let alive = true;
    rendererRef.current = renderer;
    const observer = new ResizeObserver(() => { fitRef.current(); drawRef.current(); });
    observer.observe(canvas);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      finishLayerMotion(); paintedFrameRef.current = null;
      projectedRef.current = [];
      rendererRef.current = null;
      if (alive) setRendererStatus("fallback");
    };
    const onContextRestored = () => setRendererGeneration(value => value + 1);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    return () => {
      alive = false;
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (rendererRef.current === renderer) rendererRef.current = null;
      disposeRenderer(renderer);
    };
  }, [rendererGeneration]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive || rendererRef.current !== renderer || !uploadTexture(renderer, image)) {
        if (alive) setRendererStatus("fallback");
        return;
      }
      setRendererStatus("webgl");
      drawRef.current();
    };
    image.onerror = () => { if (alive) setRendererStatus("fallback"); };
    image.src = src;
    return () => { alive = false; };
  }, [src, rendererGeneration]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let repaint: number | null = null;
    const paint = () => {
      if (repaint === null) repaint = requestAnimationFrame(() => { repaint = null; drawRef.current(); });
    };
    setTextureWarning(null);
    const queue = new LayerDemandQueue<TextureDemand>(async (demand, requestKey, isActive) => {
      const { key, record, group, clips, maxPixels } = demand;
      let image: ImageBitmap | HTMLCanvasElement | null = null;
      const current = () => isActive() && rendererRef.current === renderer && queue.hasDemand(requestKey);
      const load = async (node: UiNode) => {
        if (!current()) throw new Error("图层加载已取消");
        const bitmap = await loadLayerImage(node.layerImageDataUrl!);
        if (!current()) { bitmap.close(); throw new Error("图层加载已取消"); }
        return bitmap;
      };
      try {
        if (!current() || renderer.layerTextures.has(key)) return;
        image = record.isCollapsed
          ? group ? await loadLayerImage(group.dataUrl) : await composeSubtreeImage(record.node, sourceRect(record), load, maxPixels, demand.hidden)
          : await load(record.node);
        if (!record.isCollapsed) {
          const bitmap = image as ImageBitmap;
          try { image = clipLayerImageToOutlines(record.node, clips, bitmap); }
          finally { if (image !== bitmap) bitmap.close(); }
        }
        if (!current()) return "retry";
        // A fold temporarily retains already uploaded child pixels. Free them
        // only when the replacement upload needs the same bounded GPU budget.
        let bytes = [...renderer.layerTextureBytes.values()].reduce((sum, value) => sum + value, 0);
        const required = Math.min(maxPixels, image.width * image.height) * 4;
        const wantedKeys = new Set([...textureDemandsRef.current.values()].map(item => item.key));
        for (const [oldKey, oldBytes] of renderer.layerTextureBytes) {
          if (bytes + required <= MAX_LAYER_TEXTURE_PIXELS * 4) break;
          if (wantedKeys.has(oldKey)) continue;
          deleteLayerTexture(renderer, oldKey); bytes -= oldBytes;
        }
        const upload = uploadLayerTexture(renderer, key, image, maxPixels);
        if (upload === false) throw new Error("图层纹理上传失败");
        paint();
        if (upload.scan) {
          const texture = renderer.layerTextures.get(key);
          const scan = upload.scan(); renderer.layerAlphaScans.set(key, scan);
          const content = await scan;
          if (!isActive() || rendererRef.current !== renderer) return;
          // Folding can evict this texture during the sliced alpha scan. Its
          // reentered demand still needs a bitmap, even though loading finished.
          if (renderer.layerTextures.get(key) !== texture) return "retry";
          renderer.layerContentRects.set(key, content);
          renderer.sourcePlanes = null;
          paint();
        }
      } catch (error) {
        if (!current()) return "retry";
        setTextureWarning(error instanceof Error ? error.message : "部分图层未能加载");
      } finally {
        if (image instanceof ImageBitmap) image.close();
        else if (image) image.width = image.height = 0;
        if (isActive() && rendererRef.current === renderer) paint();
      }
    }, error => setTextureWarning(error instanceof Error ? error.message : "部分图层未能加载"));
    textureQueueRef.current = queue;
    textureQueueContextRef.current = { root, src };
    drawRef.current();
    return () => {
      queue.dispose(); if (textureQueueRef.current === queue) { textureQueueRef.current = null; textureQueueContextRef.current = null; }
      if (repaint !== null) cancelAnimationFrame(repaint);
    };
  }, [root, src, rendererGeneration]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    setTextureWarning(null);
    pruneTextures();
    drawRef.current();
  }, [textureKey, rendererGeneration]);

  function pickNode(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas || rendererStatus !== "webgl") return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return null;
    return projectedRef.current.find((plane) => pointInQuad(point, plane.corners)
      && (!plane.painted?.plane.deviceInvisible || pointNearQuadEdge(point, plane.corners)))?.node ?? null;
  }

  function quickSelectAt(clientX: number, clientY: number): QuickSelectResult {
    const canvas = canvasRef.current;
    if (!canvas || rendererStatus !== "webgl") return quickSelectMessage(quickContext, root, "no-plane", "3D 画面尚未就绪，请稍后再试。");
    const rect = canvas.getBoundingClientRect(), point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return quickSelectMessage(quickContext, root, "no-plane", "请点选一块已折叠的画面。");
    const projected = projectedRef.current.find(plane => plane.painted?.visible && pointInQuad(point, plane.corners)
      && (!plane.painted.plane.deviceInvisible || pointNearQuadEdge(point, plane.corners)));
    if (!projected) return quickSelectMessage(quickContext, root, "no-plane", "这个位置没有可选择的折叠平面。");
    const record = [parent, ...records].find(item => item?.node === projected.node);
    if (treeIndex.nodes.get(projected.node.id) !== projected.node || !record) return quickSelectMessage(quickContext, root, "stale", "页面已更新，请重新点选折叠画面。");
    if (!record.isCollapsed || !projected.painted?.plane.quickSelect?.collapsed) return quickSelectMessage(quickContext, root, "not-collapsed", "这层尚未折叠，请先收起分支，或直接选择已展开的控件。");
    if (projected.painted.kind !== "composite") return quickSelectMessage(quickContext, root, "missing-image", "这层只有边框，折叠画面尚未取得。请稍后重试，或从层级树展开选择。");
    const source = pointOnPaintedPlane(projected, point);
    if (!source) return quickSelectMessage(quickContext, root, "unsupported", "当前平面的角度或变换无法可靠映射，请调整视角后重试。");
    return findQuickSelectCandidates({ context: quickContext, root, branch: projected.node, point: source, hidden: hiddenNodeIds, focusedNode, focusKind, index: treeIndex });
  }

  function quickSelectPage(result: QuickSelectResult, page: number) {
    if (result.context !== quickContext || result.root !== root || !result.branch || !result.point) return quickSelectMessage(quickContext, root, "stale", "页面已更新，请重新点选折叠画面。");
    return findQuickSelectCandidates({ context: quickContext, root, branch: result.branch, point: result.point, hidden: hiddenNodeIds, focusedNode, focusKind, page, index: treeIndex });
  }

  function positionQuickOutline() {
    const svg = quickOutlineRef.current, preview = quickPreviewRef.current;
    if (!svg) return;
    const projected = preview?.result.context === quickContext
      ? projectedRef.current.find(plane => plane.node === preview.result.branch && plane.painted?.plane.quickSelect?.collapsed) : null;
    const points = projected && preview ? candidateOnPaintedPlane(projected, preview.candidate) : null;
    svg.style.visibility = points ? "visible" : "hidden";
    svg.dataset.quickSelectNodeId = points && preview ? preview.candidate.node.id : "";
    if (points) svg.querySelector("polygon")!.setAttribute("points", points.map(point => `${point.x},${point.y}`).join(" "));
  }

  useLayoutEffect(() => {
    quickPreviewRef.current = null;
    positionQuickOutline();
    return () => { quickPreviewRef.current = null; };
  }, [quickContext]);

  function positionHoverLabel() {
    const label = hoverLabelRef.current, canvas = canvasRef.current, point = hoverPointRef.current;
    if (!label || !canvas || !point) return;
    const rect = canvas.getBoundingClientRect();
    const viewport = canvas.closest(".screenshot-frame")?.getBoundingClientRect() ?? rect;
    const visibleViewport = viewportRef.current;
    const minX = Math.max(0, viewport.left - rect.left, (visibleViewport?.left ?? 0) - cameraRef.current.panX) + 8, minY = Math.max(0, viewport.top - rect.top, (visibleViewport?.top ?? 0) - cameraRef.current.panY) + 8;
    const maxX = Math.min(rect.width, viewport.right - rect.left, (visibleViewport ? visibleViewport.left + visibleViewport.width : rect.width) - cameraRef.current.panX) - label.offsetWidth - 8;
    const maxY = Math.min(rect.height, viewport.bottom - rect.top, (visibleViewport ? visibleViewport.top + visibleViewport.height : rect.height) - cameraRef.current.panY) - label.offsetHeight - 8;
    if (minX > maxX || minY > maxY) { label.style.visibility = "hidden"; return; }
    label.style.visibility = "visible";
    const x = point.x - rect.left, y = point.y - rect.top;
    label.style.transform = `translate(${Math.max(minX, Math.min(maxX, x + 14 > maxX ? x - label.offsetWidth - 14 : x + 14))}px, ${Math.max(minY, Math.min(maxY, y + 18 > maxY ? y - label.offsetHeight - 18 : y + 18))}px)`;
  }

  useImperativeHandle(ref, () => ({
    interruptMotion() { finishLayerMotion(); drawRef.current(); },
    paintCamera(next) {
      cameraRef.current = next;
      sceneRef.current?.style.setProperty("transform", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
      drawRef.current();
    },
    fit() { fitRef.current(); },
    pick: pickNode,
    quickSelectAt,
    quickSelectPage,
    previewQuickSelect(result, candidate) {
      quickPreviewRef.current = result?.context === quickContext && candidate && result.candidates.includes(candidate)
        && treeIndex.nodes.get(candidate.node.id) === candidate.node ? { result, candidate } : null;
      positionQuickOutline();
    },
    hover(clientX, clientY) {
      const nextId = pickNode(clientX, clientY)?.id ?? null;
      hoverPointRef.current = { x: clientX, y: clientY };
      positionHoverLabel();
      setHoveredId((current) => current === nextId ? current : nextId);
      publishHover(nextId, "canvas");
    },
    clearHover() {
      hoverPointRef.current = null;
      setHoveredId((current) => current ? null : current);
      clearHover("canvas");
    },
    toggleMeasurementPin,
    clearPinnedMeasurement,
    beginMeasurement,
    useSelectedMeasurementNode,
    startMeasurementMode,
    setTemporaryMeasurement,
  }), [rendererStatus, toggleMeasurementPin, clearPinnedMeasurement, beginMeasurement, useSelectedMeasurementNode, startMeasurementMode, setTemporaryMeasurement, publishHover, clearHover, quickContext, parent, records, treeIndex]);

  return (
    <div ref={sceneRef} className={`layer-scene layer-renderer-${rendererStatus}`} style={{ transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0)` }} data-view-mode="layers3d" data-layer-mode={focusedNode ? "focus" : "overview"} data-layer-focus-kind={focusedNode ? focusKind : ""} data-layer-focused-id={focusedNode?.id ?? ""} data-layer-parent-id={layout.parentId ?? ""} data-layer-hovered-id={visualHoveredId ?? ""} data-layer-hidden-count={hiddenNodeIds.size} data-layer-invisible-count={invisibleCount} data-layer-count={records.length + Number(Boolean(parent?.isCollapsed))} data-layer-texture-count={textureCount} data-layer-native-texture-count={nativeTextureCount} data-layer-composite-count={compositeCount} data-layer-root-composite={parent?.isCollapsed ? "true" : "false"} data-layer-text-only-count={textOnlyCount} data-layer-outline-count={outlineCount} data-layer-selection-count={Number(Boolean(selectedRecord))} data-layer-candidate-count={layout.candidateCount} data-layer-truncated={layout.truncated ? "true" : "false"} data-layer-omitted-count={layout.omittedCount} data-layer-pivot-x={pivot.x.toFixed(2)} data-layer-pivot-y={pivot.y.toFixed(2)} data-layer-pivot-z={pivot.z.toFixed(2)} aria-label="WebGL 3D hierarchy layers">
      <canvas ref={canvasRef} className="layer-webgl-canvas" data-layer-webgl="true" data-layer-renderer={rendererStatus} aria-hidden="true" />
      <svg ref={quickOutlineRef} className="layer-quick-select-outline" aria-hidden="true" style={{ visibility: "hidden" }}><polygon /></svg>
      {hoveredRecord && sharedHover?.source !== "tree" && rendererStatus === "webgl" && <div ref={hoverLabelRef} className={`layer-hover-label${hoveredRecord.isSelected ? " is-selected" : ""}`} role="tooltip" data-node-id={hoveredRecord.id}>
        <div><span>{hoveredRecord.isSelected ? "已选中" : "指向"}</span><strong title={nodeDisplayLabel(hoveredRecord.node)}>{nodeDisplayLabel(hoveredRecord.node)}</strong></div>
        <code title={hoveredRecord.node.className ?? undefined}>{nodeShortClass(hoveredRecord.node)} · {hoveredRecord.node.resourceId?.replace(/^.*:id\//, "@id/") || `#${hoveredRecord.id}`}</code>
        {hoveredImagePresentation && <small data-layer-image-hint="hover">{hoveredImagePresentation.label} · {hoveredImagePresentation.detail}</small>}
      </div>}
      {isPinned && measurement && <span className="layer-measurement-status" role="status"
        data-measure-anchor={measureAnchor!.id} data-measure-target={measureTarget!.id} data-measure-relation={measurement.relation} data-measure-pinned="true">
        测距已固定：{summary}。按原始外框测量，不含 3D 展开层距。
      </span>}
      {rendererStatus === "fallback" && <span className="layer-webgl-fallback">{focusedNode ? "WebGL 不可用，请退出聚焦查看截图。" : "WebGL 不可用，已回退到截图预览。"}</span>}
      {(invisibleCount > 0 || selectedImagePresentation || layout.truncated || textureWarning || shownGroupImages.length > 0 || localCompositeCount > 0) && <span className="layer-resource-note" role="status">{[
        invisibleCount ? `${invisibleCount} 个不可见控件仅显示虚线边界` : null,
        selectedImagePresentation ? `${nodeDisplayLabel(selectedRecord!.node)}：${selectedImagePresentation.label}。${selectedImagePresentation.detail}` : null,
        textureWarning,
        layout.truncated ? `当前显示 ${records.length} 层，另有 ${layout.omittedCount} 层未显示` : null,
        localCompositeCount ? "部分折叠画面使用本地重建，不保证与原生整组图逐像素一致" : null,
        collapsedRecords.some(record => groupRequestStates.get(record.id) === "pending") ? "正在读取原生整组图" : null,
        collapsedRecords.some(record => groupRequestStates.get(record.id) === "unavailable") ? "原生整组图未取得，保留本地重建（原因未返回）" : null,
        shownGroupImages.map(image => savedImages.has(image)
          ? `折叠画面采集于 ${new Date(image.capturedAt).toLocaleString()}（已保存），不与原快照保证同帧`
          : `折叠画面实时采集于 ${new Date(image.capturedAt).toLocaleTimeString()}，不与原快照保证同帧`).at(-1),
      ].filter(Boolean).join(" · ")}</span>}
      <div className="layer-scene-metadata" hidden aria-hidden="true">
        {records.map((record) => {
          const role = roles.get(record.id) ?? "outline";
          const textOnly = role === "surface" && usesTextOnlyTexture(record);
          const textureIdentity = role === "surface" && !record.isCollapsed ? nativeTextureKeys.get(record.id) : undefined;
          const provenance = provenanceFor(record);
          return <button data-layer-image-source={role === "surface" ? provenance.source : "none"} data-layer-group-state={provenance.groupState} data-layer-texture-identity={textureIdentity} className={`layer-plane ${role} ${record.isSelected ? "selected" : ""}`} data-layer-node-id={record.id} data-layer-device-invisible={record.isDeviceInvisible ? "true" : "false"} data-layer-depth={record.depth} data-layer-z={record.z} data-layer-z-order={record.zOrder} data-layer-z-order-source={record.zOrderSource} data-layer-selected={record.isSelected ? "true" : "false"} data-layer-role={role} data-layer-texture={role === "surface" ? "true" : "false"} data-layer-texture-mode={role === "surface" ? (record.isCollapsed ? "composite" : record.node.layerImageDataUrl ? "native" : "isolated") : "none"} data-layer-content={textOnly ? "text" : role === "surface" ? "control" : "structure"} data-layer-expanded-parent={record.node.children.length > 0 && !record.isCollapsed ? "true" : "false"} data-layer-focus={record.isSelected ? "true" : "false"} data-layer-hit-testable={record.hitTestable ? "true" : "false"} key={record.id} type="button" tabIndex={-1} onClick={() => onSelect(record.node)} />;
        })}
      </div>
    </div>
  );
});

Layer3DPreview.displayName = "Layer3DPreview";
