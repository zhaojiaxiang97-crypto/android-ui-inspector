import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import type { QmlGroupImage } from "../shared/types";
import { makeNode } from "./fixtures";
import type { LayerSceneHandle } from "../src/features/layers/types";

export async function verifyLayerProvenance() {
  const pixels = document.createElement("canvas"); pixels.width = pixels.height = 40;
  pixels.getContext("2d")!.fillRect(0, 0, 40, 40);
  const dataUrl = pixels.toDataURL();
  for (const succeeds of [true, false, null]) {
    const host = document.createElement("div"); document.body.append(host);
    const mounted = createRoot(host);
    const tree = makeNode("0"), parent = makeNode("0/0"), child = makeNode("0/0/0");
    for (const node of [tree, parent, child]) {
      node.bounds = { left: 0, top: 0, right: 40, bottom: 40, raw: "" };
      node.layerImageDataUrl = dataUrl; node.layerImageSize = { width: 40, height: 40 };
      node.attributes = { "tree-source": "debug-sdk", "image-capture-source": "ddms" };
    }
    tree.children = [parent]; parent.children = [child];
    let settle!: (image: QmlGroupImage | null) => void, calls = 0;
    const pending = new Promise<QmlGroupImage | null>(resolve => { settle = resolve; });
    const capture = () => { calls++; return pending; };
    const props = { src: dataUrl, root: tree, selectedNode: parent, size: { width: 40, height: 40 }, renderScale: 1,
      origin: { left: 0, top: 0 }, camera: { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 24, panX: 0, panY: 0 }, onSelect: () => {}, onCaptureGroup: succeeds === null ? undefined : capture };
    const plane = () => host.querySelector<HTMLElement>('[data-layer-node-id="0/0"]');
    const note = () => host.querySelector(".layer-resource-note")?.textContent ?? "";
    const wait = async (condition: () => boolean) => {
      const deadline = performance.now() + 3000;
      while (!condition()) { if (performance.now() > deadline) throw new Error("Layer provenance UI timeout"); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    try {
      flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0"])} />));
      await wait(() => plane()?.dataset.layerGroupState === (succeeds === null ? "not-live" : "pending"));
      if (plane()?.dataset.layerImageSource !== "local-composite") throw new Error("Pending group mislabels local pixels");
      if (!note().includes("本地重建图") || !note().includes("不保证与原生整组图逐像素一致"))
        throw new Error("Local reconstruction precision is not visible");
      if (succeeds !== null) {
        for (let i = 0; i < 2; i++) {
          flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0", "0/0"])} />));
          await wait(() => plane()?.dataset.layerGroupState === "not-applicable");
          flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0"])} />));
          await wait(() => plane()?.dataset.layerGroupState === "pending");
        }
        if (calls !== 1) throw new Error("Rapid folding duplicated an in-flight group request");
        settle(succeeds ? { dataUrl, size: { width: 40, height: 40 }, capturedAt: "2026-10-06T00:00:00Z" } : null);
        await wait(() => plane()?.dataset.layerGroupState === (succeeds ? "ready" : "unavailable"));
      }
      if (plane()?.dataset.layerImageSource !== (succeeds ? "live-group" : "local-composite") || calls !== (succeeds === null ? 0 : 1))
        throw new Error("Group source or request count mismatch");
      if (succeeds && (!note().includes("原生整组图") || !note().includes("来源不代表逐像素校验通过")))
        throw new Error("Native source falsely claims pixel verification");
      if (succeeds) for (let i = 0; i < 2; i++) {
        flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0", "0/0"])} />));
        await wait(() => plane()?.dataset.layerGroupState === "not-applicable");
        flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0"])} />));
        await wait(() => plane()?.dataset.layerGroupState === "ready");
        if (calls !== 1) throw new Error("Reopening a cached branch repeated group capture");
      }
      if (succeeds === false && !note().includes("原因未返回")) throw new Error("Unavailable group guessed a reason");
      if (succeeds === null && !note().includes("无法请求")) throw new Error("Saved-only group state not explained");
      flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0"])} hiddenNodeIds={new Set([child.id])} />));
      await wait(() => plane()?.dataset.layerGroupState === "hidden-descendants");
      if (plane()?.dataset.layerImageSource !== "local-composite" || !note().includes("已排除隐藏子图层")
          || calls !== (succeeds === null ? 0 : 1)) throw new Error("Hidden descendant source/hint/request mismatch");
      flushSync(() => mounted.render(<Layer3DPreview {...props} expandedNodeIds={new Set(["0", "0/0"])} />));
      await wait(() => plane()?.dataset.layerGroupState === "not-applicable");
      if (plane()?.dataset.layerImageSource !== "ddms") throw new Error("Expanded own source not restored");
      if (note().includes("本地重建图") || note().includes("原生整组图未取得")) throw new Error("Old collapsed precision hint persisted after reopening");
    } finally { flushSync(() => mounted.unmount()); host.remove(); }
  }
}

// Runs in the existing coordinate/WebGL harness; it also exercises camera paints
// which bypass React so newly visible work cannot depend on a component rerender.
export async function verifyLayerDemand() {
  const host = document.createElement("div"); host.style.cssText = "position:relative;width:800px;height:600px"; document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>();
  const pixels = document.createElement("canvas"); pixels.width = pixels.height = 40;
  const context = pixels.getContext("2d")!; context.fillStyle = "#d22"; context.fillRect(0, 0, 40, 40); const dataUrl = pixels.toDataURL();
  let tree = makeNode("demand-root"); tree.bounds = { left: 0, top: 0, right: 360, bottom: 640, raw: "" };
  tree.children = Array.from({ length: 72 }, (_, i) => ({ ...makeNode(`demand-root/${i}`, i),
    bounds: { left: (i % 6) * 60, top: Math.floor(i / 6) * 50, right: (i % 6) * 60 + 40, bottom: Math.floor(i / 6) * 50 + 40, raw: "" },
    layerImageDataUrl: dataUrl, layerImageSize: { width: 40, height: 40 } }));
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 1, panX: 5000, panY: 0 };
  let hidden = new Set<string>(), decodes = 0;
  const delayed = { release: () => {} };
  const originalBitmap = window.createImageBitmap;
  window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => { decodes++; return (originalBitmap as Function)(...args); }) as typeof createImageBitmap;
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={dataUrl} root={tree} selectedNode={tree.children[0]}
    size={{ width: 360, height: 640 }} renderScale={1} origin={{ left: 0, top: 0 }} viewport={{ left: 0, top: 0, width: 800, height: 600 }}
    camera={camera} expandedNodeIds={new Set([tree.id])} hiddenNodeIds={hidden} onSelect={() => {}} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const wait = async (count: number) => {
    const deadline = performance.now() + 4000;
    while (canvas()?.dataset.layerTextureCount !== String(count) || canvas()?.dataset.layerTexturePendingCount !== "0") {
      if (performance.now() > deadline) throw new Error(`Layer demand timeout: wanted ${count}, got ${canvas()?.dataset.layerTextureCount}, pending ${canvas()?.dataset.layerTexturePendingCount}`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  };
  try {
    render(); await wait(1);
    if (decodes !== 1) throw new Error(`Offscreen layers decoded prematurely: ${decodes}`);
    scene.current!.paintCamera({ ...camera, panX: 0 }); await wait(72);
    if (Number(decodes) !== 72) throw new Error("Viewport entry failed to load each newly visible layer exactly once");
    scene.current!.paintCamera(camera); await wait(72);
    if (Number(decodes) !== 72) throw new Error("Panning repeated cached layer decoding");
    hidden = new Set([tree.children[0].id]); render(); await wait(71);
    hidden = new Set(); render(); await wait(72);
    const beforeRefresh = decodes;
    const identity = host.querySelector<HTMLElement>('[data-layer-node-id="demand-root/0"]')!.dataset.layerTextureIdentity;
    context.fillStyle = "#22d"; context.fillRect(0, 0, 40, 40);
    tree = { ...tree, children: tree.children.map((node, i) => i ? node : { ...node, layerImageDataUrl: pixels.toDataURL() }) };
    render(); await wait(72);
    const refreshedIdentity = host.querySelector<HTMLElement>('[data-layer-node-id="demand-root/0"]')!.dataset.layerTextureIdentity;
    if (identity === refreshedIdentity || decodes !== beforeRefresh + 1) throw new Error("Refreshed own image reused stale pixels or redecoded unrelated layers");
    let heldBitmap: ImageBitmap | null = null;
    const gate = new Promise<void>(resolve => { delayed.release = resolve; });
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) =>
      (originalBitmap as Function)(...args).then(async (bitmap: ImageBitmap) => { heldBitmap = bitmap; await gate; return bitmap; })) as typeof createImageBitmap;
    context.fillStyle = "#2d2"; context.fillRect(0, 0, 40, 40);
    tree = { ...tree, children: tree.children.map((node, i) => i ? node : { ...node, layerImageDataUrl: pixels.toDataURL() }) };
    render();
    const deadline = performance.now() + 4000;
    while (!heldBitmap) { if (performance.now() > deadline) throw new Error("No delayed bitmap to test source cancellation"); await new Promise(resolve => requestAnimationFrame(resolve)); }
    window.createImageBitmap = originalBitmap;
    tree = { ...tree, id: "new-demand-root", children: [{ ...tree.children[0], id: "new-demand-root/0", layerImageDataUrl: dataUrl }] };
    render(); await wait(1);
    delayed.release();
    while ((heldBitmap as ImageBitmap).width !== 0) { if (performance.now() > deadline) throw new Error("Cancelled bitmap was not closed"); await new Promise(resolve => requestAnimationFrame(resolve)); }
    if (canvas().dataset.layerTextureCount !== "1" || host.querySelector('[data-layer-node-id="demand-root/0"]')) throw new Error("Delayed old texture entered a replacement scene");
    return ["Layer demand: selected offscreen priority, 72 viewport entries, cached pan, hidden release, refreshed image identity, delayed bitmap closed on new source"];
  } finally { delayed.release(); window.createImageBitmap = originalBitmap; flushSync(() => mounted.unmount()); host.remove(); }
}
