import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PixelSize, QmlGroupImage, SnapshotGroupImage, UiNode } from "../../../shared/types";
import { type LayerRecord } from "../../../shared/layer-layout";
import { nodeDisplayLabel, nodeShortClass } from "../../../shared/tree-utils";
import { layerImageProvenance, layerImagePresentation } from "../../../shared/layer-image-provenance";
import { nodePresentationStatus } from "../../../shared/node-presentation-status";
import { nodeCaptureFacts } from "../../../shared/node-capture-facts";
import { emptyLayerIds } from "../../../shared/empty-layers";
import { deferredLayerIds } from "../../../shared/deferred-layers";
import { type Rect, type LayerCamera, type LayerSceneHandle, type LayerMeasurementState, type Point } from "./types";
import { indexLayerTree, subtreeHasHidden, groupImageFor, hasOwnVisualStyle, outlineAncestors, nativeTextureKey, textureImageVersions, subtreeTextureVersions, collapsedTextureKey, layerPlaneRoles, usesTextOnlyTexture, visualFor } from "./presentation";
import { pickProjectedPlane } from "./projection";
import { redundantStructureOutlines } from "../../../shared/layer-structure";
import { type LayerFramingScope } from "./framing";
import { sceneCameraDistance, fitSceneScale } from "./scene-camera";
import { DEFAULT_LAYER_APPEARANCE, type LayerAppearance, type LayerDisplayMode } from "./appearance";
import { useLayerMeasurement, type LayerMeasurementController } from "./useLayerMeasurement";
import { resolveVisibleHoverId } from "../../../shared/node-hover";
import { useNodeHover } from "../inspection/NodeHoverContext";
import { candidateOnPaintedPlane, filterQuickSelectResult, findQuickSelectCandidates, pointOnPaintedPlane, quickSelectMessage, type QuickSelectCandidate, type QuickSelectResult } from "./quick-select";
import { findPositionCandidates } from "./position-select";
import { buildSceneLayout, overflowSceneSelection, buildBaseScenePlanes, buildSceneHighlights, buildSceneFraming, buildScenePresentation, deferredGroupCandidates } from "./scene-model";
import { MAX_LAYER_TEXTURE_PIXELS } from "./scene-texture-runtime";
import { useLayerSceneRuntime } from "./useLayerSceneRuntime";


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
  displayMode?: LayerDisplayMode;
  framingScope?: LayerFramingScope;
  onSelect: (node: UiNode) => void;
  onCaptureGroup?: (node: UiNode) => Promise<QmlGroupImage | null>;
  savedGroupImages?: readonly SnapshotGroupImage[];
  cachedGroupImages?: readonly SnapshotGroupImage[];
  initialFitNeeded?: boolean;
  fitViewportRef?: RefObject<Rect | null>;
  onFitScale?: (scale: number) => void;
  onMeasurementStateChange?: (state: LayerMeasurementState) => void;
  measurementController?: LayerMeasurementController;
};
const NO_HIDDEN_NODES: ReadonlySet<string> = new Set();
const NO_SAVED_GROUPS: readonly SnapshotGroupImage[] = [];

export const Layer3DPreview = forwardRef<LayerSceneHandle, Props>(function Layer3DPreview({ sessionKey, src, root, selectedNode, expandedNodeIds, hiddenNodeIds = NO_HIDDEN_NODES, focusedNode = null, focusKind = "layer", size, renderScale, origin, viewport, camera, appearance = DEFAULT_LAYER_APPEARANCE, displayMode = "images", framingScope = "screen", onSelect, onCaptureGroup, savedGroupImages = NO_SAVED_GROUPS, cachedGroupImages = NO_SAVED_GROUPS, initialFitNeeded = true, fitViewportRef, onFitScale, onMeasurementStateChange, measurementController }, ref) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const quickOutlineRef = useRef<SVGSVGElement>(null);
  const quickPreviewRef = useRef<{ result: QuickSelectResult; candidate: QuickSelectCandidate } | null>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { hover: sharedHover, publishHover, clearHover } = useNodeHover();
  // Completed in-memory images survive live-policy changes; only saved images
  // receive the saved-snapshot provenance label below.
  const savedGroups = useMemo(() => new Map([...savedGroupImages, ...cachedGroupImages].map(group => [group.nodeId, group.image])), [savedGroupImages, cachedGroupImages]);
  const initialResize = useRef(true);
  const { runtime, status: rendererStatus, warning: textureWarning, groups: groupData } = useLayerSceneRuntime(canvasRef,
    { root, src, sessionKey, capture: onCaptureGroup, savedGroups }, {
      painted() { positionHoverLabel(); positionQuickOutline(); },
      resized() {
        if (!viewportRef.current && (!initialResize.current || initialFitNeeded)) fitRef.current();
        initialResize.current = false;
      },
    });
  const groupContextMatches = groupData.context.root === root && groupData.context.src === src && groupData.context.sessionKey === sessionKey
    && groupData.context.capture === onCaptureGroup && groupData.context.savedGroups === savedGroups;
  const groupImages = groupContextMatches ? groupData.images : savedGroups;
  // Focus can expose a clipped branch without changing the saved preference.
  const showOffscreen = appearance.showOffscreen || Boolean(focusedNode);
  const emptyNodeIds = useMemo(() => emptyLayerIds(root, expandedNodeIds, new Set(groupImages.keys())), [root, expandedNodeIds, groupImages]);
  const emptyVisibilityKey = useMemo(() => appearance.showEmpty ? "[]" : JSON.stringify([...emptyNodeIds].sort()), [appearance.showEmpty, emptyNodeIds]);
  const deferredNodeIds = useMemo(() => deferredLayerIds(root, expandedNodeIds, new Set(groupImages.keys()), hiddenNodeIds, showOffscreen), [root, expandedNodeIds, groupImages, hiddenNodeIds, showOffscreen]);
  const showDeferredStructure = appearance.showEmpty && appearance.structureMode === "complete";
  const deferredVisibilityKey = useMemo(() => showDeferredStructure ? "[]" : JSON.stringify([...deferredNodeIds].sort()), [showDeferredStructure, deferredNodeIds]);
  // Stable membership prevents a late group image from rebuilding unchanged
  // geometry. This is a canvas filter; manual hiding and the tree stay separate.
  const layoutHiddenIds = useMemo(() => new Set<string>([...hiddenNodeIds, ...(JSON.parse(emptyVisibilityKey) as string[]),
    ...(JSON.parse(deferredVisibilityKey) as string[])]), [hiddenNodeIds, emptyVisibilityKey, deferredVisibilityKey]);
  const selectedEmptyHidden = Boolean(selectedNode && !appearance.showEmpty && emptyNodeIds.has(selectedNode.id) && !hiddenNodeIds.has(selectedNode.id));
  const selectedDeferredHidden = Boolean(selectedNode && !showDeferredStructure && deferredNodeIds.has(selectedNode.id) && !hiddenNodeIds.has(selectedNode.id));
  const groupRequestStates = groupContextMatches ? groupData.requests : new Map();
  const savedImages = useMemo(() => new Set(savedGroupImages.map(group => group.image)), [savedGroupImages]);
  const treeIndex = useMemo(() => indexLayerTree(root), [root]);
  const geometryRevision = useRef(0);
  const buildLayout = useMemo(() => (selection: UiNode | null) => {
    geometryRevision.current++;
    return buildSceneLayout({ root, size, expandedNodeIds, layoutHiddenIds, focusedNode, focusKind,
      layerGap: camera.layerGap, showInvisible: appearance.showInvisible, showOffscreen, structureMode: appearance.structureMode }, selection);
  }, [camera.layerGap, expandedNodeIds, focusedNode, focusKind, root, size.width, size.height, appearance.showInvisible, showOffscreen, appearance.structureMode, layoutHiddenIds]);
  const baseLayout = useMemo(() => buildLayout(null), [buildLayout]);
  // The cap retains an out-of-range selected control. Ordinary selection and
  // hover never rerun overlap packing or change the camera's geometry.
  const overflowSelection = overflowSceneSelection(baseLayout, selectedNode);
  const layout = useMemo(() => overflowSelection ? buildLayout(overflowSelection) : baseLayout, [baseLayout, buildLayout, overflowSelection]);
  // The layout excludes hidden planes before assigning depth; children and the captured tree remain intact.
  const records = useMemo(() => layout.records.filter((record) => !hiddenNodeIds.has(record.id)), [layout.records, hiddenNodeIds]);
  const parent = layout.parent && !hiddenNodeIds.has(layout.parent.id) ? layout.parent : null;
  const visibilityKey = useMemo(() => JSON.stringify([...hiddenNodeIds].sort()), [hiddenNodeIds]);
  const quickContext = useMemo(() => ({}), [root, src, sessionKey, visibilityKey, emptyVisibilityKey, deferredVisibilityKey, expandedNodeIds, focusedNode, focusKind, appearance.showInvisible, showOffscreen, framingScope, displayMode, appearance.structureMode]);
  const collapsedRecords = [parent, ...records].filter((record): record is LayerRecord => Boolean(record?.isCollapsed && !record.isDeviceInvisible && !subtreeHasHidden(record.node, hiddenNodeIds)
    && (record.node.attributes?.["inspection-source"] === "debug-qml" || root.attributes?.["tree-source"] === "debug-sdk")));
  const pendingGroups = useMemo(() => deferredGroupCandidates({ root, size, expandedNodeIds, focusedNode, focusKind, showOffscreen },
    deferredNodeIds, hiddenNodeIds, selectedNode?.id), [root, size, expandedNodeIds, focusedNode, focusKind, showOffscreen, deferredNodeIds, hiddenNodeIds, selectedNode?.id]);
  const groupCandidates = new Map([...collapsedRecords.map(record => [record.id, record.node] as const), ...pendingGroups.map(node => [node.id, node] as const)]);
  const shownGroupImages = collapsedRecords.map(record => groupImageFor(record, groupImages, hiddenNodeIds)).filter((image): image is QmlGroupImage => Boolean(image));
  const textureRecords = useMemo(() => [parent, ...records].filter((record): record is LayerRecord => Boolean(record && !record.isDeviceInvisible && hasOwnVisualStyle(record, size, hiddenNodeIds, groupImages) && (record.isCollapsed || record.node.layerImageDataUrl))), [groupImages, hiddenNodeIds, parent, records, size]);
  // Full-layout inspection exposes each own image outside its ancestors. Keep
  // the View's own outline, and keep normal clipping inside folded composites.
  const nativeLayerClips = useMemo(() => new Map(textureRecords.filter(record => !record.isCollapsed).map(record => [record.id,
    outlineAncestors(record, treeIndex).filter(node => !showOffscreen || node.id === record.id)])), [textureRecords, treeIndex, showOffscreen]);
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
  const selectedRecord = records.find((record) => record.id === selectedNode?.id) ?? (parent?.id === selectedNode?.id ? parent : null);
  const pointerHoveredRecord = records.find((record) => record.id === hoveredId) ?? (parent?.id === hoveredId ? parent : null);
  const visibleHoverIds = useMemo(() => new Set([...records.map(record => record.id), ...(parent ? [parent.id] : [])]), [records, parent]);
  const visualHoveredId = sharedHover?.source === "tree"
    ? resolveVisibleHoverId(sharedHover.nodeId, visibleHoverIds, treeIndex.parents, layoutHiddenIds) : hoveredId;
  const hoveredRecord = records.find(record => record.id === visualHoveredId) ?? (parent?.id === visualHoveredId ? parent : null);
  const treeMeasureHover = sharedHover?.source === "tree" ? records.find(record => record.id === sharedHover.nodeId) ?? (parent?.id === sharedHover.nodeId ? parent : null) : pointerHoveredRecord;
  const localMeasurement = useLayerMeasurement({
    context: sessionKey ?? root, src, records: (parent ? [parent, ...records] : records).filter(record => !record.isDeviceInvisible),
    selected: selectedRecord && selectedRecord.id === selectedNode?.id && !selectedRecord.isDeviceInvisible ? selectedRecord : null,
    hovered: treeMeasureHover?.isDeviceInvisible ? null : treeMeasureHover, ready: !measurementController && rendererStatus === "webgl", onChange: onMeasurementStateChange,
  });
  const { anchor: measureAnchor, target: measureTarget, measurement, isPinned, summary, toggleMeasurementPin, clearPinnedMeasurement, beginMeasurement, useSelectedMeasurementNode, startMeasurementMode, setTemporaryMeasurement } = measurementController ?? localMeasurement;
  const parentRole = parent ? (!parent.isDeviceInvisible && hasOwnVisualStyle(parent, size, hiddenNodeIds, groupImages) ? "surface" : "outline") : null;
  const provenanceFor = (record: LayerRecord) => {
    const provenance = layerImageProvenance({ collapsed: record.isCollapsed,
      hasGroup: Boolean(groupImageFor(record, groupImages, hiddenNodeIds)), hiddenDescendants: subtreeHasHidden(record.node, hiddenNodeIds),
      canRequestGroup: Boolean(onCaptureGroup && groupCandidates.has(record.id)),
      requestState: groupRequestStates.get(record.id), ownSource: nodeCaptureFacts(record.node).captureSource });
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
  const { frames: framingFrames, center, renderOrigin, pivot } = useMemo(() => buildSceneFraming(layout,
    { size, focusedNode, framingScope, origin, renderScale }), [layout, size, focusedNode, framingScope, origin.left, origin.top, renderScale]);

  const textureDemands = new Map(textureRecords.map(record => {
    const group = groupImageFor(record, groupImages, hiddenNodeIds);
    const key = record.isCollapsed ? collapsedTextureKey(record, visibilityKey, group) : nativeTextureKeys.get(record.id)!;
    return [record.id, { key, record, group, clips: nativeLayerClips.get(record.id) ?? [], hidden: hiddenNodeIds,
      maxPixels: Math.min(2_000_000, Math.floor(MAX_LAYER_TEXTURE_PIXELS / Math.max(1, textureRecords.length))) }];
  }));
  fitRef.current = () => {
    const canvas = canvasRef.current;
    if (!onFitScale || !canvas?.clientWidth || !canvas.clientHeight) return;
    const currentCamera = cameraRef.current;
    const distance = sceneCameraDistance(currentCamera, size, framingFrames, center);
    onFitScale(fitSceneScale(framingFrames, center, currentCamera, distance, viewport?.width ?? canvas.clientWidth, viewport?.height ?? canvas.clientHeight));
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

  const suppressedOutlines = useMemo(() => appearance.structureMode === "complete" ? new Set<string>()
    : redundantStructureOutlines([parent, ...records].filter((record): record is LayerRecord => Boolean(record))), [appearance.structureMode, parent, records]);
  const baseScenePlanes = useMemo(() => {
    const visuals = new Map<string, ReturnType<typeof visualFor> | null>(), groupNodeIds = new Set<string>();
    for (const record of [parent, ...records].filter((record): record is LayerRecord => Boolean(record))) {
      const group = groupImageFor(record, groupImages, hiddenNodeIds);
      if (group) groupNodeIds.add(record.id);
      const role = record === parent ? parentRole : roles.get(record.id);
      visuals.set(record.id, role === "surface" ? visualFor(record, size, visibilityKey, group, nativeTextureKeys.get(record.id)) : null);
    }
    return buildBaseScenePlanes({ parent, records, parentRole, roles, visuals, groupNodeIds, size,
      renderScale, renderOrigin, suppressedOutlines, showOffscreen });
  }, [parent, renderOrigin.left, renderOrigin.top, parentRole, records, renderScale, roles, size, visibilityKey, groupImages, hiddenNodeIds, nativeTextureKeys, suppressedOutlines, showOffscreen]);
  const scenePlanes = useMemo(() => buildSceneHighlights(baseScenePlanes, { selectedRecord, hoveredRecord, selectedNodeId: selectedNode?.id }),
    [baseScenePlanes, selectedRecord, hoveredRecord, selectedNode?.id]);
  const targetPresentation = useMemo(() => buildScenePresentation(scenePlanes, { center, pivot, renderScale }),
    [scenePlanes, center.x, center.y, center.z, pivot, renderScale]);
  const motionContext = useMemo(() => ({}), [root, src, sessionKey, visibilityKey, appearance.showEmpty,
    appearance.showInvisible, showOffscreen, appearance.structureMode, camera.layerGap, focusedNode?.id, focusKind]);
  useLayoutEffect(() => {
    const scene = runtime.current;
    if (!scene) return;
    scene.setDemand({ textures: textureDemands, groups: groupCandidates, pendingGroupIds: pendingGroups.map(node => node.id),
      selectedId: selectedNode?.id, visibility: visibilityKey, viewport: viewportRef.current ?? { left: 0, top: 0,
        width: canvasRef.current?.clientWidth || size.width * renderScale, height: canvasRef.current?.clientHeight || size.height * renderScale } });
    scene.setFrame({ target: { planes: scenePlanes, presentation: targetPresentation }, motionContext, expanded: expandedNodeIds,
      parents: treeIndex.parents, size, framingFrames, appearance, displayMode }, cameraRef.current);
    scene.draw();
  });
  useEffect(() => { runtime.current?.clearWarning(); }, [textureKey]);

  useEffect(() => {
    cameraRef.current = camera;
    sceneRef.current?.style.setProperty("transform", `translate3d(${camera.panX}px, ${camera.panY}px, 0)`);
    runtime.current?.paintCamera(camera);
  }, [camera, viewport?.left, viewport?.top, viewport?.width, viewport?.height]);

  // Re-entering 3D retains the previous framing. Late image arrivals and
  // selection do not reset a view the user has already positioned.
  const firstFit = useRef(true);
  useEffect(() => {
    const skip = firstFit.current && !initialFitNeeded;
    firstFit.current = false;
    if (!skip) fitRef.current();
  }, [src, sessionKey, expandedNodeIds, camera.layerGap, camera.distance, focusedNode, appearance.showInvisible, framingScope,
    size.width, size.height]);

  const localFitViewport = useRef<Rect | null>(null);
  const lastFitViewport = fitViewportRef ?? localFitViewport;
  const firstViewport = useRef(true);
  useEffect(() => {
    if (!viewport) return;
    if (firstViewport.current) {
      firstViewport.current = false;
      // The first render after returning from 2D may still contain its scrollable
      // viewport. Compare the settled 3D area with the previous 3D area instead.
      if (initialFitNeeded) lastFitViewport.current = viewport;
      return;
    }
    const previous = lastFitViewport.current;
    if (previous && previous.left === viewport.left && previous.top === viewport.top
      && previous.width === viewport.width && previous.height === viewport.height) return;
    lastFitViewport.current = viewport;
    fitRef.current();
  }, [viewport?.left, viewport?.top, viewport?.width, viewport?.height]);

  function paintedProjection() { return runtime.current?.painted?.projected ?? []; }

  function pickNode(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas || rendererStatus !== "webgl") return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return null;
    return pickProjectedPlane(point, paintedProjection())?.node ?? null;
  }

  function quickSelectAt(clientX: number, clientY: number): QuickSelectResult {
    const canvas = canvasRef.current;
    if (!canvas || rendererStatus !== "webgl") return quickSelectMessage(quickContext, root, "no-plane", "3D 画面尚未就绪，请稍后再试。");
    const rect = canvas.getBoundingClientRect(), point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return quickSelectMessage(quickContext, root, "no-plane", "请点选一块已折叠的画面。");
    const projected = pickProjectedPlane(point, paintedProjection());
    if (!projected) return quickSelectMessage(quickContext, root, "no-plane", "这个位置没有可选择的折叠平面。");
    const record = [parent, ...records].find(item => item?.node === projected.node);
    if (treeIndex.nodes.get(projected.node.id) !== projected.node || !record) return quickSelectMessage(quickContext, root, "stale", "页面已更新，请重新点选折叠画面。");
    if (!record.isCollapsed || !projected.painted?.plane.quickSelect?.collapsed) return quickSelectMessage(quickContext, root, "not-collapsed", "这层尚未折叠，请先收起分支，或直接选择已展开的控件。");
    if (projected.painted.kind !== "composite") return quickSelectMessage(quickContext, root, "missing-image", displayMode === "wireframe" ? "仅边框模式不显示折叠画面，请切回图片，或从层级树展开选择。" : "这层只有边框，折叠画面尚未取得。请稍后重试，或从层级树展开选择。");
    const source = pointOnPaintedPlane(projected, point);
    if (!source) return quickSelectMessage(quickContext, root, "unsupported", "当前平面的角度或变换无法可靠映射，请调整视角后重试。");
    return findQuickSelectCandidates({ context: quickContext, root, branch: projected.node, point: source, hidden: hiddenNodeIds, focusedNode, focusKind, index: treeIndex });
  }

  function layersAt(clientX: number, clientY: number): QuickSelectResult {
    const canvas = canvasRef.current;
    const unavailable = () => ({ ...quickSelectMessage(quickContext, root, "no-plane", "3D 画面尚未就绪，请稍后再试。"), scope: "position" as const });
    if (!canvas || rendererStatus !== "webgl") return unavailable();
    const rect = canvas.getBoundingClientRect(), point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return unavailable();
    return findPositionCandidates(quickContext, root, point, paintedProjection(), treeIndex);
  }

  function quickSelectPage(result: QuickSelectResult, page: number) {
    if (result.context !== quickContext || result.root !== root || result.scope !== "position" && (!result.branch || !result.point)) return quickSelectMessage(quickContext, root, "stale", "页面已更新，请重新点选画布。");
    return filterQuickSelectResult(result, result.query ?? "", page);
  }

  function positionQuickOutline() {
    const svg = quickOutlineRef.current, preview = quickPreviewRef.current;
    if (!svg) return;
    if (preview?.result.context === quickContext && preview.result.scope === "position") {
      const matches = paintedProjection().filter(plane => plane.node === preview.candidate.node);
      const plane = matches.find(p => p.painted?.plane.hitPolicy === "edge") ?? matches[0];
      svg.style.visibility = plane ? "visible" : "hidden";
      svg.dataset.quickSelectNodeId = plane ? preview.candidate.node.id : "";
      if (plane) svg.querySelector("polygon")!.setAttribute("points", plane.corners.map(p => `${p.x},${p.y}`).join(" "));
      return;
    }
    const projected = preview?.result.context === quickContext
      ? paintedProjection().find(plane => plane.node === preview.result.branch && plane.painted?.plane.quickSelect?.collapsed) : null;
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
    interruptMotion() { runtime.current?.interruptMotion(); },
    paintCamera(next) {
      cameraRef.current = next;
      sceneRef.current?.style.setProperty("transform", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
      runtime.current?.paintCamera(next);
    },
    fit() { fitRef.current(); },
    pick: pickNode,
    quickSelectAt,
    layersAt,
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
  }), [rendererStatus, toggleMeasurementPin, clearPinnedMeasurement, beginMeasurement, useSelectedMeasurementNode, startMeasurementMode, setTemporaryMeasurement, publishHover, clearHover, quickContext, parent, records, treeIndex, displayMode]);

  return (
    <div ref={sceneRef} className={`layer-scene layer-renderer-${rendererStatus}`} style={{ transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0)` }} data-view-mode="layers3d" data-layer-framing-scope={focusedNode ? "focus" : framingScope} data-layer-display-mode={displayMode} data-layer-geometry-revision={geometryRevision.current} data-layer-structure-mode={appearance.structureMode} data-layer-show-empty={appearance.showEmpty ? "true" : "false"} data-layer-suppressed-outline-count={suppressedOutlines.size} data-layer-mode={focusedNode ? "focus" : "overview"} data-layer-focus-kind={focusedNode ? focusKind : ""} data-layer-focused-id={focusedNode?.id ?? ""} data-layer-parent-id={layout.parentId ?? ""} data-layer-hovered-id={visualHoveredId ?? ""} data-layer-hidden-count={hiddenNodeIds.size} data-layer-invisible-count={invisibleCount} data-layer-count={records.length + Number(Boolean(parent?.isCollapsed))} data-layer-texture-count={textureCount} data-layer-native-texture-count={nativeTextureCount} data-layer-composite-count={compositeCount} data-layer-root-composite={parent?.isCollapsed ? "true" : "false"} data-layer-text-only-count={textOnlyCount} data-layer-outline-count={outlineCount} data-layer-selection-count={Number(Boolean(selectedRecord))} data-layer-candidate-count={layout.candidateCount} data-layer-truncated={layout.truncated ? "true" : "false"} data-layer-omitted-count={layout.omittedCount} data-layer-pivot-x={pivot.x.toFixed(2)} data-layer-pivot-y={pivot.y.toFixed(2)} data-layer-pivot-z={pivot.z.toFixed(2)} aria-label="WebGL 3D hierarchy layers">
      <canvas ref={canvasRef} className="layer-webgl-canvas" data-layer-webgl="true" data-layer-renderer={rendererStatus} aria-hidden="true" />
      <svg ref={quickOutlineRef} className="layer-quick-select-outline" aria-hidden="true" style={{ visibility: "hidden" }}><polygon /></svg>
      {hoveredRecord && sharedHover?.source !== "tree" && rendererStatus === "webgl" && <div ref={hoverLabelRef} className={`layer-hover-label${(hoveredRecord.id === selectedNode?.id) ? " is-selected" : ""}`} role="tooltip" data-node-id={hoveredRecord.id}>
        <div><span>{(hoveredRecord.id === selectedNode?.id) ? "已选中" : "指向"}</span><strong title={nodeDisplayLabel(hoveredRecord.node)}>{nodeDisplayLabel(hoveredRecord.node)}</strong></div>
        <code title={hoveredRecord.node.className ?? undefined}>{nodeShortClass(hoveredRecord.node)} · {hoveredRecord.node.resourceId?.replace(/^.*:id\//, "@id/") || `#${hoveredRecord.id}`}</code>
        {hoveredImagePresentation && <small data-layer-image-hint="hover">{hoveredImagePresentation.label} · {hoveredImagePresentation.detail}</small>}
      </div>}
      {!measurementController && isPinned && measurement && <span className="layer-measurement-status" role="status"
        data-measure-anchor={measureAnchor!.id} data-measure-target={measureTarget!.id} data-measure-relation={measurement.relation} data-measure-pinned="true">
        测距已固定：{summary}。按原始外框测量，不含 3D 展开层距。
      </span>}
      {rendererStatus === "fallback" && <span className="layer-webgl-fallback">{focusedNode ? "WebGL 不可用，请退出聚焦查看截图。" : "WebGL 不可用，已回退到截图预览。"}</span>}
      {(displayMode === "wireframe" || invisibleCount > 0 || selectedEmptyHidden || selectedDeferredHidden || selectedImagePresentation || layout.truncated || textureWarning || shownGroupImages.length > 0 || localCompositeCount > 0) && <span className="layer-resource-note" role="status">{[
        selectedEmptyHidden ? "所选控件为空图层，已从画布隐藏；可在 3D 设置中开启“显示空图层”查看边界" : null,
        selectedDeferredHidden ? "所选控件的独立画面尚未读取；读取后显示，也可开启完整结构查看边界" : null,
        displayMode === "wireframe" ? "仅边框：只显示当前平面边界；折叠分支保留父平面，内部空白不参与点选" : null,
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
          return <button data-layer-image-source={role === "surface" ? provenance.source : "none"} data-layer-group-state={provenance.groupState} data-layer-texture-identity={textureIdentity} className={`layer-plane ${role} ${(record.id === selectedNode?.id) ? "selected" : ""}`} data-layer-outline-suppressed={suppressedOutlines.has(record.id) ? "true" : "false"} data-layer-node-id={record.id} data-layer-device-invisible={record.isDeviceInvisible ? "true" : "false"} data-layer-depth={record.depth} data-layer-z={record.z} data-layer-z-order={record.zOrder} data-layer-z-order-source={record.zOrderSource} data-layer-selected={(record.id === selectedNode?.id) ? "true" : "false"} data-layer-role={role} data-layer-texture={role === "surface" ? "true" : "false"} data-layer-texture-mode={role === "surface" ? (record.isCollapsed ? "composite" : record.node.layerImageDataUrl ? "native" : "isolated") : "none"} data-layer-content={textOnly ? "text" : role === "surface" ? "control" : "structure"} data-layer-expanded-parent={record.node.children.length > 0 && !record.isCollapsed ? "true" : "false"} data-layer-focus={(record.id === selectedNode?.id) ? "true" : "false"} data-layer-hit-testable={record.hitTestable ? "true" : "false"} key={record.id} type="button" tabIndex={-1} onClick={() => onSelect(record.node)} />;
        })}
      </div>
    </div>
  );
});

Layer3DPreview.displayName = "Layer3DPreview";
