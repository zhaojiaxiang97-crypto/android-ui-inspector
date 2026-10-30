import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { DEFAULT_LAYER_APPEARANCE } from "../src/features/layers/appearance";
import { cameraRotation, projectPoint } from "../src/features/layers/projection";
import type { LayerCamera, LayerSceneHandle } from "../src/features/layers/types";
import type { UiNode } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyInvisibleLayers() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "680px", height: "450px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>();
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Invisible layouts: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const until = async (fn: () => boolean, message: string) => {
    const deadline = performance.now() + 5000;
    while (!fn()) { check(performance.now() < deadline, message); await tick(); }
  };
  const node = (id: string, left: number, top: number, right: number, bottom: number, color: string): UiNode => {
    const canvas = document.createElement("canvas"); canvas.width = right - left; canvas.height = bottom - top;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    return { ...makeNode(id), text: id, bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` },
      layerImageDataUrl: canvas.toDataURL(), layerImageSize: { width: canvas.width, height: canvas.height } };
  };
  const root = node("root", 0, 0, 400, 320, "#162030"); root.attributes = { "tree-source": "debug-sdk" };
  const visible = node("visible", 100, 80, 300, 240, "#486caa"), other = node("other", 12, 280, 80, 312, "#5db98c");
  const ghost = node("invisible-frame", 20, 10, 380, 270, "#ffff00"); ghost.visibleToUser = false;
  const child = node("invisible-child", 120, 120, 280, 200, "#ff0000"); ghost.children = [child]; root.children = [visible, other, ghost];
  const before = JSON.stringify(root), camera: LayerCamera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, panX: 0, panY: 0, layerGap: 64 };
  let showInvisible = false, selected: UiNode = visible, hidden: ReadonlySet<string> = new Set(), expanded: ReadonlySet<string> = new Set([root.id, ghost.id]);
  let focusedNode: UiNode | null = null, requests = 0;
  const captureGroup = async () => { requests++; return null; };
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={root.layerImageDataUrl!} root={root} selectedNode={selected}
    expandedNodeIds={expanded} hiddenNodeIds={hidden} focusedNode={focusedNode} focusKind="branch" size={{ width: 400, height: 320 }}
    origin={{ left: 90, top: 40 }} renderScale={1} camera={camera} appearance={{ ...DEFAULT_LAYER_APPEARANCE, showInvisible }}
    onSelect={() => {}} onCaptureGroup={captureGroup} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const record = (id: string) => host.querySelector<HTMLElement>(`[data-layer-node-id="${id}"]`);
  const point = (id: string, x: number, y: number) => {
    const metadata = host.querySelector<HTMLElement>(".layer-scene")!.dataset, layer = record(id)!;
    const pivot = { x: Number(metadata.layerPivotX), y: Number(metadata.layerPivotY), z: Number(metadata.layerPivotZ) };
    const projected = projectPoint(90 + x, 40 + y, Number(layer.dataset.layerZ), pivot, camera, cameraRotation(camera));
    const rect = canvas().getBoundingClientRect(); return { x: rect.left + projected.x, y: rect.top + projected.y };
  };
  const settled = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0"
    && canvas().dataset.layerAnimationProgress === "1", "scene did not settle");
  try {
    render(); await settled(); check(!record(ghost.id) && !record(child.id), "default view exposed invisible layouts");
    const target = point(other.id, 46, 296);
    flushSync(() => scene.current!.hover(target.x, target.y));
    flushSync(() => check(scene.current!.toggleMeasurementPin(), "visible pair could not be pinned"));
    const pair = host.querySelector<HTMLElement>(".layer-measurement-status")!.dataset;
    const expectedPair = `${pair.measureAnchor}:${pair.measureTarget}`;
    const gl = canvas().getContext("webgl")!, upload = gl.texImage2D, draw = gl.drawArrays;
    let uploads = 0, dashedDraws = 0, solidInvisibleSelection = false;
    gl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, gl, args); }) as typeof upload;
    gl.drawArrays = ((...args: Parameters<typeof draw>) => {
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
      const kind = gl.getUniform(program, gl.getUniformLocation(program, "u_kind")!);
      if (kind === 6) dashedDraws++;
      if (selected === ghost && kind === 4) solidInvisibleSelection = true;
      Reflect.apply(draw, gl, args);
    }) as typeof draw;
    try {
      showInvisible = true; render(); await settled();
      check(record(ghost.id)?.dataset.layerDeviceInvisible === "true" && record(child.id)?.dataset.layerDeviceInvisible === "true", "invisible ancestor was not inherited");
      check(canvas().dataset.layerInvisibleCount === "2" && dashedDraws >= 2, "invisible layouts did not use the dashed GPU pass");
      check(record(ghost.id)?.dataset.layerTexture === "false" && record(child.id)?.dataset.layerTexture === "false"
        && uploads === 0 && requests === 0, "showing layouts loaded invisible screenshots or requested native images");
      const interior = point(ghost.id, 200, 160);
      check(scene.current!.pick(interior.x, interior.y) === visible, "invisible interior intercepted the visible control");
      const edge = point(ghost.id, 21, 140);
      check(scene.current!.pick(edge.x, edge.y) === ghost, "invisible edge could not be selected");
      flushSync(() => scene.current!.hover(edge.x, edge.y));
      check(host.querySelector('[data-layer-image-hint="hover"]')?.textContent?.includes("设备不可见"), "edge hover pretended to show a screenshot");
      const preserved = host.querySelector<HTMLElement>(".layer-measurement-status")!.dataset;
      check(`${preserved.measureAnchor}:${preserved.measureTarget}` === expectedPair, "showing invisible layouts changed a valid pinned pair");
      selected = ghost; render(); await settled();
      check(!solidInvisibleSelection, "selected invisible boundary became a solid outline");
    } finally { gl.texImage2D = upload; gl.drawArrays = draw; }
    selected = ghost; focusedNode = ghost; render(); await settled();
    check(record(ghost.id)?.dataset.layerDeviceInvisible === "true" && record(child.id)?.dataset.layerDeviceInvisible === "true", "branch focus lost inherited invisibility");
    selected = child; focusedNode = child; render(); await settled();
    check(record(child.id)?.dataset.layerDeviceInvisible === "true" && record(child.id)?.dataset.layerTexture === "false", "focusing a visible child of an invisible ancestor fabricated pixels");
    focusedNode = null; expanded = new Set([root.id]); render(); await settled();
    check(record(ghost.id)?.dataset.layerTexture === "false" && !record(child.id) && requests === 0, "folded invisible branch requested a composite");
    expanded = new Set([root.id, ghost.id]); hidden = new Set([visible.id, ghost.id]); render(); await settled();
    check(!record(visible.id) && !record(ghost.id) && record(child.id), "invisible option restored manually hidden planes or hid their children");
    showInvisible = false; render(); await settled();
    check(!record(child.id) && canvas().dataset.layerInvisibleCount === "0" && !record(visible.id), "turning off the option retained invisible or manually hidden planes");
    check(JSON.stringify(root) === before && requests === 0, "layout inspection changed the snapshot or contacted the device");
    return ["invisible layouts: opt-in dashed GPU boundaries, inherited visibility and selectable edges without intercepting interiors",
      "invisible layouts: focus/folding/manual hiding, valid pinned-pair preservation, zero bitmap uploads/device requests and unchanged snapshot"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}
