import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CaptureGeometry, PixelSize, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { orbitFromDrag, orbitFromKeys, type OrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview, type LayerSceneHandle } from "./Layer3DPreview";

type ViewMode = "flat" | "layers3d";

type Props = {
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  geometry?: CaptureGeometry;
  toolbarHost?: HTMLElement | null;
  onSelect: (node: UiNode) => void;
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
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [0.5, 1, 2, 4, 8, 16] as const;
// A restrained oblique opening makes the layer order visible before the first drag.
const DEFAULT_CAMERA: OrbitCamera = { distance: 1100, azimuth: -32, elevation: 16, roll: 0, layerGap: 64, panX: 0, panY: 0 };

function clampZoom(value: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

export function ScreenshotPreview(props: Props) {
  // Changing snapshots cannot reuse the preceding image's dimensions, camera,
  // gesture state or selected layer collection.
  return <LoadedScreenshot key={props.src} {...props} />;
}

function LoadedScreenshot({ src, root, selectedNode, expandedNodeIds, geometry, toolbarHost, onSelect }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const layerSceneRef = useRef<LayerSceneHandle>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const previousSelectedIdRef = useRef<string | null>(null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const cameraRef = useRef<OrbitCamera>(DEFAULT_CAMERA);
  const cameraFrameRef = useRef<number | null>(null);
  const [sceneOrigin, setSceneOrigin] = useState<SceneOrigin>({ left: 0, top: 0 });
  const [spacePressed, setSpacePressed] = useState(false);

  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const canRender3d = Boolean(enabled && root.visibleToUser && root.bounds && root.children.length > 0);
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;

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
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && event.target instanceof HTMLElement && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
        event.preventDefault();
        setSpacePressed(true);
      }
      if (event.key === "Escape" && viewMode === "layers3d") setViewMode("flat");
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
      const gesture = gestureRef.current;
      const frame = frameRef.current;
      if (gesture && frame?.hasPointerCapture(gesture.pointerId)) frame.releasePointerCapture(gesture.pointerId);
      if (gesture?.moved) commitCamera(cameraRef.current);
      gestureRef.current = null;
      frame?.classList.remove("is-3d-dragging");
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
  }, [enabled, viewMode, zoom]);

  useEffect(() => {
    const selectedId = selectedNode?.id ?? null;
    if (!canRender3d) {
      setViewMode("flat");
    } else if (selectedId !== previousSelectedIdRef.current || previousSelectedIdRef.current === null) {
      setViewMode("layers3d");
    }
    previousSelectedIdRef.current = selectedId;
  }, [canRender3d, selectedNode?.id]);

  const fitScale = useMemo(() => {
    if (!size || !validSize(size)) return 0;
    const availableWidth = frameSize.width > 0 ? Math.max(1, frameSize.width - 30) : Number.POSITIVE_INFINITY;
    // Keep the established inspector maximum so a portrait phone remains
    // legible while the new zoom controls can grow beyond it deliberately.
    return Math.min(1, 400 / size.height, availableWidth / size.width);
  }, [frameSize.width, size]);
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
    setZoom(nextZoom);
  }

  function fitView() {
    zoomAnchorRef.current = null;
    zoomRef.current = 1;
    setZoom(1);
    commitCamera({ ...cameraRef.current, panX: 0, panY: 0, azimuth: DEFAULT_CAMERA.azimuth, elevation: DEFAULT_CAMERA.elevation, roll: DEFAULT_CAMERA.roll });
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function resetView() {
    fitView();
    commitCamera(DEFAULT_CAMERA);
  }

  function selectAtPoint(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    if (event.button !== 0 || !event.isPrimary || !enabled || !size || !image || !image.complete || !image.naturalWidth) return;
    if (viewMode === "layers3d") {
      const layer = layerSceneRef.current?.pick(event.clientX, event.clientY);
      if (layer) {
        layerSceneRef.current?.clearHover();
        onSelect(layer);
        return;
      }
    }
    if (viewMode === "layers3d" && (event.target as HTMLElement).closest("[data-layer-node-id]")) return;
    const point = clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size);
    const node = point ? findNodeAtPoint(root, point.x, point.y, size) : null;
    if (node) onSelect(node);
  }

  function startGesture(event: PointerEvent<HTMLDivElement>) {
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
    };
    gestureRef.current = gesture;
    if (viewMode === "layers3d") frame.classList.add("is-3d-dragging");
    frame.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gesture.moved = true;
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
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    frame?.classList.remove("is-3d-dragging");
    if (gesture.moved) commitCamera(cameraRef.current);
    return gesture.moved;
  }

  function handleWheel(event: WheelEvent) {
    if (!enabled || event.deltaY === 0) return;
    event.preventDefault();
    changeZoom(zoomRef.current * (event.deltaY < 0 ? 1.25 : 0.8), event);
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
        <button className={viewMode === "flat" ? "active" : ""} type="button" onClick={() => setViewMode("flat")}>2D</button>
        <button className={viewMode === "layers3d" ? "active" : ""} type="button" disabled={!canRender3d} onClick={() => setViewMode("layers3d")}>3D 层级</button>
      </div>
      <div className="zoom-controls" role="group" aria-label="截图缩放">
        <button type="button" aria-label="缩小截图" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={!size || zoom <= MIN_ZOOM}>−</button>
        <span className="zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="放大截图" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={!size || zoom >= MAX_ZOOM}>＋</button>
        <select className="zoom-preset-select" aria-label="截图倍率预设" value={zoomPresetValue ? String(zoomPresetValue) : "custom"} onChange={(event) => {
          if (event.target.value !== "custom") changeZoom(Number(event.target.value));
        }} disabled={!size}>
          <option value="custom">自定义</option>
          {ZOOM_PRESETS.map((preset) => <option value={preset} key={preset}>{Math.round(preset * 100)}%</option>)}
        </select>
        <button className="zoom-fit" type="button" onClick={fitView} disabled={!size}>适应</button>
        <button className="zoom-reset" type="button" onClick={resetView} disabled={!size}>重置</button>
      </div>
      {viewMode === "layers3d" && (
        <div className="layer-options" aria-label="3D 层级视图参数">
          <label className="layer-gap-label">
            <span>层间距 {camera.layerGap}px</span>
            <input type="range" min="24" max="128" step="8" value={camera.layerGap} onChange={(event) => commitCamera({ ...cameraRef.current, layerGap: Number(event.target.value) })} aria-label="3D 层间距" />
          </label>
          <label className="layer-perspective-label">
            <span>视距 {camera.distance}px</span>
            <input type="range" min="720" max="1800" step="40" value={camera.distance} onChange={(event) => commitCamera({ ...cameraRef.current, distance: Number(event.target.value) })} aria-label="3D 相机视距" />
          </label>
          <span className="orbit-label" aria-hidden="true">Orbit</span>
          <span className="orbit-readout" aria-live="polite">Yaw {Math.round(camera.azimuth)}° · Pitch {Math.round(camera.elevation)}°</span>
          <span className="window-stack-label" title="截图中的全部可见层">全量展开总览</span>
        </div>
      )}
    </div>;

  return <>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" onContextMenu={(event) => { if (viewMode === "layers3d") event.preventDefault(); }}
      onPointerDown={startGesture}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => { if (finishGesture(event)) return; selectAtPoint(event); }}
      onPointerCancel={finishGesture}
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
            size={size}
            renderScale={renderScale}
            origin={sceneOrigin}
            camera={camera}
            onSelect={onSelect}
          />
        )}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
    </div>
    {size && <p className={`screenshot-status ${integrity.status}`} role="status">
      {size.width}×{size.height} · {size.width > size.height ? "横屏" : size.width < size.height ? "竖屏" : "方形"} · {integrity.message}
      {viewMode === "layers3d" && canRender3d ? ` · 3D 全量展开 · 间距 ${camera.layerGap}px` : ""}
    </p>}
    {enabled && <p className="screenshot-hint">点击截图可定位节点；鼠标滚轮缩放，空格/Shift/中键拖动平移，3D 模式下左键或右键拖动环绕旋转。</p>}
  </>;
}
