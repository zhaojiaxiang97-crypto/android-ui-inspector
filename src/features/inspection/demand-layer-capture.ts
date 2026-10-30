import type { LayerImageCaptureResult, UiNode, UiSnapshot } from "../../../shared/types";
import { flattenNodes } from "../../../shared/tree-utils";
import type { InspectionPort } from "../../platform/desktop-services";

export const DEMAND_LAYER_LIMIT = 32;
export type DemandLayerState = { loading: boolean; nodeId: string | null; message: string | null; failed: boolean };
const idle: DemandLayerState = { loading: false, nodeId: null, message: null, failed: false };

/** One deliberate branch visit gets one bounded batch, never a background tree walk. */
export function demandLayerIds(branch: UiNode, retry = false, limit = DEMAND_LAYER_LIMIT): string[] {
  const pending = [branch], ids: string[] = [];
  for (let index = 0; index < pending.length && ids.length < limit; index++) {
    const node = pending[index];
    const bounds = node.bounds;
    if (node.visibleToUser && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top
      && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) && node.attributes?.["view-ref"]
      && !node.layerImageDataUrl && (node.layerImageStatus === "deferred" || retry && node.layerImageStatus === "failed")) ids.push(node.id);
    pending.push(...node.children);
  }
  return ids;
}

export function createDemandLayerCapture(options: {
  api: Pick<InspectionPort, "captureLayerImages" | "cancelLayerImages">;
  current(): { snapshot: UiSnapshot | null; requestId: string | null; blocked: boolean };
  apply(source: UiSnapshot, result: LayerImageCaptureResult): void;
  publish(state: DemandLayerState): void;
  delayMs?: number;
}) {
  let active = true, epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { nodeId: string; requestId: string; retry: boolean } | null = null;
  let running: { requestId: string; epoch: number } | null = null;
  const visited = new Set<string>();
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => {
    clearTimer();
    if (!running && pending) timer = setTimeout(() => { timer = null; void run(); }, options.delayMs ?? 250);
  };
  async function run() {
    const intent = pending; pending = null;
    const current = options.current(), source = current.snapshot;
    if (!active || !intent || !source?.root || source.layerCapture !== "on-demand" || !current.requestId
      || current.requestId !== intent.requestId || current.blocked || !options.api.captureLayerImages) return;
    const branch = flattenNodes(source.root).get(intent.nodeId);
    if (!branch) return;
    const key = `${current.requestId}:${intent.nodeId}`;
    if (!intent.retry && visited.has(key)) return;
    visited.add(key);
    const ids = demandLayerIds(branch, intent.retry);
    if (!ids.length) { options.publish({ ...idle, nodeId: branch.id, message: "当前分支已读取。" }); return; }
    const token = { requestId: current.requestId, epoch };
    running = token;
    options.publish({ loading: true, nodeId: branch.id, failed: false, message: `正在读取当前分支（最多 ${ids.length} 层）…` });
    const valid = () => active && token.epoch === epoch && running === token
      && options.current().requestId === token.requestId && options.current().snapshot === source && !options.current().blocked;
    let published = false;
    try {
      const result = await options.api.captureLayerImages(token.requestId, ids);
      if (!valid()) return;
      const requested = new Set(ids);
      if (result.updates.some(update => !requested.has(update.id)) || result.failures.some(failure => !requested.has(failure.id)))
        throw new Error("分支图层结果不匹配，请重新采集。");
      options.apply(source, result);
      const updatedRoot = options.current().snapshot?.root;
      const updatedBranch = updatedRoot && flattenNodes(updatedRoot).get(branch.id);
      const remaining = Boolean(updatedBranch && demandLayerIds(updatedBranch, false, 1).length);
      options.publish({ loading: false, nodeId: branch.id, failed: result.failures.length > 0,
        message: result.failures.length ? `${result.failures.length} 层读取失败，可重试当前分支。`
          : remaining ? "已读取一批图层；展开子分支或继续读取。" : "当前分支已读取。" });
      published = true;
    } catch (error) {
      if (valid()) {
        options.publish({ loading: false, nodeId: branch.id, failed: true,
          message: error instanceof Error ? error.message : "当前分支读取失败，可重试。" });
        published = true;
      }
    } finally {
      if (running === token) { running = null; if (!published) options.publish(idle); schedule(); }
    }
  }
  function invalidate() {
    epoch++; clearTimer(); pending = null; visited.clear();
    const old = running; running = null;
    if (old) void options.api.cancelLayerImages?.(old.requestId);
    options.publish(idle);
  }
  return {
    request(source: UiSnapshot | null, nodeId: string, retry = false) {
      const current = options.current();
      if (!active || source !== current.snapshot || source?.layerCapture !== "on-demand" || !current.requestId
        || current.blocked || !options.api.captureLayerImages) return;
      pending = { nodeId, requestId: current.requestId, retry }; schedule();
    },
    invalidate,
    isBusy: () => running !== null,
    activate() { active = true; },
    dispose() { active = false; invalidate(); },
  };
}
