import { setTimeout as delay } from "node:timers/promises";
import type { UiSnapshot } from "../../shared/types";

/** Development-only lifecycle fixture. No adb, device queries or SDK claims. */
export async function visualCaptureFixture(snapshot: UiSnapshot, requestId: string, images: { solid: string; empty: string }, options: {
  signal: AbortSignal;
  onProgress: (stage: string, elapsedMs: number) => void;
  onPreview: (phase: "tree" | "layers", snapshot: UiSnapshot) => void;
}) {
  const result = structuredClone(snapshot), leaves = [];
  const pending = result.root ? [result.root] : [];
  while (pending.length) { const node = pending.pop()!; if (!node.children.length) leaves.push(node); pending.push(...node.children); }
  if (leaves.length < 2 || !result.root) throw new Error("Lifecycle fixture requires two leaves");
  const solid = leaves[leaves.length - 1], empty = leaves[0];
  solid.text = `Fixture ${requestId}`;
  result.inspectionSource = "debug-view";
  result.root.attributes = { ...result.root.attributes, "fixture-request-id": requestId };
  const started = performance.now();
  const progress = (stage: string) => options.onProgress(stage, Math.round(performance.now() - started));
  try {
    await delay(100, undefined, { signal: options.signal });
    progress("测试夹具：树预览"); options.onPreview("tree", structuredClone(result));
    await delay(150, undefined, { signal: options.signal });
    for (const [node, image, isEmpty] of [[solid, images.solid, false], [empty, images.empty, true]] as const) {
      node.layerImageDataUrl = image; node.layerImageStatus = "captured"; node.layerImageSize = { width: 32, height: 32 };
      node.layerImageEmpty = isEmpty;
      node.attributes = { ...node.attributes, "image-source": "SDK 模拟独立图（测试夹具）", "view-ref": `Fixture@${node === solid ? "a" : "b"}` };
    }
    progress("测试夹具：独立图预览"); options.onPreview("layers", structuredClone(result));
    // A bounded window for real DOM/WebGL assertions and the cancel button.
    await delay(2500, undefined, { signal: options.signal });
    progress("测试夹具：完成"); return result;
  } catch (error) {
    if (!options.signal.aborted) throw error;
    // Deliberately attempt late callbacks while the real desktop gate is closed.
    await delay(150);
    progress("测试夹具：取消后迟到进度"); options.onPreview("layers", structuredClone(result));
    throw options.signal.reason;
  }
}
