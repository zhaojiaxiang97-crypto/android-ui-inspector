import type { PixelSize } from "../../../shared/types";
import type { LayerAppearance, LayerDisplayMode } from "./appearance";
import type { layerFraming } from "./framing";
import { LAYER_MOTION_FALLBACK_LIMIT, layerPlaneNodeId, motionProgress, sampleLayerMotion, type LayerMotion, type LayerMotionFrame } from "./motion";
import { cameraAtSceneScale, sceneCameraDistance } from "./scene-camera";
import type { SceneRuntimePorts } from "./scene-runtime-ports";
import type { LayerCamera, ProjectedPlane, Renderer, ScenePlane } from "./types";

export type SceneFrameInput = {
  target: LayerMotionFrame;
  motionContext: object;
  expanded: ReadonlySet<string>;
  parents: ReadonlyMap<string, string | null>;
  size: PixelSize;
  framingFrames: ReturnType<typeof layerFraming>["frames"];
  appearance: LayerAppearance;
  displayMode: LayerDisplayMode;
};
export type PaintedScene = { frame: LayerMotionFrame; camera: LayerCamera; projected: ProjectedPlane[] };

/** Owns the exact frame submitted to the renderer; all picking reads this snapshot. */
export class SceneFrameRuntime {
  private input: SceneFrameInput | null = null;
  private camera: LayerCamera | null = null;
  private motion: LayerMotion | null = null;
  private animation: number | null = null;
  private fallback: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private disposed = false;
  painted: PaintedScene | null = null;

  constructor(private ports: Pick<SceneRuntimePorts, "scheduler" | "draw">, private repaint: () => void) {}

  update(input: SceneFrameInput, camera: LayerCamera) {
    const previous = this.input;
    const same = previous?.motionContext === input.motionContext;
    const foldChanged = same && (previous.expanded.size !== input.expanded.size || [...input.expanded].some(id => !previous.expanded.has(id)));
    if (!same || foldChanged) {
      this.finishMotion();
      if (same && foldChanged && this.painted && !this.ports.scheduler.reducedMotion()) {
        this.motion = { from: this.painted.frame, started: this.ports.scheduler.now() };
        const generation = this.generation;
        this.fallback = this.ports.scheduler.setTimer(() => {
          if (this.disposed || generation !== this.generation) return;
          this.finishMotion(); this.repaint();
        }, LAYER_MOTION_FALLBACK_LIMIT);
      }
    }
    this.input = input; this.camera = camera;
  }

  setCamera(camera: LayerCamera) { this.camera = camera; }
  demandFrame() {
    if (!this.input || !this.camera) return null;
    const { target, size, framingFrames } = this.input;
    const distance = sceneCameraDistance(this.camera, size, framingFrames, target.presentation.center);
    return { frame: target, camera: cameraAtSceneScale(this.camera, distance, target.presentation.scale) };
  }
  get moving() { return this.motion !== null; }

  paint(renderer: Renderer): PaintedScene | null {
    const input = this.input, camera = this.camera;
    if (this.disposed || !input || !camera || !renderer.textureReady) return null;
    let motion = this.motion;
    const progress = motion ? motionProgress(motion.started, this.ports.scheduler.now()) : 1;
    if (motion && this.ports.scheduler.reducedMotion()) { this.finishMotion(); motion = null; }
    let frame = motion ? sampleLayerMotion(motion, input.target, input.parents, progress, plane => this.retiringReady(renderer, plane)) : input.target;
    if (motion && progress === 1 && !frame.planes.some(plane => plane.id.endsWith(":motion"))) {
      this.finishMotion(); motion = null; frame = input.target;
    }
    const distance = sceneCameraDistance(camera, input.size, input.framingFrames, input.target.presentation.center);
    const paintCamera = cameraAtSceneScale(camera, distance, frame.presentation.scale);
    const projected = { current: [] as ProjectedPlane[] };
    this.ports.draw(renderer, frame.planes, paintCamera, frame.presentation.pivot, projected, input.appearance, input.displayMode);
    // Publish only after the renderer has initialized its drawing dimensions.
    if (!renderer.cssWidth || !renderer.cssHeight) { this.painted = null; return null; }
    this.painted = { frame, camera: paintCamera, projected: projected.current };
    Object.assign(renderer.canvas.dataset, {
      layerAnimationProgress: motion ? progress.toFixed(3) : "1",
      layerRetiringCount: String(frame.planes.filter(plane => plane.id.endsWith(":motion")).length),
      layerPaintedDepths: JSON.stringify([...frame.presentation.depths]),
      layerCameraDistance: paintCamera.distance.toFixed(6), layerSceneDistance: distance.toFixed(6),
    });
    if (motion && progress < 1 && this.animation === null) {
      const generation = this.generation;
      this.animation = this.ports.scheduler.requestFrame(() => {
        if (this.disposed || generation !== this.generation) return;
        this.animation = null; this.repaint();
      });
    }
    return this.painted;
  }

  finishMotion() {
    this.generation++;
    if (this.animation !== null) this.ports.scheduler.cancelFrame(this.animation);
    if (this.fallback !== null) this.ports.scheduler.clearTimer(this.fallback);
    this.animation = null; this.fallback = null; this.motion = null;
  }
  invalidate() { this.finishMotion(); this.painted = null; }
  dispose() { if (this.disposed) return; this.disposed = true; this.invalidate(); }

  private retiringReady(renderer: Renderer, plane: ScenePlane) {
    const { target, parents } = this.input!;
    const id = layerPlaneNodeId(plane.id), targets = target.planes.filter(item => item.kind !== "selection" && item.kind !== "hover");
    let parentId: string | null | undefined = id;
    let parentPlane: ScenePlane | undefined;
    while (parentId && !parentPlane) {
      parentPlane = targets.find(item => layerPlaneNodeId(item.id) === parentId);
      if (!parentPlane) parentId = parents.get(parentId);
    }
    if (!parentPlane) return true;
    const loaded = (item: ScenePlane) => (item.kind !== "native" && item.kind !== "composite") || !item.textureSrc || renderer.layerTextures.has(item.textureSrc);
    if (parentId !== id || plane.kind !== "composite") return loaded(parentPlane);
    return targets.filter(item => {
      let ancestor: string | null | undefined = layerPlaneNodeId(item.id);
      while (ancestor && ancestor !== id) ancestor = parents.get(ancestor);
      return ancestor === id;
    }).every(loaded);
  }
}
