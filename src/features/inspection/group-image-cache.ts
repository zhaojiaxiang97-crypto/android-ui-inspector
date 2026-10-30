import type { InspectionPort } from "../../platform/desktop-services";
import type { QmlGroupImage, UiNode, UiSnapshot } from "../../../shared/types";
import { flattenNodes } from "../../../shared/tree-utils";
import { isGroupImage } from "../../../shared/snapshot-validation";

/** Group images can run concurrently; only the same node/source shares a request. */
export function createGroupImageCache(api: Pick<InspectionPort, "captureGroup">, current: () => UiSnapshot | null, changed: () => void) {
  let generation = 0, active = true;
  let indexed: { root: UiNode; nodes: Map<string, UiNode> } | null = null;
  let captured: { root: UiNode; images: Map<string, QmlGroupImage> } | null = null;
  let pending: { root: UiNode; generation: number; requestId: string; requests: Map<string, Promise<QmlGroupImage | null>> } | null = null;
  function images(snapshot: UiSnapshot | null) {
    const groups = new Map((snapshot?.layerGroupImages ?? []).map(group => [group.nodeId, group.image]));
    if (snapshot?.root && captured?.root === snapshot.root)
      for (const [nodeId, image] of captured.images) groups.set(nodeId, image);
    return [...groups].map(([nodeId, image]) => ({ nodeId, image }));
  }
  return {
    invalidate() { generation++; captured = null; pending = null; indexed = null; },
    activate() { active = true; },
    dispose() { active = false; generation++; captured = null; pending = null; indexed = null; },
    images,
    snapshotForStorage() {
      const snapshot = current();
      return snapshot?.root && captured?.root === snapshot.root ? { ...snapshot, layerGroupImages: images(snapshot) } : snapshot;
    },
    async request(requestId: string | null, node: UiNode, source: UiSnapshot | null) {
      if (!active || !requestId || !source?.root || current() !== source) return null;
      if (indexed?.root !== source.root) indexed = { root: source.root, nodes: flattenNodes(source.root) };
      if (indexed.nodes.get(node.id) !== node) return null;
      const root = source.root, epoch = generation;
      const cached = captured?.root === root ? captured.images.get(node.id) : null;
      if (cached) return cached;
      if (pending?.root !== root || pending.generation !== epoch || pending.requestId !== requestId)
        pending = { root, generation: epoch, requestId, requests: new Map() };
      const requests = pending.requests, existing = requests.get(node.id);
      if (existing) return existing;
      const result = (async () => {
        const image = await api.captureGroup(requestId, node.id);
        if (!isGroupImage(image) || epoch !== generation || current() !== source) return null;
        if (captured?.root !== root) captured = { root, images: new Map() };
        captured.images.set(node.id, image); changed(); return image;
      })();
      requests.set(node.id, result);
      try { return await result; }
      finally { if (requests.get(node.id) === result) requests.delete(node.id); }
    },
  };
}
