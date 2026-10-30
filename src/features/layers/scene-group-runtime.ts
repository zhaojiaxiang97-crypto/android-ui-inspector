import { LayerDemandQueue } from "../../../shared/layer-demand";
import type { GroupRequestState } from "../../../shared/layer-image-provenance";
import type { QmlGroupImage, UiNode } from "../../../shared/types";

export type SceneResourceContext = {
  root: UiNode; src: string; sessionKey?: string | number;
  savedGroups: ReadonlyMap<string, QmlGroupImage>;
  capture?: (node: UiNode) => Promise<QmlGroupImage | null>;
};
export type SceneGroups = { context: SceneResourceContext; images: ReadonlyMap<string, QmlGroupImage>; requests: ReadonlyMap<string, GroupRequestState> };

/** Group captures belong to the captured tree, so GPU restoration never recaptures them. */
export class SceneGroupRuntime {
  private queue: LayerDemandQueue<UiNode> | null = null;
  private alive = true;
  private paused = false;
  private snapshot: SceneGroups;

  constructor(context: SceneResourceContext, private changed: (snapshot: SceneGroups) => void) {
    this.snapshot = { context, images: new Map(context.savedGroups), requests: new Map() };
    if (context.capture) this.queue = new LayerDemandQueue(async (node, key, active) => {
      this.publish(key, "pending");
      const image = await context.capture!(node).catch(() => null);
      if (!this.alive || !active()) return;
      this.publish(key, image ? null : "unavailable", image);
    }, (_error, key) => { if (this.alive) this.publish(key, "unavailable"); });
  }
  get context() { return this.snapshot.context; }
  get state() { return this.snapshot; }
  schedule(ids: readonly string[], nodes: ReadonlyMap<string, UiNode>) {
    if (!this.alive || this.paused) return;
    this.queue?.update(ids.filter(id => nodes.has(id) && !this.snapshot.images.has(id))
      .map(id => ({ key: id, value: nodes.get(id)! })));
  }
  pause() { this.paused = true; }
  resume() { if (!this.alive) return; this.paused = false; this.changed(this.snapshot); }
  dispose() { if (!this.alive) return; this.alive = false; this.queue?.dispose(); }
  private publish(key: string, request: GroupRequestState | null, image?: QmlGroupImage | null) {
    const requests = new Map(this.snapshot.requests);
    if (request) requests.set(key, request); else requests.delete(key);
    const images = image ? new Map(this.snapshot.images).set(key, image) : this.snapshot.images;
    this.snapshot = { ...this.snapshot, images, requests };
    if (!this.paused) this.changed(this.snapshot);
  }
}
