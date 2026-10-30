import type { UiNode } from "../../../shared/types";
import type { LayerCamera, Rect, Renderer, RendererStatus } from "./types";
import { layerDemandOrder } from "./demand";
import { SceneFrameRuntime, type SceneFrameInput } from "./scene-frame-runtime";
import { SceneGroupRuntime, type SceneGroups, type SceneResourceContext } from "./scene-group-runtime";
import { SceneTextureRuntime, type TextureDemand } from "./scene-texture-runtime";
import type { SceneRuntimePorts } from "./scene-runtime-ports";

export type SceneDemandInput = { textures: ReadonlyMap<string, TextureDemand>; groups: ReadonlyMap<string, UiNode>; visibility: string; selectedId?: string; viewport: Rect };
export type SceneRuntimeEvents = { status(status: RendererStatus): void; warning(message: string | null): void; groups(state: SceneGroups): void; painted(): void };

/** Renderer lifetime is the authority for GPU work; tree lifetime is the authority for captures. */
export class LayerSceneRuntime {
  private renderer: Renderer | null = null;
  private textures: SceneTextureRuntime | null = null;
  private groups: SceneGroupRuntime | null = null;
  private screenshotCancel: (() => void) | null = null;
  private imageGeneration = 0;
  private lost = false;
  private disposed = false;
  private demand: SceneDemandInput | null = null;
  readonly frames: SceneFrameRuntime;

  constructor(private canvas: HTMLCanvasElement, private ports: SceneRuntimePorts, private events: SceneRuntimeEvents) {
    this.frames = new SceneFrameRuntime(ports, () => this.draw());
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.addEventListener("webglcontextrestored", this.contextRestored);
    this.createRenderer();
  }
  get painted() { return this.frames.painted; }

  setContext(context: SceneResourceContext) {
    if (this.disposed) return;
    const previous = this.groups?.context;
    if (previous?.root === context.root && previous.src === context.src && previous.sessionKey === context.sessionKey
      && previous.savedGroups === context.savedGroups && previous.capture === context.capture) return;
    const sceneChanged = !previous || previous.root !== context.root || previous.src !== context.src || previous.sessionKey !== context.sessionKey;
    this.groups?.dispose();
    this.groups = new SceneGroupRuntime(context, snapshot => { if (!this.disposed) this.events.groups(snapshot); });
    if (this.lost) this.groups.pause(); else this.groups.resume();
    if (sceneChanged) {
      this.frames.invalidate();
      this.textures?.dispose(); this.textures = null;
      this.events.warning(null);
      this.startTextures();
      if (!previous || previous.src !== context.src) this.loadScreenshot();
    }
  }
  setFrame(input: SceneFrameInput, camera: LayerCamera) { if (!this.disposed) this.frames.update(input, camera); }
  setDemand(demand: SceneDemandInput) {
    if (this.disposed) return;
    this.demand = demand; this.textures?.update(demand.textures);
  }
  paintCamera(camera: LayerCamera) { if (!this.disposed) { this.frames.setCamera(camera); this.draw(); } }
  interruptMotion() { if (!this.disposed) { this.frames.finishMotion(); this.draw(); } }
  clearWarning() { if (!this.disposed && !this.lost) this.events.warning(null); }
  draw() {
    if (this.disposed || this.lost) return;
    const painted = this.renderer ? this.frames.paint(this.renderer) : null;
    if (painted) this.events.painted();
    this.textures?.prune(this.frames.moving ? this.painted?.frame.planes ?? [] : []);
    const scheduled = painted ?? this.frames.demandFrame();
    if (!scheduled || !this.demand) return;
    const ids = layerDemandOrder(scheduled.frame.planes, scheduled.camera, scheduled.frame.presentation.pivot, this.demand.viewport, this.demand.selectedId);
    this.groups?.schedule(ids, this.demand.groups);
    this.textures?.schedule(ids, this.demand.visibility);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
    this.groups?.dispose(); this.frames.dispose(); this.releaseRenderer();
  }
  private createRenderer() {
    if (this.disposed || this.renderer) return;
    this.renderer = this.ports.createRenderer(this.canvas);
    this.events.status(this.renderer ? "loading" : "fallback");
    this.startTextures();
    this.loadScreenshot();
  }
  private startTextures() {
    if (!this.renderer || this.lost) return;
    this.textures = new SceneTextureRuntime(this.renderer, this.ports, () => this.draw(), message => {
      if (!this.disposed && !this.lost) this.events.warning(message);
    });
    if (this.demand) this.textures.update(this.demand.textures);
  }
  private loadScreenshot() {
    const generation = ++this.imageGeneration;
    this.screenshotCancel?.(); this.screenshotCancel = null;
    const renderer = this.renderer, context = this.groups?.context;
    if (!renderer || !context || this.lost || this.disposed) return;
    if (!context.src) {
      // A transparent base texture lets independently captured layers render
      // without inventing screen pixels or starting an empty image request.
      this.events.status(this.ports.uploadScreenshot(renderer, null) ? "webgl" : "fallback"); this.draw();
      return;
    }
    const current = () => !this.disposed && !this.lost && this.renderer === renderer && this.imageGeneration === generation;
    this.screenshotCancel = this.ports.loadScreenshot(context.src, image => {
      if (!current()) return;
      if (!this.ports.uploadScreenshot(renderer, image)) { this.events.status("fallback"); return; }
      this.events.status("webgl"); this.draw();
    }, () => { if (current()) this.events.status("fallback"); });
  }
  private releaseRenderer() {
    this.imageGeneration++;
    this.screenshotCancel?.(); this.screenshotCancel = null;
    this.textures?.dispose(); this.textures = null;
    const renderer = this.renderer; this.renderer = null;
    if (renderer) this.ports.disposeRenderer(renderer);
  }
  private contextLost = (event: Event) => {
    event.preventDefault();
    if (this.disposed || this.lost) return;
    this.lost = true; this.frames.invalidate(); this.groups?.pause(); this.releaseRenderer();
    this.events.status("fallback");
  };
  private contextRestored = () => {
    if (this.disposed || !this.lost) return;
    this.lost = false; this.createRenderer(); this.groups?.resume();
  };
}
