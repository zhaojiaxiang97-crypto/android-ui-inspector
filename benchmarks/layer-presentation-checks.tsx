import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { DEFAULT_LAYER_APPEARANCE, type LayerAppearance } from "../src/features/layers/appearance";
import type { LayerSceneHandle } from "../src/features/layers/types";
import { makeNode } from "./fixtures";
import type { UiNode } from "../shared/types";

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Layer presentation: ${message}`); }
async function until(predicate: () => boolean, message: string) {
  const end = performance.now() + 7000;
  while (!predicate()) { assert(performance.now() < end, message); await tick(); }
}
function node(id: string, left: number, top: number, right: number, bottom: number): UiNode {
  return { ...makeNode(id), bounds: { left, top, right, bottom, raw: "fixture" }, attributes: { "skip-draw": "true", "inspection-source": "debug-view" } };
}

export async function verifyLayerPresentation() {
  const host = document.createElement("div"); host.style.cssText = "width:500px;height:380px;position:relative"; document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>();
  const bitmap = document.createElement("canvas"); bitmap.width = bitmap.height = 20;
  bitmap.getContext("2d")!.fillStyle = "#0080ff"; bitmap.getContext("2d")!.fillRect(0, 0, 20, 20);
  let root = node("root", 0, 0, 240, 200);
  const a = node("wrapper-a", 40, 40, 160, 160), b = node("wrapper-b", 40, 40, 160, 160), c = node("wrapper-c", 40, 40, 160, 160);
  const leaf = node("painted", 90, 90, 110, 110); leaf.layerImageDataUrl = bitmap.toDataURL(); leaf.layerImageSize = { width: 20, height: 20 };
  root.children = [a]; a.children = [b]; b.children = [c]; c.children = [leaf];
  const source = bitmap.toDataURL(), expanded = new Set([root.id, a.id, b.id, c.id]), size = { width: 240, height: 200 };
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  let selected: UiNode | null = leaf, appearance: LayerAppearance = DEFAULT_LAYER_APPEARANCE, fits = 0;
  let hiddenIds = new Set<string>();
  const fit = () => { fits++; };
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={source} root={root} selectedNode={selected}
    expandedNodeIds={expanded} hiddenNodeIds={hiddenIds} appearance={appearance} size={size} origin={{ left: 100, top: 80 }} renderScale={1} camera={camera}
    onSelect={() => {}} onFitScale={fit} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const data = () => host.querySelector<HTMLElement>(".layer-scene")!.dataset;
  const borders = () => Number(canvas().dataset.layerOrdinaryBorderCount);
  const depths = () => [...host.querySelectorAll<HTMLElement>(".layer-plane")].map(el => `${el.dataset.layerNodeId}:${el.dataset.layerZ}`).join("|");
  const depthSpan = () => {
    const values = [...host.querySelectorAll<HTMLElement>(".layer-plane")].map(el => Number(el.dataset.layerZ));
    return Math.max(...values) - Math.min(...values);
  };
  const previousTheme = document.documentElement.getAttribute("data-appearance");
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0", "scene did not settle");
    await tick();
    assert(host.querySelectorAll(".layer-plane").length === 1 && host.querySelector('[data-layer-node-id="painted"]'), "default canvas retained empty wrappers or lost their child");
    selected = a; render(); scene.current!.paintCamera(camera);
    assert(data().layerSelectionCount === "0" && host.querySelector(".layer-resource-note")?.textContent?.includes("显示空图层"), "selecting a hidden empty node did not explain how to reveal it");
    appearance = { ...appearance, structureMode: "complete" }; render(); scene.current!.paintCamera(camera);
    assert(host.querySelectorAll(".layer-plane").length === 1, "full spacing bypassed the empty-layer visibility setting");
    appearance = { ...appearance, showEmpty: true, structureMode: "regular" }; selected = leaf; render(); scene.current!.paintCamera(camera);
    assert(data().layerSuppressedOutlineCount === "2", "eligible same-range wrappers were not merged");
    assert(Math.abs(depthSpan() - 64) < .01, "empty wrappers still consume visible depth slots");
    const regularBorders = borders(), beforeDepths = depths(), beforeGeometry = data().layerGeometryRevision, textureBytes = canvas().dataset.layerTextureBytes;
    appearance = { ...appearance, structureMode: "complete" }; render(); scene.current!.paintCamera(camera);
    assert(borders() === regularBorders + 2, "complete structure did not restore exactly the merged strokes");
    assert(depths() !== beforeDepths && data().layerGeometryRevision !== beforeGeometry, "complete structure did not restore individual depth slots");
    assert(depthSpan() === 192, "complete structure did not separate the four displayed nodes by three full gaps");
    appearance = { ...appearance, structureMode: "regular" }; selected = a; render(); scene.current!.paintCamera(camera);
    assert(depths() === beforeDepths, "returning to compact structure changed its original depths");
    const compactGeometry = data().layerGeometryRevision; selected = leaf; render(); scene.current!.paintCamera(camera);
    assert(data().layerGeometryRevision === compactGeometry && depths() === beforeDepths, "selection recomputed or moved geometry");
    hiddenIds = new Set([leaf.id]); render(); scene.current!.paintCamera(camera);
    assert(!host.querySelector('[data-layer-node-id="painted"]') && depthSpan() < .01, "hidden content left an empty depth slot");
    hiddenIds = new Set(); render(); scene.current!.paintCamera(camera);
    assert(depths() === beforeDepths, "showing the content did not restore its compact depth");
    await until(() => canvas().dataset.layerTexturePendingCount === "0" && canvas().dataset.layerTextureCount === "1", "restored content did not reload its image");
    await tick();
    selected = a; render(); scene.current!.paintCamera(camera);
    assert(host.querySelector('[data-layer-node-id="wrapper-a"]')?.getAttribute("data-layer-selected") === "true", "merged wrapper lost tree selection");
    selected = null; appearance = { ...appearance, showOutlines: false }; render(); scene.current!.paintCamera(camera);
    assert(borders() === 0, "structural containers bypassed the ordinary outline switch");
    const fitCount = fits;
    root = structuredClone(root);
    const newLeaf = root.children[0].children[0].children[0].children[0];
    bitmap.getContext("2d")!.fillStyle = "#00ff80"; bitmap.getContext("2d")!.fillRect(0, 0, 20, 20);
    newLeaf.layerImageDataUrl = bitmap.toDataURL(); render();
    await until(() => canvas().dataset.layerTexturePendingCount === "0" && JSON.parse(canvas().dataset.layerCommittedNativeTextures ?? "[]").some((entry: { id: string }) => entry.id === leaf.id), "late image did not draw");
    await tick(); assert(fits === fitCount, "late pixels changed the established framing");
    appearance = { ...appearance, showOutlines: true }; render(); scene.current!.paintCamera(camera);
    const gl = canvas().getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    document.documentElement.setAttribute("data-appearance", "dark"); await tick(); scene.current!.paintCamera(camera);
    const dark = [...gl.getUniform(program, gl.getUniformLocation(program, "u_color")!)];
    const geometryBeforeTheme = data().layerGeometryRevision, version = Number(canvas().dataset.layerRenderVersion);
    document.documentElement.setAttribute("data-appearance", "light");
    await until(() => Number(canvas().dataset.layerRenderVersion) > version, "theme did not repaint");
    const light = [...gl.getUniform(program, gl.getUniformLocation(program, "u_color")!)];
    assert(light[0] < dark[0] && light[1] < dark[1], "light theme did not use its outline palette");
    assert(data().layerGeometryRevision === geometryBeforeTheme && canvas().dataset.layerTextureBytes === textureBytes, "theme changed geometry or texture memory");
    const beforeFit = fits; scene.current!.fit(); assert(fits === beforeFit + 1, "explicit fit no longer works");
    assert(gl.getError() === gl.NO_ERROR, "renderer error");
    return ["layer redesign: empty planes default hidden with children retained and selected-node guidance; opt-in compact/full structure; hidden slots close; selection preserves depth; late image framing and theme repaint"];
  } finally {
    if (previousTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", previousTheme);
    flushSync(() => mounted.unmount()); host.remove();
  }
}
