import { workbenchCommands } from "../../shared/workbench-commands";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CaptureGeometry, LayerFocus, LayerMenuAction, PixelSize, QmlGroupImage, SnapshotGroupImage, TreeDoubleClickAction, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { constrainOrbitCamera, orbitFromDrag, orbitFromKeys, type OrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview } from "../features/layers/Layer3DPreview";
import { type LayerSceneHandle } from "../features/layers/types";
import { usePreviewViewport } from "../features/layers/usePreviewViewport";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY, parseLayerAppearance, type LayerAppearance, type LayerDisplayMode } from "../features/layers/appearance";
import { measurementRecords, useLayerMeasurement } from "../features/layers/useLayerMeasurement";
import type { MeasurementSnapshotIdentity } from "../../shared/measurement-card";
import { useNodeHover } from "../features/inspection/NodeHoverContext";
import { LAYER_MOTION_DURATION, mixCamera, motionProgress } from "../features/layers/motion";
import { FlatNodeHoverOverlay, useFlatNodeHover } from "../features/layers/CanvasHoverOverlay";
import { QuickSelectPanel } from "../features/layers/QuickSelectPanel";
import { MeasurementCard } from "../features/layers/MeasurementCard";
import { quickSelectModifier, type QuickSelectCandidate, type QuickSelectResult } from "../features/layers/quick-select";
import type { ContextHintsController } from "../features/inspection/useContextHints";
import { ContextHint, dismissVisibleContextHint } from "./ContextHint";
import { ContinuousZoom } from "./ContinuousZoom";
import { CanvasToolPopover } from "../features/layers/CanvasToolPopover";
import "../styles/layer-motion.css";
import "../styles/canvas-tools.css";

type ViewMode = "flat" | "layers3d";

type Props = {
  sessionKey?: string | number;
  measurementSnapshot?: MeasurementSnapshotIdentity;
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  geometry?: CaptureGeometry;
  layersAvailable?: boolean;
  toolbarHost?: HTMLElement | null;
  onSelect: (node: UiNode) => void;
  onNavigateNode?: (node: UiNode, sourceRoot: UiNode) => boolean;
  navigationDisabled?: boolean;
  toolsSuspended?: boolean;
  contextHints?: ContextHintsController;
  layerFocus: LayerFocus | null;
  hiddenNodeIds: ReadonlySet<string>;
  doubleClickAction: TreeDoubleClickAction;
  onDoubleClick: (node: UiNode) => void;
  onLayerAction: (action: LayerMenuAction, node?: UiNode | null) => void;
  onOpenLayerMenu: (node: UiNode | null) => void;
  onCaptureGroup?: (node: UiNode) => Promise<QmlGroupImage | null>;
  savedGroupImages?: readonly SnapshotGroupImage[];
};

type SceneOrigin = { left: number; top: number };
type ZoomAnchor = { imageX: number; imageY: number; clientX: number; clientY: number };
type Gesture = {
  pointerId: number;
  kind: "pan" | "rotate" | "select";
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  startAzimuth: number;
  startElevation: number;
  moved: boolean;
  contextClick: boolean;
  pressedNode: UiNode | null;
  quickSelection?: QuickSelectResult | null;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const ZOOM_STEP = 0.25;
const PINCH_ZOOM_SENSITIVITY = 0.005;
const FINE_WHEEL_SENSITIVITY = 0.002;
const DRAG_THRESHOLD = 4;
const ZOOM_PRESETS = [0.5, 1, 2, 4, 8, 16] as const;
// Open from the front-left: controls fan left, with the page stack behind them.
const DEFAULT_CAMERA: OrbitCamera = { distance: 1100, azimuth: 40, elevation: 12, roll: 0, layerGap: 96, panX: 0, panY: 0 };

function clampZoom(value: number) {
  // Keep tiny pinch deltas; only the displayed percentage should be rounded.
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function ScreenshotPreview(props: Props) {
  const [appearance, setAppearance] = useState<LayerAppearance>(() => {
    try {
      const saved = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY);
      return saved && saved.length < 1024 ? parseLayerAppearance(JSON.parse(saved)) : DEFAULT_LAYER_APPEARANCE;
    } catch { return DEFAULT_LAYER_APPEARANCE; }
  });
  const changeAppearance = (next: LayerAppearance) => {
    const value = parseLayerAppearance(next);
    setAppearance(value);
    try { localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify(value)); } catch { /* Keep the preference in this window. */ }
  };
  // A capture may replace its preview image while keeping the same camera.
  return <LoadedScreenshot key={props.sessionKey ?? props.src} {...props} appearance={appearance} onAppearanceChange={changeAppearance} />;
}

function LoadedScreenshot({ sessionKey, measurementSnapshot, src, root, selectedNode, expandedNodeIds, geometry, layersAvailable = true, toolbarHost, onSelect, onNavigateNode, navigationDisabled = false, toolsSuspended = false, contextHints, layerFocus, hiddenNodeIds, doubleClickAction, onDoubleClick, onLayerAction, onOpenLayerMenu, onCaptureGroup, savedGroupImages, appearance, onAppearanceChange }: Props & {
  appearance: LayerAppearance; onAppearanceChange: (value: LayerAppearance) => void;
}) {
  const unavailableId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const layerSceneRef = useRef<LayerSceneHandle>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const ignoredPointerRef = useRef<number | null>(null);
  const layerClickRef = useRef<{ node: UiNode; sameNode: boolean } | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const previousSelectedIdRef = useRef<string | null>(null);
  const focusedNode = layerFocus?.node ?? null;
  const focusKey = layerFocus ? `${layerFocus.kind}:${layerFocus.node.attributes?.["view-ref"] ?? layerFocus.node.id}` : null;
  const previousFocusKey = useRef<string | null>(null);
  const savedViewRef = useRef<{ mode: ViewMode; zoom: number; camera: OrbitCamera; left: number; top: number } | null>(null);
  const restoringViewRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const frameSize = usePreviewViewport(frameRef);
  const viewport = frameSize.visible;
  const [failed, setFailed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const viewChoiceRef = useRef<ViewMode | null>(null);
  const [canvasHoverId, setCanvasHoverId] = useState<string | null>(null);
  const { hover: sharedHover } = useNodeHover();
  const [gestureActive, setGestureActive] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sceneFitScale, setSceneFitScale] = useState<number | null>(null);
  const zoomRef = useRef(1);
  const rotationModeRef = useRef(appearance.rotationMode);
  const [camera, setCamera] = useState<OrbitCamera>(() => constrainOrbitCamera(DEFAULT_CAMERA, appearance.rotationMode));
  const cameraRef = useRef<OrbitCamera>(camera);
  const cameraFrameRef = useRef<number | null>(null);
  const cameraMotionRef = useRef<{ from: OrbitCamera; to: OrbitCamera; started: number } | null>(null);
  const cameraMotionFrameRef = useRef<number | null>(null);
  const previousModeRef = useRef(viewMode);
  const modeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [sceneOrigin, setSceneOrigin] = useState<SceneOrigin>({ left: 0, top: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);
  const quickToolRef = useRef<HTMLButtonElement>(null);
  const measurementToolRef = useRef<HTMLButtonElement>(null);
  const [activeTool, setActiveTool] = useState<"zoom" | "settings" | "help" | null>(null);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const [displayMode, setDisplayMode] = useState<LayerDisplayMode>("images");
  const toolOpen = (tool: "zoom" | "settings" | "help", open: boolean) => {
    if (open && !toolsSuspended && !document.querySelector("dialog[open]")) {
      cancelGesture(); layerClickRef.current = null; closeQuickSelect(); setActiveTool(tool);
    } else setActiveTool(current => current === tool ? null : current);
  };
  useLayoutEffect(() => { setActiveTool(null); setDisplayMode("images"); }, [root, src, sessionKey]);
  useLayoutEffect(() => { if (viewMode !== "layers3d") setActiveTool(current => current === "settings" ? null : current); }, [viewMode]);

  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const canRender3d = Boolean(layersAvailable && enabled && root.bounds && root.children.length > 0);
  useLayoutEffect(() => { if (toolsSuspended || navigationDisabled || !enabled) setActiveTool(null); }, [toolsSuspended, navigationDisabled, enabled]);
  const macPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const quickModifierLabel = macPlatform ? "Command" : "Ctrl";
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;
  const { hoverFlatNode, clearCanvasHover: clearFlatHover } = useFlatNodeHover({ root, imageRef, size, active: enabled && viewMode === "flat" });
  const clearCanvasHover = useCallback(() => { clearFlatHover(); setCanvasHoverId(null); }, [clearFlatHover]);
  const quickContext = useMemo(() => ({}), [root, src, sessionKey, expandedNodeIds, hiddenNodeIds, focusedNode, layerFocus?.kind, navigationDisabled, viewMode, enabled, onNavigateNode, appearance.showInvisible]);
  type QuickUi = { context: object; result: QuickSelectResult | null; anchor?: { x: number; y: number } };
  const [quickUi, setQuickUi] = useState<QuickUi | null>(null);
  const quickUiRef = useRef<QuickUi | null>(null);
  const quickLiveRef = useRef({ context: quickContext, alive: true });
  quickLiveRef.current.context = quickContext;
  const activeQuick = quickUi?.context === quickContext ? quickUi : null;
  // Keep the current view and captured geometry independent: changing camera or
  // tree folding must not silently change an already selected A/B comparison.
  const measureRecords = useMemo(() => measurementRecords(root, hiddenNodeIds, layerFocus), [root, hiddenNodeIds, layerFocus]);
  const measureById = useMemo(() => new Map(measureRecords.map(record => [record.id, record])), [measureRecords]);
  const measureHoverId = sharedHover?.source === "tree" ? sharedHover.nodeId : canvasHoverId;
  const measurement = useLayerMeasurement({ context: sessionKey ?? root, src, records: measureRecords,
    selected: selectedNode ? measureById.get(selectedNode.id) : null,
    hovered: !activeQuick && !navigationDisabled && measureHoverId ? measureById.get(measureHoverId) : null, ready: enabled });
  const measurementState = measurement.state;
  const measurementRef = useRef(measurement);
  measurementRef.current = measurement;
  const requestContextHint = contextHints?.requestHint;
  const clearContextHint = contextHints?.clearHint;
  useEffect(() => {
    if (!activeQuick) clearContextHint?.("quick-select");
    if (!measurementState.pinned) clearContextHint?.("pinned-measurement");
    if (!focusKey) clearContextHint?.("layer-focus");
    if (activeQuick) requestContextHint?.("quick-select");
    else if (measurementState.pinned) requestContextHint?.("pinned-measurement");
    else if (focusKey) requestContextHint?.("layer-focus");
  }, [Boolean(activeQuick), measurementState.pinned, focusKey, requestContextHint, clearContextHint]);
  function changeQuickUi(next: QuickUi | null) { quickUiRef.current = next; setQuickUi(next); }
  function closeQuickSelect(restoreFocus = false) {
    changeQuickUi(null);
    layerSceneRef.current?.previewQuickSelect(null, null);
    if (restoreFocus) quickToolRef.current?.focus({ preventScroll: true });
  }
  function quickCallbackCurrent() { return quickLiveRef.current.alive && quickLiveRef.current.context === quickContext && !navigationDisabled; }
  function previewQuickCandidate(candidate: QuickSelectCandidate | null) {
    if (!quickCallbackCurrent()) return;
    layerSceneRef.current?.previewQuickSelect(activeQuick?.result ?? null, candidate);
  }
  function confirmQuickCandidate(candidate: QuickSelectCandidate) {
    const result = activeQuick?.result;
    if (!quickCallbackCurrent() || !result || result.root !== root || !result.candidates.includes(candidate)) return;
    if (onNavigateNode?.(candidate.node, result.root)) closeQuickSelect();
    else { closeQuickSelect(); frameRef.current?.focus({ preventScroll: true }); }
  }
  function quickPage(page: number) {
    if (!quickCallbackCurrent() || !activeQuick?.result) return;
    const result = layerSceneRef.current?.quickSelectPage(activeQuick.result, page);
    if (result) { layerSceneRef.current?.previewQuickSelect(null, null); changeQuickUi({ context: quickContext, result, anchor: activeQuick.anchor }); }
  }
  function filterQuickCandidates(query: string) {
    if (!quickCallbackCurrent() || !activeQuick?.result) return;
    const result = layerSceneRef.current?.quickSelectPage({ ...activeQuick.result, query }, 0);
    if (result) { layerSceneRef.current?.previewQuickSelect(null, null); changeQuickUi({ context: quickContext, result, anchor: activeQuick.anchor }); }
  }
  useLayoutEffect(() => {
    if (gestureRef.current?.quickSelection) { cancelGesture(); layerClickRef.current = null; }
    closeQuickSelect();
    return () => { layerSceneRef.current?.previewQuickSelect(null, null); };
  }, [quickContext]);
  useLayoutEffect(() => {
    quickLiveRef.current.alive = true;
    return () => { quickLiveRef.current.alive = false; quickUiRef.current = null; };
  }, []);

  useLayoutEffect(() => { cancelGesture(); layerClickRef.current = null; }, [root, doubleClickAction, viewMode, focusKey, enabled, appearance.showInvisible]);
  useLayoutEffect(() => {
    if (navigationDisabled && measurementState.picking) measurementRef.current.clearPinnedMeasurement();
    if (navigationDisabled) measurementRef.current.setTemporaryMeasurement(false);
  }, [navigationDisabled, Boolean(measurementState.picking)]);

  function beginMeasurement(endpoint?: "anchor" | "target") {
    if (navigationDisabled) return false;
    closeQuickSelect(); cancelGesture(); layerClickRef.current = null;
    const started = Boolean(measurementRef.current.beginMeasurement(endpoint));
    if (started) frameRef.current?.focus({ preventScroll: true });
    return started;
  }
  function startMeasurementMode() {
    if (navigationDisabled) return false;
    closeQuickSelect(); cancelGesture(); layerClickRef.current = null;
    const started = Boolean(measurementRef.current.startMeasurementMode());
    if (started) frameRef.current?.focus({ preventScroll: true });
    return started;
  }
  function endMeasurement() {
    measurementRef.current.clearPinnedMeasurement();
    measurementToolRef.current?.focus({ preventScroll: true });
  }

  function openLayerMenu(clientX?: number, clientY?: number) {
    if (viewMode !== "layers3d" || !enabled) return;
    const node = clientX !== undefined && clientY !== undefined ? layerSceneRef.current?.pick(clientX, clientY) : selectedNode;
    layerSceneRef.current?.clearHover();
    onOpenLayerMenu(node ?? null);
  }

  function normalizeCamera(next: OrbitCamera) {
    return constrainOrbitCamera(next, rotationModeRef.current);
  }

  function paintCamera(next: OrbitCamera) {
    next = normalizeCamera(next);
    const stage = stageRef.current;
    if (stage) stage.style.setProperty("--layer-live-pan", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
    if (frameRef.current) {
      frameRef.current.dataset.cameraPaintAzimuth = String(next.azimuth);
      frameRef.current.dataset.cameraPaintElevation = String(next.elevation);
      frameRef.current.dataset.cameraPaintRoll = String(next.roll);
    }
    layerSceneRef.current?.paintCamera(next);
  }

  function cancelModeMotion() {
    if (modeTimerRef.current !== null) clearTimeout(modeTimerRef.current);
    modeTimerRef.current = null;
    if (frameRef.current) delete frameRef.current.dataset.modeMotion;
  }

  function interruptCameraMotion() {
    if (cameraMotionFrameRef.current !== null) cancelAnimationFrame(cameraMotionFrameRef.current);
    cameraMotionFrameRef.current = null;
    if (!cameraMotionRef.current) return;
    cameraMotionRef.current = null;
    if (frameRef.current) frameRef.current.dataset.cameraMotionProgress = "1";
    cameraRef.current = normalizeCamera(cameraRef.current);
    setCamera({ ...cameraRef.current });
    paintCamera(cameraRef.current);
  }

  function animateCamera(next: OrbitCamera) {
    next = normalizeCamera(next);
    interruptCameraMotion();
    if (viewMode !== "layers3d" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { commitCamera(next); return; }
    cameraMotionRef.current = { from: { ...normalizeCamera(cameraRef.current) }, to: next, started: performance.now() };
    // Controls describe the destination. Only GPU/DOM paint follows the frames.
    setCamera(next);
    const animate = () => {
      cameraMotionFrameRef.current = null;
      const motion = cameraMotionRef.current;
      if (!motion) return;
      const progress = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : motionProgress(motion.started, performance.now());
      cameraRef.current = normalizeCamera(mixCamera(motion.from, motion.to, progress));
      paintCamera(cameraRef.current);
      if (frameRef.current) {
        frameRef.current.dataset.cameraMotionProgress = progress === 1 ? "1" : progress.toFixed(3);
        frameRef.current.dataset.cameraPaintAzimuth = String(cameraRef.current.azimuth);
        frameRef.current.dataset.cameraPaintElevation = String(cameraRef.current.elevation);
      }
      if (progress < 1) cameraMotionFrameRef.current = requestAnimationFrame(animate);
      else cameraMotionRef.current = null;
    };
    animate();
  }

  function scheduleCameraPaint(next: OrbitCamera) {
    cameraRef.current = normalizeCamera(next);
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      paintCamera(cameraRef.current);
    });
  }

  function commitCamera(next: OrbitCamera) {
    next = normalizeCamera(next);
    interruptCameraMotion();
    if (cameraFrameRef.current !== null) {
      cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }
    cameraRef.current = next;
    paintCamera(next);
    setCamera(next);
  }

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => handleWheel(event);
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [enabled, size]);

  useEffect(() => {
    if (cameraMotionRef.current) paintCamera(cameraRef.current);
    else { cameraRef.current = normalizeCamera(camera); paintCamera(cameraRef.current); }
  }, [camera]);

  useLayoutEffect(() => {
    if (rotationModeRef.current === appearance.rotationMode) return;
    rotationModeRef.current = appearance.rotationMode;
    if (savedViewRef.current) savedViewRef.current.camera = normalizeCamera(savedViewRef.current.camera);
    commitCamera(cameraRef.current);
  }, [appearance.rotationMode]);

  useLayoutEffect(() => {
    interruptCameraMotion();
    cancelModeMotion();
    const changed = previousModeRef.current !== viewMode;
    previousModeRef.current = viewMode;
    if (!changed || !enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (frameRef.current) frameRef.current.dataset.modeMotion = viewMode;
    modeTimerRef.current = setTimeout(cancelModeMotion, LAYER_MOTION_DURATION);
    return cancelModeMotion;
  }, [viewMode, root, src, focusKey, enabled]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => {
      if (!preference.matches) return;
      const destination = cameraMotionRef.current?.to;
      if (destination) commitCamera(destination);
      cancelModeMotion();
    };
    preference.addEventListener?.("change", changed);
    return () => preference.removeEventListener?.("change", changed);
  }, []);

  useEffect(() => () => {
    if (cameraFrameRef.current !== null) cancelAnimationFrame(cameraFrameRef.current);
    if (cameraMotionFrameRef.current !== null) cancelAnimationFrame(cameraMotionFrameRef.current);
    if (modeTimerRef.current !== null) clearTimeout(modeTimerRef.current);
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    // Clear a pinned pair before the workspace's existing Escape-to-exit actions.
    const releaseMeasurement = (event: globalThis.KeyboardEvent) => {
      // Capture listeners run before a candidate input can handle its IME keys.
      if (event.isComposing || event.keyCode === 229) return;
      if (activeToolRef.current) return;
      if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return;
      if (event.key === "Escape" && !event.defaultPrevented && quickUiRef.current?.context === quickContext) {
        event.preventDefault(); event.stopPropagation(); closeQuickSelect(true); return;
      }
      if (event.key !== "Escape" || event.defaultPrevented
        || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], details[open]"))) return;
      if (measurementRef.current.clearPinnedMeasurement()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("keydown", releaseMeasurement, true);
    return () => window.removeEventListener("keydown", releaseMeasurement, true);
  }, [viewMode, quickContext, toolbarHost]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (activeToolRef.current) return;
      if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return;
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable=true]"));
      const screenshotFocused = Boolean(frameRef.current && event.target instanceof Node && frameRef.current.contains(event.target));
      if (event.target instanceof HTMLElement && event.target.closest(".quick-select-panel")) return;
      if (event.key === "Alt" && selectedNode && !editing && !event.repeat && !event.defaultPrevented
        && !event.ctrlKey && !event.metaKey && !event.shiftKey && !navigationDisabled && !activeQuick && !gestureRef.current) {
        if (measurementRef.current.setTemporaryMeasurement(true)) event.preventDefault();
      }
      if (event.code === "Space" && screenshotFocused && !editing && !event.defaultPrevented) {
        event.preventDefault();
        setSpacePressed(true);
        layerClickRef.current = null;
        layerSceneRef.current?.clearHover();
        clearCanvasHover();
      }
      if (event.key === "Shift" && screenshotFocused && !editing) { setShiftPressed(true); layerSceneRef.current?.clearHover(); clearCanvasHover(); }
      if (event.key === "Escape" && viewMode === "layers3d" && !event.defaultPrevented
        && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, details[open]"))) {
        if (focusedNode) { event.preventDefault(); onLayerAction("exit-focus"); }
        else setViewMode("flat");
      }
      if (viewMode === "layers3d" && screenshotFocused) {
        if (event.key === "Home") {
          event.preventDefault();
          resetView();
          return;
        }
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          layerSceneRef.current?.interruptMotion();
          commitCamera(orbitFromKeys(cameraRef.current, event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"));
          return;
        }
      }
      if (!enabled || !screenshotFocused || editing || event.defaultPrevented) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeZoom(zoom + ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(zoom - ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        fitView();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") measurementRef.current.setTemporaryMeasurement(false);
      if (event.code === "Space") setSpacePressed(false);
      if (event.key === "Shift") setShiftPressed(false);
    };
    const onWindowBlur = () => {
      measurementRef.current.setTemporaryMeasurement(false);
      closeQuickSelect();
      layerClickRef.current = null;
      cancelGesture();
      layerSceneRef.current?.clearHover();
      clearCanvasHover();
      setSpacePressed(false);
      setShiftPressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [enabled, viewMode, zoom, focusedNode, onLayerAction, clearCanvasHover, quickContext, selectedNode, Boolean(activeQuick)]);

  useEffect(() => {
    const selectedId = selectedNode?.id ?? null;
    if (restoringViewRef.current) { restoringViewRef.current = false; previousSelectedIdRef.current = selectedId; return; }
    if (!canRender3d) {
      setViewMode("flat");
    } else if (viewChoiceRef.current !== "flat" && measurementRef.current.state.mode === "off" && !focusedNode && (selectedId !== previousSelectedIdRef.current || previousSelectedIdRef.current === null)) {
      setViewMode("layers3d");
    }
    previousSelectedIdRef.current = selectedId;
  }, [canRender3d, selectedNode?.id, focusedNode]);

  const flatFitScale = useMemo(() => {
    if (!size || !validSize(size)) return 0;
    const availableWidth = frameSize.width > 0 ? Math.max(1, frameSize.occluded ? viewport.width * .86 : frameSize.width - 30) : Number.POSITIVE_INFINITY;
    const availableHeight = frameSize.occluded ? Math.max(1, viewport.height * .86) : Number.POSITIVE_INFINITY;
    // Keep the established inspector maximum so a portrait phone remains
    // legible while the new zoom controls can grow beyond it deliberately.
    return Math.min(1, 400 / size.height, availableWidth / size.width, availableHeight / size.height);
  }, [frameSize, size]);
  const fitScale = viewMode === "layers3d" ? sceneFitScale ?? flatFitScale : flatFitScale;
  const renderScale = fitScale * zoom;
  const stageWidth = size ? Math.max(1, size.width * renderScale) : 0;
  const stageHeight = size ? Math.max(1, size.height * renderScale) : 0;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (viewMode !== "layers3d" || !stage) return;
    const next = { left: stage.offsetLeft, top: stage.offsetTop };
    setSceneOrigin((current) => current.left === next.left && current.top === next.top ? current : next);
  }, [frameSize, stageHeight, stageWidth, viewMode]);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!anchor || !frame || !image || !size) return;
    const rect = image.getBoundingClientRect();
    const currentX = rect.left + anchor.imageX / size.width * rect.width;
    const currentY = rect.top + anchor.imageY / size.height * rect.height;
    frame.scrollLeft = Math.max(0, frame.scrollLeft + currentX - anchor.clientX);
    frame.scrollTop = Math.max(0, frame.scrollTop + currentY - anchor.clientY);
    zoomAnchorRef.current = null;
  }, [renderScale, size]);

  function changeZoom(next: number, event?: WheelEvent, centerAnchor = false) {
    if (!size) return;
    interruptCameraMotion(); cancelModeMotion(); layerSceneRef.current?.interruptMotion();
    const image = imageRef.current;
    if ((event || centerAnchor && viewMode === "flat") && image) {
      const rect = image.getBoundingClientRect();
      const frame = frameRef.current!.getBoundingClientRect();
      const clientX = event?.clientX ?? frame.left + viewport.left + viewport.width / 2;
      const clientY = event?.clientY ?? frame.top + viewport.top + viewport.height / 2;
      const imageX = (clientX - rect.left) / rect.width * size.width;
      const imageY = (clientY - rect.top) / rect.height * size.height;
      if (imageX >= 0 && imageY >= 0 && imageX <= size.width && imageY <= size.height) {
        zoomAnchorRef.current = { imageX, imageY, clientX, clientY };
      }
    }
    const nextZoom = clampZoom(next);
    zoomRef.current = nextZoom;
    if (event) {
      // Accumulate every pinch delta, but rebuild React/scene geometry only once
      // per display frame, including high-rate trackpads.
      if (zoomFrameRef.current === null) zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        setZoom(zoomRef.current);
      });
    } else {
      if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
      setZoom(nextZoom);
    }
  }

  function fitView() {
    cancelGesture();
    zoomAnchorRef.current = null;
    changeZoom(1);
    commitCamera({ ...cameraRef.current, panX: 0, panY: 0, azimuth: DEFAULT_CAMERA.azimuth, elevation: DEFAULT_CAMERA.elevation, roll: DEFAULT_CAMERA.roll });
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function resetView() {
    cancelGesture();
    zoomAnchorRef.current = null;
    changeZoom(1);
    animateCamera(DEFAULT_CAMERA);
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  useLayoutEffect(() => {
    if (focusKey === previousFocusKey.current) return;
    previousFocusKey.current = focusKey;
    if (scrollFrameRef.current !== null) { cancelAnimationFrame(scrollFrameRef.current); scrollFrameRef.current = null; }
    layerClickRef.current = null;
    layerSceneRef.current?.clearHover();
    zoomAnchorRef.current = null;
    if (zoomFrameRef.current !== null) { cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; }
    if (focusKey) {
      savedViewRef.current ??= { mode: viewMode, zoom: zoomRef.current, camera: { ...normalizeCamera(cameraRef.current) },
        left: frameRef.current?.scrollLeft ?? 0, top: frameRef.current?.scrollTop ?? 0 };
      setViewMode("layers3d");
      changeZoom(1);
      commitCamera({ ...cameraRef.current, panX: 0, panY: 0 });
      frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
    } else {
      const saved = savedViewRef.current;
      savedViewRef.current = null;
      if (!saved) return;
      restoringViewRef.current = true;
      setViewMode(saved.mode);
      changeZoom(saved.zoom);
      commitCamera(saved.camera);
      scrollFrameRef.current = requestAnimationFrame(() => { scrollFrameRef.current = null;
        frameRef.current?.scrollTo({ left: saved.left, top: saved.top, behavior: "auto" }); });
    }
  }, [focusKey]);

  function selectAtPoint(event: PointerEvent<HTMLDivElement>, pressedNode?: UiNode | null) {
    const image = imageRef.current;
    if (event.button !== 0 || !event.isPrimary || navigationDisabled || !enabled || !size || !image || !image.complete || !image.naturalWidth) return null;
    if (viewMode === "layers3d") {
      const layer = pressedNode === undefined ? layerSceneRef.current?.pick(event.clientX, event.clientY) : pressedNode;
      if (layer) onSelect(layer);
      // Never fall back to the flattened screen: it still contains hidden layers.
      return layer ?? null;
    }
    const point = clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size);
    if (!point) return null;
    const node = findNodeAtPoint(root, point.x, point.y, size);
    if (node) onSelect(node);
    return node;
  }

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !event.isPrimary || gestureRef.current) return;
    ignoredPointerRef.current = null;
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed) || (event.button === 0 && event.shiftKey);
    const shouldRotate = viewMode === "layers3d" && (event.button === 2 || event.button === 0);
    if (!shouldPan && !shouldRotate && event.button !== 0) return;
    interruptCameraMotion(); cancelModeMotion();
    const contextClick = event.button === 2 || (macPlatform && event.button === 0 && event.ctrlKey);
    const shortcutQuickSelection = viewMode === "layers3d" && onNavigateNode && !navigationDisabled && layerFocus?.kind !== "layer"
      && quickSelectModifier(event, navigator.platform);
    const plainQuickSelection = (activeQuick || shortcutQuickSelection) && !shouldPan && event.button === 0 && !contextClick;
    if (plainQuickSelection && measurementRef.current.state.mode !== "fixed") measurementRef.current.clearPinnedMeasurement();
    // Query the frame the user pressed. A later drag still finishes the motion.
    if (!plainQuickSelection) layerSceneRef.current?.interruptMotion();
    event.preventDefault();
    const frame = event.currentTarget;
    frame.focus({ preventScroll: true });
    const currentCamera = cameraRef.current;
    const gesture: Gesture = {
      pointerId: event.pointerId,
      kind: shouldPan ? "pan" : shouldRotate ? "rotate" : "select",
      startX: event.clientX,
      startY: event.clientY,
      startPanX: currentCamera.panX,
      startPanY: currentCamera.panY,
      startAzimuth: currentCamera.azimuth,
      startElevation: currentCamera.elevation,
      moved: false,
      contextClick,
      pressedNode: viewMode === "layers3d" ? layerSceneRef.current?.pick(event.clientX, event.clientY) ?? null : null,
      quickSelection: plainQuickSelection
        ? layerSceneRef.current?.quickSelectAt(event.clientX, event.clientY) ?? null : undefined,
    };
    gestureRef.current = gesture;
    setGestureActive(true);
    if (shouldPan) clearCanvasHover();
    if (viewMode === "layers3d" && !shouldPan && !activeQuick) layerSceneRef.current?.hover(event.clientX, event.clientY);
    frame.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.quickSelection) layerSceneRef.current?.interruptMotion();
      if (activeQuick) { layerSceneRef.current?.interruptMotion(); layerSceneRef.current?.previewQuickSelect(null, null); changeQuickUi({ context: quickContext, result: null }); }
      event.currentTarget.dataset.gesture = gesture.kind;
      if (viewMode === "layers3d") event.currentTarget.classList.add("is-3d-dragging");
      layerSceneRef.current?.clearHover();
      clearCanvasHover();
    }
    if (gesture.kind === "pan") {
      scheduleCameraPaint({ ...cameraRef.current, panX: gesture.startPanX + dx, panY: gesture.startPanY + dy });
    } else if (gesture.kind === "rotate") {
      scheduleCameraPaint(orbitFromDrag({ ...cameraRef.current, azimuth: gesture.startAzimuth, elevation: gesture.startElevation }, dx, dy));
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (gestureRef.current) {
      moveGesture(event);
      return;
    }
    setShiftPressed(event.shiftKey);
    if (activeQuick) return;
    if (spacePressed || event.shiftKey) { layerSceneRef.current?.clearHover(); clearCanvasHover(); return; }
    if (viewMode === "layers3d") {
      layerSceneRef.current?.hover(event.clientX, event.clientY);
      setCanvasHoverId(layerSceneRef.current?.pick(event.clientX, event.clientY)?.id ?? null);
    } else {
      hoverFlatNode(event.clientX, event.clientY);
      const image = imageRef.current, point = image && size ? clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size) : null;
      setCanvasHoverId(point && size ? findNodeAtPoint(root, point.x, point.y, size)?.id ?? null : null);
    }
  }

  function cancelGesture() {
    clearCanvasHover();
    const gesture = gestureRef.current, frame = frameRef.current;
    gestureRef.current = null;
    setGestureActive(false);
    if (gesture) {
      ignoredPointerRef.current = gesture.pointerId;
      if (frame?.hasPointerCapture(gesture.pointerId)) frame.releasePointerCapture(gesture.pointerId);
      if (gesture.moved) commitCamera(cameraRef.current);
    }
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    layerSceneRef.current?.clearHover();
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    // A quick drag can reach release before Chromium sends another move event.
    if (event.type === "pointerup") moveGesture(event);
    const frame = frameRef.current;
    gestureRef.current = null;
    setGestureActive(false);
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    if (gesture.moved) commitCamera(cameraRef.current);
    if (event.type !== "pointerup") {
      ignoredPointerRef.current = gesture.pointerId;
      layerClickRef.current = null;
      layerSceneRef.current?.clearHover();
    } else if (gesture.moved && !spacePressed && !event.shiftKey && frame?.contains(document.elementFromPoint(event.clientX, event.clientY))) layerSceneRef.current?.hover(event.clientX, event.clientY);
    return event.type !== "pointerup" || gesture.moved || gesture.kind === "pan";
  }

  function handleWheel(event: WheelEvent) {
    if (event.target instanceof Element && event.target.closest(".quick-select-panel, .measurement-card")) return;
    if (!enabled || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    // Chromium delivers trackpad pinch as Ctrl+wheel with small pixel deltas.
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frameRef.current?.clientHeight || 400 : 1);
    const factor = event.ctrlKey || event.deltaMode === 0 && Math.abs(event.deltaY) < 40
      ? Math.exp(-pixels * (event.ctrlKey ? PINCH_ZOOM_SENSITIVITY : FINE_WHEEL_SENSITIVITY))
      : pixels < 0 ? 1.25 : 0.8;
    changeZoom(zoomRef.current * factor, event);
  }

  const stageStyle: CSSProperties = {
    width: stageWidth,
    height: stageHeight,
    transform: `var(--layer-live-pan, translate3d(${camera.panX}px, ${camera.panY}px, 0))`,
    willChange: "transform",
    ...(viewMode === "layers3d" ? { left: viewport.left + viewport.width / 2 - frameSize.width / 2, top: viewport.top + viewport.height / 2 - frameSize.height / 2 } : {}),
  };
  const stageShellStyle: CSSProperties = viewMode === "layers3d"
    ? { width: "100%", height: "100%" }
    : { width: stageWidth, height: stageHeight, transform: `translate(${viewport.left + viewport.width / 2 - frameSize.width / 2}px, ${viewport.top + viewport.height / 2 - frameSize.height / 2}px)` };

  const zoomPresetValue = ZOOM_PRESETS.find((preset) => Math.abs(preset - zoom) < 0.001);

  const handleMeasurementShortcut = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return false;
    if (event.defaultPrevented || navigationDisabled || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], details[open]")) return false;
    const handled = event.key === "Escape" ? measurementRef.current.clearPinnedMeasurement()
      : event.key.toLowerCase() === "m" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        ? activeQuick ? startMeasurementMode() : measurementRef.current.toggleMeasurementPin() || startMeasurementMode() : false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return Boolean(handled);
  };

  const unavailable3d = !layersAvailable ? "当前为快速采集，只提供 2D 截图和控件边界。" : !enabled ? "截图尚未就绪，或截图与控件坐标不一致。" : "当前快照没有可展开的层级。";
  const unavailableQuick = viewMode !== "layers3d" ? "请切换到 3D 后选择折叠内部的控件。" : layerFocus?.kind === "layer" ? "仅看此层时不能选择内部控件，请先退出聚焦。" : navigationDisabled ? "正在更新快照，请稍后选择。" : !onNavigateNode ? "当前视图不支持内部控件定位。" : !enabled ? "截图尚未就绪。" : null;
  const currentOperation = activeQuick ? "内部选择 · 点选折叠画面 · Esc 取消"
    : measurementState.picking ? `测距 · 选择 ${measurementState.picking.endpoint === "anchor" ? "A" : "B"} · Esc 结束`
    : measurementState.pinned ? "测距 · 已固定 A / B · Esc 结束"
    : measurementState.mode === "temporary" ? "临时测距 · 悬停 B · 松开 Option / Alt 结束"
    : measurementState.mode === "live" ? `测距 · ${selectedNode ? "悬停 B，M 固定" : "选择 A"} · Esc 结束`
    : focusedNode ? `${layerFocus?.kind === "branch" ? "分支聚焦" : "仅看此层"} · Esc 退出`
    : `${viewMode === "layers3d" ? "3D 层级" : "2D 截图"} · 点击选择控件`;

  const toolbar = <div className="screenshot-view-toolbar" aria-label="截图视图工具栏" onKeyDown={handleMeasurementShortcut}>
      <div className="canvas-tool-group canvas-view-tools" role="group" aria-label="视图与缩放">
      <div className="view-mode-toggle" role="group" aria-label="截图显示模式">
        <button className={viewMode === "flat" ? "active" : ""} aria-pressed={viewMode === "flat"} type="button" onClick={() => {
          if (focusedNode) { if (savedViewRef.current) savedViewRef.current.mode = "flat"; onLayerAction("exit-focus"); }
          viewChoiceRef.current = "flat"; setViewMode("flat");
        }}>2D</button>
        <span className="canvas-disabled-control" tabIndex={!canRender3d ? 0 : undefined} aria-describedby={!canRender3d ? `${unavailableId}-3d` : undefined}>
        <button className={`view-mode-3d ${viewMode === "layers3d" ? "active" : ""}`} aria-pressed={viewMode === "layers3d"} type="button" disabled={!canRender3d} title={!canRender3d ? unavailable3d : "展开查看已采集的控件层级"} onClick={() => { viewChoiceRef.current = "layers3d"; setViewMode("layers3d"); }}>3D 层级</button>
        {!canRender3d && <span id={`${unavailableId}-3d`} className="canvas-disabled-reason" role="tooltip">{unavailable3d}</span>}</span>
      </div>
      <div className="zoom-controls" role="group" aria-label="截图缩放">
        <button type="button" aria-label="缩小截图" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={!size || zoom <= MIN_ZOOM}>−</button>
        <span className="zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="放大截图" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={!size || zoom >= MAX_ZOOM}>＋</button>
        <select className="zoom-preset-select" aria-label="截图倍率预设" value={zoomPresetValue ? String(zoomPresetValue) : "custom"} onChange={(event) => {
          if (event.target.value !== "custom") changeZoom(Number(event.target.value));
        }} disabled={!size}>
          <option value="custom">{Math.round(zoom * 100)}%</option>
          {ZOOM_PRESETS.map((preset) => <option value={preset} key={preset}>{Math.round(preset * 100)}%</option>)}
        </select>
        <ContinuousZoom value={zoom} min={MIN_ZOOM} max={MAX_ZOOM} disabled={!enabled}
          open={activeTool === "zoom"} onOpenChange={open => toolOpen("zoom", open)}
          onChange={next => changeZoom(next, undefined, true)} />
        <button className="zoom-fit" type="button" onClick={fitView} disabled={!size} title="适应可见画布；收起属性栏可扩大视野">适应</button>
        <button className="zoom-reset" type="button" onClick={resetView} disabled={!size}>重置</button>
      </div></div>
      <div className="canvas-tool-group canvas-inspection-tools zoom-controls" role="group" aria-label="检查工具">
        <button ref={measurementToolRef} className="pin-layer-measurement" type="button"
          aria-pressed={measurementState.mode !== "off"}
          disabled={!measurementState.ready || navigationDisabled}
          title={measurementState.pinned ? `已测量：${measurementState.summary} · M 或 Esc 结束` : "选中 A，悬停 B 实时测距；按住 Option / Alt 临时测距"}
          onClick={() => measurementState.mode !== "off" ? endMeasurement() : startMeasurementMode()}>
          {measurementState.mode !== "off" ? "结束测距" : "测距"}</button>
        <span className="canvas-disabled-control" tabIndex={unavailableQuick ? 0 : undefined} aria-describedby={unavailableQuick ? `${unavailableId}-quick` : undefined}>
        <button ref={quickToolRef} className="quick-select-tool" type="button" aria-pressed={Boolean(activeQuick)}
          disabled={Boolean(unavailableQuick)}
          title={unavailableQuick ?? `按住 ${quickModifierLabel} 点选折叠画面，也可直接查找内部控件 · 按边界匹配 · Esc 退出`}
          onClick={() => {
            if (activeQuick) closeQuickSelect(true);
            else { if (measurementRef.current.state.mode !== "fixed") measurementRef.current.clearPinnedMeasurement(); cancelGesture(); layerClickRef.current = null; changeQuickUi({ context: quickContext, result: null }); frameRef.current?.focus({ preventScroll: true }); }
          }}>选择折叠内部的控件</button>
        {unavailableQuick && <span id={`${unavailableId}-quick`} className="canvas-disabled-reason" role="tooltip">{unavailableQuick}</span>}</span>
        {focusedNode && <button className="zoom-fit exit-layer-focus" type="button" onClick={() => onLayerAction("exit-focus")} title={`${layerFocus?.kind === "branch" ? "聚焦分支" : "仅看此层"}：${nodeDisplayLabel(focusedNode)} · Esc 退出`}>退出聚焦</button>}
        {viewMode === "layers3d" && hiddenNodeIds.size > 0 && <button className="restore-layers" type="button" onClick={() => onLayerAction("restore")} aria-label={workbenchCommands["restore-layers"].label} title={workbenchCommands["restore-layers"].label}>恢复图层 ({hiddenNodeIds.size})</button>}
      </div>
      {viewMode === "layers3d" && (
        <CanvasToolPopover className="layer-settings" bodyClassName="layer-settings-body" label="3D 层级设置" open={activeTool === "settings"} onOpenChange={open => toolOpen("settings", open)}
          summary={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10" /><path d="M8 3v6m6 0v6M6 15v6" /></svg>}>
            <div className="layer-options" aria-label="3D 层级视图参数">
              <label className="layer-highlight-label">
                <span>显示内容</span>
                <select aria-label="3D 显示内容" value={displayMode} onChange={event => setDisplayMode(event.target.value as LayerDisplayMode)}>
                  <option value="images">图片</option><option value="wireframe">仅边框</option>
                </select>
              </label>
              <label className="layer-outline-label" title={displayMode === "wireframe" ? "仅边框模式始终显示边界；切回图片后恢复此偏好" : "关闭后仍显示选中、悬停和缺图轮廓"}>
                <span>普通轮廓</span>
                <input type="checkbox" checked={appearance.showOutlines} disabled={displayMode === "wireframe"} onChange={event => onAppearanceChange({ ...appearance, showOutlines: event.target.checked })} aria-label="显示普通轮廓" />
              </label>
              <label className="layer-outline-label" title="只显示已采集的布局边界，不恢复设备画面">
                <span>不可见控件边界</span>
                <input type="checkbox" checked={appearance.showInvisible} onChange={event => onAppearanceChange({ ...appearance, showInvisible: event.target.checked })} aria-label="显示不可见控件边界" />
              </label>
              <label className="layer-highlight-label">
                <span>选中强调</span>
                <select aria-label="选中强调强度" value={appearance.highlightStrength} disabled={displayMode === "wireframe"}
                  onChange={event => onAppearanceChange({ ...appearance, highlightStrength: event.target.value as LayerAppearance["highlightStrength"] })}>
                  <option value="light">轻（仅边框）</option>
                  <option value="medium">中</option>
                  <option value="strong">强</option>
                </select>
              </label>
              <label className="layer-highlight-label">
                <span>旋转模式</span>
                <select aria-label="3D 旋转模式" value={appearance.rotationMode}
                  onChange={event => onAppearanceChange({ ...appearance, rotationMode: event.target.value as LayerAppearance["rotationMode"] })}>
                  <option value="free">自由旋转</option>
                  <option value="horizontal">仅水平旋转</option>
                </select>
              </label>
              <div className="layer-appearance-help"><span>{displayMode === "wireframe" ? "仅边框不显示图片与面状强调" : "缺图轮廓始终保留"}</span><button type="button" onClick={() => { onAppearanceChange(DEFAULT_LAYER_APPEARANCE); setDisplayMode("images"); }}>恢复显示默认</button></div>
              <label className="layer-gap-label">
                <span>层间距 {camera.layerGap}px</span>
                <input type="range" min="24" max="240" step="8" value={camera.layerGap} onChange={(event) => commitCamera({ ...cameraRef.current, layerGap: Number(event.target.value) })} aria-label="3D 层间距" />
              </label>
              <label className="layer-perspective-label">
                <span>视距 {camera.distance}px</span>
                <input type="range" min="720" max="1800" step="40" value={camera.distance} onChange={(event) => commitCamera({ ...cameraRef.current, distance: Number(event.target.value) })} aria-label="3D 相机视距" />
              </label>
              <span className="orbit-label" aria-hidden="true">Orbit</span>
              <span className="orbit-readout" aria-live="polite">Yaw {Math.round(camera.azimuth)}° · Pitch {Math.round(camera.elevation)}°</span>
              <span className="window-stack-label" title={focusedNode ? nodeDisplayLabel(focusedNode) : "截图中的全部可见层"}>{focusedNode ? layerFocus?.kind === "branch" ? "分支聚焦" : "仅看此层" : "全量展开总览"}</span>
            </div>
        </CanvasToolPopover>
      )}
      <CanvasToolPopover className="canvas-help" bodyClassName="canvas-help-body" label="画布操作帮助" summary="?" open={activeTool === "help"} onOpenChange={open => toolOpen("help", open)}>
          <strong>画布操作</strong>
          <p>点击选择；双击{doubleClickAction === "focus-branch" ? "聚焦分支" : doubleClickAction === "toggle" ? "展开或收起" : "展开控件"}。</p>
          <p>测距：选择 A，悬停 B；M 固定，Esc 结束。按住 Option / Alt 临时测距。</p>
          <p>{quickModifierLabel}＋点击折叠画面，选择内部控件。</p>
          <p>滚轮或 ＋ / − 缩放，0 适应；空格 / Shift / 中键拖动平移。3D 拖动或方向键旋转，Home 重置。</p>
          {size && <p>{size.width}×{size.height} 屏幕 px · {integrity.message}</p>}
      </CanvasToolPopover>
    </div>;

  return <>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    {contextHints && <ContextHint hint={contextHints.hint} suspended={contextHints.suspended || !enabled || navigationDisabled || gestureActive || toolsSuspended || Boolean(activeTool)}
      onShown={contextHints.markShown} onDismiss={contextHints.dismissHint} />}
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" data-pan-ready={spacePressed || shiftPressed}
      data-measurement-active={measurementState.mode !== "off"}
      data-viewport-left={viewport.left} data-viewport-top={viewport.top} data-viewport-width={viewport.width} data-viewport-height={viewport.height}
      onContextMenu={(event) => { if (viewMode === "layers3d") event.preventDefault(); }}
      onKeyDown={(event) => {
        if (handleMeasurementShortcut(event)) return;
        if (viewMode === "layers3d" && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          void openLayerMenu();
        }
      }}
      onPointerDown={startGesture}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        if (event.pointerId === ignoredPointerRef.current) return;
        const previousClick = layerClickRef.current;
        layerClickRef.current = null;
        const pressedNode = gestureRef.current?.pressedNode;
        const quickSelection = gestureRef.current?.quickSelection;
        const contextClick = gestureRef.current?.contextClick || event.button === 2;
        if (finishGesture(event)) return;
        // Open on release, not contextmenu: Windows emits contextmenu on press,
        // which would otherwise interrupt the existing right-button orbit drag.
        if (contextClick && viewMode === "layers3d") { closeQuickSelect(); void openLayerMenu(event.clientX, event.clientY); return; }
        if (quickSelection && quickCallbackCurrent()) {
          const bounds = frameRef.current!.getBoundingClientRect();
          changeQuickUi({ context: quickContext, result: quickSelection, anchor: { x: event.clientX - bounds.left, y: event.clientY - bounds.top } });
          return;
        }
        if (activeQuick) {
          return;
        }
        const node = selectAtPoint(event, pressedNode);
        if (viewMode === "layers3d" && node) layerClickRef.current = { node, sameNode: previousClick?.node.id === node.id };
      }}
      onDoubleClick={(event) => {
        const click = layerClickRef.current;
        layerClickRef.current = null;
        if (activeQuick || measurementState.mode !== "off" || viewMode !== "layers3d" || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || spacePressed) return;
        // Every plane shares one canvas: two clicks must hit the same node,
        // and neither may be a drag, pan, context click or empty-space click.
        if (click?.sameNode) {
          event.preventDefault();
          onDoubleClick(click.node);
        }
      }}
      onPointerCancel={event => { finishGesture(event); clearCanvasHover(); }}
      onLostPointerCapture={event => { finishGesture(event); clearCanvasHover(); }}
      onPointerLeave={() => { setShiftPressed(false); layerSceneRef.current?.clearHover(); clearCanvasHover(); }}>
      {viewMode === "layers3d" && canRender3d && size && (
        <>
          <div className="viewport-grid" aria-hidden="true" />
          <div className="orbit-gizmo viewport-gizmo" aria-hidden="true">
            <span className="gizmo-axis gizmo-axis-x"><i>X</i></span>
            <span className="gizmo-axis gizmo-axis-y"><i>Y</i></span>
            <span className="gizmo-axis gizmo-axis-z"><i>Z</i></span>
          </div>
        </>
      )}
      <div className={`screenshot-stage-shell ${viewMode === "layers3d" ? "layers3d-viewport" : ""}`} style={stageShellStyle}>
        <div ref={stageRef} className={`screenshot-stage ${viewMode === "layers3d" ? "layers3d-base" : ""}`} data-coordinate-status={enabled ? integrity.status : failed ? "error" : size ? integrity.status : "loading"}
          style={stageStyle}>
          <img ref={imageRef} src={src} alt="Android screen snapshot" draggable={false}
            onLoad={event => {
              const image = event.currentTarget;
              const next = { width: image.naturalWidth, height: image.naturalHeight };
              if (validSize(next)) { setSize(next); setFailed(false); }
              else { setSize(null); setFailed(true); }
            }}
            onError={() => { setSize(null); setFailed(true); }} />
          {overlay && selectedNode && (
            <div className={`selection-overlay ${rootSelected ? "root-selection" : ""}`} style={overlay} aria-hidden="true">
              <span className="selection-label">
                <strong>{nodeDisplayLabel(selectedNode)}</strong>
                <span>{selectedNode.className ?? "unknown"}</span>
              </span>
            </div>
          )}
          {enabled && size && viewMode === "flat" && <FlatNodeHoverOverlay root={root} size={size} selectedId={selectedNode?.id ?? null} />}
        </div>
        {viewMode === "layers3d" && canRender3d && size && (
          <Layer3DPreview
            ref={layerSceneRef}
            sessionKey={sessionKey}
            src={src}
            root={root}
            selectedNode={selectedNode}
            expandedNodeIds={expandedNodeIds}
            hiddenNodeIds={hiddenNodeIds}
            focusedNode={focusedNode}
            focusKind={layerFocus?.kind}
            size={size}
            renderScale={renderScale}
            origin={sceneOrigin}
            viewport={viewport}
            camera={constrainOrbitCamera(camera, appearance.rotationMode)}
            appearance={appearance}
            displayMode={displayMode}
            onSelect={onSelect}
            onCaptureGroup={onCaptureGroup}
            savedGroupImages={savedGroupImages}
            onFitScale={setSceneFitScale}
            measurementController={measurement}
          />
        )}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
      {activeQuick && <QuickSelectPanel viewport={viewport} result={activeQuick.result} disabled={navigationDisabled} onPreview={previewQuickCandidate}
        onConfirm={confirmQuickCandidate} onPage={quickPage} onFilter={filterQuickCandidates} anchor={activeQuick.anchor} onClose={() => closeQuickSelect(true)} />}
      {measurementState.mode !== "off" && !activeQuick && <MeasurementCard
        state={measurementState} root={root} savedGroupImages={savedGroupImages} snapshot={measurementSnapshot}
        viewport={{ left: 0, top: 0, width: frameSize.width, height: frameSize.height }} selectionDisabled={navigationDisabled}
        onClear={endMeasurement} onPick={beginMeasurement}
        onPin={() => measurementRef.current.toggleMeasurementPin()} onLive={startMeasurementMode}
        onUseSelected={() => { if (measurementRef.current.useSelectedMeasurementNode()) frameRef.current?.focus({ preventScroll: true }); }} />}
      {measurementState.pinned && measurementState.card && <span className="layer-measurement-status" role="status"
        data-measure-anchor={measurementState.card.anchor.id} data-measure-target={measurementState.card.target.id}
        data-measure-relation={measurementState.card.measurement.relation} data-measure-pinned="true">
        测距已固定：{measurementState.summary}。按原始外框测量，不含 3D 展开层距。
      </span>}
    </div>
    {size && <p className={`screenshot-status canvas-operation-status ${integrity.status}`} role="status">
      <span>{currentOperation}</span>
      <small title={measurementSnapshot?.capturedAt ? `当前画面采集于 ${measurementSnapshot.capturedAt}` : "当前画面未提供采集时间"}>
        {measurementSnapshot?.capturedAt ? `采集于 ${new Date(measurementSnapshot.capturedAt).toLocaleTimeString()}` : "采集时间未记录"}
      </small>
      {integrity.status === "mismatch" && <span>{integrity.message}</span>}
    </p>}
    {measurementState.pinned && <p className="screenshot-pinned-measurement" hidden>测距已固定：{measurementState.summary} · M 或 Esc 解除</p>}

  </>;
}
