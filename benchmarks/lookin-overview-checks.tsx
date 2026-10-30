import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { makeNode } from "./fixtures";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import type { LayerSceneHandle } from "../src/features/layers/types";
import { DEFAULT_LAYER_APPEARANCE, type LayerAppearance, type LayerDisplayMode } from "../src/features/layers/appearance";
import { DEFAULT_ORBIT_CAMERA } from "../shared/orbit-camera";
import { TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";
import type { InspectionPreview, UiSnapshot } from "../shared/types";

const check = (value: unknown, message: string) => { if (!value) throw new Error(`Lookin overview: ${message}`); };
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

export async function verifyOverviewCapture() {
  const oldApi = window.electronApi, preference = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
  localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY);
  const host = document.createElement("div"); document.body.append(host); const mounted = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>, preview: ((event: InspectionPreview) => void) | null = null;
  let pending!: { requestId: string; resolve: (value: UiSnapshot) => void };
  window.electronApi = { ...oldApi, cancelInspection: async () => {}, onInspectionProgress: () => () => {},
    onInspectionPreview: callback => { preview = callback; return () => { preview = null; }; },
    inspectDevice: (_serial, requestId) => new Promise(resolve => { pending = { requestId, resolve }; }) };
  function Harness() { workspace = useInspectionWorkspace(); return null; }
  try {
    flushSync(() => mounted.render(<Harness />)); await tick();
    for (const interaction of ["none", "expand", "select"] as const) {
      const root = makeNode("window"), panel = makeNode("panel"), card = makeNode("card"), leaf = makeNode("leaf");
      root.children = [panel, ...Array.from({ length: 301 }, (_, i) => makeNode(`extra-${i}`))]; panel.children = [card]; card.children = [leaf];
      const snapshot: UiSnapshot = { serial: "overview", root, nodeCount: 305, screenshotDataUrl: null, rawXml: null, xmlSize: 0, warning: null, error: null };
      let request!: Promise<UiSnapshot | null>; flushSync(() => { request = workspace.inspectDevice(snapshot.serial); });
      flushSync(() => preview?.({ requestId: pending.requestId, phase: "tree", snapshot }));
      check(workspace.treeExpandedIds.has(card.id), "uncaptured hierarchy was guessed to be painted");
      if (interaction === "expand") flushSync(() => workspace.setTreeExpandedIds(new Set(workspace.treeExpandedIds)));
      if (interaction === "select") flushSync(() => { workspace.setSelectedNode(leaf); });
      const updates = [root, panel, card].map(node => ({ id: node.id, layerImageStatus: "captured" as const, layerImageDataUrl: "pixels" }));
      flushSync(() => preview?.({ requestId: pending.requestId, phase: "layers", updates }));
      check(workspace.treeExpandedIds.has(card.id) === (interaction !== "none"), "late images reset manual browsing or failed to apply overview");
      const final = workspace.snapshot!;
      pending.resolve(final); await request; await tick();
      check(workspace.treeExpandedIds.has(card.id) === (interaction !== "none"), "final capture changed the intended expansion");
      if (interaction === "select") check(workspace.selectedNode?.id === leaf.id, "final capture lost the selected control");
    }
    return ["overview: late paint evidence applies initial folds; explicit expansion and selection survive image updates and final capture"];
  } finally {
    flushSync(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    if (preference === null) localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY); else localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, preference);
  }
}

export async function verifySideOutlines() {
  const host = document.createElement("div"); Object.assign(host.style, { position: "relative", width: "600px", height: "700px" }); document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(), bitmap = document.createElement("canvas"); bitmap.width = 240; bitmap.height = 440;
  const context = bitmap.getContext("2d")!; context.fillStyle = "red"; context.fillRect(30, 30, 180, 380);
  const root = { ...makeNode("root"), bounds: { left: 0, top: 0, right: 300, bottom: 600, raw: "fixture" }, layerImageEmpty: true };
  const face = { ...makeNode("face"), bounds: { left: 30, top: 80, right: 270, bottom: 520, raw: "fixture" }, layerImageDataUrl: bitmap.toDataURL(), layerImageSize: { width: 240, height: 440 } };
  root.children = [face]; const original = JSON.stringify(root), expanded = new Set([root.id]);
  try {
    for (const azimuth of [0, 81, -81, 99]) {
      const camera = { ...DEFAULT_ORBIT_CAMERA, azimuth, elevation: 0, roll: 0 };
      const render = (structureMode: LayerAppearance["structureMode"], selected = false, displayMode: LayerDisplayMode = "images") => {
        flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={bitmap.toDataURL()} root={root} selectedNode={selected ? face : null} expandedNodeIds={expanded}
          size={{ width: 300, height: 600 }} renderScale={1} origin={{ left: 150, top: 50 }} camera={camera} appearance={{ ...DEFAULT_LAYER_APPEARANCE, structureMode }} displayMode={displayMode} initialFitNeeded={false} onSelect={() => {}} />));
        scene.current!.paintCamera(camera);
      };
      render("regular"); const canvas = host.querySelector<HTMLCanvasElement>("canvas")!, deadline = performance.now() + 4000;
      while (canvas.dataset.layerTextureCount !== "1" || canvas.dataset.layerTexturePendingCount !== "0") { check(performance.now() < deadline, "side texture timed out"); await tick(); }
      scene.current!.paintCamera(camera);
      const gl = canvas.getContext("webgl")!, rect = canvas.getBoundingClientRect();
      const patch = (x: number) => {
        const state = host.querySelector<HTMLElement>(".layer-scene")!.dataset, pivotZ = Number(state.layerPivotZ);
        const z = Number(host.querySelector<HTMLElement>('[data-layer-node-id="face"]')!.dataset.layerZ);
        const yaw = -azimuth * Math.PI / 180, dx = x - 150, dz = z - pivotZ, distance = Number(canvas.dataset.layerCameraDistance);
        const px = 300 + (Math.cos(yaw) * dx + Math.sin(yaw) * dz) * distance / (distance + Math.sin(yaw) * dx - Math.cos(yaw) * dz);
        const pixels = new Uint8Array(9 * 9 * 4); gl.readPixels(Math.round(px * canvas.width / rect.width) - 4, Math.round(canvas.height - 350 * canvas.height / rect.height) - 4, 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { x: px, pixels, blue: Array.from({ length: 81 }, (_, i) => pixels[i * 4 + 2]).reduce((a, b) => a + b, 0) };
      };
      const regular = patch(30).blue; render("complete"); const complete = patch(30).blue;
      check(complete > 80 && regular > 0, "side border disappeared");
      check(Math.abs(regular - complete) < 5, "ordinary contours disappeared when viewed from the side");
      render("regular", true); check(patch(30).blue > complete, "selection was faded along with ordinary borders");
      render("regular", false, "wireframe"); check(patch(30).blue >= complete, "wireframe lost its diagnostic edges");
      render("regular"); const content = patch(150);
      check(content.pixels[40 * 4] > 240 && content.pixels[40 * 4 + 2] === 0, "side outlines changed image pixels");
      check(scene.current!.pick(rect.left + content.x, rect.top + 350)?.id === face.id, "side outlines broke content picking");
      check(JSON.stringify(root) === original, "side outlines modified captured data");
    }
    return ["side outlines: thin contours remain visible at front/back grazing angles; selection, wireframe, image pixels and picking stay intact"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}
