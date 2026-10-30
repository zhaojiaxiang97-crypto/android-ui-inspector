import { workbenchCommands } from "../../shared/workbench-commands";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CaptureGeometry, LayerFocus, LayerMenuAction, PixelSize, QmlGroupImage, SnapshotGroupImage, TreeDoubleClickAction, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { orbitFromDrag, orbitFromKeys, type OrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview } from "../features/layers/Layer3DPreview";
import { type LayerSceneHandle, type LayerMeasurementState } from "../features/layers/types";
import { usePreviewViewport } from "../features/layers/usePreviewViewport";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY, parseLayerAppearance, type LayerAppearance } from "../features/layers/appearance";
import { EMPTY_LAYER_MEASUREMENT } from "../features/layers/useLayerMeasurement";

type ViewMode = "flat" | "layers3d";

type Props = {
  sessionKey?: string | number;
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  geometry?: CaptureGeometry;
  layersAvailable?: boolean;
  toolbarHost?: HTMLElement | null;
  onSelect: (node: UiNode) => void;
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

function LoadedScreenshot({ sessionKey, src, root, selectedNode, expandedNodeIds, geometry, layersAvailable = true, toolbarHost, onSelect, layerFocus, hiddenNodeIds, doubleClickAction, onDoubleClick, onLayerAction, onOpenLayerMenu, onCaptureGroup, savedGroupImages, appearance, onAppearanceChange }: Props & {
  appearance: LayerAppearance; onAppearanceChange: (value: LayerAppearance) => void;
}) {
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
  const [measurementState, setMeasurementState] = useState<LayerMeasurementState>(EMPTY_LAYER_MEASUREMENT);
  const [zoom, setZoom] = useState(1);
  const [sceneFitScale, setSceneFitScale] = useState<number | null>(null);
  const zoomRef = useRef(1);
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const cameraRef = useRef<OrbitCamera>(DEFAULT_CAMERA);
  const cameraFrameRef = useRef<number | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [sceneOrigin, setSceneOrigin] = useState<SceneOrigin>({ left: 0, top: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const canRender3d = Boolean(layersAvailable && enabled && root.visibleToUser && root.bounds && root.children.length > 0);
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;

  useLayoutEffect(() => { cancelGesture(); layerClickRef.current = null; }, [root, doubleClickAction, viewMode, focusKey, enabled]);

  function openLayerMenu(clientX?: number, clientY?: number) {
    if (viewMode !== "layers3d" || !enabled) return;
    const node = clientX !== undefined && clientY !== undefined ? layerSceneRef.current?.pick(clientX, clientY) : selectedNode;
    layerSceneRef.current?.clearHover();
    onOpenLayerMenu(node ?? null);
  }

  function paintCamera(next: OrbitCamera) {
    const stage = stageRef.current;
    if (stage) stage.style.setProperty("--layer-live-pan", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
    layerSceneRef.current?.paintCamera(next);
  }

  function scheduleCameraPaint(next: OrbitCamera) {
    cameraRef.current = next;
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      paintCamera(cameraRef.current);
    });
  }

  function commitCamera(next: OrbitCamera) {
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
    cameraRef.current = camera;
    paintCamera(camera);
  }, [camera]);

  useEffect(() => () => {
    if (cameraFrameRef.current !== null) cancelAnimationFrame(cameraFrameRef.current);
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    // Clear a pinned pair before the workspace's existing Escape-to-exit actions.
    const releaseMeasurement = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || viewMode !== "layers3d"
        || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], details[open]"))) return;
      if (layerSceneRef.current?.clearPinnedMeasurement()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("keydown", releaseMeasurement, true);
    return () => window.removeEventListener("keydown", releaseMeasurement, true);
  }, [viewMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable=true]"));
      const screenshotFocused = Boolean(frameRef.current && event.target instanceof Node && frameRef.current.contains(event.target));
      if (event.code === "Space" && screenshotFocused && !editing && !event.defaultPrevented) {
        event.preventDefault();
        setSpacePressed(true);
        layerClickRef.current = null;
        layerSceneRef.current?.clearHover();
      }
      if (event.key === "Shift" && screenshotFocused && !editing) { setShiftPressed(true); layerSceneRef.current?.clearHover(); }
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
      if (event.code === "Space") setSpacePressed(false);
      if (event.key === "Shift") setShiftPressed(false);
    };
    const onWindowBlur = () => {
      layerClickRef.current = null;
      cancelGesture();
      layerSceneRef.current?.clearHover();
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
  }, [enabled, viewMode, zoom, focusedNode, onLayerAction]);

  useEffect(() => {
    const selectedId = selectedNode?.id ?? null;
    if (restoringViewRef.current) { restoringViewRef.current = false; previousSelectedIdRef.current = selectedId; return; }
    if (!canRender3d) {
      setViewMode("flat");
    } else if (!focusedNode && (selectedId !== previousSelectedIdRef.current || previousSelectedIdRef.current === null)) {
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

  function changeZoom(next: number, event?: WheelEvent) {
    if (!size) return;
    const image = imageRef.current;
    if (event && image) {
      const rect = image.getBoundingClientRect();
      const imageX = (event.clientX - rect.left) / rect.width * size.width;
      const imageY = (event.clientY - rect.top) / rect.height * size.height;
      if (imageX >= 0 && imageY >= 0 && imageX <= size.width && imageY <= size.height) {
        zoomAnchorRef.current = { imageX, imageY, clientX: event.clientX, clientY: event.clientY };
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
    fitView();
    commitCamera(DEFAULT_CAMERA);
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
      savedViewRef.current ??= { mode: viewMode, zoom: zoomRef.current, camera: { ...cameraRef.current },
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
    if (event.button !== 0 || !event.isPrimary || !enabled || !size || !image || !image.complete || !image.naturalWidth) return null;
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
      contextClick: event.button === 2 || (event.button === 0 && event.ctrlKey),
      pressedNode: viewMode === "layers3d" ? layerSceneRef.current?.pick(event.clientX, event.clientY) ?? null : null,
    };
    gestureRef.current = gesture;
    if (viewMode === "layers3d" && !shouldPan) layerSceneRef.current?.hover(event.clientX, event.clientY);
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
      event.currentTarget.dataset.gesture = gesture.kind;
      if (viewMode === "layers3d") event.currentTarget.classList.add("is-3d-dragging");
      layerSceneRef.current?.clearHover();
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
    if (spacePressed || event.shiftKey) { layerSceneRef.current?.clearHover(); return; }
    if (viewMode === "layers3d") layerSceneRef.current?.hover(event.clientX, event.clientY);
  }

  function cancelGesture() {
    const gesture = gestureRef.current, frame = frameRef.current;
    gestureRef.current = null;
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
    if (event.defaultPrevented || viewMode !== "layers3d" || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], details[open]")) return false;
    const handled = event.key === "Escape" ? layerSceneRef.current?.clearPinnedMeasurement()
      : event.key.toLowerCase() === "m" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        ? layerSceneRef.current?.toggleMeasurementPin() : false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return Boolean(handled);
  };

  const toolbar = <div className="screenshot-view-toolbar" aria-label="截图视图工具栏" onKeyDown={handleMeasurementShortcut}>
      <div className="view-mode-toggle" role="group" aria-label="截图显示模式">
        <button className={viewMode === "flat" ? "active" : ""} type="button" onClick={() => {
          if (focusedNode) { if (savedViewRef.current) savedViewRef.current.mode = "flat"; onLayerAction("exit-focus"); }
          setViewMode("flat");
        }}>2D</button>
        <button className={viewMode === "layers3d" ? "active" : ""} type="button" disabled={!canRender3d} onClick={() => setViewMode("layers3d")}>3D 层级</button>
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
        <button className="zoom-fit" type="button" onClick={fitView} disabled={!size} title="适应可见画布；收起属性栏可扩大视野">适应</button>
        <button className="zoom-reset" type="button" onClick={resetView} disabled={!size}>重置</button>
        {viewMode === "layers3d" && <button className="pin-layer-measurement" type="button" aria-pressed={measurementState.pinned}
          disabled={!measurementState.pinned && !measurementState.canPin}
          title={measurementState.pinned ? `测距已固定：${measurementState.summary} · M 或 Esc 解除` : measurementState.canPin ? `固定 ${measurementState.summary} · M` : "先选中一层，再指向另一层测距 · M 固定"}
          onClick={() => layerSceneRef.current?.toggleMeasurementPin()}>{measurementState.pinned ? "解除固定" : "固定测距"}</button>}
        {focusedNode && <button className="zoom-fit exit-layer-focus" type="button" onClick={() => onLayerAction("exit-focus")} title={`${layerFocus?.kind === "branch" ? "聚焦分支" : "仅看此层"}：${nodeDisplayLabel(focusedNode)} · Esc 退出`}>退出聚焦</button>}
        {viewMode === "layers3d" && hiddenNodeIds.size > 0 && <button className="restore-layers" type="button" onClick={() => onLayerAction("restore")} aria-label={workbenchCommands["restore-layers"].label} title={workbenchCommands["restore-layers"].label}>恢复图层 ({hiddenNodeIds.size})</button>}
      </div>
      {viewMode === "layers3d" && (
        <details className="layer-settings">
          <summary aria-label="3D 层级设置" title="3D 层级设置">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10" /><path d="M8 3v6m6 0v6M6 15v6" /></svg>
          </summary>
          <div className="layer-settings-body">
            <div className="layer-options" aria-label="3D 层级视图参数">
              <label className="layer-outline-label" title="关闭后仍显示选中、悬停和缺图轮廓">
                <span>普通轮廓</span>
                <input type="checkbox" checked={appearance.showOutlines} onChange={event => onAppearanceChange({ ...appearance, showOutlines: event.target.checked })} aria-label="显示普通轮廓" />
              </label>
              <label className="layer-highlight-label">
                <span>选中强调</span>
                <select aria-label="选中强调强度" value={appearance.highlightStrength}
                  onChange={event => onAppearanceChange({ ...appearance, highlightStrength: event.target.value as LayerAppearance["highlightStrength"] })}>
                  <option value="light">轻（仅边框）</option>
                  <option value="medium">中</option>
                  <option value="strong">强</option>
                </select>
              </label>
              <div className="layer-appearance-help"><span>缺图轮廓始终保留</span><button type="button" onClick={() => onAppearanceChange(DEFAULT_LAYER_APPEARANCE)}>恢复显示默认</button></div>
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
          </div>
        </details>
      )}
    </div>;

  return <>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" data-pan-ready={spacePressed || shiftPressed}
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
        const contextClick = gestureRef.current?.contextClick || event.button === 2;
        if (finishGesture(event)) return;
        // Open on release, not contextmenu: Windows emits contextmenu on press,
        // which would otherwise interrupt the existing right-button orbit drag.
        if (contextClick && viewMode === "layers3d") { void openLayerMenu(event.clientX, event.clientY); return; }
        const node = selectAtPoint(event, pressedNode);
        if (viewMode === "layers3d" && node) layerClickRef.current = { node, sameNode: previousClick?.node.id === node.id };
      }}
      onDoubleClick={(event) => {
        const click = layerClickRef.current;
        layerClickRef.current = null;
        if (viewMode !== "layers3d" || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || spacePressed) return;
        // Every plane shares one canvas: two clicks must hit the same node,
        // and neither may be a drag, pan, context click or empty-space click.
        if (click?.sameNode) {
          event.preventDefault();
          onDoubleClick(click.node);
        }
      }}
      onPointerCancel={finishGesture}
      onLostPointerCapture={finishGesture}
      onPointerLeave={() => { setShiftPressed(false); layerSceneRef.current?.clearHover(); }}>
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
            camera={camera}
            appearance={appearance}
            onSelect={onSelect}
            onCaptureGroup={onCaptureGroup}
            savedGroupImages={savedGroupImages}
            onFitScale={setSceneFitScale}
            onMeasurementStateChange={setMeasurementState}
          />
        )}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
    </div>
    {size && <p className={`screenshot-status ${integrity.status}`} role="status">
      {size.width}×{size.height} · {size.width > size.height ? "横屏" : size.width < size.height ? "竖屏" : "方形"} · {integrity.message}
      {viewMode === "layers3d" && canRender3d ? focusedNode ? ` · 聚焦：${nodeDisplayLabel(focusedNode)} · Esc 退出` : ` · 3D 全量展开 · 间距 ${camera.layerGap}px` : ""}
    </p>}
    {viewMode === "layers3d" && measurementState.pinned && <p className="screenshot-pinned-measurement" title={measurementState.summary ?? undefined}>测距已固定：{measurementState.summary} · M 或 Esc 解除</p>}
    {enabled && <p className="screenshot-hint">点击选中，双击{doubleClickAction === "focus-branch" ? "聚焦分支" : doubleClickAction === "toggle" ? "展开/收起" : "仅展开"}；悬停另一层测距（原始外框 px），M 固定/解除，Esc 解除；滚轮缩放，空格/Shift/中键平移；3D 左/右键拖动旋转，右键聚焦或隐藏。</p>}
  </>;
}
