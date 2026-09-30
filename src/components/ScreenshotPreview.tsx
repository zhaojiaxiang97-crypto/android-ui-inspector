import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CaptureGeometry, PixelSize, QmlGroupImage, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";
import { flattenNodes, nodeDisplayLabel, remapViewNodeIds } from "../../shared/tree-utils";
import { orbitFromDrag, orbitFromKeys, type OrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview, type LayerSceneHandle } from "./Layer3DPreview";

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
  onExpand?: (node: UiNode) => void;
  onCaptureGroup?: (node: UiNode) => Promise<QmlGroupImage | null>;
};

type FrameSize = { width: number; height: number };
type SceneOrigin = { left: number; top: number };
type ZoomAnchor = { imageX: number; imageY: number; clientX: number; clientY: number };
type Gesture = {
  pointerId: number;
  kind: "pan" | "rotate";
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
const DRAG_THRESHOLD = 4;
const ZOOM_PRESETS = [0.5, 1, 2, 4, 8, 16] as const;
// Open from the front-left: controls fan left, with the page stack behind them.
const DEFAULT_CAMERA: OrbitCamera = { distance: 1100, azimuth: 40, elevation: 12, roll: 0, layerGap: 96, panX: 0, panY: 0 };

function clampZoom(value: number) {
  // Keep tiny pinch deltas; only the displayed percentage should be rounded.
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function ScreenshotPreview(props: Props) {
  // A capture may replace its preview image while keeping the same camera.
  return <LoadedScreenshot key={props.sessionKey ?? props.src} {...props} />;
}

function LoadedScreenshot({ sessionKey, src, root, selectedNode, expandedNodeIds, geometry, layersAvailable = true, toolbarHost, onSelect, onExpand, onCaptureGroup }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const layerSceneRef = useRef<LayerSceneHandle>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const layerClickRef = useRef<{ node: UiNode; sameNode: boolean } | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const previousSelectedIdRef = useRef<string | null>(null);
  const menuRequestRef = useRef(0);
  const [hiddenNodeIds, setHiddenNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedNode, setFocusedNode] = useState<UiNode | null>(null);
  const previousRootRef = useRef(root);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [zoom, setZoom] = useState(1);
  const [sceneFitScale, setSceneFitScale] = useState<number | null>(null);
  const zoomRef = useRef(1);
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const cameraRef = useRef<OrbitCamera>(DEFAULT_CAMERA);
  const cameraFrameRef = useRef<number | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [sceneOrigin, setSceneOrigin] = useState<SceneOrigin>({ left: 0, top: 0 });
  const [spacePressed, setSpacePressed] = useState(false);

  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const canRender3d = Boolean(layersAvailable && enabled && root.visibleToUser && root.bounds && root.children.length > 0);
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;

  useEffect(() => {
    layerClickRef.current = null;
    setHiddenNodeIds(new Set());
    setFocusedNode(null);
    setMenuError(null);
    return () => { menuRequestRef.current++; };
  }, [sessionKey ?? root]);

  useEffect(() => {
    const nodes = flattenNodes(root);
    const remap = remapViewNodeIds(previousRootRef.current, root);
    previousRootRef.current = root;
    setFocusedNode((current) => current ? nodes.get(remap.get(current.id) ?? "") ?? null : null);
    setHiddenNodeIds((current) => {
      const kept = new Set([...current].map(id => remap.get(id)).filter((id): id is string => Boolean(id)));
      return kept.size === current.size && [...current].every(id => kept.has(id)) ? current : kept;
    });
  }, [root]);

  async function openLayerMenu(clientX?: number, clientY?: number) {
    if (viewMode !== "layers3d" || !enabled) return;
    const node = clientX !== undefined && clientY !== undefined ? layerSceneRef.current?.pick(clientX, clientY) : selectedNode;
    const canHide = Boolean(node?.visibleToUser && node.bounds && !hiddenNodeIds.has(node.id));
    if (!canHide && hiddenNodeIds.size === 0 && !focusedNode) return;
    if (node && canHide) onSelect(node);
    const request = ++menuRequestRef.current;
    setMenuError(null);
    try {
      const action = await window.electronApi.showLayerMenu(canHide, hiddenNodeIds.size > 0, Boolean(focusedNode));
      if (request !== menuRequestRef.current || !frameRef.current) return;
      layerSceneRef.current?.clearHover();
      if (action === "hide" && node && canHide) setHiddenNodeIds((current) => new Set([...current, node.id]));
      if (action === "restore") setHiddenNodeIds(new Set());
      if (action === "focus" && node && canHide) changeLayerFocus(node);
      if (action === "exit-focus") changeLayerFocus(null);
    } catch {
      if (request === menuRequestRef.current && frameRef.current) setMenuError("无法打开图层菜单，请重新启动程序后重试。");
    }
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
    const update = () => setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

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
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && event.target instanceof HTMLElement && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
        event.preventDefault();
        setSpacePressed(true);
      }
      if (event.key === "Escape" && viewMode === "layers3d") {
        if (focusedNode) { event.preventDefault(); changeLayerFocus(null); }
        else setViewMode("flat");
      }
      const screenshotFocused = Boolean(frameRef.current && event.target instanceof Node && frameRef.current.contains(event.target));
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
      if (!enabled || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
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
    };
    const onWindowBlur = () => {
      layerClickRef.current = null;
      const gesture = gestureRef.current;
      const frame = frameRef.current;
      gestureRef.current = null;
      if (gesture && frame?.hasPointerCapture(gesture.pointerId)) frame.releasePointerCapture(gesture.pointerId);
      if (gesture?.moved) commitCamera(cameraRef.current);
      frame?.classList.remove("is-3d-dragging");
      if (frame) delete frame.dataset.gesture;
      layerSceneRef.current?.clearHover();
      setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [enabled, viewMode, zoom, focusedNode]);

  useEffect(() => {
    const selectedId = selectedNode?.id ?? null;
    if (!canRender3d) {
      setViewMode("flat");
    } else if (selectedId !== previousSelectedIdRef.current || previousSelectedIdRef.current === null) {
      setViewMode("layers3d");
    }
    previousSelectedIdRef.current = selectedId;
  }, [canRender3d, selectedNode?.id]);

  const flatFitScale = useMemo(() => {
    if (!size || !validSize(size)) return 0;
    const availableWidth = frameSize.width > 0 ? Math.max(1, frameSize.width - 30) : Number.POSITIVE_INFINITY;
    // Keep the established inspector maximum so a portrait phone remains
    // legible while the new zoom controls can grow beyond it deliberately.
    return Math.min(1, 400 / size.height, availableWidth / size.width);
  }, [frameSize.width, size]);
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
    zoomAnchorRef.current = null;
    zoomRef.current = 1;
    setZoom(1);
    commitCamera({ ...cameraRef.current, panX: 0, panY: 0, azimuth: DEFAULT_CAMERA.azimuth, elevation: DEFAULT_CAMERA.elevation, roll: DEFAULT_CAMERA.roll });
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function resetView() {
    fitView();
    commitCamera(DEFAULT_CAMERA);
  }

  function changeLayerFocus(node: UiNode | null) {
    menuRequestRef.current++;
    layerClickRef.current = null;
    layerSceneRef.current?.clearHover();
    setFocusedNode(node);
    zoomAnchorRef.current = null;
    changeZoom(1);
    commitCamera({ ...cameraRef.current, panX: 0, panY: 0 });
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

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
    if (!event.isPrimary || gestureRef.current) return;
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed) || (event.button === 0 && event.shiftKey);
    const shouldRotate = viewMode === "layers3d" && (event.button === 2 || event.button === 0);
    if (!shouldPan && !shouldRotate) return;
    event.preventDefault();
    const frame = event.currentTarget;
    const currentCamera = cameraRef.current;
    const gesture: Gesture = {
      pointerId: event.pointerId,
      kind: shouldPan ? "pan" : "rotate",
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
    } else {
      scheduleCameraPaint(orbitFromDrag({ ...cameraRef.current, azimuth: gesture.startAzimuth, elevation: gesture.startElevation }, dx, dy));
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (gestureRef.current) {
      moveGesture(event);
      return;
    }
    if (viewMode === "layers3d") layerSceneRef.current?.hover(event.clientX, event.clientY);
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    const frame = frameRef.current;
    gestureRef.current = null;
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    if (gesture.moved) commitCamera(cameraRef.current);
    if (event.type !== "pointerup") {
      layerClickRef.current = null;
      layerSceneRef.current?.clearHover();
    } else if (gesture.moved && frame?.contains(document.elementFromPoint(event.clientX, event.clientY))) layerSceneRef.current?.hover(event.clientX, event.clientY);
    return gesture.moved || gesture.kind === "pan" || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= DRAG_THRESHOLD;
  }

  function handleWheel(event: WheelEvent) {
    if (!enabled || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    // Chromium delivers trackpad pinch as Ctrl+wheel with small pixel deltas.
    const factor = event.ctrlKey
      ? Math.exp(-event.deltaY * PINCH_ZOOM_SENSITIVITY)
      : event.deltaY < 0 ? 1.25 : 0.8;
    changeZoom(zoomRef.current * factor, event);
  }

  const stageStyle: CSSProperties = {
    width: stageWidth,
    height: stageHeight,
    transform: `var(--layer-live-pan, translate3d(${camera.panX}px, ${camera.panY}px, 0))`,
    willChange: "transform",
  };
  const stageShellStyle: CSSProperties = viewMode === "layers3d"
    ? { width: "100%", height: "100%" }
    : { width: stageWidth, height: stageHeight };

  const zoomPresetValue = ZOOM_PRESETS.find((preset) => Math.abs(preset - zoom) < 0.001);

  const toolbar = <div className="screenshot-view-toolbar" aria-label="截图视图工具栏">
      <div className="view-mode-toggle" role="group" aria-label="截图显示模式">
        <button className={viewMode === "flat" ? "active" : ""} type="button" onClick={() => { if (focusedNode) changeLayerFocus(null); setViewMode("flat"); }}>2D</button>
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
        <button className="zoom-fit" type="button" onClick={fitView} disabled={!size}>适应</button>
        <button className="zoom-reset" type="button" onClick={resetView} disabled={!size}>重置</button>
        {focusedNode && <button className="zoom-fit exit-layer-focus" type="button" onClick={() => changeLayerFocus(null)} title={`正在聚焦：${nodeDisplayLabel(focusedNode)} · Esc 退出`}>退出聚焦</button>}
        {viewMode === "layers3d" && hiddenNodeIds.size > 0 && <button className="restore-layers" type="button" onClick={() => setHiddenNodeIds(new Set())} aria-label="恢复所有隐藏图层">恢复图层 ({hiddenNodeIds.size})</button>}
      </div>
      {viewMode === "layers3d" && (
        <details className="layer-settings">
          <summary aria-label="3D 层级设置">⋯</summary>
          <div className="layer-settings-body">
            <div className="layer-options" aria-label="3D 层级视图参数">
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
              <span className="window-stack-label" title={focusedNode ? nodeDisplayLabel(focusedNode) : "截图中的全部可见层"}>{focusedNode ? "单控件聚焦" : "全量展开总览"}</span>
            </div>
          </div>
        </details>
      )}
    </div>;

  return <>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" onContextMenu={(event) => { if (viewMode === "layers3d") event.preventDefault(); }}
      onKeyDown={(event) => {
        if (viewMode === "layers3d" && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          void openLayerMenu();
        }
      }}
      onPointerDown={startGesture}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
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
        if (click?.sameNode && click.node.children.length > 0 && !expandedNodeIds.has(click.node.id)) {
          event.preventDefault();
          onExpand?.(click.node);
        }
      }}
      onPointerCancel={finishGesture}
      onLostPointerCapture={finishGesture}
      onPointerLeave={() => layerSceneRef.current?.clearHover()}>
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
            src={src}
            root={root}
            selectedNode={selectedNode}
            expandedNodeIds={expandedNodeIds}
            hiddenNodeIds={hiddenNodeIds}
            focusedNode={focusedNode}
            size={size}
            renderScale={renderScale}
            origin={sceneOrigin}
            camera={camera}
            onSelect={onSelect}
            onCaptureGroup={onCaptureGroup}
            onFitScale={setSceneFitScale}
          />
        )}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
    </div>
    {size && <p className={`screenshot-status ${integrity.status}`} role="status">
      {size.width}×{size.height} · {size.width > size.height ? "横屏" : size.width < size.height ? "竖屏" : "方形"} · {integrity.message}
      {viewMode === "layers3d" && canRender3d ? focusedNode ? ` · 聚焦：${nodeDisplayLabel(focusedNode)} · Esc 退出` : ` · 3D 全量展开 · 间距 ${camera.layerGap}px` : ""}
    </p>}
    {menuError && <p className="screenshot-status mismatch" role="alert">{menuError}</p>}
    {enabled && <p className="screenshot-hint">点击选中，双击父层级展开；悬停另一层测距（原始外框 px，不含展开层距）；滚轮缩放，空格/Shift/中键平移；3D 左/右键拖动旋转，右键聚焦或隐藏。</p>}
  </>;
}
