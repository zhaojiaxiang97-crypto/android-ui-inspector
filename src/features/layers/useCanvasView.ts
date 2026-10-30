import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PixelSize, UiNode } from "../../../shared/types";
import { validSize } from "../../../shared/screen-coordinates";
import { cameraForLayerPreset, constrainOrbitCamera, DEFAULT_ORBIT_CAMERA, type LayerViewPreset, type OrbitCamera } from "../../../shared/orbit-camera";
import type { LayerSceneHandle, LayerMeasurementState } from "./types";
import type { LayerAppearance } from "./appearance";
import type { LayerFramingScope } from "./framing";
import type { usePreviewViewport } from "./usePreviewViewport";
import { LAYER_MOTION_DURATION } from "./motion";
import { createCanvasCamera } from "./canvas-camera";

export type CanvasViewMode = "flat" | "layers3d";
export type CanvasSurface = {
  frameRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  layerSceneRef: RefObject<LayerSceneHandle | null>;
};
export const MIN_ZOOM = 0.25, MAX_ZOOM = 16, ZOOM_STEP = 0.25;
export const ZOOM_PRESETS = [0.5, 1, 2, 4, 8, 16] as const;
const DEFAULT_CAMERA = DEFAULT_ORBIT_CAMERA;
type ZoomAnchor = {
  imageX: number; imageY: number; clientX: number; clientY: number;
  src: string; width: number; height: number; mode: CanvasViewMode; focus: string | null;
};
const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

/** Owns persistent view state and all camera, zoom, scroll and mode scheduling. */
export function useCanvasView({ surface, content, layout, appearance, onCancelGesture, measurementMode, onExitFocus, onToggleStructure }: {
  surface: CanvasSurface;
  content: { root: UiNode; src: string; focusKey: string | null; focusedNode: UiNode | null; selectedId: string | null; enabled: boolean; canRender3d: boolean; preferFlat?: boolean };
  layout: { size: PixelSize | null; frameSize: ReturnType<typeof usePreviewViewport> };
  appearance: LayerAppearance;
  onCancelGesture: () => void;
  measurementMode: () => LayerMeasurementState["mode"];
  onExitFocus: () => void;
  onToggleStructure: () => void;
}) {
  const { frameRef, stageRef, imageRef, layerSceneRef } = surface;
  const { root, src, focusKey, focusedNode, selectedId, enabled, canRender3d } = content;
  const { size, frameSize } = layout;
  const viewport = frameSize.visible;
  const [viewMode, setViewMode] = useState<CanvasViewMode>("flat");
  const viewChoiceRef = useRef<CanvasViewMode | null>(content.preferFlat ? "flat" : null);
  const previousSelectedIdRef = useRef<string | null>(null);
  const previousFocusKey = useRef<string | null>(null);
  const savedViewRef = useRef<{ mode: CanvasViewMode; zoom: number; camera: OrbitCamera; left: number; top: number } | null>(null);
  const restoringViewRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollRestore = useRef<{ left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [camera, setCamera] = useState(() => constrainOrbitCamera(DEFAULT_CAMERA, appearance.rotationMode));
  const rotationModeRef = useRef(appearance.rotationMode);
  const [cameraControl] = useState(() => createCanvasCamera(camera, appearance.rotationMode, {
    paint: next => {
      stageRef.current?.style.setProperty("--layer-live-pan", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
      const frame = frameRef.current;
      if (frame) {
        frame.dataset.cameraPaintAzimuth = String(next.azimuth);
        frame.dataset.cameraPaintElevation = String(next.elevation);
        frame.dataset.cameraPaintRoll = String(next.roll);
        frame.dataset.cameraPaintDistance = String(next.distance);
        frame.dataset.cameraPaintLayerGap = String(next.layerGap);
      }
      layerSceneRef.current?.paintCamera(next);
    },
    commit: setCamera,
    progress: progress => { if (frameRef.current) frameRef.current.dataset.cameraMotionProgress = progress === 1 ? "1" : progress.toFixed(3); },
  }, { request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id), now: () => performance.now(),
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches }));
  const previousModeRef = useRef(viewMode);
  const modeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomEpoch = useRef(0), scrollEpoch = useRef(0), modeEpoch = useRef(0);
  const [sceneFitScale, setSceneFitScale] = useState<number | null>(null);
  const [framingScope, setFramingScope] = useState<LayerFramingScope>("screen");
  const sceneFitViewportRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const [sceneOrigin, setSceneOrigin] = useState({ left: 0, top: 0 });
  const structureFitPending = useRef(false);
  const commitCamera = cameraControl.commit;
  const interruptCameraMotion = cameraControl.interrupt;
  const normalizeCamera = (next: OrbitCamera) => constrainOrbitCamera(next, rotationModeRef.current);
  const animateCamera = (next: OrbitCamera) => cameraControl.animate(next, viewMode === "layers3d");
  const cancelGesture = onCancelGesture;
  function cancelModeMotion() {
    modeEpoch.current++;
    if (modeTimerRef.current !== null) clearTimeout(modeTimerRef.current);
    modeTimerRef.current = null;
    if (frameRef.current) delete frameRef.current.dataset.modeMotion;
  }

  useEffect(() => cameraControl.repaint(camera), [camera]);
  useLayoutEffect(() => {
    if (rotationModeRef.current === appearance.rotationMode) return;
    rotationModeRef.current = appearance.rotationMode;
    if (savedViewRef.current) savedViewRef.current.camera = normalizeCamera(savedViewRef.current.camera);
    cameraControl.setRotationMode(appearance.rotationMode);
  }, [appearance.rotationMode]);

  useLayoutEffect(() => {
    interruptCameraMotion();
    cancelModeMotion();
    const changed = previousModeRef.current !== viewMode;
    previousModeRef.current = viewMode;
    if (!changed || !enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (frameRef.current) frameRef.current.dataset.modeMotion = viewMode;
    const epoch = modeEpoch.current;
    modeTimerRef.current = setTimeout(() => { if (epoch === modeEpoch.current) cancelModeMotion(); }, LAYER_MOTION_DURATION);
    return cancelModeMotion;
  }, [viewMode, root, src, focusKey, enabled]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => { if (preference.matches) { cameraControl.finishMotion(); cancelModeMotion(); } };
    preference.addEventListener?.("change", changed);
    return () => preference.removeEventListener?.("change", changed);
  }, []);

  function cancelZoomFrame() {
    zoomEpoch.current++;
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = null;
  }
  function cancelScrollFrame() {
    scrollEpoch.current++;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }
  function discardScrollRestore() {
    cancelScrollFrame();
    pendingScrollRestore.current = null;
  }
  function restoreScroll(position: { left: number; top: number }) {
    cancelScrollFrame();
    pendingScrollRestore.current = position;
    const epoch = scrollEpoch.current;
    scrollFrameRef.current = requestAnimationFrame(() => {
      if (epoch !== scrollEpoch.current) return;
      scrollFrameRef.current = null;
      pendingScrollRestore.current = null;
      frameRef.current?.scrollTo({ ...position, behavior: "auto" });
    });
  }
  function currentZoomAnchor(anchor: ZoomAnchor) {
    return anchor.src === src && anchor.width === size?.width && anchor.height === size?.height
      && anchor.mode === viewMode && anchor.focus === focusKey;
  }
  // Context changes preserve the current view but invalidate work queued for old content.
  useLayoutEffect(() => {
    // A root-only update keeps the same image coordinates, so preserve its pending
    // zoom anchor. Other content/view changes invalidate the anchor before applying scale.
    const anchor = zoomAnchorRef.current;
    if (anchor && (!enabled || !currentZoomAnchor(anchor))) zoomAnchorRef.current = null;
    if (zoomRef.current !== zoom) setZoom(zoomRef.current);
    // A same-session image/tree replacement may arrive before focus-exit scrolling.
    // Keep that intent, but schedule a fresh callback for the new content.
    if (!focusKey && pendingScrollRestore.current) restoreScroll(pendingScrollRestore.current);
    return () => {
      cameraControl.cancelPending(); cancelModeMotion();
      cancelZoomFrame(); cancelScrollFrame();
    };
  }, [root, src, focusKey, enabled]);
  useLayoutEffect(() => () => { discardScrollRestore(); zoomAnchorRef.current = null; }, []);
  useEffect(() => {
    if (restoringViewRef.current) { restoringViewRef.current = false; previousSelectedIdRef.current = selectedId; return; }
    if (!canRender3d) {
      setViewMode("flat");
    } else if (viewChoiceRef.current !== "flat" && measurementMode() === "off" && !focusedNode && (selectedId !== previousSelectedIdRef.current || previousSelectedIdRef.current === null)) {
      setViewMode("layers3d");
    }
    previousSelectedIdRef.current = selectedId;
  }, [canRender3d, selectedId, focusedNode]);

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
    if (!currentZoomAnchor(anchor)) { zoomAnchorRef.current = null; return; }
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
        zoomAnchorRef.current = { imageX, imageY, clientX, clientY, src, width: size.width, height: size.height, mode: viewMode, focus: focusKey };
      }
    }
    const nextZoom = clampZoom(next);
    zoomRef.current = nextZoom;
    if (event) {
      // Accumulate every pinch delta, but rebuild React/scene geometry only once
      // per display frame, including high-rate trackpads.
      if (zoomFrameRef.current === null) {
        const epoch = zoomEpoch.current;
        zoomFrameRef.current = requestAnimationFrame(() => {
          if (epoch !== zoomEpoch.current) return;
          zoomFrameRef.current = null;
          setZoom(zoomRef.current);
        });
      }
    } else {
      cancelZoomFrame();
      setZoom(nextZoom);
    }
  }

  function fitView() {
    discardScrollRestore();
    cancelGesture();
    zoomAnchorRef.current = null;
    changeZoom(1);
    commitCamera({ ...cameraControl.read(), panX: 0, panY: 0 });
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  const previousOffscreen = useRef(appearance.showOffscreen);
  useLayoutEffect(() => {
    const turningOff = previousOffscreen.current && !appearance.showOffscreen;
    previousOffscreen.current = appearance.showOffscreen;
    // Enabling offscreen exploration preserves the user's current camera.
    // Disabling it returns from any panned/overview state to the screen.
    if (turningOff) { setFramingScope("screen"); fitView(); }
  }, [appearance.showOffscreen]);

  function changeFramingScope(scope: LayerFramingScope) {
    setFramingScope(scope);
    fitView();
  }

  function resetView() {
    discardScrollRestore();
    cancelGesture();
    zoomAnchorRef.current = null;
    changeZoom(1);
    animateCamera(DEFAULT_CAMERA);
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function applyLayerPreset(preset: LayerViewPreset) {
    discardScrollRestore();
    cancelGesture();
    zoomAnchorRef.current = null;
    changeZoom(1);
    commitCamera(cameraForLayerPreset(cameraControl.read(), preset, appearance.rotationMode));
    // The preset is a viewport operation; preserve selection, tree expansion,
    // image mode and saved appearance. New spacing fits after React lays it out.
    layerSceneRef.current?.fit();
    frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
  }

  function toggleCompleteStructure() {
    onToggleStructure();
    // The explicit structure command restores a level viewing angle, while
    // preserving the user's yaw, gap, hidden nodes and tree expansion.
    commitCamera({ ...cameraControl.read(), elevation: 0, roll: 0 });
    structureFitPending.current = true;
  }
  useLayoutEffect(() => {
    if (!structureFitPending.current) return;
    structureFitPending.current = false;
    fitView();
  }, [appearance.showEmpty, appearance.structureMode, appearance.showOutlines]);

  useLayoutEffect(() => {
    if (focusKey === previousFocusKey.current) return;
    previousFocusKey.current = focusKey;
    discardScrollRestore();
    layerSceneRef.current?.clearHover();
    zoomAnchorRef.current = null;
    cancelZoomFrame();
    if (focusKey) {
      savedViewRef.current ??= { mode: viewMode, zoom: zoomRef.current, camera: { ...normalizeCamera(cameraControl.read()) },
        left: frameRef.current?.scrollLeft ?? 0, top: frameRef.current?.scrollTop ?? 0 };
      setViewMode("layers3d");
      changeZoom(1);
      commitCamera({ ...cameraControl.read(), panX: 0, panY: 0 });
      frameRef.current?.scrollTo({ left: 0, top: 0, behavior: "auto" });
    } else {
      const saved = savedViewRef.current;
      savedViewRef.current = null;
      if (!saved) return;
      restoringViewRef.current = true;
      setViewMode(saved.mode);
      changeZoom(saved.zoom);
      commitCamera(saved.camera);
      restoreScroll({ left: saved.left, top: saved.top });
    }
  }, [focusKey]);

  function handleWheel(event: WheelEvent) {
    if (event.target instanceof Element && event.target.closest(".quick-select-panel, .measurement-card")) return;
    if (!enabled || viewMode === "flat" && !imageRef.current?.naturalWidth || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frameRef.current?.clientHeight || 400 : 1);
    const factor = event.ctrlKey || event.deltaMode === 0 && Math.abs(event.deltaY) < 40
      ? Math.exp(-pixels * (event.ctrlKey ? 0.005 : 0.002)) : pixels < 0 ? 1.25 : 0.8;
    changeZoom(zoomRef.current * factor, event);
  }
  // The listener always uses the current viewport, view mode and image size.
  const wheelRef = useRef(handleWheel);
  wheelRef.current = handleWheel;
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const wheel = (event: WheelEvent) => wheelRef.current(event);
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => frame.removeEventListener("wheel", wheel);
  }, []);

  function chooseMode(mode: CanvasViewMode) {
    if (mode === "flat" && focusedNode) {
      if (savedViewRef.current) savedViewRef.current.mode = "flat";
      onExitFocus();
    }
    viewChoiceRef.current = mode; setViewMode(mode);
  }
  return {
    viewMode, camera, zoom, framingScope, sceneOrigin, sceneFitScale, sceneFitViewportRef,
    renderScale, stageWidth, stageHeight, onFitScale: setSceneFitScale,
    cameraControl, commitCamera, changeZoom, fitView, resetView, applyLayerPreset, toggleCompleteStructure,
    changeFramingScope, chooseMode, exit3d: () => setViewMode("flat"),
    interrupt: () => { interruptCameraMotion(); cancelModeMotion(); },
  };
}
export type CanvasView = ReturnType<typeof useCanvasView>;
