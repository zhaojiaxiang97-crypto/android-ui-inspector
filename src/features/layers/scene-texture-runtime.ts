import type { LayerRecord } from "../../../shared/layer-layout";
import { LayerDemandQueue } from "../../../shared/layer-demand";
import type { QmlGroupImage, UiNode } from "../../../shared/types";
import { sourceRect } from "./presentation";
import type { SceneRuntimePorts } from "./scene-runtime-ports";
import type { Renderer, ScenePlane } from "./types";

export const MAX_LAYER_TEXTURE_PIXELS = 16_000_000;
export type TextureDemand = { key: string; record: LayerRecord; group: QmlGroupImage | null; clips: readonly UiNode[]; hidden: ReadonlySet<string>; maxPixels: number };

/** A single renderer generation owns its queue and every asynchronous upload/scan. */
export class SceneTextureRuntime {
  private demands: ReadonlyMap<string, TextureDemand> = new Map();
  private queue: LayerDemandQueue<TextureDemand>;
  private repaint: number | null = null;
  private alive = true;
  private pendingScans = new Map<string, WebGLTexture | undefined>();

  constructor(private renderer: Renderer, private ports: SceneRuntimePorts, private draw: () => void, private warning: (message: string | null) => void) {
    this.queue = new LayerDemandQueue((demand, key, active) => this.load(demand, key, active), error => {
      if (this.alive) this.warning(error instanceof Error ? error.message : "部分图层未能加载");
    });
  }

  update(demands: ReadonlyMap<string, TextureDemand>) { this.demands = demands; }
  schedule(ids: readonly string[], visibility: string) {
    if (!this.alive || !this.renderer.textureReady) return;
    this.queue.update(ids.flatMap(id => {
      const demand = this.demands.get(id);
      return demand && !this.renderer.layerTextures.has(demand.key) ? [{ key: `${demand.key}@${demand.maxPixels}`, value: demand }] : [];
    }));
    const { dataset } = this.renderer.canvas;
    dataset.layerTextureBytes = String([...this.renderer.layerTextureBytes.values()].reduce((sum, bytes) => sum + bytes, 0));
    dataset.layerTextureCount = String(this.renderer.layerTextures.size);
    dataset.layerTexturePendingCount = String(this.queue.pendingCount);
    if (this.queue.pendingCount === 0) dataset.layerTextureVisibility = visibility;
    else delete dataset.layerTextureVisibility;
  }
  prune(retiring: readonly ScenePlane[]) {
    if (!this.alive) return;
    const wanted = new Map([...this.demands.values()].map(demand => [demand.key, demand.maxPixels]));
    const retained = new Set(retiring.flatMap(plane => plane.textureSrc ? [plane.textureSrc] : []));
    for (const [key, bytes] of this.renderer.layerTextureBytes) {
      const budget = wanted.get(key);
      if (budget !== undefined ? bytes <= budget * 4 : retained.has(key)) continue;
      this.deleteTexture(key);
    }
  }
  dispose() {
    if (!this.alive) return;
    this.alive = false; this.queue.dispose();
    if (this.repaint !== null) this.ports.scheduler.cancelFrame(this.repaint);
    this.repaint = null;
    // An uploaded texture with an unfinished alpha scan is not transferable to
    // the next scene queue. Otherwise the new queue would skip its missing mask.
    for (const [key, texture] of this.pendingScans) {
      if (this.renderer.layerTextures.get(key) === texture) this.deleteTexture(key);
    }
    this.pendingScans.clear();
  }

  private paintSoon() {
    if (!this.alive || this.repaint !== null) return;
    this.repaint = this.ports.scheduler.requestFrame(() => {
      if (!this.alive) return;
      this.repaint = null; this.draw();
    });
  }
  private deleteTexture(key: string) {
    const renderer = this.renderer;
    renderer.gl.deleteTexture(renderer.layerTextures.get(key) ?? null);
    renderer.layerTextures.delete(key); renderer.layerTextureBytes.delete(key);
    renderer.layerContentRects.delete(key); renderer.layerAlphaMasks.delete(key); renderer.layerAlphaScans.delete(key);
    renderer.sourcePlanes = null;
  }
  private async load(demand: TextureDemand, requestKey: string, isActive: () => boolean): Promise<void | "retry"> {
    const renderer = this.renderer, { key, record, group, clips, maxPixels } = demand;
    let image: ImageBitmap | HTMLCanvasElement | null = null;
    const current = () => this.alive && isActive() && this.queue.hasDemand(requestKey);
    const load = async (node: UiNode) => {
      if (!current()) throw new Error("图层加载已取消");
      const bitmap = await this.ports.decode(node.layerImageDataUrl!);
      if (!current()) { bitmap.close(); throw new Error("图层加载已取消"); }
      return bitmap;
    };
    try {
      if (!current() || renderer.layerTextures.has(key)) return;
      image = record.isCollapsed
        ? group ? await this.ports.decode(group.dataUrl) : await this.ports.compose(record.node, sourceRect(record), load, maxPixels, demand.hidden)
        : await load(record.node);
      if (!current()) return "retry";
      if (!record.isCollapsed) {
        const bitmap = image as ImageBitmap;
        try { image = this.ports.clip(record.node, clips, bitmap); }
        finally { if (image !== bitmap) bitmap.close(); }
      }
      if (!current()) return "retry";
      let bytes = [...renderer.layerTextureBytes.values()].reduce((sum, value) => sum + value, 0);
      const required = Math.min(maxPixels, image.width * image.height) * 4;
      const wantedKeys = new Set([...this.demands.values()].map(item => item.key));
      for (const [oldKey, oldBytes] of renderer.layerTextureBytes) {
        if (bytes + required <= MAX_LAYER_TEXTURE_PIXELS * 4) break;
        if (wantedKeys.has(oldKey)) continue;
        this.deleteTexture(oldKey); bytes -= oldBytes;
      }
      const upload = this.ports.uploadLayer(renderer, key, image, maxPixels);
      if (upload === false) throw new Error("图层纹理上传失败");
      this.paintSoon();
      if (upload.scan) {
        const texture = renderer.layerTextures.get(key);
        const scan = upload.scan(); renderer.layerAlphaScans.set(key, scan);
        this.pendingScans.set(key, texture);
        const content = await scan;
        this.pendingScans.delete(key);
        if (!this.alive || !isActive()) return;
        // Texture identity, not just its key, protects eviction and rapid reentry.
        if (renderer.layerTextures.get(key) !== texture || renderer.layerAlphaScans.get(key) !== scan) return "retry";
        if (content.rect === undefined) renderer.layerContentRects.delete(key);
        else renderer.layerContentRects.set(key, content.rect);
        if (content.mask) renderer.layerAlphaMasks.set(key, content.mask);
        renderer.sourcePlanes = null;
        this.paintSoon();
      }
    } catch (error) {
      if (!current()) return "retry";
      this.warning(error instanceof Error ? error.message : "部分图层未能加载");
    } finally {
      if (image && "close" in image) image.close();
      else if (image) image.width = image.height = 0;
      if (this.alive && isActive()) this.paintSoon();
    }
  }
}
