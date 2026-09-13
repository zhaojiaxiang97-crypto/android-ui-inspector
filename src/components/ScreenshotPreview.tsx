import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import type { CaptureGeometry, PixelSize, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { orbitFromDrag, orbitFromKeys, type OrbitCamera } from "../../shared/orbit-camera";
import { Layer3DPreview } from "./Layer3DPreview";
import type { LayerScope } from "../../shared/layer-layout";

type ViewMode = "flat" | "layers3d";

type Props = {
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  geometry?: CaptureGeometry;
  onSelect: (node: UiNode) => void;
};

type FrameSize = { width: number; height: number };
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
// Keep the initial 3D view front-facing. The depth stack, opacity and layer
// shadows still communicate hierarchy; rotation is an explicit gesture so a
// node selection never makes the whole device screen look tilted.
const DEFAULT_CAMERA: OrbitCamera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 32, panX: 0, panY: 0 };

function clampZoom(value: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

export function ScreenshotPreview(props: Props) {
  // Changing snapshots cannot reuse the preceding image's dimensions, camera,
  // gesture state or selected layer collection.
  return <LoadedScreenshot key={props.src} {...props} />;
}

function LoadedScreenshot({ src, root, selectedNode, geometry, onSelect }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const previousSelectedIdRef = useRef<string | null>(selectedNode?.id ?? null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [zoom, setZoom] = useState(1);
  const [camera, setCamera] = useState<OrbitCamera>(DEFAULT_CAMERA);
  const [scope, setScope] = useState<LayerScope>("focus");
  const [includeParents, setIncludeParents] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [spacePressed, setSpacePressed] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);

  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const selectedCanExpand = Boolean(enabled && selectedNode && selectedNode.id !== root.id && selectedNode.visibleToUser && selectedNode.bounds);
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;
  const rootSelected = selectedNode?.id === root.id;

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
          setCamera((current) => orbitFromKeys(current, event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"));
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
      gestureRef.current = null;
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
    if (selectedId === root.id) {
      setViewMode("flat");
    } else if (selectedCanExpand && selectedId !== previousSelectedIdRef.current) {
      setViewMode("layers3d");
    } else if (selectedCanExpand && previousSelectedIdRef.current === null) {
      setViewMode("layers3d");
    }
    if (selectedId !== previousSelectedIdRef.current) setSceneKey((value) => value + 1);
    previousSelectedIdRef.current = selectedId;
  }, [root.id, selectedCanExpand, selectedNode?.id]);

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

  function changeZoom(next: number, event?: WheelEvent<HTMLDivElement>) {
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
    setZoom(clampZoom(next));
  }

  function fitView() {
    zoomAnchorRef.current = null;
    setZoom(1);
    setCamera((current) => ({ ...current, panX: 0, panY: 0, azimuth: DEFAULT_CAMERA.azimuth, elevation: DEFAULT_CAMERA.elevation, roll: DEFAULT_CAMERA.roll }));
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function resetView() {
    fitView();
    setCamera(DEFAULT_CAMERA);
  }

  function selectAtPoint(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    if (event.button !== 0 || !event.isPrimary || !enabled || !size || !image || !image.complete || !image.naturalWidth) return;
    if (viewMode === "layers3d" && (event.target as HTMLElement).closest("[data-layer-node-id]")) return;
    const point = clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size);
    const node = point ? findNodeAtPoint(root, point.x, point.y, size) : null;
    if (node) onSelect(node);
  }

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed) || (event.button === 0 && event.shiftKey);
    const shouldRotate = viewMode === "layers3d" && (event.button === 2 || (event.button === 0 && event.altKey));
    if (!shouldPan && !shouldRotate) return;
    event.preventDefault();
    const frame = event.currentTarget;
    const gesture: Gesture = {
      pointerId: event.pointerId,
      kind: shouldRotate ? "rotate" : "pan",
      startX: event.clientX,
      startY: event.clientY,
      startPanX: camera.panX,
      startPanY: camera.panY,
      startAzimuth: camera.azimuth,
      startElevation: camera.elevation,
      moved: false,
    };
    gestureRef.current = gesture;
    frame.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gesture.moved = true;
    if (gesture.kind === "pan") {
      setCamera((current) => ({ ...current, panX: gesture.startPanX + dx, panY: gesture.startPanY + dy }));
    } else {
      setCamera((current) => orbitFromDrag({ ...current, azimuth: gesture.startAzimuth, elevation: gesture.startElevation }, dx, dy));
    }
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    const frame = frameRef.current;
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    return gesture.moved;
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(zoom * (event.deltaY < 0 ? 1.25 : 0.8), event);
  }

  const stageStyle: CSSProperties = {
    width: stageWidth,
    height: stageHeight,
    transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0)`,
    willChange: "transform",
  };

  const zoomPresetValue = ZOOM_PRESETS.find((preset) => Math.abs(preset - zoom) < 0.001);

  return <>
    <div className="screenshot-view-toolbar" aria-label="截图视图工具栏">
      <div className="view-mode-toggle" role="group" aria-label="截图显示模式">
        <button className={viewMode === "flat" ? "active" : ""} type="button" onClick={() => setViewMode("flat")}>2D</button>
        <button className={viewMode === "layers3d" ? "active" : ""} type="button" disabled={!selectedCanExpand} onClick={() => setViewMode("layers3d")}>3D 层级</button>
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
            <input type="range" min="20" max="64" step="4" value={camera.layerGap} onChange={(event) => setCamera((current) => ({ ...current, layerGap: Number(event.target.value) }))} aria-label="3D 层间距" />
          </label>
          <label className="layer-perspective-label">
            <span>视距 {camera.distance}px</span>
            <input type="range" min="720" max="1800" step="40" value={camera.distance} onChange={(event) => setCamera((current) => ({ ...current, distance: Number(event.target.value) }))} aria-label="3D 相机视距" />
          </label>
          <span className="orbit-label" aria-hidden="true">Orbit</span>
          <span className="orbit-readout" aria-live="polite">Yaw {Math.round(camera.azimuth)}° · Pitch {Math.round(camera.elevation)}°</span>
        </div>
      )}
      {viewMode === "layers3d" && (
        <details className="layer-settings">
          <summary>层级设置</summary>
          <div className="layer-settings-body" aria-label="3D 层级选项">
            <label><input type="checkbox" checked={includeParents} onChange={(event) => setIncludeParents(event.target.checked)} /> 包含父级</label>
            <label><input type="checkbox" checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} /> 包含子级</label>
            <label className="layer-scope-label">
              <span>范围</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as LayerScope)} aria-label="3D 层级范围">
                <option value="focus">焦点父子</option>
                <option value="branch">当前分支</option>
                <option value="all">全部层级</option>
              </select>
            </label>
          </div>
        </details>
      )}
    </div>
    <div className={`screenshot-frame ${viewMode === "layers3d" ? "layers3d-active" : ""}`} ref={frameRef} tabIndex={0} aria-label="截图工作区" onWheel={handleWheel} onContextMenu={(event) => { if (viewMode === "layers3d") event.preventDefault(); }}
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={(event) => { if (finishGesture(event)) return; selectAtPoint(event); }}
      onPointerCancel={finishGesture}>
      {viewMode === "layers3d" && selectedCanExpand && size && (
        <>
          <div className="viewport-grid" aria-hidden="true" />
          <div className="orbit-gizmo viewport-gizmo" aria-hidden="true">
            <span className="gizmo-axis gizmo-axis-x"><i>X</i></span>
            <span className="gizmo-axis gizmo-axis-y"><i>Y</i></span>
            <span className="gizmo-axis gizmo-axis-z"><i>Z</i></span>
          </div>
        </>
      )}
      <div className="screenshot-stage-shell" style={{ width: stageWidth, height: stageHeight }}>
        <div className={`screenshot-stage ${viewMode === "layers3d" ? "layers3d-base" : ""}`} data-coordinate-status={enabled ? integrity.status : failed ? "error" : size ? integrity.status : "loading"}
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
          {viewMode === "layers3d" && selectedCanExpand && size && (
            <Layer3DPreview
              key={`${sceneKey}-${selectedNode?.id ?? root.id}`}
              src={src}
              root={root}
              selectedNode={selectedNode}
              size={size}
              renderScale={renderScale}
              camera={camera}
              scope={scope}
              includeParents={includeParents}
              includeChildren={includeChildren}
              maxChildDepth={3}
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
    </div>
    {size && <p className={`screenshot-status ${integrity.status}`} role="status">
      {size.width}×{size.height} · {size.width > size.height ? "横屏" : size.width < size.height ? "竖屏" : "方形"} · {integrity.message}
      {viewMode === "layers3d" && selectedCanExpand ? ` · 3D 层级 · 间距 ${camera.layerGap}px` : ""}
    </p>}
    {enabled && <p className="screenshot-hint">点击截图可定位节点；Ctrl/⌘+滚轮缩放，空格/Shift/中键拖动平移，3D 模式下 Alt+左键或右键拖动环绕旋转。</p>}
  </>;
}
